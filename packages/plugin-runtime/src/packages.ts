import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { pluginEnvironment } from "./environment.ts";
import { check, parseManifest, PluginError, record } from "./manifest.ts";

function snapshot(directory: string, stored = false) {
  check(isAbsolute(directory) && lstatSync(directory).isDirectory(), "Expected an absolute package directory");
  const root = realpathSync(directory);
  const files = new Map<string, Buffer>();
  let size = 0, entries = 0;
  function walk(base: string, depth: number) {
    check(depth <= 12, "Package nesting limit");
    for (const name of readdirSync(join(root, base))) {
      if (name.toLowerCase() === "node_modules") continue;
      check(++entries <= 512 && !name.startsWith(".") && !/[\\\x00-\x1f]/.test(name), "Invalid package entry");
      const rel = base ? base + "/" + name : name;
      const path = join(root, rel);
      check(realpathSync(path) === path, "Package contains a link");
      const st = lstatSync(path);
      if (st.isDirectory()) { walk(rel, depth + 1); continue; }
      check(st.isFile() && st.nlink === 1, "Unsupported package file");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const f = fstatSync(fd);
        size += f.size;
        check(f.ino === st.ino && f.dev === st.dev && f.isFile() && size <= 8 * 1024 * 1024, "Package changed or too large");
        const data = Buffer.alloc(f.size);
        let offset = 0;
        while (offset < data.length) {
          const count = readSync(fd, data, offset, data.length - offset, null);
          check(count, "Package changed"); offset += count;
        }
        check(fstatSync(fd).size === data.length, "Package changed");
        const canonical = rel.normalize("NFC");
        check(!files.has(canonical), "Duplicate normalized path");
        files.set(canonical, data);
      } finally { closeSync(fd); }
    }
  }
  walk("", 0);
  check(files.has("index.mjs") && files.has("alter-plugin.json"), "Missing index.mjs or alter-plugin.json");
  const bytes = files.get("alter-plugin.json")!;
  check(bytes.length <= 128 * 1024, "Manifest too large");
  const metadata = files.get("package.json");
  const dependencies: Record<string, string> = Object.create(null);
  const locked = files.has("package-lock.json");
  check(metadata || !locked, "package-lock.json requires package.json");
  if (metadata) {
    const pkg: unknown = JSON.parse(metadata.toString());
    check(record(pkg), "Invalid package.json");
    for (const name of ["peerDependencies", "devDependencies", "dependencies", "optionalDependencies"]) {
      if (!(name in pkg)) continue;
      const list = pkg[name];
      check(record(list), "Invalid dependency list");
      for (const [key, version] of Object.entries(list)) {
        check(typeof version === "string" && version.length > 0, "Invalid dependency version");
        dependencies[key] = version;
      }
    }
    check(!Object.keys(dependencies).length || locked, "npm dependencies require package-lock.json");
  }
  const manifest = parseManifest(JSON.parse(bytes.toString()), stored);
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    hash.update(name).update("\0").update(String(data.length)).update("\0").update(data);
  }
  return { manifest, sha: hash.digest("hex"), dependencies, locked, files };
}
export function inspect(dir: string) {
  const { manifest, sha, dependencies } = snapshot(dir);
  return { manifest, sha, dependencies };
}
export function verify(directory: string, sha: string) {
  check(snapshot(directory, true).sha === sha, "Package SHA-256 mismatch");
}
async function installDependencies(directory: string, secretNames: string[]) {
  const scratch = mkdtempSync(join(tmpdir(), "alter-npm-"));
  try {
    const args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", directory,
      "--cache", join(scratch, "cache"), "--userconfig", join(scratch, "userconfig"), "--globalconfig", join(scratch, "globalconfig")];
    const bin = dirname(process.execPath);
    const npmCli = join(bin, process.platform === "win32" ? "." : "../lib", "node_modules/npm/bin/npm-cli.js");
    let command = process.execPath;
    if (existsSync(npmCli)) args.unshift(npmCli);
    else {
      const npm = process.env.PATH?.split(delimiter).filter(isAbsolute).map(d => join(d, "npm")).find(existsSync);
      check(npm, "npm executable not found");
      command = npm;
    }
    await promisify(execFile)(command, args, {
      cwd: directory, env: pluginEnvironment(secretNames), windowsHide: true, timeout: 120_000, killSignal: "SIGKILL",
    });
  } catch (error) {
    if (error instanceof PluginError) throw error;
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const code = failure.killed ? "timeout" : failure.stderr?.match(/^npm (?:error|ERR!) code ([A-Z0-9_]+)$/im)?.[1] ?? failure.code;
    throw new PluginError("npm ci --ignore-scripts failed" + (code === undefined ? "" : " (" + code + ")"));
  } finally { rmSync(scratch, { force: true, recursive: true }); }
}

function checkLocalDependencies(files: Map<string, Buffer>) {
  function inside(base: string, target: string) {
    const path = decodeURIComponent(target.replace(/^file:/i, "")).replaceAll("\\", "/");
    const normalized = posix.join(base, path);
    check(!/^(?:[~/]|[A-Za-z]:)/.test(path) && normalized !== ".." && !normalized.startsWith("../"),
      "Local npm dependencies must be inside the plugin package");
  }
  function spec(base: string, value: unknown) {
    if (typeof value === "string" && /^(?:file:|[.\/\\]|~[\/\\]|[A-Za-z]:[\/\\])/.test(value)) inside(base, value);
  }
  for (const [name, bytes] of files) {
    if (posix.basename(name) !== "package.json") continue;
    const pkg = JSON.parse(bytes.toString());
    if (!record(pkg)) continue;
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[key];
      if (record(deps)) Object.values(deps).forEach(value => spec(posix.dirname(name), value));
    }
    const workspaces = record(pkg.workspaces) ? pkg.workspaces.packages : pkg.workspaces;
    if (Array.isArray(workspaces)) for (const path of workspaces) if (typeof path === "string") inside(posix.dirname(name), path);
  }
  check(!files.has("npm-shrinkwrap.json"), "Use package-lock.json as the plugin lock file");
  const lock = JSON.parse(files.get("package-lock.json")!.toString());
  if (record(lock) && record(lock.packages)) {
    for (const [name, entry] of Object.entries(lock.packages)) {
      inside("", name);
      if (!record(entry)) continue;
      if (entry.link && typeof entry.resolved === "string") inside("", entry.resolved);
      else spec("", entry.resolved);
    }
  }
}

export async function preparePackage(root: string, source: string, stored = false) {
  const { files, locked, ...info } = snapshot(source, stored);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = realpathSync(mkdtempSync(join(root, "pending-")));
  try {
    for (const [rel, data] of files) {
      const path = join(directory, rel);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, data, { mode: 0o600, flag: "wx" });
    }
    if (locked) {
      checkLocalDependencies(files);
      await installDependencies(directory, info.manifest.secrets.map(s => s.name));
    }
    verify(directory, info.sha);
    return { ...info, staged: directory, path: source };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function activatePackage(root: string, staged: string, sha: string) {
  verify(staged, sha);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, sha);
  try { renameSync(staged, target); }
  catch (error) {
    if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    verify(target, sha);
  }
}

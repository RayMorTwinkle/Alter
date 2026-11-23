import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { check, parseManifest, record } from "./manifest.ts";

function snapshot(directory: string) {
  check(isAbsolute(directory) && lstatSync(directory).isDirectory(), "Expected an absolute package directory");
  const root = realpathSync(directory);
  const files = new Map<string, Buffer>();
  let size = 0, entries = 0;
  function walk(base: string, depth: number) {
    check(depth <= 12, "Package nesting limit");
    for (const name of readdirSync(join(root, base))) {
      check(++entries <= 512 && !name.startsWith(".") && !/[\\\x00-\x1f]/.test(name) && name.toLowerCase() !== "node_modules", "Invalid package entry");
      const rel = base ? base + "/" + name : name;
      const path = join(root, rel);
      check(realpathSync(path) === path, "Package contains a link");
      const st = lstatSync(path);
      if (st.isDirectory()) { walk(rel, depth + 1); continue; }
      check(!name.toLowerCase().endsWith(".node") && st.isFile() && st.nlink === 1, "Unsupported package file");
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
  if (metadata) {
    const pkg = JSON.parse(metadata.toString());
    check(record(pkg) && ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"].every(k =>
      !(k in pkg) || record(pkg[k]) && !Object.keys(pkg[k]).length), "External npm dependencies are unsupported");
  }
  const manifest = parseManifest(JSON.parse(bytes.toString()));
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    hash.update(name).update("\0").update(String(data.length)).update("\0").update(data);
  }
  return { manifest, sha: hash.digest("hex"), files };
}
export function inspect(dir: string) {
  const { manifest, sha } = snapshot(dir);
  return { manifest, sha };
}
export function verify(directory: string, sha: string) {
  check(inspect(directory).sha === sha, "Package SHA-256 mismatch");
}
export function installPackage(root: string, source: string, sha: string) {
  const snap = snapshot(source);
  check(snap.sha === sha, "Pending package SHA-256 mismatch");
  const target = join(root, sha);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(root, ".install-"));
  try {
    for (const [rel, data] of snap.files) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true, mode: 0o700 });
      writeFileSync(join(tmp, rel), data, { mode: 0o400, flag: "wx" });
    }
    verify(tmp, sha);
    try { renameSync(tmp, target); }
    catch (e) { if (!["EEXIST", "ENOTEMPTY"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
    verify(target, sha);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

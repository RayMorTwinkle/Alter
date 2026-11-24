import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HttpError } from "./static.ts";

const label = "top.raymor.alter";
const defaults = { autostart: false, keepAlive: false, preventSleep: false };
type Flags = typeof defaults;

export type ServiceOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  launchAgentsDir?: string;
  repoRoot?: string;
  execPath?: string;
  launchctlPath?: string;
  lsofPath?: string;
  startSeconds?: number;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawnChild>;
  shutdown?: () => void;
};

function optionalFile(path: string) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function replaceFile(path: string, content: string) {
  const temp = path + "." + randomUUID();
  try {
    writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function validPatch(input: unknown): input is Partial<Flags> {
  return !!input && typeof input === "object" && !Array.isArray(input) &&
    Object.entries(input).every(([key, value]) => Object.hasOwn(defaults, key) && typeof value === "boolean");
}

function serviceEnv(env: NodeJS.ProcessEnv, node: string) {
  const vars: Record<string, string> = {
    PATH: (env.PATH ?? "/usr/bin:/bin").split(":").map(path =>
      path.split("/").includes("fnm_multishells") ? dirname(node) : path).join(":"),
  };
  for (const key of ["ALTER_DATA_DIR", "ALTER_WEB_PORT", "ALTER_WEB_HOST"]) {
    if (env[key] !== undefined) vars[key] = env[key];
  }
  return vars;
}

function plist(flags: Flags, node: string, main: string, repo: string, env: Record<string, string>, log: string) {
  const escaped = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const str = (s: string) => `<string>${escaped(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label)}
  <key>ProgramArguments</key><array>${str(node)}${str(main)}</array>
  <key>WorkingDirectory</key>${str(repo)}
  <key>EnvironmentVariables</key><dict>
    ${Object.entries(env).map(([key, value]) => `<key>${key}</key>${str(value)}`).join("\n    ")}
  </dict>
  <key>RunAtLoad</key><${flags.autostart}/>
  <key>KeepAlive</key>${flags.keepAlive ? "<dict><key>SuccessfulExit</key><false/></dict>" : "<false/>"}
  <key>AbandonProcessGroup</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}

// Pass paths as positional arguments so neither shell syntax nor whitespace in them is interpreted.
const handoff = `old_pid=$1
plist=$2
node=$3
main=$4
log=$5
launchctl=$6
port=$7
failed=$8
lsof=$9
seconds=\${10}
domain=gui/$(/usr/bin/id -u)
job="$domain/${label}"
exec >>"$log" 2>&1 || exit 1
i=0
while kill -0 "$old_pid" 2>/dev/null && [ "$i" -lt 15 ]; do
  /bin/sleep 1
  i=$((i+1))
done
"$launchctl" bootout "$job" 2>/dev/null || :
if [ -f "$plist" ]; then
  "$launchctl" bootstrap "$domain" "$plist" && "$launchctl" kickstart "$job"
  # A job launchd cannot run (for example macOS denying it the Documents folder) must not leave Alter down.
  i=0
  until "$lsof" -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    i=$((i+1))
    if [ "$i" -ge "$seconds" ]; then
      "$launchctl" bootout "$job" 2>/dev/null || :
      /bin/rm -f "$plist"
      printf '%s\n' "$node" >"$failed"
      /usr/bin/nohup "$node" "$main" >>"$log" 2>&1 &
      exit 0
    fi
    /bin/sleep 1
  done
else
  /usr/bin/nohup "$node" "$main" >>"$log" 2>&1 &
fi`;

export function openService(dataDir: string, options: ServiceOptions = {}) {
  const env = options.env ?? process.env;
  const supported = (options.platform ?? process.platform) === "darwin";
  const managed = env.XPC_SERVICE_NAME === label;
  const agents = options.launchAgentsDir ?? join(options.home ?? homedir(), "Library", "LaunchAgents");
  const agentFile = join(agents, label + ".plist");
  const repo = resolve(options.repoRoot ?? join(import.meta.dirname, "../../.."));
  const main = join(repo, "packages/server/src/main.ts");
  const log = resolve(dataDir, "logs/server.log");
  const settings = join(dataDir, "service.json");
  const failedFile = join(dataDir, "service-failed");
  const port = env.ALTER_WEB_PORT || "4317";
  const spawn = options.spawn ?? spawnChild;
  const shutdown = options.shutdown ?? (() => process.kill(process.pid, "SIGTERM"));
  const saved = optionalFile(settings);
  const initial: unknown = saved === undefined ? {} : JSON.parse(saved);
  if (!validPatch(initial)) throw new Error("Invalid service.json");
  let flags = { ...defaults, ...initial };
  // The handoff helper fell back to an unmanaged start; reflect that instead of claiming the switches work.
  const failedNode = !managed ? optionalFile(failedFile)?.trim() : undefined;
  let failed: string | undefined = failedNode || undefined;
  if (failedNode !== undefined) {
    rmSync(failedFile, { force: true });
    flags = { ...flags, autostart: false, keepAlive: false };
    replaceFile(settings, JSON.stringify(flags));
  }
  let caffeinate: ReturnType<typeof spawnChild> | undefined;
  let closed = false;
  let switching = false;
  let reload = false;
  const state = () => ({ supported, ...flags, managed, ...(failed && { failedNode: failed }) });

  function stopCaffeinate() {
    caffeinate?.kill();
    caffeinate = undefined;
  }
  function applySleep() {
    if (closed || !supported || !flags.preventSleep) return stopCaffeinate();
    if (caffeinate) return;
    const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    caffeinate = child;
    child.once("error", error => console.error("Could not run caffeinate", error));
    child.once("close", () => { if (caffeinate === child) caffeinate = undefined; });
  }

  async function applyLaunchAgent() {
    const node = realpathSync(options.execPath ?? process.execPath);
    const vars = serviceEnv(env, node);
    const wanted = flags.autostart || flags.keepAlive;
    const content = wanted ? plist(flags, node, main, repo, vars, log) : undefined;
    if (optionalFile(agentFile) !== content) {
      if (content === undefined) rmSync(agentFile);
      else {
        mkdirSync(agents, { recursive: true, mode: 0o700 });
        replaceFile(agentFile, content);
      }
      reload = true;
    }
    if (switching || (!reload && managed === wanted)) return;
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    // launchd supplies the login environment for its jobs. Give the unmanaged child
    // its home and temporary directory too, without inheriting XPC_SERVICE_NAME or credentials.
    const helperEnv: NodeJS.ProcessEnv = { ...vars };
    for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) {
      if (env[key] !== undefined) helperEnv[key] = env[key];
    }
    switching = true;
    try {
      const helper = spawn("/bin/sh", ["-c", handoff, label, String(process.pid), agentFile, node, main, log,
        options.launchctlPath ?? "/bin/launchctl", port, failedFile,
        options.lsofPath ?? "/usr/sbin/lsof", String(options.startSeconds ?? 30)],
        { detached: true, stdio: "ignore", cwd: repo, env: helperEnv });
      await once(helper, "spawn");
      helper.unref();
      if (!closed) shutdown();
    } catch (error) { switching = false; throw error; }
  }

  applySleep();
  return {
    state,
    update(patch: unknown) {
      if (!validPatch(patch)) throw new HttpError(400, "Expected boolean autostart, keepAlive or preventSleep");
      if (!supported) throw new HttpError(409, "Background service settings require macOS");
      const next = { ...flags, ...patch };
      if ("autostart" in patch || "keepAlive" in patch) failed = undefined;
      replaceFile(settings, JSON.stringify(next));
      flags = next;
      return { state: state(), async apply() {
        applySleep();
        if ("autostart" in patch || "keepAlive" in patch) await applyLaunchAgent();
      } };
    },
    close() { closed = true; stopCaffeinate(); },
  };
}

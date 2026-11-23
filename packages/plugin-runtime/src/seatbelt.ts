import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

function literal(path: string) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid sandbox path");
  return JSON.stringify(realpathSync(path));
}
// Node realpaths the entry script, so it needs stat (not listing) on every ancestor.
function ancestors(...paths: string[]) {
  const out = new Set<string>();
  for (const path of paths) for (let dir = dirname(realpathSync(path)); dir !== "/"; dir = dirname(dir)) out.add(dir);
  return [...out].map(dir => `(literal ${JSON.stringify(dir)})`).join(" ");
}
export function seatbelt(directory: string, executable = process.execPath) {
  const node = literal(executable), pkg = literal(directory);
  return `(version 1)
(deny default)
(deny network-outbound network-bind network-inbound (with send-signal SIGKILL))
(allow process-exec (literal ${node}))
(allow file-read* (literal ${node}) (subpath ${pkg})
  (subpath "/usr/lib") (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks") (subpath "/System/Library/dyld"))
(allow file-map-executable (literal ${node}) (subpath "/usr/lib")
  (subpath "/System/Library/Frameworks") (subpath "/System/Library/PrivateFrameworks") (subpath "/System/Library/dyld"))
(allow file-read* (literal "/") (subpath "/System/Library/OpenSSL"))
(allow file-read-metadata (literal "/dev") ${ancestors(directory, executable)})
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))
(allow sysctl-read)
(allow process-info* (target self))
(allow signal (target self))`;
}

export function launchSandbox(directory: string, args: string[]) {
  if (process.platform !== "darwin") throw new Error("External plugins require macOS Seatbelt");
  return spawn("/usr/bin/sandbox-exec", ["-p", seatbelt(directory), process.execPath, ...args], {
    cwd: directory, env: {}, stdio: ["pipe", "pipe", "pipe"],
  });
}

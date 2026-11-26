import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, windowsUserSid } from "./config.ts";
import { cliScript as cli } from "./finish.ts";

const label = "org.alter.node";
const unit = "alter-node.service";
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Started through a hidden PowerShell so logging in does not leave a console window that closing would kill.
export function taskXml(sid: string, node: string, script: string, shell = "powershell.exe") {
  const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& ${literal(node)} ${literal(script)} run"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="user"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="user"><Exec><Command>${xml(shell)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>
`;
}

export function launchAgent(node: string, script: string, searchPath: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
}

export function systemdUnit(node: string, script: string, searchPath: string) {
  function quote(value: string) {
    return JSON.stringify(value.replaceAll("%", "%%"));
  }
  return `[Unit]
Description=Alter node

[Service]
Environment=${quote("PATH=" + searchPath)}
ExecStart=${quote(node.replaceAll("$", () => "$$"))} ${quote(script.replaceAll("$", () => "$$"))} run

[Install]
WantedBy=default.target
`;
}

export function configureService(install: boolean, platform = process.platform) {
  if (platform === "win32") {
    const sid = windowsUserSid();
    const task = "Alter Node " + sid;
    const scheduler = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
    if (!install) {
      execFileSync(scheduler, ["/Delete", "/TN", task, "/F"], { windowsHide: true });
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "alter-node-task-"));
    const file = path.join(dir, "task.xml");
    try {
      const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      writeFileSync(file, "\uFEFF" + taskXml(sid, process.execPath, cli, shell), "utf16le");
      execFileSync(scheduler, ["/Create", "/TN", task, "/XML", file, "/F"], { windowsHide: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  const searchPath = (process.env.PATH ?? "").split(":").filter(p => path.posix.isAbsolute(p)).join(":");
  if (platform === "darwin") {
    const file = path.join(homedir(), "Library/LaunchAgents", label + ".plist");
    if (install) {
      mkdirSync(path.dirname(file), { recursive: true });
      atomicWrite(file, launchAgent(process.execPath, cli, searchPath));
    } else rmSync(file, { force: true });
    return;
  }
  if (platform !== "linux") throw new Error("不支持此操作系统");
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd/user", unit);
  if (install) {
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, systemdUnit(process.execPath, cli, searchPath));
    execFileSync("systemctl", ["--user", "enable", unit]);
  } else if (existsSync(file)) {
    execFileSync("systemctl", ["--user", "disable", unit]);
    rmSync(file);
    execFileSync("systemctl", ["--user", "daemon-reload"]);
  }
}

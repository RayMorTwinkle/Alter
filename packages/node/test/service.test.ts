import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { configureService, launchAgent, systemdUnit } from "../src/service.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

test.skipIf(process.platform !== "win32")("creates and deletes the same per-user logon task", () => {
  const sid = "S-1-5-21-123-456-789-1001";
  let file = "", xml = "";
  const commands: string[][] = [];
  vi.mocked(execFileSync).mockImplementation((exe, args) => {
    if (path.basename(exe) === "whoami.exe") return '"user","' + sid + '"';
    expect(path.basename(exe)).toBe("schtasks.exe");
    commands.push([...args as string[]]);
    if (args?.includes("/XML")) {
      file = args[args.indexOf("/XML") + 1]!;
      xml = readFileSync(file, "utf16le");
    }
    return Buffer.alloc(0);
  });
  configureService(true);
  expect(existsSync(file)).toBe(false);
  configureService(false);
  expect(commands).toEqual([["/Create", "/TN", "Alter Node " + sid, "/XML", file, "/F"],
    ["/Delete", "/TN", "Alter Node " + sid, "/F"]]);
  expect(xml).toContain("<LogonTrigger><UserId>" + sid + "</UserId>");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("-WindowStyle Hidden");
  expect(xml).toContain("cli.ts' run\"</Arguments>");
});

test("login definitions preserve paths with spaces and platform-specific quoting", () => {
  const bin = "/opt/Node JS/node", script = "/home/me/代码 & 50%/$project/cli.ts";
  const plist = launchAgent(bin, script, "/opt/Node JS:/bin");
  expect(plist).toContain("<string>/home/me/代码 &amp; 50%/$project/cli.ts</string><string>run</string>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  const unit = systemdUnit(bin, script, "/opt/Node JS:/bin");
  expect(unit).toContain('ExecStart="/opt/Node JS/node" "/home/me/代码 & 50%%/$$project/cli.ts" run');
  expect(unit).toContain("WantedBy=default.target");
});

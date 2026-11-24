import { ChildProcess, execFileSync, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { listen } from "../src/main.ts";
import { openService, type ServiceOptions } from "../src/service.ts";
import { cleanup, setup } from "./web-fixture.ts";

const label = "top.raymor.alter";
async function fixture(managed = false, listening = true) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "alter-service-")));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo & 'code'");
  const node = join(dir, "bin", "node");
  const execPath = join(dir, "fnm_multishells", "123", "bin", "node");
  await mkdir(dirname(node), { recursive: true });
  await mkdir(dirname(execPath), { recursive: true });
  await mkdir(repo);
  await writeFile(node, '#!/bin/sh\npwd\necho "$1"\necho "$PATH"\necho "$ALTER_WEB_PORT"\n', { mode: 0o700 });
  await symlink(node, execPath);
  // A failing bootout also exercises the first install, when no job was previously loaded.
  const launchctlPath = join(dir, "fake launchctl");
  await writeFile(launchctlPath, '#!/bin/sh\necho "$@"\n[ "$1" != bootout ]\n', { mode: 0o700 });
  const lsofPath = join(dir, "fake lsof");
  await writeFile(lsofPath, `#!/bin/sh\nexit ${listening ? 0 : 1}\n`, { mode: 0o700 });
  const children: ChildProcess[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions) => {
    const child = new ChildProcess();
    children.push(child);
    vi.spyOn(child, "kill").mockReturnValue(true);
    vi.spyOn(child, "unref").mockImplementation(() => {});
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const shutdown = vi.fn();
  const options: ServiceOptions = {
    platform: "darwin", home: dir, repoRoot: repo, execPath, launchctlPath, lsofPath, startSeconds: 1, spawn, shutdown,
    env: { PATH: "/usr/bin:" + dirname(execPath) + ":/bin", ALTER_WEB_HOST: "a<&>\"'", ALTER_WEB_PORT: "9876",
      ALTER_DATA_DIR: dir, ALTER_WEB_PASSWORD: "secret-marker", ALTER_LLM_API_KEY: "secret-marker",
      XPC_SERVICE_NAME: managed ? label : "some.other.job" },
  };
  const plist = join(dir, "Library/LaunchAgents", label + ".plist");
  return { options, children, spawn, shutdown, dir, repo, node, plist };
}

it.each([[true, false], [false, true], [true, true]])("writes a reboot-safe plist for autostart=%s keepAlive=%s", async (autostart, keepAlive) => {
  const f = await fixture(true);
  const service = openService(f.dir, f.options);
  await service.update({ autostart, keepAlive }).apply();
  const xml = await readFile(f.plist, "utf8");
  const repo = f.repo.replaceAll("&", "&amp;").replaceAll("'", "&apos;");
  expect(xml).toContain('<key>Label</key><string>' + label + '</string>');
  expect(xml).toContain(`<key>ProgramArguments</key><array><string>${f.node}</string><string>${repo}/packages/server/src/main.ts</string></array>`);
  expect(xml).toContain(`<key>WorkingDirectory</key><string>${repo}</string>`);
  expect(xml).toContain(`<key>PATH</key><string>/usr/bin:${dirname(f.node)}:/bin</string>`);
  expect(xml).toContain(`<key>ALTER_DATA_DIR</key><string>${f.dir}</string>`);
  expect(xml).toContain("<key>ALTER_WEB_HOST</key><string>a&lt;&amp;&gt;&quot;&apos;</string>");
  expect(xml).toContain("<key>ALTER_WEB_PORT</key><string>9876</string>");
  expect(xml).not.toMatch(/fnm_multishells|secret-marker|ALTER_WEB_PASSWORD|ALTER_LLM_API_KEY|XPC_SERVICE_NAME/);
  expect(xml).toContain(`<key>RunAtLoad</key><${autostart}/>`);
  expect(xml).toContain("<key>KeepAlive</key>" + (keepAlive ? "<dict><key>SuccessfulExit</key><false/></dict>" : "<false/>"));
  expect(xml).toContain("<key>AbandonProcessGroup</key><true/>");
  expect(xml).toContain("<key>ThrottleInterval</key><integer>10</integer>");
  const log = join(f.dir, "logs/server.log");
  for (const key of ["StandardOutPath", "StandardErrorPath"]) expect(xml).toContain(`<key>${key}</key><string>${log}</string>`);
});

it("loads the agent, skips an unchanged job, and restarts unmanaged after removing it", async () => {
  const f = await fixture(true);
  const log = join(f.dir, "logs/server.log");
  const service = openService(f.dir, f.options);
  await service.update({ autostart: true }).apply();
  // Exercise the actual shell branches with the fake executables and an already exited PID.
  function runLastHelper() {
    const [sh, args, opts] = f.spawn.mock.calls.at(-1)!;
    expect(sh).toBe("/bin/sh");
    expect(opts).toMatchObject({ cwd: f.repo, detached: true, stdio: "ignore" });
    expect(opts.env).not.toHaveProperty("ALTER_WEB_PASSWORD");
    expect(opts.env).not.toHaveProperty("XPC_SERVICE_NAME");
    const helperArgs = [...args];
    expect(helperArgs[3]).toBe(String(process.pid));
    helperArgs[3] = "2147483647";
    execFileSync(sh, helperArgs, { cwd: opts.cwd, env: opts.env, timeout: 3000 });
  }
  runLastHelper();
  const domain = "gui/" + process.getuid!();
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    `bootout ${domain}/${label}`, `bootstrap ${domain} ${f.plist}`, `kickstart ${domain}/${label}`,
  ]);
  expect(f.shutdown).toHaveBeenCalledOnce();

  const reopened = openService(f.dir, f.options);
  await reopened.update({ autostart: true }).apply();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await reopened.update({ autostart: false, keepAlive: false }).apply();
  expect(existsSync(f.plist)).toBe(false);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  runLastHelper();
  await expect.poll(() => readFile(log, "utf8")).toContain([
    `bootout ${domain}/${label}`, f.repo, join(f.repo, "packages/server/src/main.ts"), `/usr/bin:${dirname(f.node)}:/bin`, "9876",
  ].join("\n"));
});

it("falls back to an unmanaged start and reports it when launchd cannot keep Alter listening", async () => {
  const f = await fixture(false, false);
  const log = join(f.dir, "logs/server.log");
  await openService(f.dir, f.options).update({ autostart: true, keepAlive: true }).apply();
  const [sh, args, opts] = f.spawn.mock.calls.at(-1)!;
  const helperArgs = [...args];
  helperArgs[3] = "2147483647";
  execFileSync(sh, helperArgs, { cwd: opts.cwd, env: opts.env, timeout: 5000 });
  const domain = "gui/" + process.getuid!();
  await expect.poll(() => readFile(log, "utf8")).toContain([
    `bootout ${domain}/${label}`, `bootstrap ${domain} ${f.plist}`, `kickstart ${domain}/${label}`, `bootout ${domain}/${label}`, f.repo,
  ].join("\n"));
  expect(existsSync(f.plist)).toBe(false);
  const reopened = openService(f.dir, f.options);
  expect(reopened.state()).toMatchObject({ autostart: false, keepAlive: false, managed: false, failedNode: f.node });
  expect(JSON.parse(await readFile(join(f.dir, "service.json"), "utf8"))).toMatchObject({ autostart: false, keepAlive: false });
  await reopened.update({ preventSleep: true }).apply();
  expect(reopened.state()).toHaveProperty("failedNode", f.node);
  await reopened.update({ autostart: false }).apply();
  expect(reopened.state()).not.toHaveProperty("failedNode");
});

async function api(options: ServiceOptions) {
  const web = await setup(undefined, false, undefined, Date.now, undefined, options);
  const put = (value: unknown) => fetch(web.base + "/api/service", { method: "PUT",
    headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify(value) });
  return { ...web, put };
}

it("authenticates and strictly validates updates before persisting or running commands", async () => {
  const f = await fixture();
  const web = await api(f.options);
  expect((await web.read("/api/service")).status).toBe(401);
  expect((await web.put({ autostart: true })).status).toBe(401);
  await web.login();
  const initial = { supported: true, managed: false, autostart: false, keepAlive: false, preventSleep: false };
  expect(await (await web.read("/api/service")).json()).toEqual(initial);
  for (const bad of [null, [], true, { autostart: 1 }, { keepAlive: null }, { preventSleep: "false" },
    { keepAlive: true, other: false }, { managed: true }, { constructor: false }]) {
    expect((await web.put(bad)).status).toBe(400);
  }
  expect(existsSync(join(web.dir, "service.json"))).toBe(false);
  expect(await (await web.put({})).json()).toEqual(initial);
  expect(await (await web.put({ keepAlive: false })).json()).toEqual(initial);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("reports unsupported platforms and rejects writes without touching launch services", async () => {
  const f = await fixture();
  const web = await api({ ...f.options, platform: "linux" });
  await web.login();
  expect(await (await web.read("/api/service")).json()).toMatchObject({ supported: false, managed: false });
  expect((await web.put({ preventSleep: true })).status).toBe(409);
  expect(existsSync(join(web.dir, "service.json"))).toBe(false);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("restores the sleep assertion at boot and releases it on disable and shutdown without a handoff", async () => {
  const f = await fixture(true);
  const service = openService(f.dir, f.options);
  await service.update({ preventSleep: true }).apply();
  await service.update({ preventSleep: true }).apply();
  expect(f.spawn.mock.calls).toEqual([["/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }]]);
  await service.update({ preventSleep: false }).apply();
  expect(f.children[0]!.kill).toHaveBeenCalledOnce();
  await service.update({ preventSleep: true }).apply();
  service.close();
  expect(f.children[1]!.kill).toHaveBeenCalledOnce();
  const restarted = openService(f.dir, f.options);
  expect(restarted.state()).toMatchObject({ managed: true, preventSleep: true });
  restarted.close();
  expect(f.children[2]!.kill).toHaveBeenCalledOnce();
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it("returns saved flags and current ownership and hands off to one detached helper", async () => {
  const f = await fixture();
  const web = await api(f.options);
  await web.login();
  const sent = vi.fn();
  web.server.once("request", (_req, res) => res.once("finish", sent));
  const response = await web.put({ autostart: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ supported: true, managed: false, autostart: true, keepAlive: false, preventSleep: false });
  expect(JSON.parse(await readFile(join(web.dir, "service.json"), "utf8"))).toEqual({ autostart: true, keepAlive: false, preventSleep: false });
  await expect.poll(() => f.shutdown.mock.calls.length).toBe(1);
  expect(sent).toHaveBeenCalledBefore(f.spawn);
  expect(f.spawn).toHaveBeenCalledBefore(f.shutdown);
  expect(f.children[0]!.unref).toHaveBeenCalledOnce();
  await web.put({ autostart: true });
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it("keeps serving if the helper cannot spawn and retries the pending plist reload", async () => {
  const f = await fixture(true);
  const service = openService(f.dir, f.options);
  f.spawn.mockImplementationOnce(() => {
    const child = new ChildProcess();
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  });
  await expect(service.update({ keepAlive: true }).apply()).rejects.toThrow("spawn failed");
  expect(f.shutdown).not.toHaveBeenCalled();
  await service.update({ keepAlive: true }).apply();
  expect(f.shutdown).toHaveBeenCalledOnce();
});

it("retries listening after the old process releases the port", async () => {
  const old = createServer(), replacement = createServer();
  cleanup.push(() => { old.close(); replacement.close(); });
  old.listen(0, "127.0.0.1");
  await once(old, "listening");
  const port = (old.address() as AddressInfo).port;
  const busy = once(replacement, "error");
  const ready = listen(replacement, port, "127.0.0.1");
  expect((await busy)[0]).toMatchObject({ code: "EADDRINUSE" });
  old.close();
  await ready;
  expect(replacement.address()).toMatchObject({ port });
});

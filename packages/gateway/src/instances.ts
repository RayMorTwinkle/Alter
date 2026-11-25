import { fork, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "../../server/src/gateway-trust.ts";
import { HttpError } from "../../server/src/static.ts";
import type { User } from "./accounts.ts";

export type Target = { port: number; secret: string };
export type InstanceOptions = {
  adminPort: number; secret: string; usersDir: string; env: NodeJS.ProcessEnv;
  entry?: string; backoffMs?: number;
};
type Slot = {
  status: "starting" | "running" | "backoff" | "stopping"; failures: number;
  child?: ChildProcess; ended?: Promise<void>; timer?: NodeJS.Timeout;
};

export function manageInstances(options: InstanceOptions) {
  const slots = new Map<string, Slot>();
  let closing = false;
  function target(user: User): Target {
    if (user.port === null) return { port: options.adminPort, secret: options.secret };
    return { port: user.port, secret: createHmac("sha256", options.secret).update(user.id).digest("hex") };
  }
  function launch(user: User, slot: Slot) {
    const started = Date.now();
    slot.status = "starting";
    const env = { ...options.env };
    for (const key of Object.keys(env)) {
      if (/^ALTER_(FEISHU_|MAIL_|ADMIN_|WEB_PASSWORD$)/.test(key)) env[key] = "";
    }
    Object.assign(env, { ALTER_USER_ID: user.id, ALTER_DATA_DIR: join(options.usersDir, user.id),
      ALTER_WEB_HOST: "127.0.0.1", ALTER_WEB_PORT: String(user.port), ALTER_AUTH: "gateway",
      ALTER_ROLE: "user", ALTER_GATEWAY_SECRET: target(user).secret, ALTER_BROWSER: "off" });
    const child = fork(options.entry ?? join(repoRoot, "packages/server/src/main.ts"), [], {
      execArgv: [], cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    slot.child = child;
    // Only the process we launched may declare its port ready (it might already be occupied).
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000).unref();
    child.on("message", msg => {
      if (msg === "ready" && slot.status === "starting") { slot.status = "running"; clearTimeout(timeout); }
    });
    child.on("error", error => console.error("Instance process error", user.id, error.message));
    slot.ended = new Promise(resolve => child.once("close", (code, signal) => {
      clearTimeout(timeout);
      slot.child = undefined;
      if (!closing && slot.status !== "stopping") {
        if (Date.now() - started > 60_000) slot.failures = 0;
        const wait = Math.min(60_000, (options.backoffMs ?? 500) * 2 ** Math.min(10, slot.failures++));
        slot.status = "backoff";
        console.warn("Instance exited, retrying", user.id, code ?? signal, wait);
        slot.timer = setTimeout(() => launch(user, slot), wait).unref();
      }
      resolve();
    }));
  }
  function start(user: User) {
    if (closing || user.disabled) throw new HttpError(503, "Instance unavailable");
    if (user.port === null) return;
    let slot = slots.get(user.id);
    if (!slot) {
      slot = { status: "starting", failures: 0 };
      slots.set(user.id, slot);
      launch(user, slot);
    }
    return slot;
  }
  async function stop(id: string) {
    const slot = slots.get(id);
    if (!slot) return;
    slot.status = "stopping";
    clearTimeout(slot.timer);
    if (slot.child) {
      const child = slot.child;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      try { await slot.ended; } finally { clearTimeout(force); }
    }
    if (slots.get(id) === slot) slots.delete(id);
  }
  return {
    start, stop,
    async ready(user: User) {
      const slot = start(user);
      if (slot) {
        const deadline = Date.now() + 15_000;
        while (slot.status === "starting" && Date.now() < deadline) await delay(50);
        if (slot.status !== "running") throw new HttpError(503, "Instance unavailable");
      }
      return target(user);
    },
    async info(user: User) {
      const { port, secret } = target(user);
      let status = user.port === null ? "external" : slots.get(user.id)?.status ?? "stopped";
      let rss: number | null = null;
      if (status === "running" || status === "external") {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/gateway/instance`, {
            headers: { "X-Alter-Gateway-Secret": secret }, signal: AbortSignal.timeout(1000), redirect: "error",
          });
          if (!res.ok) throw new Error("Instance unavailable");
          const data = await res.json();
          if (!Number.isSafeInteger(data.rss)) throw new Error("Missing RSS");
          rss = data.rss;
          status = "running";
        } catch { status = "unavailable"; }
      }
      return { port, status, rss, managed: user.port !== null };
    },
    async close() { closing = true; await Promise.all([...slots.keys()].map(stop)); },
  };
}
export type Instances = ReturnType<typeof manageInstances>;

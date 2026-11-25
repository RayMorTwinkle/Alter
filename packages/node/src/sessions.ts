import { listSessions as claudeSessions } from "@anthropic-ai/claude-agent-sdk";
import type { NativeSession, SessionsList, SessionsResult } from "@alter/node-protocol";
import { acpArgs, initializeAcp } from "./adapters/acp.ts";
import { dshLog, dshTitle, logTime } from "./adapters/dsh-history.ts";
import { stdioRpc } from "./adapters/rpc.ts";
import { inside, loadConfig, taskDirectory } from "./config.ts";
import type { Detected } from "./spawn.ts";

type AcpRow = Omit<NativeSession, "updatedAt"> & { updatedAt?: string };
type Thread = { id: string; cwd: string; name?: string; preview?: string; updatedAt: number };

export async function listSessions(dir: string, harnesses: Detected[], request: SessionsList, signal: AbortSignal): Promise<SessionsResult> {
  const { harness, requestId, limit = 20 } = request;
  let rpc: ReturnType<typeof stdioRpc> | undefined;
  async function list(): Promise<NativeSession[]> {
    signal.throwIfAborted();
    const agent = harnesses.find(h => h.id === harness && h.available && h.sessions);
    if (!agent?.executable) throw new Error("代理不可用或不支持列出会话");
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit 需要非负整数");
    const { roots } = loadConfig(dir);
    const cwd = request.cwd === undefined ? undefined : taskDirectory(roots, request.cwd);
    if (!roots.length || !limit) return [];
    const found = new Map<string, NativeSession>();
    const logs = new Map<string, string>();
    async function add(row: NativeSession) {
      signal.throwIfAborted();
      if (!row?.cwd || !row.sessionId || found.has(row.sessionId)) return;
      let real: string;
      try { real = taskDirectory(roots, row.cwd); } catch { return; }
      if (cwd && !(inside(cwd, real) && inside(real, cwd))) return;
      if (harness === "dsh") {
        const file = dshLog(row);
        row.updatedAt = await logTime(file);
        logs.set(row.sessionId, file);
      }
      found.set(row.sessionId, { ...row, cwd: real });
    }
    if (harness === "claude-code") {
      for (const s of await claudeSessions({ dir: cwd, includeWorktrees: false })) {
        if (s.cwd) await add({ sessionId: s.sessionId, cwd: s.cwd, title: s.customTitle || s.summary, updatedAt: s.lastModified });
      }
    } else {
      const codex = harness === "codex";
      const startDir = cwd ?? roots.find(root => {
        try { taskDirectory(roots, root); return true; } catch { return false; }
      });
      if (!startDir) return [];
      rpc = stdioRpc(agent.executable, codex ? ["app-server", "--listen", "stdio://"] : acpArgs(harness), startDir, !codex);
      if (codex) {
        await rpc.request("initialize", { clientInfo: { name: "alter-node", version: "1" }, capabilities: { experimentalApi: true } });
        rpc.notify("initialized");
      } else if (!(await initializeAcp(rpc)).sessionCapabilities?.list) throw new Error("代理不支持 session/list");
      const seen = new Set<string>();
      let cursor: string | null | undefined;
      do {
        signal.throwIfAborted();
        if (codex) {
          const page: { data: Thread[]; nextCursor?: string } = await rpc.request("thread/list", { cwd, cursor, sortKey: "updated_at", limit: 100, modelProviders: [] });
          for (const t of page.data) await add({ sessionId: t.id, cwd: t.cwd, title: t.name || t.preview, updatedAt: t.updatedAt * 1000 });
          if (found.size >= limit) break; // thread/list is ordered by updated_at descending.
          cursor = page.nextCursor;
        } else {
          const page: { sessions: AcpRow[]; nextCursor?: string } = await rpc.request("session/list", { cwd, cursor });
          for (const s of page.sessions) {
            const time = Date.parse(s.updatedAt ?? "");
            await add({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: Number.isFinite(time) ? time : undefined });
          }
          cursor = page.nextCursor;
        }
        if (cursor && seen.has(cursor)) throw new Error("代理返回重复分页游标");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    const rows = [...found.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, limit);
    for (const row of rows) {
      const log = logs.get(row.sessionId);
      if (log && row.updatedAt !== undefined) row.title = await dshTitle(log, signal);
    }
    return rows;
  }
  const result = { type: "sessions.result", requestId, harness } as const;
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(new Error(signal.reason?.name === "TimeoutError" ? "列出会话超时" : "查询已取消"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    try { return { ...result, sessions: await Promise.race([list(), aborted.promise]) }; }
    finally { signal.removeEventListener("abort", abort); await rpc?.close(); }
  } catch (err) { return { ...result, sessions: [], error: err instanceof Error ? err.message : String(err) }; }
}

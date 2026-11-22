// A contract-faithful fake of packages/server for UI work (docs/architecture/web-api.md). Password: "alter".
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LedgerEntry, PermissionRequest, Snapshot, Task, TimelineItem, TranscriptItem } from "../src/types.ts";

const port = Number(process.env.PORT ?? 4318);
const now = Date.now();
let seq = 100;
const id = () => String(++seq);

const timeline: TimelineItem[] = [
  { id: "1", kind: "user", text: "幫我看一下 welcome 這條筆記寫了什麼", at: now - 3_600_000 },
  { id: "2", kind: "assistant", text: "好的，我派一個任務去讀取 welcome 筆記。", at: now - 3_598_000, model: "opencode-go/glm-5.3" },
  { id: "3", kind: "report", taskId: "task-14", text: "task task-14 finished: 已讀取筆記「welcome」，內容為：**Remember the planning meeting.**", at: now - 3_590_000 },
  { id: "4", kind: "assistant", text: "welcome 筆記只有一句話：\n\n> Remember the planning meeting.\n\n意思是「記得規劃會議」。需要我幫你在日曆上找時間嗎？", at: now - 3_588_000, model: "opencode-go/glm-5.3" },
];
const tasks: Task[] = [{
  taskId: "task-14", brief: "讀取 welcome 筆記並回報完整內容", context: "fresh", permission: "restricted", allow: ["notes"],
  status: "completed", conversationId: "c-14", createdAt: now - 3_597_000, pending: [],
}];
const ledger: LedgerEntry[] = [{ taskId: "task-14", summary: "讀取了 welcome 筆記，內容是提醒規劃會議", refs: [{ kind: "note", ref: "welcome" }], at: now - 3_590_000 }];
const transcripts: Record<string, TranscriptItem[]> = {
  "task-14": [
    { kind: "user", text: "讀取 welcome 筆記並回報完整內容", at: now - 3_597_000 },
    { kind: "tool_call", tool: "notes_read", arguments: { id: "welcome" }, at: now - 3_596_000 },
    { kind: "tool_result", tool: "notes_read", text: "Remember the planning meeting.", isError: false, at: now - 3_595_000 },
    { kind: "tool_call", tool: "finish", arguments: { summary: "已讀取筆記「welcome」", refs: [{ kind: "note", ref: "welcome" }] }, at: now - 3_591_000 },
  ],
};
let busy = false;
const sessions = new Set<string>();
const clients = new Set<ServerResponse>();

const pending = () => tasks.flatMap(task => task.pending);
const snapshot = (): Snapshot => ({
  timeline: timeline.slice(-200), tasks, pending: pending(), ledger,
  leases: [{ capability: "calendar", idleTurns: 3, window: 30 }], busy,
});

function emit(event: string, data: unknown) {
  for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function push(item: TimelineItem) {
  timeline.push(item);
  emit("timeline", item);
}
function setBusy(value: boolean) {
  busy = value;
  emit("busy", { busy });
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function answer(text: string) {
  const reply = `收到。${text.includes("派") || text.includes("發") ? "這件事需要對外發送，我派一個 **auto** 權限的任務去做，發送前會請你確認。" : "這是一個模擬回答，用來檢查流式輸出、Markdown 和滾動。\n\n- 列表第一項\n- 列表第二項，帶 `code`\n\n更多內容見 https://example.com 。"}`;
  const answerId = id();
  setBusy(true);
  await sleep(600);
  for (let i = 1; i <= reply.length; i += 3) {
    emit("delta", { id: answerId, text: reply.slice(0, i) });
    await sleep(25);
  }
  push({ id: answerId, kind: "assistant", text: reply, at: Date.now(), model: "opencode-go/glm-5.3" });
  setBusy(false);
  if (text.includes("派") || text.includes("發")) void runTask(text);
}

async function runTask(text: string) {
  const taskId = `task-${id()}`;
  const task: Task = {
    taskId, brief: `在日曆建立週報會，並用 outbox 發邀請給老闆（來自：${text}）`, context: "fresh", permission: "auto",
    allow: [], status: "running", conversationId: `c-${taskId}`, createdAt: Date.now(), pending: [],
  };
  tasks.push(task);
  transcripts[taskId] = [
    { kind: "user", text: task.brief, at: Date.now() },
    { kind: "tool_call", tool: "calendar_create", arguments: { title: "週報會", start: "2026-11-23T15:00" }, at: Date.now() },
  ];
  emit("tasks", tasks);
  await sleep(1500);
  transcripts[taskId].push({ kind: "tool_result", tool: "calendar_create", text: "event-76", isError: false, at: Date.now() });
  const request: PermissionRequest = {
    id: `permission-${id()}`, taskId, audience: "user", capability: "outbox", tool: "outbox_send",
    arguments: { message: "老闆您好，邀請您參加明天下午三點的週報會。" }, reason: task.brief,
    expiresAt: Date.now() + 24 * 3_600_000, tainted: true, taint: { source: "mail_read", capability: "mail", at: Date.now() },
  };
  task.pending.push(request);
  push({ id: id(), kind: "permission", taskId, text: `${taskId} 需要你批准 outbox_send`, at: Date.now() });
  emit("tasks", tasks);
  emit("pending", pending());
}

async function decide(requestId: string, allow: boolean, note?: string) {
  const task = tasks.find(t => t.pending.some(p => p.id === requestId));
  if (!task) return false;
  task.pending = task.pending.filter(p => p.id !== requestId);
  emit("pending", pending());
  await sleep(800);
  task.status = allow ? "completed" : "failed";
  if (!allow) task.failure = note ?? "用戶拒絕了發送";
  const summary = allow ? "已建立週報會（event-76），並向老闆發送了會議邀請。" : `未發送：${task.failure}`;
  push({ id: id(), kind: "report", taskId: task.taskId, text: `task ${task.taskId} ${allow ? "finished" : "failed"}: ${summary}`, at: Date.now() });
  if (allow) {
    ledger.push({ taskId: task.taskId, summary, refs: [{ kind: "calendar", ref: "event-76" }, { kind: "outbox", ref: "msg-1" }], at: Date.now() });
    emit("ledger", ledger);
  }
  emit("tasks", tasks);
  return true;
}

function cookie(req: IncomingMessage) {
  return /alter_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function json(res: ServerResponse, status: number, data?: unknown) {
  res.writeHead(status, data === undefined ? {} : { "Content-Type": "application/json" });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (req.method === "POST" && req.headers["content-type"] !== "application/json") return json(res, 415, { error: "JSON required" });
  if (path === "/api/login" && req.method === "POST") {
    const { password } = await body(req);
    if (password !== "alter") return json(res, 401, { error: "bad password" });
    const token = crypto.randomUUID();
    sessions.add(token);
    res.setHeader("Set-Cookie", `alter_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return json(res, 204);
  }
  if (!sessions.has(cookie(req) ?? "")) return json(res, 401, { error: "unauthorized" });
  if (path === "/api/logout") { sessions.delete(cookie(req)!); return json(res, 204); }
  if (path === "/api/state") return json(res, 200, snapshot());
  if (path === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (path === "/api/messages" && req.method === "POST") {
    const { text } = await body(req);
    const item: TimelineItem = { id: id(), kind: "user", text, at: Date.now() };
    push(item);
    void answer(text);
    return json(res, 202, { id: item.id });
  }
  const permission = /^\/api\/permissions\/(.+)$/.exec(path);
  if (permission && req.method === "POST") {
    const { allow, note } = await body(req);
    return (await decide(decodeURIComponent(permission[1]!), allow, note)) ? json(res, 204) : json(res, 409, { error: "not pending" });
  }
  const transcript = /^\/api\/tasks\/(.+)\/transcript$/.exec(path);
  if (transcript) return json(res, 200, { items: transcripts[decodeURIComponent(transcript[1]!)] ?? [] });
  if (path === "/api/stop") { setBusy(false); return json(res, 204); }
  if (path === "/api/usage") {
    return json(res, 200, [
      { model: "opencode-go/glm-5.3", calls: 12, failureRate: "0.0%", aborted: 1, fallbacks: 0, inputTokens: 9508, outputTokens: 1290, p50Ms: 1825, p95Ms: 4430 },
      { model: "opencode-go/deepseek-v4.1-flash", calls: 13, failureRate: "0.0%", aborted: 0, fallbacks: 0, inputTokens: 16658, outputTokens: 4352, p50Ms: 3395, p95Ms: 5756 },
    ]);
  }
  json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${port}`));

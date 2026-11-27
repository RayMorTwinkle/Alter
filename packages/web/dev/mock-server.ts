// A contract-faithful fake of packages/server for UI work (docs/architecture/web-api.md). Password: "alter".
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgendaEvent, LedgerEntry, PermissionRequest, Snapshot, Task, TimelineItem, TranscriptItem, Notification } from "../src/types.ts";

const port = Number(process.env.PORT ?? 4318);
const now = Date.now();
const notifications: Notification[] = [
  { id: "n1", at: now - 600_000, kind: "reminder", level: "now", title: "提醒：交實驗報告", body: "操作系統實驗三，今晚 23:59 截止", source: "schedule", status: "unread" },
  { id: "n2", at: now - 86_400_000, kind: "reminder", level: "digest", title: "提醒：給王老師回郵件", source: "schedule", status: "read", feedback: "useful" },
];
const memory = [
  { id: "1", kind: "goal", text: "12 月中旬的操作系统期末考试", due: now + 21 * 86_400_000, status: "active", createdAt: now - 86_400_000, updatedAt: now - 86_400_000 },
  { id: "2", kind: "goal", text: "投完 3 家后端实习", due: now - 2 * 86_400_000, status: "pending", createdAt: now - 9 * 86_400_000, updatedAt: now - 2 * 86_400_000 },
  { id: "3", kind: "profile", text: "回覆偏好繁體中文，簡潔、先給結論", status: "active", createdAt: now - 5 * 86_400_000, updatedAt: now - 5 * 86_400_000 },
  { id: "4", kind: "fact", text: "導師是王老師，郵箱在通訊錄裡", status: "active", createdAt: now - 3 * 86_400_000, updatedAt: now - 3 * 86_400_000 },
];
let seq = 100;
const id = () => String(++seq);

const timeline: TimelineItem[] = [
  { id: "1", kind: "user", text: "幫我看一下 welcome 這條筆記寫了什麼", at: now - 3_600_000, source: "feishu" },
  { id: "2", kind: "tool", tool: "dispatch_task", args: '{"brief":"整理筆記"}', text: "", isError: true, errorDetail: 'Invalid arguments for tool "dispatch_task": missing required arguments "context" and "permission" when creating a new task without "continue_from" or "runner"', at: now - 3_599_000 },
  { id: "2b", kind: "assistant", text: "好的，我派一個任務去讀取 welcome 筆記。", at: now - 3_598_000, model: "opencode-go/glm-5.3" },
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
const hour = 3_600_000;
// Local midnight in Asia/Shanghai, which has no daylight saving.
const midnight = Math.floor((now + 8 * hour) / (24 * hour)) * 24 * hour - 8 * hour;
const at = (day: number, h: number) => midnight + day * 24 * hour + h * hour;
const events: AgendaEvent[] = [
  { id: "evt_1", title: "和導師討論開題", start: now - hour / 2, end: now + hour / 2, allDay: false, location: "主樓 302" },
  { id: "evt_2", title: "健身", start: at(0, 21), end: at(0, 22), allDay: false },
  { id: "evt_3", title: "週報會", start: at(1, 15), end: at(1, 16), allDay: false, location: "A 會議室", notes: "帶上本週評測結果：租約 vs 全派任務" },
  { id: "evt_4", title: "團建", start: at(2, 0), end: at(3, 0), allDay: true },
  { id: "evt_5", title: "夜間部署窗口", start: at(2, 23), end: at(3, 1), allDay: false },
  { id: "evt_6", title: "面試：後端開發", start: at(4, 10), end: at(4, 11), allDay: false, location: "線上" },
];
const agenda = () => ({ timeZone: "Asia/Shanghai", events: events.filter(e => e.end > midnight && e.start < at(7, 0)).sort((a, b) => a.start - b.start) });
let busy = false;
const sessions = new Set<string>();
const clients = new Set<ServerResponse>();

const pending = () => tasks.flatMap(task => task.pending);
const snapshot = (): Snapshot => ({
  timeline: timeline.slice(-200), tasks, pending: pending(), ledger,
  watches: [
    { id: "watch-33", brief: "老闆在組群裡派任務時提醒我", where: { channel: "feishu", chatId: "研發組" }, createdAt: now - 1_800_000, until: now + 3 * 3_600_000, keywords: ["任務", "今晚"], thinking: "low", status: "running", wakes: 2 },
    { id: "watch-21", brief: "王老師的郵件到了就告訴我", where: { channel: "mail" }, createdAt: now - 5 * 3_600_000, until: now - 3 * 3_600_000, keywords: [], thinking: "low", status: "completed", wakes: 1 },
  ],
  schedules: [
    { id: "scheduled-29", brief: "整理當天日程：彙總今日事項的時間、地點與注意事項並通知用戶", trigger: { kind: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] }, action: "task", createdAt: now - 3_600_000, nextAt: now + 20 * 3_600_000, paused: false },
    { id: "scheduled-35", brief: "提醒用戶早點休息", trigger: { kind: "daily", time: "22:30" }, action: "wake", createdAt: now - 3_600_000, nextAt: now + 12 * 3_600_000, paused: false },
    { id: "scheduled-41", brief: "會前把資料整理成一頁", trigger: { kind: "event", eventId: "e1", offsetMinutes: -30, anchor: "start" }, action: "task", continue_from: "task-14", createdAt: now - 3_600_000, nextAt: now + 26 * 3_600_000, paused: false },
    { id: "scheduled-44", brief: "看看 GitHub 上新的 issue", trigger: { kind: "every", minutes: 120 }, action: "task", createdAt: now - 3_600_000, nextAt: null, paused: true },
  ],
  notifications, leases: [{ capability: "calendar", idleTurns: 3, window: 30 }], busy,
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
    expiresAt: Date.now() + 24 * 3_600_000, defaultAt: Date.now() + 60_000,
    statement: [
      { tool: "calendar_create", target: "本地日曆", purpose: "按郵件建立明天 15:00 的週報會", isNew: false },
      { tool: "outbox_send", target: "老闆（boss@example.com）", purpose: "發送週報會邀請", isNew: true },
    ],
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
    events.push({ id: "evt_76", title: "規劃會議", start: at(3, 14), end: at(3, 15), allDay: false, location: "B 會議室" });
    emit("calendar", agenda());
  }
  emit("tasks", tasks);
  return true;
}

function cookie(req: IncomingMessage) {
  return /alter_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}
const mockPlugins = [
  { id: "feishu", name: "飛書", enabled: true,
    provides: { channels: ["機器人"], capabilities: ["讀寫消息", "日曆"], sources: ["他人發給你的消息"] },
    settings: [
      { key: "appId", label: "App ID", type: "text", required: true, help: "開放平台 → 憑證與基礎信息" },
      { key: "appSecret", label: "App Secret", type: "secret", required: true, help: "只保存在本機，加密存儲" },
      { key: "domain", label: "版本", type: "select", required: false, help: "", options: ["feishu", "lark"] },
    ],
    values: { appId: "cli_a8f2c1d3e4b5", appSecret: { set: true }, domain: "feishu" },
    status: { state: "ok", checks: [
      { id: "credentials", label: "憑證有效", ok: true }, { id: "socket", label: "長連接已連上", ok: true },
      { id: "paired", label: "機器人已配對", ok: true }, { id: "account", label: "用戶賬號已授權", ok: false, detail: "授權已過期，請重新授權" },
    ] } },
  { id: "mail", name: "郵件", enabled: true,
    provides: { channels: [], capabilities: ["讀郵件", "發郵件"], sources: ["新郵件"] },
    settings: [
      { key: "address", label: "郵箱地址", type: "text", required: true, help: "" },
      { key: "password", label: "授權碼", type: "secret", required: true, help: "不是登錄密碼，在郵箱設置裡開啟 IMAP 後生成" },
    ],
    values: { address: "", password: { set: false } }, status: { state: "needs-config", detail: "還沒填郵箱地址和授權碼" } },
  { id: "browser", name: "瀏覽器", enabled: false, provides: { channels: [], capabilities: ["打開網頁", "填寫與點擊"], sources: [] },
    settings: [], values: {}, status: { state: "off" } },
  { id: "calendar", name: "本地日曆", enabled: true, provides: { channels: [], capabilities: ["讀寫日程"], sources: [] },
    settings: [], values: {}, status: { state: "ok" } },
];

function mockStats(range: string) {
  const usage = (calls: number, input: number, cacheRead: number, output: number, cost: number | null) => ({
    calls, input, cacheRead, cacheWrite: 0, output, tokens: input + cacheRead + output,
    cacheHitRate: cacheRead / (input + cacheRead), costUsd: cost, errors: 0, aborted: 0, fallbacks: 1, retries: 2,
  });
  const days = range === "day" ? 1 : range === "7d" ? 7 : 30;
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(now - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const k = 1 + ((i * 7) % 5);
    return { date, usage: usage(20 * k, 9000 * k, 30000 * k, 1800 * k, 0.04 * k), tasks: k, succeeded: k - (i % 3 === 0 ? 1 : 0), wakes: 3 * k };
  });
  return {
    silent: 0,
    range, timeZone: "Asia/Shanghai", at: Date.now(), total: usage(612, 284_000, 1_020_000, 61_000, 1.32),
    leases: { count: 2, byTool: { calendar_list: 2 }, dispatchAfterLeaseRate: 0.5, items: [] },
    byRole: [
      { role: "main", ...usage(210, 120_000, 640_000, 22_000, 0.6) }, { role: "task", ...usage(330, 150_000, 370_000, 36_000, 0.66) },
      { role: "judge", ...usage(52, 9000, 6000, 1800, 0.03) }, { role: "triage", ...usage(20, 5000, 4000, 1200, 0.03) },
    ],
    byModel: [{ model: "deepseek-v4.1-flash", ...usage(560, 260_000, 990_000, 57_000, 1.2) }, { model: "glm-5.1-air", ...usage(52, 24_000, 30_000, 4000, 0.12) }],
    tasks: { count: 23, completed: 20, terminal: 22, successRate: 20 / 22, items: tasks.map(task => ({
      taskId: task.taskId, status: task.status, createdAt: task.createdAt, continuedFrom: null, wakeId: null, thinking: "high",
      models: ["deepseek-v4.1-flash"], usage: usage(14, 6000, 21000, 900, 0.03), usageSource: "ledger", durationMs: 48_000, rounds: 7,
      tools: { browser_open: 2 }, approvals: [], result: null,
    })) },
    wakes: { count: 71, bySource: { "user-web": 30, "user-feishu": 18, report: 19, schedule: 4 }, items: [] },
    approvals: { decisions: { park: 1, allow: 14, deny: 2 }, pending: [], byApprover: [{ approver: "user", count: 12 }, { approver: "judge", count: 4 }, { approver: "timeout", count: 1 }], timeouts: 1, modelAllowed: 4, askedUser: 13, userApproved: 10, userDenied: 2 },
    funnel: { days: [], precision: null }, watchWakeAccuracy: null,
    latency: { firstToken: { samples: 210, p50Ms: 1400, p95Ms: 3900 }, total: { samples: 210, p50Ms: 9800, p95Ms: 31000 } },
    topTasks: [], daily,
  };
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
  if (path === "/gateway/me") return json(res, 404, { error: "no gateway" });
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
    const { decision, note } = await body(req);
    return (await decide(decodeURIComponent(permission[1]!), decision !== "deny", note)) ? json(res, 204) : json(res, 409, { error: "not pending" });
  }
  const transcript = /^\/api\/tasks\/(.+)\/transcript$/.exec(path);
  if (transcript) return json(res, 200, { items: transcripts[decodeURIComponent(transcript[1]!)] ?? [] });
  if (path === "/api/stop") { setBusy(false); return json(res, 204); }
  if (path === "/api/calendar") return json(res, 200, agenda());
  if (path.startsWith("/api/funnel")) return json(res, 200, { timeZone: "Asia/Shanghai", precision: 0.75,
    days: [{ date: "2026-11-21", triggered: 18, passed: 9, pushed: 2, read: 2, useful: 2, useless: 0, digests: 1, reminders: 1 },
      { date: "2026-11-22", triggered: 23, passed: 12, pushed: 3, read: 2, useful: 1, useless: 1, digests: 1, reminders: 2 }] });
  if (path === "/api/memory") {
    const entries = memory.map(m => ({ id: m.id, title: m.text.slice(0, 18), type: m.kind === "profile" ? "user" : m.kind === "fact" ? "reference" : m.kind,
      body: m.text, source: "web", ...(m.due !== undefined && { dueAt: m.due }), status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt }));
    return json(res, 200, url.searchParams.get("memory") === "entries" ? { index: "", entries, needsConsolidation: false } : memory);
  }
  const notice = /^\/api\/notifications\/(.+)$/.exec(path);
  if (notice) {
    const item = notifications.find(n => n.id === decodeURIComponent(notice[1]!));
    if (!item) return json(res, 404, { error: "Unknown notification" });
    Object.assign(item, await body(req));
    emit("notifications", notifications);
    return json(res, 204);
  }
  const memoryItem = /^\/api\/memory\/(.+)$/.exec(path);
  if (memoryItem) {
    const index = memory.findIndex(item => item.id === decodeURIComponent(memoryItem[1]!));
    if (index < 0) return json(res, 404, { error: "Unknown memory" });
    if (req.method === "DELETE") memory.splice(index, 1);
    else Object.assign(memory[index]!, await body(req), { updatedAt: Date.now() });
    emit("memory", memory);
    return json(res, 204);
  }
  if (path === "/api/feishu") return json(res, 200, { paired: false, code: "482915", expiresAt: Date.now() + 600_000, account: { connected: false } });
  if (path === "/api/plugins") return json(res, 200, mockPlugins);
  if (path.startsWith("/api/plugins/feishu/guide")) return json(res, 200, {
    permissionsJson: JSON.stringify({ scopes: { tenant: ["im:message", "im:message:send_as_bot", "im:chat:readonly"], user: ["im:message:readonly", "calendar:calendar"] } }),
    redirectUri: "http://127.0.0.1:4317/api/feishu/oauth/callback", eventsMode: "long-connection",
    steps: ["在飛書開放平台創建企業自建應用，開啟機器人能力", "權限管理中批量導入下面的權限 JSON", "事件訂閱選擇「長連接」，添加接收消息事件", "安全設置中添加下面的回調地址", "把 App ID 和 App Secret 填到下面並保存", "在飛書裡給機器人發配對碼，再授權你的賬號"],
  });
  if (path.startsWith("/api/plugins/")) return json(res, 200, mockPlugins.find(p => path.includes(p.id)));
  if (path === "/api/settings") return json(res, 200, { compactAtTokens: 128000, approvalModel: "on", heartbeat: { enabled: true, start: "08:00", end: "23:00" } });
  if (path === "/api/service") return json(res, 200, { supported: false, autostart: false, keepAlive: false, preventSleep: false, managed: false, restrictedCapabilities: ["browser", "adapters", "ext-plugins", "cli", "feishu", "service"] });
  if (path === "/api/nodes") return json(res, 200, [
    { id: "node-mac", name: "MacBook Pro", platform: "darwin", online: true, createdAt: now - 86_400_000, lastSeen: now,
      roots: ["/Users/Ray/Documents"], harnesses: [{ id: "codex", version: "0.166.0", available: true }],
      adapters: [{ id: "github", name: "GitHub", kind: "mcp", capabilityId: "node-github-demo", enabled: true, state: "ok",
        tools: [{ name: "list_issues", description: "列出倉庫 Issue", effect: "read", defaultEffect: "read" }], effects: {} }] },
    { id: "node-win", name: "宿舍台式", platform: "win32", online: false, createdAt: now - 172_800_000, lastSeen: now - 7_200_000,
      roots: [], harnesses: [] },
  ]);
  if (path === "/api/nodes/adapter-presets") return json(res, 200, []);
  if (path === "/api/nodes/node-mac/adapters") return json(res, 200, { online: true, adapters: [
    { id: "github", name: "GitHub", kind: "mcp", capabilityId: "node-github-demo", enabled: true, state: "ok",
      tools: [{ name: "list_issues", description: "列出倉庫 Issue", effect: "read", defaultEffect: "read" }], effects: {} },
  ] });
  if (path === "/api/models") return json(res, 200, []);
  if (path === "/api/settings/always-allowed") return json(res, 200, { capabilities: [] });
  if (path === "/api/sources") return json(res, 200, []);
  if (path === "/api/sources/templates") return json(res, 200, []);
  if (path === "/api/ext-plugins") return json(res, 200, []);
  if (path === "/api/approvals/stats") return json(res, 200, { modelAllowed: 4, askedUser: 13, userApproved: 10, userDenied: 2 });
  if (path.startsWith("/api/watches/")) return json(res, 204);
  if (path.startsWith("/api/schedules/")) return json(res, 204);
  if (path === "/api/heartbeat") {
    const h = 3_600_000;
    const counts = (d: number) => ({ goals: 2, memories: 6, chat: 4, agenda: 1, tasks: 0, digests: d });
    return json(res, 200, {
      enabled: true, nextAt: Date.now() + 3.2 * h, intervalMs: 4.4 * h, adoption: 0.62,
      report: { intervalDays: 1, activeDays: 5, time: "22:00", nextAt: Date.now() + 5 * h, paused: false },
      signals: { dueGoals: 2, backlog: 5, userMessages24h: 9 },
      runs: [
        { id: "hb-4", at: Date.now() - 1.3 * h, finishedAt: Date.now() - 1.28 * h, status: "ran", skipReason: null, counts: counts(5),
          actions: [{ tool: "notify", id: "n-31", level: "digest" }, { tool: "dispatch_task", id: "task-171" }], notified: true,
          finalReply: "看到你這週要投 3 家後端實習，還差 2 家；派了一個任務去整理本週新開的實習崗位，並把一場週六的黑客松放進摘要。", tokens: 8421, feedback: "useful" },
        { id: "hb-3", at: Date.now() - 5.6 * h, finishedAt: Date.now() - 5.59 * h, status: "ran", skipReason: null, counts: counts(1),
          actions: [], notified: false, finalReply: "郵件只有兩封廣告，目標和日程都沒有變化，暫時不打擾。", tokens: 3120, feedback: null },
        { id: "hb-2", at: Date.now() - 9 * h, finishedAt: Date.now() - 9 * h, status: "skipped", skipReason: "recent-activity", counts: counts(0), actions: [], notified: false, finalReply: "", tokens: 0, feedback: null },
        { id: "hb-1", at: Date.now() - 26 * h, finishedAt: Date.now() - 26 * h, status: "skipped", skipReason: "outside-hours", counts: counts(0), actions: [], notified: false, finalReply: "", tokens: 0, feedback: null },
      ],
    });
  }
  if (path === "/api/heartbeat/run") return json(res, 409, { error: "主會話正忙", id: "hb-5" });
  if (path === "/api/stats") return json(res, 200, mockStats(url.searchParams.get("range") ?? "7d"));
  if (path === "/api/usage") {
    return json(res, 200, [
      { model: "opencode-go/glm-5.3", calls: 12, failureRate: "0.0%", aborted: 1, fallbacks: 0, inputTokens: 9508, outputTokens: 1290, p50Ms: 1825, p95Ms: 4430 },
      { model: "opencode-go/deepseek-v4.1-flash", calls: 13, failureRate: "0.0%", aborted: 0, fallbacks: 0, inputTokens: 16658, outputTokens: 4352, p50Ms: 3395, p95Ms: 5756 },
    ]);
  }
  json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${port}`));

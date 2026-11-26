import { join } from "node:path";
import { createInterface } from "node:readline";
import { contentText } from "@earendil-works/pi-ai";
import { answerUserPermission } from "./broker.ts";
import { gatewayConfig, loadRepoEnv } from "./config.ts";
import { openAlter } from "./main.ts";
import { createGatewayModels } from "./models.ts";
import { context, openNodeSqliteStorage } from "./runtime.ts";
import { observeSurface, type PermissionRequest, type AlterApp } from "./observe.ts";
import { submitMessage, type TimelineItem } from "./timeline.ts";
import { Tasks } from "./state.ts";

export async function observeChat(app: AlterApp, print: (text: string) => void) {
  let shown = new Set<string>();
  function permissions(requests: PermissionRequest[]) {
    const pending = requests.filter(req => req.audience === "user");
    for (const req of pending) {
      if (!shown.has(req.id)) print(`[用户审批] ${req.id} · ${req.taskId} · ${req.tool} ${JSON.stringify(req.arguments)}\n原因：${req.reason}\n/approve ${req.id} 或 /deny ${req.id}`);
    }
    shown = new Set(pending.map(req => req.id));
  }
  function show(item: TimelineItem) {
    if (item.kind === "notice" && item.id.endsWith("-error")) print(item.text);
    else if (["report", "permission", "notice"].includes(item.kind) && !item.id.startsWith("approval-")) print(`[回投] ${item.text}`);
  }
  let seenMessages: Set<string> | undefined;
  const observer = await observeSurface(app, event => {
    if (event.event === "notifications") {
      const messages = event.data.filter(n => n.kind === "message" && (n.channel === undefined || n.channel === "cli"));
      for (const n of messages.toReversed()) if (seenMessages && !seenMessages.has(n.id)) print(`Alter> ${n.body}`);
      seenMessages = new Set(messages.map(n => n.id));
    }
    if (event.event === "timeline") show(event.data);
    if (event.event === "pending") permissions(event.data);
  });
  return observer.detach;
}

export async function chatCommand({ main, harness }: AlterApp, line: string, print: (text: string) => void) {
  if (line === "/tasks") {
    const tasks = await harness.snapshot(Tasks, main.id, context);
    print(JSON.stringify(tasks?.byId ?? {}, null, 2));
  } else if (/^\/(approve|deny)(?:\s|$)/.test(line)) {
    const [command, requestId, ...note] = line.split(/\s+/);
    if (!requestId) { print(`用法：${command} <id> [note]`); return; }
    const answer = await answerUserPermission(main, { requestId, decision: command === "/approve" ? "once" : "deny", note: note.join(" ") || undefined });
    print(contentText(answer.output));
  } else if (line) {
    await submitMessage(main, line, "cli");
  }
}

async function chat() {
  loadRepoEnv();
  const config = gatewayConfig();
  const { models, mainModel, taskModel, thinking } = await createGatewayModels(config);
  const storage = await openNodeSqliteStorage(join(config.dataDir, "main.sqlite"));
  const app = await openAlter(storage, models, mainModel, taskModel, thinking, { approvalTimeoutMs: config.approvalTimeoutMs, timeZone: config.timeZone });
  try {
    const detach = await observeChat(app, console.log);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      app.harness.resume();
      console.log("Alter 已就绪。输入消息，或使用 /tasks、/approve <id>、/deny <id>、/quit。");
      for await (const line of rl) {
        if (line.trim() === "/quit") break;
        try { await chatCommand(app, line.trim(), console.log); }
        catch (error) { console.error(error instanceof Error ? error.message : error); }
      }
    } finally {
      rl.close();
      detach();
    }
  } finally {
    await app.close();
  }
}

if (import.meta.main) await chat();

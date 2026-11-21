import { join } from "node:path";
import { createInterface } from "node:readline";
import { contentText } from "@earendil-works/pi-ai";
import { answerUserPermission, Requests, type PermissionState } from "./broker.ts";
import { gatewayConfig, loadRepoEnv } from "./config.ts";
import { openAlter } from "./main.ts";
import { createGatewayModels } from "./models.ts";
import { context, InboxDoc, openNodeSqliteStorage, type InboxState } from "./runtime.ts";
import { Tasks } from "./state.ts";

type App = Awaited<ReturnType<typeof openAlter>>;
const cliEntry = "alter.cli-input";

export async function observeChat({ harness, main }: App, print: (text: string) => void) {
  // Attach before resume, including documents not yet created in an older database.
  await main.commit(async tx => {
    await tx.doc(Requests, main.id);
    await tx.doc(InboxDoc, main.id);
  }, context);
  const queued = new Set<number>();
  function showInbox({ items }: InboxState) {
    for (const item of items) {
      if (item.mode === "write" || item.entry?.kind === cliEntry || queued.has(item.id)) continue;
      print(`[回投] ${contentText(item.content)}`);
      queued.add(item.id);
    }
  }
  const inbox = await harness.observeDoc(InboxDoc, main.id, {
    advance(call) { if (call.kind === "value") showInbox(call.value); }, end() {},
  }, context);
  showInbox(inbox!.value);

  let shown = new Set<string>();
  function showPermissions(requests: PermissionState) {
    const pending = Object.values(requests.pending).filter(req => req.audience === "user");
    for (const req of pending) {
      if (!shown.has(req.id)) print(`[用户审批] ${req.id} · ${req.taskId} · ${req.tool} ${req.argumentsJson}\n原因：${req.reason}\n/approve ${req.id} 或 /deny ${req.id}`);
    }
    shown = new Set(pending.map(req => req.id));
  }
  const permissions = await harness.observeDoc(Requests, main.id, {
    advance(call) { if (call.kind === "value") showPermissions(call.value); }, end() {},
  }, context);
  showPermissions(permissions!.value);

  const commits = harness.observeCommits({
    advance({ changes }) {
      const alreadyShown = new Set<number>();
      for (const change of changes) {
        if (change.type !== "submission" || change.value.conversationId !== main.id) continue;
        const submission = change.value;
        if (submission.status !== "queued" && queued.delete(submission.id) && submission.entry !== undefined) {
          alreadyShown.add(submission.entry);
        }
      }
      for (const change of changes) {
        if (change.type !== "entry" || change.value.conversationId !== main.id) continue;
        const entry = change.value;
        for (const msg of entry.model ?? []) {
          if (msg.role === "user" && entry.kind !== cliEntry && !alreadyShown.has(entry.id)) print(`[回投] ${contentText(msg.content)}`);
          if (msg.role !== "assistant") continue;
          const text = contentText(msg.content);
          if (text) print(`Alter> ${text}`);
          if (msg.errorMessage) print(`[模型错误] ${msg.model} · ${msg.errorMessage}`);
        }
      }
    }, end() {},
  });
  return () => { inbox!.detach(); permissions!.detach(); commits.detach(); };
}

export async function chatCommand({ main, harness }: App, line: string, print: (text: string) => void) {
  if (line === "/tasks") {
    const tasks = await harness.snapshot(Tasks, main.id, context);
    print(JSON.stringify(tasks?.byId ?? {}, null, 2));
  } else if (/^\/(approve|deny)(?:\s|$)/.test(line)) {
    const [command, requestId, ...note] = line.split(/\s+/);
    if (!requestId) { print(`用法：${command} <id> [note]`); return; }
    const answer = await answerUserPermission(main, { requestId, allow: command === "/approve", note: note.join(" ") || undefined });
    print(contentText(answer.output));
  } else if (line) {
    await main.submit({ type: "input", content: line, whenBusy: "followUp", entry: { kind: cliEntry } }, context);
  }
}

async function chat() {
  loadRepoEnv();
  const config = gatewayConfig();
  const { models, mainModel, taskModel, thinking } = await createGatewayModels(config);
  const storage = await openNodeSqliteStorage(join(config.dataDir, "main.sqlite"));
  const app = await openAlter(storage, models, mainModel, taskModel, thinking);
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
    await app.harness.close(context);
  }
}

if (import.meta.main) await chat();

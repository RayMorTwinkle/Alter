// A deterministic model script drives the same submissions, tools and ledger as the app.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, observeSurface, openAlter, openNodeSqliteStorage, readTranscript, submitMessage, Tasks, type AlterApp } from "@alter/core";

const prompt = "Read the welcome note and tell me what it says.";
const brief = "Read note welcome, then report back with its reference.";
const note = "Remember the planning meeting.";
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  say(fauxToolCall(name, args), { stopReason: "toolUse" });

function scriptedModels() {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 16 }, () => ({ messages }) => {
    const last = messages.findLast(message => message.role !== "system");
    assert.ok(last, "expected a user input or tool result");
    const text = contentText(last.content);
    if (last.role === "user" && text.endsWith(prompt))
      return call("dispatch_task", { brief, context: "fresh", permission: "restricted" });
    if (last.role === "user" && text.endsWith(brief)) return call("notes_read", { id: "welcome" });
    if (last.role === "toolResult" && last.toolName === "notes_read") {
      assert.ok(!last.isError, "note lookup failed");
      return call("finish", { summary: text, refs: [{ kind: "note", ref: "welcome" }] });
    }
    // A quick worker can report in this same turn, or wake the main session later.
    const report = messages.find(message => message.role === "user" && contentText(message.content).includes("finished: " + note));
    return say(report ? note : "Waiting for the note.");
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

async function run(app: AlterApp) {
  const replies = new EventEmitter();
  const observer = await observeSurface(app, event => {
    if (event.event === "timeline" && event.data.kind === "message" && event.data.text === note) replies.emit("reply");
  });
  try {
    app.harness.resume();
    await Promise.all([
      once(replies, "reply", { signal: AbortSignal.timeout(15_000) }),
      submitMessage(app.main, prompt, "cli", "demo-read-welcome"),
    ]);
    const { tasks, ledger, pending } = observer.snapshot();
    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.ok(task && task.context === "fresh" && task.permission === "restricted" && task.status === "completed");
    const records = await app.harness.snapshot(Tasks, app.main.id, context);
    const record = records?.byId[task.taskId];
    assert.ok(record);
    const worker = await app.harness.conversation(record.conversationId, context);
    assert.ok(worker);
    const transcript = await readTranscript(worker);
    const result = transcript.find(item => item.kind === "tool_result" && item.tool === "notes_read");
    assert.ok(result?.kind === "tool_result" && !result.isError && result.text === note);
    assert.equal(ledger.length, 1);
    const [entry] = ledger;
    assert.ok(entry && entry.taskId === task.taskId && entry.summary === note);
    assert.deepEqual(entry.refs, [{ kind: "note", ref: "welcome" }]);
    assert.equal(pending.length, 0);
    console.log([
      "Alter | Offline demo · scripted model · temporary SQLite",
      "Surface    " + prompt,
      "Main       dispatch_task → " + task.context + " / " + task.permission,
      "Worker     " + result.tool + " → " + result.text,
      "Ledger     " + entry.refs[0]!.kind + "/" + entry.refs[0]!.ref + " → " + entry.summary,
      "Reply      " + note,
      "PASS       Completed task, reference and main-session reply verified.",
    ].join("\n"));
  } finally {
    observer.detach();
  }
}

// This CLI runs in its own process. An existing production setup must not
// change its schedule, approval defaults or database location.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ALTER_")) delete process.env[key];
}
process.env.ALTER_HEARTBEAT = "off";
const fixtureTime = Date.UTC(2026, 10, 26, 12);
const directory = await mkdtemp(join(tmpdir(), "alter-demo-"));
try {
  const storage = await openNodeSqliteStorage(join(directory, "main.sqlite"));
  let app: AlterApp | undefined;
  try {
    app = await openAlter(storage, scriptedModels(), { provider: "faux", modelId: "faux-1" },
      undefined, {}, { demos: true, timeZone: "UTC", now: () => fixtureTime });
    await run(app);
  } finally {
    if (app) await app.close();
    else await storage.close(context);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

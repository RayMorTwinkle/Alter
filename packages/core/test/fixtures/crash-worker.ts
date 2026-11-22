// Launched with IPC. The parent kills this process only after SQLite records the sleeping tool.
import { setTimeout as delay } from "node:timers/promises";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Requests } from "../../src/broker.ts";
import { openAlter } from "../../src/main.ts";
import { context, openNodeSqliteStorage } from "../../src/runtime.ts";

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 8 }, () => ({ messages }) => {
  const last = messages.findLast(message => message.role !== "system")!;
  if (last.role !== "user") return say("OK");
  const tool = contentText(last.content) === "delegate"
    ? fauxToolCall("dispatch_task", { brief: "send after recovery", context: "fresh", permission: "auto" })
    : fauxToolCall("outbox_send", { message: "recovered" });
  return say(tool, { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const app = await openAlter(await openNodeSqliteStorage(process.argv[2]!), models, { provider: "faux", modelId: "faux-1" });
await app.main.submit({ type: "input", content: "delegate" }, context);
await app.main.waitForIdle(context);
for (;;) {
  const state = await app.harness.snapshot(Requests, app.main.id, context);
  const pending = Object.values(state?.pending ?? {})[0];
  if (pending && (await app.harness.getTask(pending.toolTask, context))?.state.status === "sleeping") {
    process.channel!.ref();
    process.send!(pending.id);
    break;
  }
  await delay(5);
}

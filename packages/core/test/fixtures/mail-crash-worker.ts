// The parent kills this process after the fake SMTP server has accepted the mail,
// while mail_send is still awaiting the SMTP acknowledgement.
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createMailPlugin } from "../../../plugin-mail/src/index.ts";
import { config, fakeMail, outgoing } from "../../../plugin-mail/test/fake.ts";
import { context, openAlter, openNodeSqliteStorage } from "../../src/index.ts";

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 8 }, () => ({ messages }) => {
  const last = messages.findLast(message => message.role !== "system")!;
  if (last.role !== "user") return say("OK");
  const call = contentText(last.content) === "delegate"
    ? fauxToolCall("dispatch_task", { brief: "send", permission: "full", context: "fresh", allow: [] })
    : fauxToolCall("mail_send", outgoing);
  return say(call, { stopReason: "toolUse" });
}));
const mail = fakeMail();
mail.clients.smtp.mockImplementation(async (_config, _to, raw) => {
  process.channel!.ref();
  process.send!(raw.toString("base64"));
  await new Promise<void>(() => {});
});
const models = createModels();
models.setProvider(faux.provider);
const app = await openAlter(await openNodeSqliteStorage(process.argv[2]!), models, { provider: "faux", modelId: "faux-1" },
  undefined, {}, { plugins: [createMailPlugin(config, mail.clients)] });
await app.main.submit({ type: "input", content: "delegate" }, context);

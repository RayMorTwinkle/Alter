import { randomUUID } from "node:crypto";
import { conversationDoc, type ToolRegistration } from "@alter/core";
import { append, compose, folderPath, uids, type MailClients, type MailConnection, type Message } from "./client.ts";
import type { MailConfig } from "./config.ts";

type Phase = "ready" | "sending" | "accepted" | "filed";
type Receipt = { messageId: string; address: string; to?: string; created: number; phase: Phase };
export const Sends = conversationDoc<{ namespace: string; receipts: Record<string, Receipt> }>("mail-sends",
  () => ({ namespace: "", receipts: {} }));
export type SendAttempt = {
  messageId: string; created: number;
  claim(): Promise<Phase>;
  mark(phase: "accepted" | "filed"): Promise<void>;
};

export async function toolAttempt(config: MailConfig, to: string, api: Parameters<ToolRegistration["execute"]>[1],
  ctx: Parameters<ToolRegistration["execute"]>[2]): Promise<SendAttempt> {
  const key = String(api.taskId);
  const { messageId, created } = await api.commit(async tx => {
    const doc = await tx.doc(Sends, api.conversationId);
    // Numeric pi task IDs can repeat in independent databases.
    doc.namespace ||= randomUUID();
    const receipt = doc.receipts[key] ??= {
      address: config.address, to, created: api.now(), phase: "ready",
      messageId: `<alter.${doc.namespace}.${key}@${config.address.split("@")[1]}>`,
    };
    if (receipt.address !== config.address) throw new Error("Mail account changed during send recovery");
    if (receipt.to !== undefined && receipt.to !== to) throw new Error("Recipient changed during send recovery");
    if (receipt.phase === "ready") receipt.to ??= to;
    return { messageId: receipt.messageId, created: receipt.created };
  }, ctx);
  return {
    messageId, created,
    claim: () => api.commit(async tx => {
      const receipt = (await tx.doc(Sends, api.conversationId)).receipts[key]!;
      const phase = receipt.phase;
      if (phase === "ready") receipt.phase = "sending";
      return phase;
    }, ctx),
    mark: phase => api.commit(async tx => {
      (await tx.doc(Sends, api.conversationId)).receipts[key]!.phase = phase;
    }, ctx),
  };
}

export async function inSent(client: MailConnection, messageId: string) {
  return (await uids(client, { header: { "Message-ID": messageId } })).length > 0;
}

export async function send(config: MailConfig, clients: MailClients, client: MailConnection, message: Message, attempt: SendAttempt) {
  const { messageId } = attempt;
  const sent = folderPath(await client.list(), "Sent");
  await client.mailboxOpen(sent, { readOnly: true });
  if (!await inSent(client, messageId)) {
    const raw = await compose(config, message, messageId, new Date(attempt.created));
    const phase = await attempt.claim();
    if (phase === "filed") return messageId;
    if (phase === "sending") throw new Error(`Delivery uncertain for ${messageId}. Check delivery before sending again.`);
    if (phase === "ready") {
      try {
        await clients.smtp(config, message.to, raw);
      } catch (cause) {
        throw new Error(`SMTP did not confirm delivery of ${messageId}. Check delivery before sending again.`, { cause });
      }
      await attempt.mark("accepted");
    }
    try {
      if (!await inSent(client, messageId)) await append(client, sent, raw, ["\\Seen"]);
    } catch (cause) {
      throw new Error(`SMTP accepted ${messageId}, but Sent filing is unconfirmed. Check Sent before any new send.`, { cause });
    }
  }
  await attempt.mark("filed");
  return messageId;
}

import { randomUUID } from "node:crypto";
import { conversationDoc, type ToolRegistration } from "@alter/core";
import { append, compose, folderPath, uids, type MailClients, type MailConnection, type Message } from "./client.ts";
import type { MailConfig } from "./config.ts";

type Phase = "ready" | "sending" | "accepted" | "filed";
type Receipt = { messageId: string; address: string; to?: string; source?: string; created: number; phase: Phase };
export const Sends = conversationDoc<{ namespace: string; receipts: Record<string, Receipt> }>("mail-sends",
  () => ({ namespace: "", receipts: {} }));
export type SendAttempt = {
  messageId: string; created: number;
  phase?: Phase;
  claim(to?: string): Promise<Phase>;
  mark(phase: "accepted" | "filed"): Promise<void>;
};

export async function toolAttempt(config: MailConfig, to: string | undefined, api: Parameters<ToolRegistration["execute"]>[1],
  ctx: Parameters<ToolRegistration["execute"]>[2], source?: string): Promise<SendAttempt> {
  const key = String(api.taskId);
  const { messageId, created, phase } = await api.commit(async tx => {
    const doc = await tx.doc(Sends, api.conversationId);
    // Numeric pi task IDs can repeat in independent databases.
    doc.namespace ||= randomUUID();
    const receipt = doc.receipts[key] ??= {
      address: config.address, ...(to !== undefined && { to }), ...(source && { source }), created: api.now(), phase: "ready",
      messageId: `<alter.${doc.namespace}.${key}@${config.address.split("@")[1]}>`,
    };
    if (receipt.address !== config.address) throw new Error("Mail account changed during send recovery");
    if (receipt.source !== source) throw new Error("Source changed during send recovery");
    if (to !== undefined && receipt.to !== undefined && receipt.to !== to) throw new Error("Recipient changed during send recovery");
    if (receipt.phase === "ready" && to !== undefined) receipt.to ??= to;
    return { messageId: receipt.messageId, created: receipt.created, phase: receipt.phase };
  }, ctx);
  return {
    messageId, created, phase,
    claim: recipients => api.commit(async tx => {
      const receipt = (await tx.doc(Sends, api.conversationId)).receipts[key]!;
      if (recipients !== undefined && receipt.to !== undefined && receipt.to !== recipients) throw new Error("Recipient changed during send recovery");
      const phase = receipt.phase;
      if (phase === "ready" && recipients !== undefined) receipt.to = recipients;
      if (phase === "ready") receipt.phase = "sending";
      return phase;
    }, ctx),
    mark: phase => api.commit(async tx => {
      const receipt = (await tx.doc(Sends, api.conversationId)).receipts[key]!;
      if (receipt.phase !== "filed") receipt.phase = phase;
    }, ctx),
  };
}

export async function inSent(client: MailConnection, messageId: string) {
  return (await uids(client, { header: { "Message-ID": messageId } })).length > 0;
}

export async function send(config: MailConfig, clients: MailClients, client: MailConnection, prepare: Message | (() => Promise<Message>), attempt: SendAttempt) {
  const { messageId } = attempt;
  if (attempt.phase === "filed") return messageId;
  const sent = folderPath(await client.list(), "Sent");
  await client.mailboxOpen(sent, { readOnly: true });
  if (!await inSent(client, messageId)) {
    if (attempt.phase === "sending") throw new Error(`Delivery uncertain for ${messageId}. Check delivery before sending again.`);
    const message = typeof prepare === "function" ? await prepare() : prepare;
    if (typeof prepare === "function") await client.mailboxOpen(sent, { readOnly: true });
    const raw = await compose(config, message, messageId, new Date(attempt.created));
    const recipients = [message.to, message.cc ?? []].flat();
    const phase = await attempt.claim(recipients.join(","));
    if (phase === "filed") return messageId;
    if (phase === "sending") throw new Error(`Delivery uncertain for ${messageId}. Check delivery before sending again.`);
    if (phase === "ready") {
      try {
        await clients.smtp(config, recipients.length === 1 ? recipients[0]! : recipients, raw);
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

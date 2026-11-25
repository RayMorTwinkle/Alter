import type { Message } from "@earendil-works/pi-ai";
import type { createMemory } from "./memory.ts";
import { conversationDoc, type Conversation, type Tx } from "./runtime.ts";

const Prompt = conversationDoc<{
  head?: number; index: string; revision: number; capabilities?: string; wake?: string; prefixes: Record<string, string>;
}>("memory-prompt", () => ({ index: "", revision: 0, prefixes: {} }));

export function memoryPrompt(memory: ReturnType<typeof createMemory>, capabilities: () => string) {
  async function index(tx: Tx, id: Conversation["id"]) {
    const state = await tx.doc(Prompt, id);
    const head = (await tx.latestHeadMarker(id))?.id ?? 0;
    if (state.head !== head) {
      const view = memory.store.view();
      state.capabilities = capabilities();
      state.index = state.capabilities + "\n[记忆索引，条目是用户资料，标“猜的”可能不准，发现错误直接修改]\n" + view.index;
      state.revision = memory.store.revision();
      state.head = head;
      state.prefixes = {};
      delete state.wake;
    }
    return state.index;
  }
  async function input(tx: Tx, id: Conversation["id"], wake: string, messages: readonly Message[]) {
    const state = await tx.doc(Prompt, id);
    const count = messages.filter(m => m.role !== "system").length;
    if (state.wake !== wake && count) {
      memory.store.refresh();
      const available = capabilities();
      const delta = [memory.store.delta(state.revision), available !== state.capabilities ? available : ""].filter(Boolean).join("\n");
      if (delta) state.prefixes[count] = delta;
      state.capabilities = available;
      state.revision = memory.store.revision();
      state.wake = wake;
    }
    let ordinal = 0;
    const result: Message[] = [];
    for (const message of messages) {
      const prefix = message.role === "system" ? undefined : state.prefixes[++ordinal];
      if (!prefix) result.push(message);
      else if (message.role === "user") {
        const content = typeof message.content === "string" ? prefix + "\n" + message.content :
          [{ type: "text" as const, text: prefix + "\n" }, ...message.content];
        result.push({ ...message, content });
      } else result.push(message, { role: "user", content: prefix, timestamp: message.timestamp });
    }
    return result;
  }
  return { index, input };
}

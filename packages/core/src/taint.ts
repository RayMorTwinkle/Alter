import { conversationDoc, type Context, type ConversationId, type ToolExecutionApi, type ToolExecutionResult, type Tx } from "./runtime.ts";

export type TaintSource = { source: string; capability: string; at: number };
type TaintState = { first?: TaintSource; seen?: string[] };
export const Taint = conversationDoc<TaintState>("taint", () => ({}));

export async function isTainted(api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) {
  return !!(await api.snapshot(Taint, api.conversationId, ctx))?.first;
}

const entities: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'" };
const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimUrl(match: string) {
  let end = match.length;
  const excess = new Map<string, number>();
  while (end) {
    const last = match[end - 1]!;
    const open = opening[last];
    if (open) {
      // Keep balanced path parentheses and IPv6 brackets when stripping surrounding prose.
      const count = excess.get(last) ?? match.split(last).length - match.split(open).length;
      if (count <= 0) break;
      excess.set(last, count - 1);
    } else if (!".,!?;:".includes(last)) break;
    end--;
  }
  return match.slice(0, end);
}

// "http://host" and "http://host/" are the same page; the browser reports the latter.
export const normalUrl = (value: string) => URL.canParse(value) ? new URL(value).href : undefined;

export function recordUntrusted(state: TaintState, source: TaintSource, output: ToolExecutionResult["output"]) {
  state.first ??= source;
  const seen = new Set(state.seen);
  for (const part of output ?? []) {
    if (part.type !== "text") continue;
    const text = part.text.replace(/&(?:amp|quot|lt|gt|#39);/g, entity => entities[entity]!);
    for (const [match, attribute] of text.matchAll(/\burl="(https?:\/\/[^\s"<>\\]+)"|https?:\/\/[^\s<>"'\\`，。！？；：、（）【】“”‘’]+/gi)) {
      const url = normalUrl(attribute ?? trimUrl(match));
      if (!url) continue;
      seen.delete(url);
      seen.add(url);
      if (seen.size > 500) seen.delete(seen.values().next().value!);
    }
  }
  if (seen.size) state.seen = [...seen];
}

export async function inheritTaint(tx: Tx, from: ConversationId, to: ConversationId) {
  const { first } = await tx.doc(Taint, from);
  if (first) (await tx.doc(Taint, to)).first ??= { ...first };
}

export function isUntrusted(details: unknown) {
  return typeof details === "object" && details !== null && "untrusted" in details && details.untrusted === true;
}

export async function markPluginTaint(api: ToolExecutionApi, ctx: Context, capability: string, name: string) {
  await api.commit(async tx => {
    recordUntrusted(await tx.doc(Taint,api.conversationId),{capability,source:name,at:api.now()},[]);
  },ctx);
}

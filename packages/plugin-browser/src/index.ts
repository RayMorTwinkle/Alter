import { context, conversationDoc, defineTool, reply, schema, type AlterPlugin, type ToolRegistration } from "@alter/core";
import { actions, clip, createSpace, finishSpace, runEgo, view, type EgoRunner } from "./ego.ts";

export type { EgoRunner } from "./ego.ts";

const { obj, oneOf, str } = schema;
const target = str({ pattern: "^(@[0-9]+|text=[\\s\\S]+)$", description: "A viewport snapshot ref (@21) or text=..." });
const Space = conversationDoc<{ id: number | null }>("browser-space", () => ({ id: null }));
type Execute = ToolRegistration["execute"];
type Api = Pick<Parameters<Execute>[1], "conversationId" | "commit">;
type Ctx = Parameters<Execute>[2];

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function createBrowserPlugin({ runner = runEgo, snapshotLimit = 12_000 }: {
  runner?: EgoRunner; snapshotLimit?: number;
} = {}): AlterPlugin {
  if (!Number.isSafeInteger(snapshotLimit) || snapshotLimit < 0) throw new Error("Invalid snapshotLimit");
  const opened = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  let stopping = false;

  function external(text: string, url = "", isError = false) {
    const attr = escape(clip(url, snapshotLimit)).replaceAll('"', "&quot;");
    const body = escape(clip(text, snapshotLimit));
    return { ...reply(`<external source="browser" url="${attr}">${body}</external>`, isError),
      details: { untrusted: true, source: "browser" } };
  }

  async function serial<T>(name: string, fn: () => Promise<T>) {
    if (stopping) throw new Error("Browser plugin is stopping");
    const work = (pending.get(name) ?? Promise.resolve()).then(fn, fn);
    pending.set(name, work);
    try { return await work; }
    finally { if (pending.get(name) === work) pending.delete(name); }
  }

  async function operate(api: Api, ctx: Ctx, build?: () => string) {
    const name = `Alter ${api.conversationId}`;
    const save = (id: number | null) => api.commit(async tx => { (await tx.doc(Space, api.conversationId)).id = id; }, ctx);
    try {
      return await serial(name, async () => {
        const action = build?.();
        const stored = await api.commit(async tx => (await tx.doc(Space, api.conversationId)).id, ctx);
        let id = opened.get(name) ?? stored;
        let result = null;
        if (id !== null) {
          opened.set(name, id);
          result = await view(runner, name, id, action ?? "", snapshotLimit, action === undefined);
        }
        if (action === undefined) {
          if (stored !== null) await save(null);
          opened.delete(name);
          return result ? external(result.text, result.url, result.isError) : external("Space already closed");
        }
        if (!result) {
          id = await createSpace(runner, name);
          opened.set(name, id);
          await save(id);
          result = await view(runner, name, id, action, snapshotLimit);
          if (!result) throw new Error("New browser space disappeared");
        } else if (id !== stored) {
          await save(id);
        }
        return external(result.text, result.url, result.isError);
      });
    } catch (error) {
      return external(String(error), "", true);
    }
  }

  return {
    capability: { id: "browser", mainLeasable: false, actions: [
      { name: "open", effect: "read", guarded: true, seenArg: "url" }, { name: "snapshot", effect: "read" }, { name: "scroll", effect: "read" },
      { name: "click", effect: "write-local" }, { name: "fill", effect: "external-send" },
      { name: "press", effect: "external-send" }, { name: "close", effect: "write-local" },
    ] },
    tools: [
      defineTool({ name: "browser_open", description: "Navigate p1 to an HTTP(S) URL and read the viewport.", parameters: obj({ url: str() }),
        execute: ({ url }, api, ctx) => operate(api, ctx, () => actions.open(url)) }),
      defineTool({ name: "browser_snapshot", description: "Read the current viewport and element refs.", parameters: obj({}), replay: "safe",
        execute: (_, api, ctx) => operate(api, ctx, () => "") }),
      defineTool({ name: "browser_scroll", description: "Scroll one viewport.", parameters: obj({ direction: oneOf(["up", "down"]) }),
        execute: ({ direction }, api, ctx) => operate(api, ctx, () => actions.scroll(direction)) }),
      defineTool({ name: "browser_click", description: "Click a visible element.", parameters: obj({ target }),
        execute: ({ target }, api, ctx) => operate(api, ctx, () => actions.click(target)) }),
      defineTool({ name: "browser_fill", description: "Fill a page input.", parameters: obj({ target, text: str() }),
        execute: ({ target, text }, api, ctx) => operate(api, ctx, () => actions.fill(target, text)) }),
      defineTool({ name: "browser_press", description: "Press a key in the focused element.", parameters: obj({ key: str({ minLength: 1 }) }),
        execute: ({ key }, api, ctx) => operate(api, ctx, () => actions.press(key)) }),
      defineTool({ name: "browser_close", description: "Return the last viewport and close this task's space.", parameters: obj({}), replay: "safe",
        execute: (_, api, ctx) => operate(api, ctx) }),
    ],
    async onTaskEnd(conversation) {
      const name = `Alter ${conversation.id}`;
      await serial(name, async () => {
        const id = opened.get(name) ?? await conversation.commit(async tx => (await tx.doc(Space, conversation.id)).id, context);
        if (id === null) return;
        opened.set(name, id);
        await finishSpace(runner, name, id);
        await conversation.commit(async tx => { (await tx.doc(Space, conversation.id)).id = null; }, context);
        opened.delete(name);
      });
    },
    async start() {
      stopping = false;
      return async () => {
        stopping = true;
        await Promise.allSettled(pending.values());
        await Promise.allSettled([...opened].map(async ([name, id]) => {
          await finishSpace(runner, name, id);
          opened.delete(name);
        }));
      };
    },
  };
}

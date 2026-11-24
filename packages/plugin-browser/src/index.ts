import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, conversationDoc, defineTool, reply, schema, type AlterPlugin, type ToolRegistration } from "@alter/core";
import { actions, clip, createSpace, describePage, finishSpace, readGuide, runEgo, view, type EgoRunner } from "./ego.ts";

export type { EgoRunner } from "./ego.ts";

const { int, obj, oneOf, opt, str } = schema;
const target = str({ pattern: "^(@[0-9]+|text=[\\s\\S]+)$", description: "A viewport snapshot ref (@21) or text=..." });
const Space = conversationDoc<{ id: number | null; selected?: string }>("browser-space", () => ({ id: null }));
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

  async function operate(api: Api, ctx: Ctx, build?: () => string, options: { timeoutMs?: number; handoffTimeoutMs?: number } = {}) {
    const name = `Alter ${api.conversationId}`;
    const save = (id: number | null, selected = "p1") => api.commit(async tx => {
      Object.assign(await tx.doc(Space, api.conversationId), { id, selected });
    }, ctx);
    try {
      return await serial(name, async () => {
        const action = build?.();
        let { id: stored, selected = "p1" } = await api.commit(async tx => ({ ...await tx.doc(Space, api.conversationId) }), ctx);
        let id = opened.get(name) ?? stored;
        let result = null;
        if (id !== null) {
          opened.set(name, id);
          result = await view(runner, name, id, action ?? "", snapshotLimit, {
            close: action === undefined, label: selected, ...options, signal: ctx.abortSignal,
          });
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
          stored = id;
          selected = "p1";
          result = await view(runner, name, id, action, snapshotLimit, { ...options, signal: ctx.abortSignal });
          if (!result) throw new Error("New browser space disappeared");
        }
        if (id !== stored || selected !== result.selected) {
          await save(id, result.selected);
        }
        return external(result.text, result.url, result.isError);
      });
    } catch (error) {
      return external(String(error), "", true);
    }
  }

  async function screenshot(api: Api, ctx: Ctx) {
    const dir = await mkdtemp(join(tmpdir(), "alter-browser-"));
    try {
      const path = join(dir, "viewport.png");
      const result = await operate(api, ctx, () => actions.screenshot(path));
      if (result.isError) return result;
      const data = await readFile(path, "base64");
      return { ...result, output: [...result.output, { type: "image" as const, mimeType: "image/png", data }] };
    } catch (error) {
      return external(String(error), "", true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    capability: { id: "browser", mainLeasable: true, actions: [
      { name: "open", effect: "read" }, { name: "snapshot", effect: "read" }, { name: "scroll", effect: "read" },
      { name: "click", effect: "write" }, { name: "fill", effect: "write" },
      { name: "press", effect: "write" }, { name: "close", effect: "read" },
      { name: "screenshot", effect: "read" }, { name: "handoff", effect: "read" },
      { name: "run", effect: "write" }, { name: "guide", effect: "read" },
    ] },
    async describe({ tool, arguments: args }, state) {
      const name = `Alter ${state.conversationId}`;
      return serial(name, async () => {
        const space = await state.snapshot(Space);
        const id = opened.get(name) ?? space?.id;
        if (id == null) return;
        const target = (tool === "browser_fill" || tool === "browser_click") && typeof args.target === "string" ? args.target : undefined;
        return describePage(runner, name, id, target, tool === "browser_press", space?.selected);
      });
    },
    tools: [
      defineTool({ name: "browser_open", description: "Navigate the selected tab to an HTTP(S) URL and read the viewport.", parameters: obj({ url: str() }),
        execute: ({ url }, api, ctx) => operate(api, ctx, () => actions.open(url)) }),
      defineTool({ name: "browser_snapshot", description: "Read text and element refs in the current viewport before choosing a target. Use screenshot for visual layout.", parameters: obj({}), replay: "safe",
        execute: (_, api, ctx) => operate(api, ctx, () => "") }),
      defineTool({ name: "browser_scroll", description: "Move up or down one viewport and read the newly visible content and refs.", parameters: obj({ direction: oneOf(["up", "down"]) }),
        execute: ({ direction }, api, ctx) => operate(api, ctx, () => actions.scroll(direction)) }),
      defineTool({ name: "browser_click", description: "Activate a visible link or control using its snapshot ref or text.", parameters: obj({ target }),
        execute: ({ target }, api, ctx) => operate(api, ctx, () => actions.click(target)) }),
      defineTool({ name: "browser_fill", description: "Set a text input by ref or text. Use press to send a key to the focused element.", parameters: obj({ target, text: str() }),
        execute: ({ target, text }, api, ctx) => operate(api, ctx, () => actions.fill(target, text)) }),
      defineTool({ name: "browser_press", description: "Send a key or shortcut to the focused element, for example Enter to submit a form.", parameters: obj({ key: str({ minLength: 1 }) }),
        execute: ({ key }, api, ctx) => operate(api, ctx, () => actions.press(key)) }),
      defineTool({ name: "browser_close", description: "Finish the task’s browser space and return the last viewport.", parameters: obj({}), replay: "safe",
        execute: (_, api, ctx) => operate(api, ctx) }),
      defineTool({ name: "browser_screenshot", description: "Return a viewport PNG to inspect canvas, layout or other visual content. Use snapshot for element refs.",
        parameters: obj({}), replay: "safe", execute: (_, api, ctx) => screenshot(api, ctx) }),
      defineTool({ name: "browser_handoff", description: "Give the user browser control for login, CAPTCHA or another manual step. Wait until the user returns control. Default timeout is five minutes.",
        parameters: obj({ timeoutMs: opt(int({ minimum: 1, maximum: 1800000 })) }),
        execute: ({ timeoutMs = 300000 }, api, ctx) => operate(api, ctx, () => actions.handoff(timeoutMs), { handoffTimeoutMs: timeoutMs }) }),
      defineTool({ name: "browser_run", description: "Call browser_guide first for the API. Run an async Node.js script with task (current space) and page (selected tab) for multi-tab work, downloads, uploads, iframes, page JS, in-page fetch or condition waits. Return a JSON value or use console.log.",
        parameters: obj({ script: str(), timeoutMs: opt(int({ minimum: 1, maximum: 600_000 })) }),
        execute: ({ script, timeoutMs = 120_000 }, api, ctx) => operate(api, ctx, () => actions.run(script), { timeoutMs }) }),
      defineTool({ name: "browser_guide", description: "Read the installed ego-browser API guide before using browser_run.",
        parameters: obj({}), replay: "safe", execute: async () => {
          try { return reply(await readGuide(runner)); }
          catch (error) { return reply(String(error), true); }
        } }),
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

export { browserDescription, browserInstance } from "./settings.ts";

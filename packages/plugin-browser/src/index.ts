import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { context, conversationDoc, defineTool, reply, schema, type AlterPlugin, type ToolRegistration } from "@alter/core";
import { actions, clip, createSpace, describePage, finishSpace, runEgo, view, type EgoRunner } from "./ego.ts";

export type { EgoRunner } from "./ego.ts";

const { arr, int, lit, obj, oneOf, opt, str, union } = schema;
const nonempty = str({ minLength: 1 });
const condition = union([
  obj({ kind: lit("selector"), selector: nonempty }),
  obj({ kind: lit("function"), expression: nonempty }),
  obj({ kind: lit("networkidle") }),
]);
const option = union([str(), obj({ value: str() }), obj({ label: str() }), obj({ index: int({ minimum: 0 }) })]);
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

  async function operate(api: Api, ctx: Ctx, build?: () => string, timeoutMs?: number) {
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
            close: action === undefined, label: selected, timeoutMs, signal: ctx.abortSignal,
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
          result = await view(runner, name, id, action, snapshotLimit, { timeoutMs, signal: ctx.abortSignal });
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
      { name: "open", effect: "read", guarded: true, seenArg: "url" }, { name: "snapshot", effect: "read" }, { name: "scroll", effect: "read" },
      { name: "click", effect: "write-local" }, { name: "fill", effect: "external-send" },
      { name: "press", effect: "external-send" }, { name: "close", effect: "read" },
      { name: "eval", effect: "external-send" }, { name: "fetch", effect: "external-send" },
      { name: "screenshot", effect: "read" }, { name: "wait", effect: "external-send" }, { name: "handoff", effect: "write-local" },
      { name: "select", effect: "external-send" }, { name: "upload", effect: "external-send" }, { name: "dialog", effect: "external-send" },
      { name: "tabs", effect: "read" }, { name: "switch", effect: "read" }, { name: "adopt", effect: "write-local" },
      { name: "back", effect: "write-local" }, { name: "forward", effect: "write-local" },
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
      defineTool({ name: "browser_open", description: "Navigate the selected tab to an HTTP(S) URL and read the viewport. Use fetch for an API response without navigation.", parameters: obj({ url: str() }),
        execute: ({ url }, api, ctx) => operate(api, ctx, () => actions.open(url)) }),
      defineTool({ name: "browser_snapshot", description: "Read text and element refs in the current viewport before choosing a target. Use screenshot for visual layout.", parameters: obj({}), replay: "safe",
        execute: (_, api, ctx) => operate(api, ctx, () => "") }),
      defineTool({ name: "browser_scroll", description: "Move up or down one viewport and read the newly visible content and refs.", parameters: obj({ direction: oneOf(["up", "down"]) }),
        execute: ({ direction }, api, ctx) => operate(api, ctx, () => actions.scroll(direction)) }),
      defineTool({ name: "browser_click", description: "Activate a visible link or control using its snapshot ref or text. Use select for a native dropdown.", parameters: obj({ target }),
        execute: ({ target }, api, ctx) => operate(api, ctx, () => actions.click(target)) }),
      defineTool({ name: "browser_fill", description: "Set a text input by ref or text. Use press to send a key to the focused element.", parameters: obj({ target, text: str() }),
        execute: ({ target, text }, api, ctx) => operate(api, ctx, () => actions.fill(target, text)) }),
      defineTool({ name: "browser_press", description: "Send a key or shortcut to the focused element, for example Enter to submit a form.", parameters: obj({ key: str({ minLength: 1 }) }),
        execute: ({ key }, api, ctx) => operate(api, ctx, () => actions.press(key)) }),
      defineTool({ name: "browser_close", description: "Finish the task’s browser space and return the last viewport. Use switch to continue in another managed tab.", parameters: obj({}), replay: "safe",
        execute: (_, api, ctx) => operate(api, ctx) }),
      defineTool({ name: "browser_eval", description: "Run a JavaScript expression in the selected page and return its JSON value. Use for DOM data a snapshot cannot express.",
        parameters: obj({ expression: nonempty }), execute: ({ expression }, api, ctx) => operate(api, ctx, () => actions.eval(expression)) }),
      defineTool({ name: "browser_fetch", description: "Request an API from the selected page, using its session and CORS rules. Returns status, headers and body without navigating.",
        parameters: obj({ url: nonempty, method: opt(nonempty), headers: opt(schema.map(str())), body: opt(str()),
          credentials: opt(oneOf(["omit", "same-origin", "include"])) }),
        execute: ({ url, method, headers, body, credentials }, api, ctx) => operate(api, ctx, () => actions.fetch(url, { method, headers, body, credentials })) }),
      defineTool({ name: "browser_screenshot", description: "Return a viewport PNG to inspect canvas, layout or other visual content. Use snapshot for element refs.",
        parameters: obj({}), replay: "safe", execute: (_, api, ctx) => screenshot(api, ctx) }),
      defineTool({ name: "browser_wait", description: "Wait for a visible selector, a truthy page JavaScript expression, or network idle, then read the viewport. Use when a change is asynchronous.",
        parameters: obj({ condition, timeoutMs: opt(int({ minimum: 1, maximum: 60000 })) }),
        execute: ({ condition, timeoutMs = 10000 }, api, ctx) => operate(api, ctx, () => actions.wait(condition, timeoutMs)) }),
      defineTool({ name: "browser_handoff", description: "Give the user browser control for login, CAPTCHA or another manual step. Wait until the user returns control. Default timeout is five minutes.",
        parameters: obj({ timeoutMs: opt(int({ minimum: 1, maximum: 1800000 })) }),
        execute: ({ timeoutMs = 300000 }, api, ctx) => operate(api, ctx, () => actions.handoff(timeoutMs), timeoutMs + 90000) }),
      defineTool({ name: "browser_select", description: "Choose options in a native select by value, visible label or zero-based index. An array selects multiple options and [] clears the selection.",
        parameters: obj({ target: nonempty, options: union([option, arr(option)]) }),
        execute: ({ target, options }, api, ctx) => operate(api, ctx, () => actions.select(target, options)) }),
      defineTool({ name: "browser_upload", description: "Attach local files to an existing file input by selector or ref. The page may upload them immediately.",
        parameters: obj({ target: nonempty, paths: arr(nonempty, { minItems: 1 }) }),
        execute: ({ target, paths }, api, ctx) => operate(api, ctx, () => {
          if (!paths.every(path => isAbsolute(path))) throw new Error("Expected absolute file paths");
          return actions.upload(target, paths);
        }) }),
      defineTool({ name: "browser_dialog", description: "Inspect or resolve a pending JavaScript alert, confirm or prompt. Supply promptText when accepting a prompt. Use click for dialogs rendered in the DOM.",
        parameters: obj({ action: oneOf(["inspect", "accept", "dismiss"]), promptText: opt(str()) }),
        execute: ({ action, promptText }, api, ctx) => operate(api, ctx, () => actions.dialog(action, promptText)) }),
      defineTool({ name: "browser_tabs", description: "List managed and unmanaged tabs in this task space with labels, target IDs and the selected page. Use before switching or adopting.",
        parameters: obj({}), replay: "safe", execute: (_, api, ctx) => operate(api, ctx, () => actions.tabs) }),
      defineTool({ name: "browser_switch", description: "Select an already managed tab by its browser_tabs label for subsequent tools and read its viewport.",
        parameters: obj({ label: nonempty }), execute: ({ label }, api, ctx) => operate(api, ctx, () => actions.switch(label)) }),
      defineTool({ name: "browser_adopt", description: "Take control of an existing unmanaged tab in this task space using its browser_tabs targetId and select it for subsequent tools.",
        parameters: obj({ targetId: nonempty }), execute: ({ targetId }, api, ctx) => operate(api, ctx, () => actions.adopt(targetId)) }),
      defineTool({ name: "browser_back", description: "Navigate one entry back in the selected tab's history and read the viewport.",
        parameters: obj({}), execute: (_, api, ctx) => operate(api, ctx, () => actions.back) }),
      defineTool({ name: "browser_forward", description: "Navigate one entry forward after going back in the selected tab and read the viewport.",
        parameters: obj({}), execute: (_, api, ctx) => operate(api, ctx, () => actions.forward) }),
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

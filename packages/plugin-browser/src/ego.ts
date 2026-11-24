import { spawn } from "node:child_process";

type RunOptions = { timeoutMs?: number; signal?: AbortSignal; command?: "nodejs" | "skill" };
export type EgoRunner = (script: string, options?: RunOptions) => Promise<string>;

// When spawned, ego-browser forwards the script's console output on stderr, so both streams carry frames.
const outputLimit = 4 * 1024 * 1024;
export const runEgo: EgoRunner = (script, { timeoutMs = 90_000, signal, command = "nodejs" } = {}) => new Promise((resolve, reject) => {
  const child = spawn("ego-browser", [command], { stdio: "pipe", signal });
  let stdout = "";
  let stderr = "";
  const collect = (buffer: string, chunk: string) => command === "skill" ? buffer + chunk : (buffer + chunk).slice(-outputLimit);
  let stdinError: Error | undefined;
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`ego-browser timed out after ${timeoutMs / 1000} seconds`));
  }, timeoutMs);
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout = collect(stdout, chunk); });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = collect(stderr, chunk); });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`ego-browser exited (${signal ?? code}): ${stderr.trim().slice(-2048)}`));
    else if (stdinError) reject(stdinError);
    else resolve(stdout && stderr ? stdout + "\n" + stderr : stdout || stderr);
  });
  child.stdin.on("error", error => { stdinError = error; });
  child.stdin.end(script);
});

const guides = new WeakMap<EgoRunner, Promise<string>>();
export function readGuide(runner: EgoRunner) {
  const cached = guides.get(runner);
  if (cached) return cached;
  const guide = runner("", { command: "skill" }).then(output => {
    if (!output.trim()) throw new Error("ego-browser skill returned an empty guide");
    return "在 Alter 中，task 是当前任务空间，page 是当前选中的标签页，两者均已就绪。\n"
      + "任务空间由插件管理，请勿自行创建或结束任务空间，也不要调用 finish。\n" + output;
  }).catch(error => {
    guides.delete(runner);
    throw error;
  });
  guides.set(runner, guide);
  return guide;
}

// The CLI can also print notices. Only our single-line JSON frame carries page data.
const prelude = 'const report = value => console.log("ALTER_BROWSER " + JSON.stringify(value));';
async function run(runner: EgoRunner, script: string, options?: RunOptions) {
  const stdout = await runner(prelude + "\n" + script, options);
  const frame = stdout.split("\n").findLast(line => line.startsWith("ALTER_BROWSER "));
  if (!frame) throw new Error("Missing ego-browser response");
  return JSON.parse(frame.slice("ALTER_BROWSER ".length));
}

const controlError = "浏览器控制权在用户手里，请等用户归还或告诉用户；重新 enable_tool 不能解决";

function existingSpace(id: number, name: string, cleanup = false) {
  return `await (async () => {
    const entry = (await listTaskSpaces()).find(s => s.id === ${JSON.stringify(id)} && s.name === ${JSON.stringify(name)});
    if (!entry) return null;
    if (entry.ownership === "user" || entry.ownership === "agentDelegatedToUser") {
      ${cleanup ? "return null;" : `try { return await takeOverTaskSpace(entry.id); } catch { throw new Error(${JSON.stringify(controlError)}); }`}
    }
    return taskSpace(entry.id);
  })()`;
}

export async function createSpace(runner: EgoRunner, name: string): Promise<number> {
  const id = await run(runner, `const task = await taskSpace(${JSON.stringify(name)});\nreport(task.spaceId);`);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid ego-browser space ID");
  return id;
}

const literal = JSON.stringify;

export const actions = {
  open(url: string) {
    const parsed = URL.parse(url);
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) throw new Error("Expected an HTTP or HTTPS URL");
    return `await page.goto(${literal(parsed.href)}); await page.waitForLoadState();`;
  },
  scroll(direction: "up" | "down") {
    return `await page.evaluate(d => window.scrollBy(0, (d === "up" ? -1 : 1) * window.innerHeight), ${literal(direction)});`;
  },
  click: (target: string) => `receipt = await page.click(${literal(target)});`,
  fill: (target: string, text: string) => `receipt = await page.fill(${literal(target)}, ${literal(text)});`,
  press: (key: string) => `receipt = await page.keyboard.press(${literal(key)});`,
  screenshot: (path: string) => `await page.screenshot({ path: ${literal(path)} }); return "Viewport screenshot";`,
  handoff: (timeout: number) => `
    await task.handOff();
    if (await task.waitForControl({ timeout: ${literal(timeout)} }) === false) throw new Error("Timed out waiting for user control");
    return "User returned control";`,
  run(script: string) {
    if (/taskSpace\s*\(|listTaskSpaces|claimTaskSpace|takeOverTaskSpace|\.\s*finish\s*\(/.test(script)) {
      throw new Error("任务空间由插件管理，请使用已有的 task 和 page，不要创建、接管或结束空间。");
    }
    return `
      const { format } = await import("node:util");
      let logs;
      // The ego runtime freezes console, so the script gets a local one.
      const scriptConsole = Object.defineProperty(Object.create(console), "log", { value: (...args) => {
        if (logs === undefined) logs = clip(format(...args));
        else if (logs.length <= limit) logs = clip(logs + "\\n" + format(...args));
      } });
      const value = await (async console => {\n${script}\n})(scriptConsole);
      return [JSON.stringify(value), logs].filter(part => part !== undefined).join("\\n");`
  },
};

export type View = { text: string; url: string; isError: boolean; selected: string };
export function clip(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit) + "… [truncated]" : text;
}

export async function view(runner: EgoRunner, name: string, id: number, action: string, limit: number,
  { close = false, label = "p1", handoffTimeoutMs, ...options }: RunOptions & { close?: boolean; label?: string; handoffTimeoutMs?: number } = {}): Promise<View | null> {
  const script = `
const task = ${existingSpace(id, name)};
if (!task) {
  report(null);
} else {
  const limit = ${literal(limit)};
  const clip = text => text.length > limit ? text.slice(0, limit) + "… [truncated]" : text;
  const selected = ${literal(label)};
  let url = "", text = "", isError = false, receipt;
  try {
    const page = task.page(selected);
    const output = await (async () => { ${action} })();
    const observed = receipt?.dialog ? JSON.stringify({ dialog: receipt.dialog }) : undefined;
    text = clip(output ?? observed ?? await page.snapshot());
    try { url = clip(await page.url()); } catch {}
  } catch (error) {
    isError = true;
    text = clip(String(error));
  }
  ${close ? "await task.finish({ keep: [] });" : ""}
  report({ url, text, isError, selected });
}`;
  let result;
  try {
    result = await run(runner, script, handoffTimeoutMs === undefined ? options : { ...options, timeoutMs: handoffTimeoutMs + 90_000 });
  } finally {
    // A timed-out CLI process cannot reclaim the space from inside its script.
    if (handoffTimeoutMs !== undefined && result !== null && result?.isError !== false) {
      await run(runner, `const task = ${existingSpace(id, name)}; report(Boolean(task));`);
    }
  }
  if (result === null) return null;
  if (typeof result?.text !== "string" || typeof result.url !== "string" || typeof result.isError !== "boolean" || typeof result.selected !== "string") {
    throw new Error("Invalid ego-browser page response");
  }
  return result;
}

export async function finishSpace(runner: EgoRunner, name: string, id: number) {
  await run(runner, `const task = ${existingSpace(id, name, true)};
if (task) await task.finish({ keep: [] });
report(true);`);
}

function elementAttributes({ selector, focused }: { selector: string; focused: boolean }) {
  let element: Element | null = null;
  if (focused) {
    element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  } else {
    const roots: (Document | ShadowRoot)[] = [document];
    for (const root of roots) {
      if (root.querySelector("frame,iframe")) return {};
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    if (selector.startsWith("text=")) {
      // Only identify an unambiguous leaf control. The text itself stays in the page.
      if (roots.length !== 1) return {};
      const text = selector.slice(5).trim().replace(/\s+/g, " ");
      const quoted = text.startsWith('"') && text.endsWith('"');
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const label = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
        if (!(quoted ? label === text.slice(1, -1) : label.toLowerCase().includes(text.toLowerCase()))) continue;
        const parent = node.parentElement;
        if (element || !parent?.matches("a,button,textarea") || parent.childNodes.length !== 1) return {};
        element = parent;
      }
    } else if (selector) {
      const matches = roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
      if (matches.length === 1) element = matches[0]!;
    }
  }
  if (!element || ["body", "html", "iframe", "frame"].includes(element.localName)) return {};
  const attributes: Record<string, string> = { tag: element.localName };
  for (const key of ["type", "name", "placeholder", "aria-label"]) {
    const value = element.getAttribute(key);
    if (value) attributes[key] = value;
  }
  return attributes;
}

export async function describePage(runner: EgoRunner, name: string, id: number, target?: string, focused = false, label = "p1") {
  const result = await run(runner, `
const task = ${existingSpace(id, name)};
async function describe() {
  if (!task) return null;
  const page = task.page(${literal(label)});
  const { url, title } = await page.info();
  if (${target === undefined && !focused}) return { url, title };
  if (!/^https?:\\/\\//i.test(url)) return null;
  let selector = ${JSON.stringify(target ?? "")};
  const ref = /^@(\\d+)$/.exec(selector);
  if (ref && !/[\\r\\n]/.test(title)) {
    // The root line is generated by ego. Discard the rest of the subtree.
    const tree = await page.snapshot({ scope: "subtree", root: selector, includeStableLocator: true });
    const [header, line] = tree.split("\\n", 2);
    const root = header.startsWith("[" + page.label + " " + JSON.stringify(title) + " | space ") && header.endsWith("]") ? line ?? "" : "";
    const locator = /^\\w+(?: "(?:[^"\\\\]|\\\\.)*")? \\[ref=(\\d+), loc=css:(.+)\\]$/.exec(root);
    selector = locator?.[1] === ref[1] ? locator[2] : "";
  } else if (ref) selector = "";
  const attributes = selector || ${focused}
    ? await page.evaluate(${elementAttributes.toString()}, { selector, focused: ${focused} }) : {};
  return await page.url() === url ? { attributes, url, title } : null;
}
report(await describe());`);
  if (!result || typeof result.url !== "string" || typeof result.title !== "string") return;
  const metadata: Record<string, string> = { url: result.url, title: result.title };
  for (const key of ["tag", "type", "name", "placeholder", "aria-label"]) {
    const value = result.attributes?.[key];
    if (typeof value === "string") metadata[key] = value;
  }
  return metadata;
}

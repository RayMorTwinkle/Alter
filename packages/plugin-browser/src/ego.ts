import { spawn } from "node:child_process";

export type EgoRunner = (script: string) => Promise<string>;

// When spawned, ego-browser forwards the script's console output on stderr, so both streams carry frames.
const outputLimit = 4 * 1024 * 1024;
export const runEgo: EgoRunner = script => new Promise((resolve, reject) => {
  const child = spawn("ego-browser", ["nodejs"], { stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  let stdinError: Error | undefined;
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("ego-browser timed out after 90 seconds"));
  }, 90_000);
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout = (stdout + chunk).slice(-outputLimit); });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-outputLimit); });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`ego-browser exited (${signal ?? code}): ${stderr.trim().slice(-2048)}`));
    else if (stdinError) reject(stdinError);
    else resolve(stdout + "\n" + stderr);
  });
  child.stdin.on("error", error => { stdinError = error; });
  child.stdin.end(script);
});

// The CLI can also print notices. Only our single-line JSON frame carries page data.
const prelude = 'const report = value => console.log("ALTER_BROWSER " + JSON.stringify(value));';
async function run(runner: EgoRunner, script: string) {
  const stdout = await runner(prelude + "\n" + script);
  const frame = stdout.split("\n").findLast(line => line.startsWith("ALTER_BROWSER "));
  if (!frame) throw new Error("Missing ego-browser response");
  return JSON.parse(frame.slice("ALTER_BROWSER ".length));
}

function existingSpace(id: number, name: string) {
  return `(await listTaskSpaces()).some(s => s.id === ${JSON.stringify(id)} && s.name === ${JSON.stringify(name)})
    ? await taskSpace(${JSON.stringify(id)}) : null`;
}

export async function createSpace(runner: EgoRunner, name: string): Promise<number> {
  const id = await run(runner, `const task = await taskSpace(${JSON.stringify(name)});\nreport(task.spaceId);`);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid ego-browser space ID");
  return id;
}

export const actions = {
  open(url: string) {
    const parsed = URL.parse(url);
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) throw new Error("Expected an HTTP or HTTPS URL");
    return `await page.goto(${JSON.stringify(parsed.href)});\nawait page.waitForLoadState();`;
  },
  scroll(direction: "up" | "down") {
    return `await page.evaluate(d => window.scrollBy(0, (d === "up" ? -1 : 1) * window.innerHeight), ${JSON.stringify(direction)});`;
  },
  click: (target: string) => `await page.click(${JSON.stringify(target)});`,
  fill: (target: string, text: string) => `await page.fill(${JSON.stringify(target)}, ${JSON.stringify(text)});`,
  press: (key: string) => `await page.keyboard.press(${JSON.stringify(key)});`,
};

export type View = { text: string; url: string; isError: boolean };
export function clip(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit) + "… [truncated]" : text;
}

export async function view(runner: EgoRunner, name: string, id: number, action: string, limit: number, close = false): Promise<View | null> {
  const result = await run(runner, `
const task = ${existingSpace(id, name)};
if (!task) {
  report(null);
} else {
  const limit = ${JSON.stringify(limit)};
  const clip = text => text.length > limit ? text.slice(0, limit) + "… [truncated]" : text;
  let url = "", text = "", isError = false;
  try {
    const page = task.page("p1");
    try {
      ${action}
    } finally {
      url = clip(await page.url().catch(() => ""));
    }
    text = clip(await page.snapshot());
  } catch (error) {
    isError = true;
    text = clip(String(error));
  }
  ${close ? "await task.finish({ keep: [] });" : ""}
  report({ url, text, isError });
}`);
  if (result === null) return null;
  if (typeof result?.text !== "string" || typeof result.url !== "string" || typeof result.isError !== "boolean") {
    throw new Error("Invalid ego-browser page response");
  }
  return result;
}

export async function finishSpace(runner: EgoRunner, name: string, id: number) {
  await run(runner, `const task = ${existingSpace(id, name)};
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

export async function describePage(runner: EgoRunner, name: string, id: number, target?: string, focused = false) {
  const result = await run(runner, `
const task = ${existingSpace(id, name)};
async function describe() {
  if (!task) return null;
  const page = task.page("p1");
  const { url, title } = await page.info();
  if (!/^https?:\\/\\//i.test(url)) return null;
  let selector = ${JSON.stringify(target ?? "")};
  const ref = /^@(\\d+)$/.exec(selector);
  if (ref && !/[\\r\\n]/.test(title)) {
    // The root line is generated by ego. Discard the rest of the subtree.
    const tree = await page.snapshot({ scope: "subtree", root: selector, includeStableLocator: true });
    const [header, line] = tree.split("\\n", 2);
    const root = header.startsWith("[p1 " + JSON.stringify(title) + " | space ") && header.endsWith("]") ? line ?? "" : "";
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

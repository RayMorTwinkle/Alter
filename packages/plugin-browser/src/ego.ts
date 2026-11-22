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

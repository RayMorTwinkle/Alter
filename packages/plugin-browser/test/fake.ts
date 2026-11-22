import { runInNewContext } from "node:vm";
import { vi } from "vitest";

// Each invocation gets fresh JS globals. Only the simulated ego spaces survive.
export function fakeEgo() {
  const url = "https://example.test/";
  const page = {
    url: vi.fn(async () => url), snapshot: vi.fn(async () => "link @21"),
    goto: vi.fn(async (_url: string) => {}), waitForLoadState: vi.fn(async () => {}),
    click: vi.fn(async (_target: string) => {}), fill: vi.fn(async (_target: string, _text: string) => {}),
    evaluate: vi.fn(async (fn: (arg: string) => void, arg: string) => fn(arg)),
    keyboard: { press: vi.fn(async (_key: string) => {}) },
  };
  const scrollBy = vi.fn();
  const spaces = new Map<number, string>();
  let next = 1;
  const finish = vi.fn(async (id: number, _options: { keep: string[] }) => { spaces.delete(id); });
  const taskSpace = vi.fn(async (key: string | number) => {
    const id = typeof key === "string" ? next++ : key;
    if (typeof key === "string") spaces.set(id, key);
    if (!spaces.has(id)) throw new Error("Space missing");
    return { spaceId: id, page: (label: string) => {
      if (label !== "p1") throw new Error("Unexpected page label");
      return page;
    }, finish: (options: { keep: string[] }) => finish(id, options) };
  });
  const runner = vi.fn(async (script: string) => {
    const lines: string[] = [];
    await runInNewContext(`(async () => {\n${script}\n})()`, {
      taskSpace, listTaskSpaces: async () => Array.from(spaces, ([id, name]) => ({ id, name })),
      console: { log: (line: string) => lines.push(line) }, window: { innerHeight: 600, scrollBy },
    });
    return [...lines, "[ego-browser:notice] fixture"].join("\n");
  });
  return { page, runner, spaces, taskSpace, finish, scrollBy };
}

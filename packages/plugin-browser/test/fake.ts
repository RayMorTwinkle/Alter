import { writeFile } from "node:fs/promises";
import { constants, runInNewContext } from "node:vm";
import { vi } from "vitest";
import type { EgoRunner } from "../src/ego.ts";

export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

// Each invocation gets fresh JS globals. Only the simulated ego spaces survive.
export function fakeEgo(document?: object) {
  const url = "https://example.test/";
  function makePage(label: string) {
    return {
      label, info: vi.fn(async () => ({ url, title: "Example" })),
      url: vi.fn(async () => url), snapshot: vi.fn(async () => "link @21"),
      goto: vi.fn(async (_url: string) => {}), waitForLoadState: vi.fn(),
      click: vi.fn(), fill: vi.fn(), keyboard: { press: vi.fn() },
      evaluate: vi.fn(async (fn: string | ((arg: unknown) => unknown), arg?: unknown) =>
        typeof fn === "string" ? runInNewContext(fn, { document }) : fn(arg)),
      fetch: vi.fn(async () => ({ ok: true, status: 200, headers: {}, body: "page response" })),
      screenshot: vi.fn(async ({ path }: { path: string }) => { await writeFile(path, png, "base64"); return path; }),
    };
  }
  const page = makePage("p1");
  const second = makePage("p2");
  const pages = [page, second];
  const handOff = vi.fn();
  const waitForControl = vi.fn();
  const userControlled = new Set<number>();
  const scrollBy = vi.fn();
  const spaces = new Map<number, string>();
  let next = 1;
  const finish = vi.fn(async (id: number, _options: { keep: string[] }) => { spaces.delete(id); });
  const taskSpace = vi.fn(async (key: string | number) => {
    const id = typeof key === "string" ? next++ : key;
    if (typeof key === "string") spaces.set(id, key);
    if (!spaces.has(id)) throw new Error("Space missing");
    return { spaceId: id, pages: async () => pages, page: (label: string) => {
      const match = pages.find(p => p.label === label);
      if (!match) throw new Error("Unknown page");
      return match;
    },
    handOff: () => { userControlled.add(id); return handOff(); },
    waitForControl: async (options: { timeout: number }) => {
      const result = await waitForControl(options);
      if (result !== false) userControlled.delete(id);
      return result;
    },
    finish: (options: { keep: string[] }) => finish(id, options) };
  });
  const takeOverTaskSpace = vi.fn(async (id: number) => { userControlled.delete(id); return taskSpace(id); });
  const skill = vi.fn(async () => "ego-browser API guide\n[end of guide]\n");
  const runner = vi.fn(async (script: string, options?: Parameters<EgoRunner>[1]) => {
    if (options?.command === "skill") return skill();
    const lines: string[] = [];
    await runInNewContext(`(async () => {\n${script}\n})()`, {
      taskSpace, takeOverTaskSpace, listTaskSpaces: async () => Array.from(spaces, ([id, name]) => ({ id, name, ownership: userControlled.has(id) ? "agentDelegatedToUser" : "agent" })),
      document, NodeFilter: { SHOW_TEXT: 4 }, console: Object.freeze({ log: (line: string) => lines.push(line) }), window: { innerHeight: 600, scrollBy },
    }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    return [...lines, "[ego-browser:notice] fixture"].join("\n");
  });
  return { page, second, skill, runner, spaces, taskSpace, finish, scrollBy, handOff, waitForControl, takeOverTaskSpace };
}

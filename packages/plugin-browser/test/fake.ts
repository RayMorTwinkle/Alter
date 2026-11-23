import { writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";
import type { EgoRunner } from "../src/ego.ts";

export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

// Each invocation gets fresh JS globals. Only the simulated ego spaces survive.
export function fakeEgo(document?: object) {
  const url = "https://example.test/";
  function makePage(label: string) {
    let currentIndex = 1;
    return {
      label, info: vi.fn(async () => ({ url, title: "Example" })),
      url: vi.fn(async () => url), snapshot: vi.fn(async () => "link @21"),
      goto: vi.fn(async (_url: string) => {}), waitForLoadState: vi.fn(),
      click: vi.fn(), fill: vi.fn(), keyboard: { press: vi.fn() },
      evaluate: vi.fn(async (fn: string | ((arg: unknown) => unknown), arg?: unknown) =>
        typeof fn === "string" ? runInNewContext(fn, { document }) : fn(arg)),
      fetch: vi.fn(async () => ({ ok: true, status: 200, headers: {}, body: "page response" })),
      screenshot: vi.fn(async ({ path }: { path: string }) => { await writeFile(path, png, "base64"); return path; }),
      waitForSelector: vi.fn(), waitForFunction: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(),
      acceptDialog: vi.fn(), dismissDialog: vi.fn(),
      cdp: vi.fn(async (method: string, params?: { entryId: number }) => {
        if (method === "Page.getNavigationHistory") return { currentIndex, entries: [{ id: 10 }, { id: 11 }] };
        if (method === "Page.navigateToHistoryEntry") currentIndex = params!.entryId - 10;
        else if (method !== "Page.bringToFront") throw new Error("Unknown CDP method");
      }),
    };
  }
  const page = makePage("p1");
  const second = makePage("p2");
  const userTab = makePage("p3");
  const adopted = new Set<number>();
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
    const managed = () => adopted.has(id) ? [page, second, userTab] : [page, second];
    return { spaceId: id, pages: async () => managed(), page: (label: string) => {
      const match = managed().find(p => p.label === label);
      if (!match) throw new Error("Unknown page");
      return match;
    },
    handOff: () => { userControlled.add(id); return handOff(); },
    waitForControl: async (options: { timeout: number }) => {
      const result = await waitForControl(options);
      if (result !== false) userControlled.delete(id);
      return result;
    },
    tabs: async () => [page, second, userTab].map(p => ({ page: p, label: managed().includes(p) ? p.label : undefined,
      targetId: "target-" + p.label, title: "Page " + p.label, url, active: p === page, openedBy: p === userTab ? "user" : "agent" })),
    adopt: async (p: typeof page) => {
      if (p !== userTab || adopted.has(id)) throw new Error("Expected unmanaged tab");
      adopted.add(id);
      return p;
    }, finish: (options: { keep: string[] }) => finish(id, options) };
  });
  const runner = vi.fn(async (script: string, _options?: Parameters<EgoRunner>[1]) => {
    const lines: string[] = [];
    await runInNewContext(`(async () => {\n${script}\n})()`, {
      taskSpace, listTaskSpaces: async () => Array.from(spaces, ([id, name]) => ({ id, name, ownership: userControlled.has(id) ? "agentDelegatedToUser" : "agent" })),
      document, NodeFilter: { SHOW_TEXT: 4 }, console: { log: (line: string) => lines.push(line) }, window: { innerHeight: 600, scrollBy },
    });
    return [...lines, "[ego-browser:notice] fixture"].join("\n");
  });
  return { page, second, userTab, runner, spaces, taskSpace, finish, scrollBy, handOff, waitForControl };
}

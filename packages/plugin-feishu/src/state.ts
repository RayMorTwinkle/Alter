import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Owner = { openId: string; chatId: string };
type State = { owner?: Owner; recent: string[]; notifications?: string[] };

export function openState(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "feishu.json");
  let state: State;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(state.recent) || (state.notifications !== undefined && !Array.isArray(state.notifications)) || (state.owner && (!state.owner.openId || !state.owner.chatId))) {
      throw new Error("Invalid feishu.json");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = { recent: [] };
  }
  function save(next: State) {
    const temp = path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
      state = next;
    } finally { rmSync(temp, { force: true }); }
  }
  return {
    get value() { return state; },
    claimNotification(id: string) {
      const ids = state.notifications ?? [];
      if (ids.includes(id)) return false;
      save({ ...state, notifications: [...ids.slice(-499), id] });
      return true;
    },
    remember(id: string, owner = state.owner) {
      save({ ...state, owner, recent: [...state.recent.slice(-499), id] });
    },
  };
}

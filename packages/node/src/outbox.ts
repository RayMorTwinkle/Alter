import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync } from "node:fs";
import path from "node:path";
import type { ApprovalRequest, Hello, TaskEnd, TaskEvent } from "@alter/node-protocol";
import { atomicWrite } from "./config.ts";

export type Entry = ApprovalRequest | TaskEnd | TaskEvent;
type Body<T> = T extends unknown ? Omit<T, "at" | "seq" | "taskId"> : never;
function basename(id: string) {
  // Task IDs are opaque on the wire. Avoid separators, reserved devices and case collisions.
  return /^[a-z0-9-]{1,120}$/.test(id) && !/^(con|prn|aux|nul|com\d|lpt\d)$/.test(id)
    ? id : "_" + createHash("sha256").update(id).digest("hex");
}

export class Outbox {
  dir: string;
  journals = new Map<string, Entry[]>();
  constructor(dir: string) {
    this.dir = path.join(dir, "outbox");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.dir).filter(n => n.endsWith(".jsonl"))) {
      const file = path.join(this.dir, name);
      const bytes = readFileSync(file), end = bytes.lastIndexOf(10) + 1;
      if (end !== bytes.length) truncateSync(file, end);
      if (!end) { rmSync(file); continue; }
      const entries: Entry[] = bytes.subarray(0, end - 1).toString().split("\n").map(line => JSON.parse(line));
      const id = entries[0]!.taskId;
      if (name !== basename(id) + ".jsonl" || entries.some((e, i) => e.taskId !== id || e.seq !== i + 1))
        throw new Error("outbox 记录损坏");
      if (this.delivered(id)) rmSync(file); else this.journals.set(id, entries);
    }
  }

  private file(id: string) { return path.join(this.dir, basename(id)); }
  private delivered(id: string) { return existsSync(this.file(id) + ".done"); }
  known(id: string) { return this.journals.has(id) || this.delivered(id); }

  append(id: string, body: Body<Entry>): Entry {
    const entries = this.journals.get(id) ?? [];
    const entry = { ...body, taskId: id, at: Date.now(), seq: entries.length + 1 };
    appendFileSync(this.file(id) + ".jsonl", JSON.stringify(entry) + "\n", { mode: 0o600, flush: true });
    entries.push(entry);
    this.journals.set(id, entries);
    return entry;
  }

  tasks(): Hello["tasks"] {
    return Array.from(this.journals, ([taskId, entries]) => ({ taskId, lastSeq: entries.length,
      state: entries.at(-1)?.type === "task.end" ? "ended" : "running" }));
  }

  ack(id: string, seq: number) {
    const entries = this.journals.get(id);
    if (entries?.at(-1)?.type !== "task.end" || seq !== entries.length) return;
    atomicWrite(this.file(id) + ".done", String(seq));
    rmSync(this.file(id) + ".jsonl");
    this.journals.delete(id);
  }
}

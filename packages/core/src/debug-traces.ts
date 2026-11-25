import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext, type AssistantMessage, type Context, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { Harness } from "./runtime.ts";
import type { UsageLine } from "./usage.ts";

type TraceOwner = { conversation: "main" | "task"; conversationId: string; trigger: string; entryId?: number; entryKind?: string; taskId?: string; wakeId?: string; wakeAt?: number };
type Summary = TraceOwner & {
  model: string; attempt: number; fallback: boolean; fallbackFrom?: string; outcome: "pending" | "ok" | "error";
  latencyMs: number | null; firstTokenMs?: number; toolCallCount: number; error?: string;
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number };
};
type Input = { format: "gateway" | "transcript"; systemPrompt: string; tools: object[]; messages: { role: string }[]; options: object };

function recordSafely(write: () => void) {
  try { write(); }
  catch (error) { console.warn("Debug trace write failed", error instanceof Error ? error.name : "Error", (error as NodeJS.ErrnoException)?.code); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function traceInput(context: Context, payload: unknown, reasoning?: string): Input {
  if (object(payload) && Array.isArray(payload.messages) && payload.messages.every(m => object(m) && typeof m.role === "string")) {
    const { messages, tools, ...options } = payload;
    return { format: "gateway", messages, options,
      systemPrompt: messages.filter(m => m.role === "system" || m.role === "developer").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n\n"),
      tools: (Array.isArray(tools) ? tools : []).map(t => t.function ?? t) };
  }
  const { messages } = normalizeContext(context);
  return { format: "transcript", messages, options: { reasoning }, tools: getCurrentTools(messages), systemPrompt: getCurrentSystemPrompt(messages) };
}

const day = 86_400_000;
const resultLimit = 20_000;

export function openDebugTraces(dir: string | undefined, now: () => number) {
  const path = dir ? join(dir, "debug.sqlite") : ":memory:";
  if (dir) { mkdirSync(dir, { recursive: true }); closeSync(openSync(path, "a", 0o600)); }
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS content(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS traces(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      conversation TEXT NOT NULL, conversationId TEXT NOT NULL, trigger TEXT NOT NULL, summary TEXT NOT NULL,
      promptHash TEXT NOT NULL REFERENCES content(hash), toolsHash TEXT NOT NULL REFERENCES content(hash),
      options TEXT NOT NULL, format TEXT NOT NULL, output TEXT, isError INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS trace_time ON traces(at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS trace_conversation ON traces(conversationId, at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS inputs(trace INTEGER REFERENCES traces ON DELETE CASCADE, pos INTEGER,
      hash TEXT NOT NULL REFERENCES content(hash), textHash TEXT REFERENCES content(hash), addedToolsHash TEXT REFERENCES content(hash), PRIMARY KEY(trace,pos));
    CREATE TABLE IF NOT EXISTS calls(trace INTEGER REFERENCES traces ON DELETE CASCADE, pos INTEGER,
      conversationId TEXT NOT NULL, callId TEXT NOT NULL, result TEXT, PRIMARY KEY(trace,pos));
    CREATE INDEX IF NOT EXISTS call_owner ON calls(conversationId,callId,trace DESC);
  `);

  function transaction<T>(work: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function prune() {
    transaction(() => {
      db.prepare("DELETE FROM traces WHERE at < ?").run(now() - 14 * day);
      db.exec(`DELETE FROM content WHERE hash NOT IN (
        SELECT promptHash FROM traces UNION SELECT toolsHash FROM traces UNION SELECT hash FROM inputs
        UNION SELECT textHash FROM inputs WHERE textHash IS NOT NULL
        UNION SELECT addedToolsHash FROM inputs WHERE addedToolsHash IS NOT NULL)`);
    });
  }
  prune();
  const timer = setInterval(() => recordSafely(prune), day).unref();
  const insertContent = db.prepare("INSERT OR IGNORE INTO content VALUES(?,?,?)");
  function save(kind: string, value: unknown) {
    const body = JSON.stringify(value);
    const hash = createHash("sha256").update(kind + "\0" + body).digest("hex");
    insertContent.run(hash, kind, body);
    return hash;
  }
  const insertInput = db.prepare("INSERT INTO inputs VALUES(?,?,?,?,?)");
  const insertCall = db.prepare("INSERT INTO calls(trace,pos,conversationId,callId) VALUES(?,?,?,?)");
  function start(owner: TraceOwner, input: Input, at: number, model: string, attempt: number, previousModel?: string) {
    return transaction(() => {
      const summary: Summary = { ...owner, model, attempt, fallbackFrom: previousModel, fallback: previousModel !== undefined && previousModel !== model,
        outcome: "pending", latencyMs: null, tokens: {}, toolCallCount: 0 };
      const promptHash = save("system", input.systemPrompt);
      const toolsHash = save("tools", input.tools);
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO traces(at,conversation,conversationId,trigger,summary,promptHash,toolsHash,options,format,output,isError)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(at, owner.conversation, owner.conversationId, owner.trigger, JSON.stringify(summary),
        promptHash, toolsHash, JSON.stringify(input.options), input.format, null, 0);
      input.messages.forEach((msg, i) => {
        if (msg.role !== "system" && msg.role !== "developer") {
          insertInput.run(id, i, save("message", msg), null, null);
          return;
        }
        // Positional SDK system updates can carry both instructions and newly leased tools.
        const { content, toolsAdded, ...rest } = msg as { role: string; content?: unknown; toolsAdded?: object[] };
        const textHash = typeof content === "string" ? save("system", content) : null;
        const addedToolsHash = toolsAdded ? save("tools", toolsAdded) : null;
        const fields = textHash || content === undefined ? rest : { ...rest, content };
        insertInput.run(id, i, save("message", fields), textHash, addedToolsHash);
      });
      return Number(id);
    });
  }
  function finish(id: number, conversationId: string, line: UsageLine, output?: AssistantMessage, error?: string) {
    transaction(() => {
      const calls = output?.content.filter(c => c.type === "toolCall") ?? [];
      const summary = { model: line.model, attempt: line.attempt, fallback: line.fallback ?? false, fallbackFrom: line.fallbackFrom,
        outcome: line.outcome, latencyMs: line.latencyMs, firstTokenMs: line.firstTokenMs, toolCallCount: calls.length,
        tokens: { input: line.input, output: line.outputTokens, cacheRead: line.cacheRead, cacheWrite: line.cacheWrite, reasoning: output?.usage.reasoning },
        error: error ?? output?.errorMessage ?? line.errorKind };
      db.prepare("UPDATE traces SET summary=json_patch(summary,?),output=?,isError=? WHERE id=?")
        .run(JSON.stringify(summary), output ? JSON.stringify(output) : null, Number(line.outcome === "error"), id);
      calls.forEach((call, pos) => insertCall.run(id, pos, conversationId, call.id));
    });
  }
  function toolResult(conversationId: string, msg: ToolResultMessage) {
    const text = msg.content.map(part => part.type === "text" ? part.text : JSON.stringify(part)).join("\n");
    transaction(() => {
      const row = db.prepare("SELECT trace,pos FROM calls WHERE conversationId=? AND callId=? AND result IS NULL ORDER BY trace DESC,pos LIMIT 1").get(conversationId, msg.toolCallId);
      if (!row) return;
      const result = { toolCallId: msg.toolCallId, name: msg.toolName, at: msg.timestamp, isError: msg.isError,
        text: text.slice(0, resultLimit), truncated: text.length > resultLimit };
      db.prepare("UPDATE calls SET result=? WHERE trace=? AND pos=?").run(JSON.stringify(result), row.trace!, row.pos!);
      if (msg.isError) db.prepare("UPDATE traces SET isError=1 WHERE id=?").run(row.trace!);
    });
  }

  function summary(row: Record<string, unknown>) {
    const metadata: Summary = JSON.parse(String(row.summary));
    return { ...metadata, id: Number(row.id), at: Number(row.at), isError: !!row.isError };
  }
  function list({ conversation = "main", trigger, before, limit = 50 }: { conversation?: string; trigger?: string; before?: string; limit?: number } = {}) {
    const column = conversation === "main" || conversation === "task" ? "conversation" : "conversationId";
    const conditions = [column + "=?"];
    const params: (number | string)[] = [conversation];
    if (trigger) { conditions.push("trigger=?"); params.push(trigger); }
    if (before) { conditions.push("(at,id)<(?,?)"); params.push(...before.split(".").map(Number)); }
    const rows = db.prepare(`SELECT id,at,summary,isError FROM traces WHERE ${conditions.join(" AND ")} ORDER BY at DESC,id DESC LIMIT ?`).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(summary);
    const last = items.at(-1);
    return { items, nextCursor: last && rows.length > limit ? `${last.at}.${last.id}` : null };
  }
  function prompt(hash: string) {
    const row = db.prepare("SELECT kind,body FROM content WHERE hash=? AND kind IN ('system','tools')").get(hash);
    return row && { hash, kind: row.kind, content: JSON.parse(String(row.body)) };
  }
  function detail(id: number) {
    const row = db.prepare("SELECT * FROM traces WHERE id=?").get(id);
    if (!row) return;
    const messages = db.prepare(`SELECT m.body, p.body AS systemText, t.body AS addedTools FROM inputs i
      JOIN content m ON m.hash=i.hash LEFT JOIN content p ON p.hash=i.textHash LEFT JOIN content t ON t.hash=i.addedToolsHash
      WHERE trace=? ORDER BY pos`).all(id).map(m => {
      const message = JSON.parse(String(m.body));
      if (m.systemText !== null) message.content = JSON.parse(String(m.systemText));
      if (m.addedTools !== null) message.toolsAdded = JSON.parse(String(m.addedTools));
      return message;
    });
    const toolResults = db.prepare("SELECT result FROM calls WHERE trace=? AND result IS NOT NULL ORDER BY pos").all(id).map(r => JSON.parse(String(r.result)));
    return { ...summary(row), promptHash: row.promptHash, toolsHash: row.toolsHash, systemPrompt: prompt(String(row.promptHash))!.content,
      tools: prompt(String(row.toolsHash))!.content, messages, format: row.format, options: JSON.parse(String(row.options)),
      output: JSON.parse(String(row.output)), toolResults };
  }
  function observe(harness: Harness) {
    return harness.observeCommits({ advance({ changes }) {
      for (const change of changes) if (change.type === "entry") {
        for (const msg of change.value.model ?? []) if (msg.role === "toolResult") recordSafely(() => toolResult(String(change.value.conversationId), msg));
      }
    }, end() {} });
  }
  function request(owner: TraceOwner, context: Context, reasoning?: string) {
    let traceId: number | undefined;
    let attempt = 0;
    let previousModel: string | undefined;
    function capture(model: string, payload?: unknown) {
      attempt++;
      recordSafely(() => { traceId = start(owner, traceInput(context, payload, reasoning), now(), model, attempt, previousModel); });
      previousModel = model;
    }
    return { capture, complete(line: UsageLine, message?: AssistantMessage, error?: string) {
      // Setup/auth can fail before the provider has constructed a payload.
      if (traceId === undefined) capture(line.model);
      if (traceId !== undefined) {
        const id = traceId;
        recordSafely(() => finish(id, owner.conversationId, line, message, error));
        traceId = undefined;
      }
    } };
  }
  return { list, detail, prompt, request, toolResult, observe, prune, close() { clearInterval(timer); db.close(); } };
}
export type DebugTraces = ReturnType<typeof openDebugTraces>;

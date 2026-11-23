import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Feedback, type Bank, type Candidate, type Change, type Issued } from "./feedback.ts";
import { context, ROOT_CONVERSATION_ID, type Harness } from "./runtime.ts";

// The transaction log owns issuance. Materialize its committed state for offline SQL and the history API.
export async function openFeedbackTables(dir: string | undefined, harness: Harness) {
  const db = new DatabaseSync(dir ? join(dir, "feedback.sqlite") : ":memory:");
  type Row = Candidate | Issued | Change;
  function table(name: string, fields: string[]) {
    const columns = fields.map(field => `"${field}" GENERATED ALWAYS AS (json_extract(record,'$.${field}')) VIRTUAL`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), ${columns.join(",")})`);
    const save = db.prepare(`INSERT INTO ${name}(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record WHERE record<>excluded.record`);
    return (rows: Record<string, Row>, prior?: Record<string, Row>) => {
      if (!prior) db.exec("DELETE FROM " + name);
      else for (const id of Object.keys(prior)) if (!Object.hasOwn(rows, id)) db.prepare("DELETE FROM " + name + " WHERE id=?").run(id);
      for (const [id, row] of Object.entries(rows)) if (row !== prior?.[id]) save.run(id, JSON.stringify(row));
    };
  }
  try {
    const questions = table("feedback_questions", ["source", "prompt", "options", "allowOther", "multi", "why", "effect", "createdAt", "cooldownUntil", "asked", "skipped", "answered"]);
    const issues = table("feedback_issues", ["candidateId", "outlet", "batch", "askedAt", "status", "answer", "changeIds"]);
    const changes = table("feedback_changes", ["issueId", "at", "kind", "key", "before", "after", "memoryChangeId", "undoneBy", "undoOf"]);
    db.exec(`CREATE VIEW IF NOT EXISTS feedback_param_changes AS SELECT c.* FROM feedback_changes c
      JOIN feedback_issues i ON i.id=c.issueId WHERE json_extract(i.record,'$.effect.kind')='param'`);
    let previous: Readonly<Bank> | undefined, latest: Readonly<Bank> | undefined;
    let closed = false;
    function flush() {
      if (closed || !latest || latest === previous) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        questions(latest.candidates, previous?.candidates);
        issues(latest.issues, previous?.issues);
        changes(latest.changes, previous?.changes);
        db.exec("COMMIT");
        previous = latest;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    const sub = await harness.observeDoc(Feedback, ROOT_CONVERSATION_ID, {
      advance(call) {
        if (call.kind !== "value") return;
        latest = call.value;
        queueMicrotask(() => { try { flush(); } catch (e) { console.error("Feedback history sync failed", e); } });
      }, end() {},
    }, context);
    if (!sub) throw new Error("Feedback bank missing");
    latest = sub.value;
    try { flush(); } catch (error) { sub.detach(); throw error; }
    return {
      view() {
        flush();
        const rows = db.prepare("SELECT record FROM feedback_issues ORDER BY askedAt DESC,rowid").all().map(row => JSON.parse(String(row.record)) as Issued);
        const changes = db.prepare("SELECT record FROM feedback_changes ORDER BY at DESC,rowid DESC").all().map(row => JSON.parse(String(row.record)) as Change);
        return { pending: rows.filter(i => i.status === "pending"), history: rows.filter(i => i.status !== "pending"), changes };
      },
      close() { sub.detach(); try { flush(); } finally { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}

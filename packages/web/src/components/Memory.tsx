import { ArrowCounterClockwise, Check, PencilSimple, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { MemoryChange, MemoryEntry, MemoryPatch, MemoryView } from "../types.ts";

type Props = { view: MemoryView | null; onUpdate: (id: string, patch: MemoryPatch) => Promise<unknown>; onDelete: (id: string) => Promise<unknown> };

const types = ["user", "preference", "goal", "reference"] as const;
const day = (at: number) => new Intl.DateTimeFormat(document.documentElement.lang || "zh-Hans", { month: "short", day: "numeric" }).format(at);

function Row({ entry, onUpdate, onDelete }: { entry: MemoryEntry } & Omit<Props, "view">) {
  const t = useT().mem;
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [open, setOpen] = useState(false);
  const save = () => {
    if (!draft) return;
    const patch: MemoryPatch = {};
    if (draft.title.trim() && draft.title.trim() !== entry.title) patch.title = draft.title.trim();
    if (draft.body.trim() && draft.body.trim() !== entry.body) patch.body = draft.body.trim();
    if (Object.keys(patch).length) void onUpdate(entry.id, patch).then(() => setDraft(null), () => {});
    else setDraft(null);
  };
  return (
    <li className={`memory-item ${entry.status} ${entry.guess ? "guess" : ""}`}>
      <div className="row-main">
        {draft ? (
          <div className="memory-form">
            <input type="text" value={draft.title} autoFocus onChange={e => setDraft({ ...draft, title: e.target.value })} aria-label={t.titleLabel} />
            <textarea rows={3} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} aria-label={t.bodyLabel}
              onKeyDown={e => { if (e.key === "Escape") setDraft(null); }} />
            <div className="form-actions">
              <button className="btn primary" onClick={save}>{t.save}</button>
              <button className="text-btn" onClick={() => setDraft(null)}>{t.cancel}</button>
            </div>
          </div>
        ) : <>
          <button className="memory-title" onClick={() => setOpen(o => !o)} aria-expanded={open}>{entry.title}</button>
          {entry.body !== entry.title && <div className={`memory-body ${open ? "open" : ""}`}>{entry.body}</div>}
          <div className="row-meta">
            {entry.guess && <span className="chip guess" title={t.guessHint}>{t.guess}</span>}
            {entry.dueAt !== undefined && <span>{t.due(day(entry.dueAt))}</span>}
            {entry.status === "pending" && <span className="chip warn">{t.pending}</span>}
            {entry.status === "done" && <span className="chip">{t.done}</span>}
            {open && <span className="memory-source">{t.source(entry.source)} · {t.updated(day(entry.updatedAt))}</span>}
          </div>
        </>}
      </div>
      {!draft && (
        <div className="memory-actions">
          {entry.guess && (
            <button className="icon-btn ghost" title={t.confirmGuess} aria-label={t.confirmGuess}
              onClick={() => void onUpdate(entry.id, { guess: false }).catch(() => {})}><Check /></button>
          )}
          {!entry.guess && entry.type === "goal" && entry.status !== "done" && (
            <button className="icon-btn ghost" title={t.markDone} aria-label={t.markDone}
              onClick={() => void onUpdate(entry.id, { status: "done" }).catch(() => {})}><Check /></button>
          )}
          <button className="icon-btn ghost" title={t.edit} aria-label={t.edit} onClick={() => setDraft({ title: entry.title, body: entry.body })}><PencilSimple /></button>
          <button className="icon-btn ghost" title={t.remove} aria-label={t.remove}
            onClick={() => { if (confirm(t.confirmRemove(entry.title))) void onDelete(entry.id).catch(() => {}); }}><Trash /></button>
        </div>
      )}
    </li>
  );
}

function describe(change: MemoryChange, t: ReturnType<typeof useT>["mem"]) {
  const titles = new Map(change.snapshots.map(s => [s.id, (s.after ?? s.before)?.title ?? s.id]));
  return change.operations.filter(op => op.op !== "keep" && op.ids.length)
    .map(op => `${t.ops[op.op]}「${op.ids.map(id => titles.get(id) ?? id).join("」「")}」`).join("；");
}

function Changes({ version }: { version: unknown }) {
  const t = useT().mem;
  const [changes, setChanges] = useState<MemoryChange[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.memoryChanges().then(setChanges, () => setChanges([])); }, [version]);
  const visible = (changes ?? []).filter(c => c.kind !== "expire" && describe(c, t)).slice(0, 30);
  if (!visible.length) return null;
  return (
    <details className="memory-changes">
      <summary>{t.changes}</summary>
      {error && <p className="form-error">{error}</p>}
      <ul className="rows">
        {visible.map(change => (
          <li key={change.id} className={change.undoneBy ? "undone" : ""}>
            <div className="row-main">
              <div className="change-head"><span className="chip">{t.kinds[change.kind]}</span><time>{day(change.at)}</time></div>
              <div className="change-text">{describe(change, t)}</div>
            </div>
            {change.kind !== "undo" && !change.undoneBy && (
              <button className="icon-btn ghost" title={t.undo} aria-label={t.undo} onClick={() => {
                setError("");
                api.undoMemoryChange(change.id).catch(err => setError(err instanceof Error && err.message.includes("409") ? t.conflict : String(err?.message ?? err)));
              }}><ArrowCounterClockwise /></button>
            )}
            {change.undoneBy && <span className="chip">{t.undone}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function MemoryPanel({ view, onUpdate, onDelete }: Props) {
  const all = useT();
  const t = all.mem;
  if (!view) return <div className="panel-body"><p className="empty">{all.loading}</p></div>;
  const current = view.entries.filter(e => !e.supersededBy);
  const guesses = current.filter(e => e.guess);
  // Guesses and expired goals need a decision, so they lead; finished goals sink.
  const rank = (e: MemoryEntry) => (e.status === "pending" ? 0 : e.status === "done" ? 2 : 1);
  return (
    <div className="panel-body">
      {current.length === 0 && <p className="empty">{all.emptyMemory}</p>}
      {guesses.length > 0 && <p className="memory-hint">{t.guessIntro(guesses.length)}</p>}
      {view.needsConsolidation && <p className="memory-hint">{t.consolidate}</p>}
      {types.map(type => {
        const group = current.filter(e => e.type === type).sort((a, b) => rank(a) - rank(b) || Number(b.guess) - Number(a.guess) || b.updatedAt - a.updatedAt);
        if (!group.length) return null;
        return (
          <section key={type} className="memory-group">
            <h3>{t.types[type]}</h3>
            <ul className="rows">{group.map(entry => <Row key={entry.id} entry={entry} onUpdate={onUpdate} onDelete={onDelete} />)}</ul>
          </section>
        );
      })}
      <Changes version={view} />
    </div>
  );
}

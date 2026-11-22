import { Check, PencilSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useT } from "../i18n.tsx";
import type { MemoryItem } from "../types.ts";

type Patch = Partial<Pick<MemoryItem, "text" | "status">>;
type Props = { items: MemoryItem[]; onUpdate: (id: string, patch: Patch) => Promise<unknown>; onDelete: (id: string) => Promise<unknown> };

const kinds = ["goal", "profile", "fact"] as const;

function Row({ item, onUpdate, onDelete }: { item: MemoryItem } & Omit<Props, "items">) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const due = item.due === undefined ? null
    : new Intl.DateTimeFormat(document.documentElement.lang || "zh-Hans", { month: "short", day: "numeric" }).format(item.due);
  const save = () => {
    const text = draft?.trim();
    if (text && text !== item.text) void onUpdate(item.id, { text }).then(() => setDraft(null), () => {});
    else setDraft(null);
  };
  return (
    <li className={`memory-item ${item.status}`}>
      <div className="row-main">
        {draft === null
          ? <div className="memory-text">{item.text}</div>
          : <textarea className="memory-edit" value={draft} autoFocus rows={2} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
                if (e.key === "Escape") setDraft(null);
              }} onBlur={save} />}
        {item.kind === "goal" && (
          <div className="row-meta">
            {due && <span>{t.memoryDue(due)}</span>}
            {item.status === "pending" && <span className="chip warn">{t.memoryPending}</span>}
            {item.status === "done" && <span className="chip">{t.memoryDone}</span>}
          </div>
        )}
      </div>
      <div className="memory-actions">
        {item.kind === "goal" && item.status !== "done" && (
          <button className="icon-btn ghost" title={t.memoryMarkDone} aria-label={t.memoryMarkDone}
            onClick={() => void onUpdate(item.id, { status: "done" }).catch(() => {})}><Check /></button>
        )}
        <button className="icon-btn ghost" title={t.memoryEdit} aria-label={t.memoryEdit} onClick={() => setDraft(item.text)}><PencilSimple /></button>
        <button className="icon-btn ghost" title={t.memoryDelete} aria-label={t.memoryDelete}
          onClick={() => { if (confirm(t.memoryConfirmDelete)) void onDelete(item.id).catch(() => {}); }}><Trash /></button>
      </div>
    </li>
  );
}

export function MemoryPanel({ items, onUpdate, onDelete }: Props) {
  const t = useT();
  // Pending goals need a decision, so they lead; finished goals sink.
  const rank = { pending: 0, active: 1, done: 2 };
  return (
    <div className="panel-body">
      {items.length === 0 && <p className="empty">{t.emptyMemory}</p>}
      {kinds.map(kind => {
        const group = items.filter(item => item.kind === kind).sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt);
        if (!group.length) return null;
        return (
          <section key={kind} className="memory-group">
            <h3>{t.memoryKinds[kind]}</h3>
            <ul className="rows">
              {group.map(item => <Row key={item.id} item={item} onUpdate={onUpdate} onDelete={onDelete} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

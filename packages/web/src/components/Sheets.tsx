import { X } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { compactNumber, pretty, seconds } from "../format.ts";
import { useT } from "../i18n.tsx";
import { Markdown } from "../markdown.tsx";
import type { Task, TranscriptItem, UsageRow } from "../types.ts";
import { StatusChip } from "./Panels.tsx";

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t.close}><X /></button>
        </header>
        <div className="sheet-body">{children}</div>
      </aside>
    </div>
  );
}

export function TaskSheet({ task, taskId, onClose }: { task?: Task; taskId: string; onClose: () => void }) {
  const t = useT();
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [error, setError] = useState("");
  const status = task?.status;

  // Refetch when the task changes state so a running task's process fills in.
  useEffect(() => {
    let live = true;
    api.transcript(taskId).then(result => live && setItems(result.items), err => live && setError(String(err.message ?? err)));
    return () => { live = false; };
  }, [taskId, status]);

  return (
    <Sheet title={<><code>{taskId}</code>{task && <StatusChip status={task.status} />}</>} onClose={onClose}>
      {task && (
        <section className="task-meta">
          <h3>{t.brief}</h3>
          <Markdown text={task.brief} />
          <div className="row-meta">
            <span>{t[task.permission]}</span>
            <span>{t[task.context]}</span>
            {task.allow.length > 0 && <span>{t.allowed}: {task.allow.join(", ")}</span>}
          </div>
          {task.failure && <p className="form-error">{task.failure}</p>}
        </section>
      )}
      <section>
        <h3>{t.process}</h3>
        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="empty">{t.loading}</p>}
        <ol className="transcript">
          {items?.map((item, index) => <TranscriptRow key={index} item={item} />)}
        </ol>
      </section>
    </Sheet>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  const t = useT();
  switch (item.kind) {
    case "user":
    case "assistant":
      return <li className={`tr tr-${item.kind}`}><Markdown text={item.text} /></li>;
    case "tool_call":
      return (
        <li className="tr tr-call">
          <details>
            <summary>{t.toolCall} <code>{item.tool}</code></summary>
            <pre>{pretty(item.arguments)}</pre>
          </details>
        </li>
      );
    case "tool_result":
      return (
        <li className={`tr tr-result ${item.isError ? "error" : ""}`}>
          <details>
            <summary>{t.toolResult} <code>{item.tool}</code></summary>
            <pre>{item.text}</pre>
          </details>
        </li>
      );
  }
}

export function UsageSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.usage().then(setRows, err => setError(String(err.message ?? err))); }, []);
  return (
    <Sheet title={t.usage} onClose={onClose}>
      {error && <p className="form-error">{error}</p>}
      {!rows && !error && <p className="empty">{t.loading}</p>}
      {rows?.length === 0 && <p className="empty">{t.noUsage}</p>}
      {rows?.map(row => (
        <article key={row.model} className="usage">
          <code>{row.model}</code>
          <dl>
            <div><dt>{t.calls}</dt><dd>{row.calls}</dd></div>
            <div><dt>{t.failureRate}</dt><dd>{row.failureRate}</dd></div>
            <div><dt>{t.fallbacks}</dt><dd>{row.fallbacks}</dd></div>
            <div><dt>{t.latency}</dt><dd>{seconds(row.p50Ms)} / {seconds(row.p95Ms)}</dd></div>
            <div><dt>{t.tokens}</dt><dd>{compactNumber(row.inputTokens)} / {compactNumber(row.outputTokens)}</dd></div>
          </dl>
        </article>
      ))}
    </Sheet>
  );
}

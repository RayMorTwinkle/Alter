import { X } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { clock, compactNumber, pretty, seconds } from "../format.ts";
import { useT } from "../i18n.tsx";
import { Markdown } from "../markdown.tsx";
import type { Funnel, Notification, Task, TranscriptItem, UsageRow } from "../types.ts";
import { StatusChip } from "./Panels.tsx";

export function Sheet({ title, onClose, headerExtra, children, wide }: {
  title: ReactNode; onClose: () => void; headerExtra?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className={`sheet${wide ? " wide" : ""}`} role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t.close}><X /></button>
        </header>
        {headerExtra}
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
            {task.runner && <span>{t.nodes.harnessNames[task.runner.harness] ?? task.runner.harness} @ {task.runner.node}</span>}
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
          <details open={item.isError}>
            <summary>{t.toolResult} <code>{item.tool}</code></summary>
            <pre>{item.text}</pre>
          </details>
        </li>
      );
  }
}

export function NotificationsSheet({ items, onClose, onFeedback }: {
  items: Notification[]; onClose: () => void; onFeedback: (id: string, feedback: "useful" | "useless") => void;
}) {
  const t = useT();
  const ordered = [...items].sort((a, b) => b.at - a.at);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  useEffect(() => { api.funnel().then(setFunnel, () => {}); }, []);
  const total = (key: "triggered" | "pushed" | "read" | "useful") => funnel?.days.reduce((sum, day) => sum + day[key], 0) ?? 0;
  return (
    <Sheet title={t.notifications} onClose={onClose}>
      {funnel && total("triggered") > 0 && (
        <div className="funnel" aria-label={t.funnel}>
          <span className="funnel-label">{t.funnel}</span>
          {(["triggered", "pushed", "read", "useful"] as const).map((key, i) => (
            <span key={key}>{i > 0 && <i>→</i>}{t.funnelSteps[key]} <b>{total(key)}</b></span>
          ))}
          {funnel.precision !== null && <span className="funnel-precision">{t.precision} <b>{Math.round(funnel.precision * 100)}%</b></span>}
        </div>
      )}
      {ordered.length === 0 && <p className="empty">{t.emptyNotifications}</p>}
      <ul className="rows">
        {ordered.map(item => (
          <li key={item.id} className={`notice ${item.status}`}>
            <div className="row-main">
              <div className="notice-title">{item.title}</div>
              {item.body && <div className="notice-body">{item.body}</div>}
              <div className="row-meta">
                <span className="chip">{t.noticeLevels[item.level]}</span>
                <span>{t.noticeSources[item.source] ?? item.source}</span>
                <time>{clock(item.at)}</time>
              </div>
              <div className="notice-feedback">
                {(["useful", "useless"] as const).map(value => (
                  <button key={value} className={`text-btn ${item.feedback === value ? "chosen" : ""}`} aria-pressed={item.feedback === value}
                    onClick={() => onFeedback(item.id, value)}>{t.feedback[value]}</button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

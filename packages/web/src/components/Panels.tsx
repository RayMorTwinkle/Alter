import { CaretRight, Link as LinkIcon, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { clock, pretty, remaining } from "../format.ts";
import { useT } from "../i18n.tsx";
import { Inline } from "../markdown.tsx";
import type { Lease, LedgerEntry, PermissionRequest, Task } from "../types.ts";

export function StatusChip({ status }: { status: Task["status"] }) {
  const t = useT();
  return <span className={`chip status-${status}`}>{status === "running" && <i className="live-dot" />}{t[status]}</span>;
}

export function TasksPanel({ tasks, leases, onOpen }: { tasks: Task[]; leases: Lease[]; onOpen: (taskId: string) => void }) {
  const t = useT();
  const ordered = [...tasks].sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running") || b.createdAt - a.createdAt);
  return (
    <div className="panel-body">
      {leases.length > 0 && (
        <div className="leases">
          {leases.map(lease => (
            <span key={lease.capability} className="chip">
              {t.leased} · {lease.capability} · {t.idleTurns(lease.idleTurns, lease.window)}
            </span>
          ))}
        </div>
      )}
      {ordered.length === 0 && <p className="empty">{t.emptyTasks}</p>}
      <ul className="rows">
        {ordered.map(task => (
          <li key={task.taskId}>
            <button className="row" onClick={() => onOpen(task.taskId)}>
              <div className="row-main">
                <div className="row-title"><Inline text={task.brief} /></div>
                <div className="row-meta">
                  <StatusChip status={task.status} />
                  <span>{t[task.permission]}</span>
                  <span>{t[task.context]}</span>
                  {task.pending.some(p => p.audience === "user") && <span className="badge">{t.needsYou}</span>}
                  <time>{clock(task.createdAt)}</time>
                </div>
              </div>
              <CaretRight className="row-caret" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovalCard({ request, onAnswer, inline = false }: {
  request: PermissionRequest; onAnswer: (id: string, allow: boolean, note?: string) => Promise<void>; inline?: boolean;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const mine = request.audience === "user";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const left = remaining(request.expiresAt - now);

  async function answer(allow: boolean) {
    setBusy(true);
    try {
      await onAnswer(request.id, allow, note.trim() || undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`approval ${inline ? "inline" : ""} ${mine ? "mine" : ""}`}>
      <header>
        <span className="approval-tool">{request.capability} · <code>{request.tool}</code></span>
        <span className={mine ? "badge" : "chip"}>{mine ? t.needsYou : t.handledByMain}</span>
      </header>
      {request.taint && <p className="approval-taint"><Warning weight="fill" /> {t.tainted(request.taint.source)}</p>}
      <dl>
        <dt>{t.reason}</dt>
        <dd>{request.reason}</dd>
        <dt>{t.arguments}</dt>
        <dd><pre>{pretty(request.arguments)}</pre></dd>
      </dl>
      {mine && (
        <div className="approval-actions">
          <input value={note} onChange={event => setNote(event.target.value)} placeholder={t.notePlaceholder} />
          <button className="btn" disabled={busy} onClick={() => void answer(false)}>{t.deny}</button>
          <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>{t.approve}</button>
          <span className="approval-expiry">{t.expiresIn(left.n, left.unit)}</span>
        </div>
      )}
    </article>
  );
}

export function ApprovalsPanel({ pending, onAnswer }: {
  pending: PermissionRequest[]; onAnswer: (id: string, allow: boolean, note?: string) => Promise<void>;
}) {
  const t = useT();
  const ordered = [...pending].sort((a, b) => Number(b.audience === "user") - Number(a.audience === "user"));
  return (
    <div className="panel-body">
      {ordered.length === 0 && <p className="empty">{t.emptyApprovals}</p>}
      {ordered.map(request => <ApprovalCard key={request.id} request={request} onAnswer={onAnswer} />)}
    </div>
  );
}

export function LedgerPanel({ ledger, onOpen }: { ledger: LedgerEntry[]; onOpen: (taskId: string) => void }) {
  const t = useT();
  const ordered = [...ledger].sort((a, b) => b.at - a.at);
  return (
    <div className="panel-body">
      {ordered.length === 0 && <p className="empty">{t.emptyLedger}</p>}
      <ul className="rows">
        {ordered.map(entry => (
          <li key={`${entry.taskId}-${entry.at}`}>
            <button className="row" onClick={() => onOpen(entry.taskId)}>
              <div className="row-main">
                <div className="row-title"><Inline text={entry.summary} /></div>
                {entry.refs.length > 0 && (
                  <div className="refs">
                    {entry.refs.map((ref, i) => (
                      <span key={i} className="chip"><LinkIcon /> {ref.kind}: {ref.ref}</span>
                    ))}
                  </div>
                )}
                <div className="row-meta"><code>{entry.taskId}</code><time>{clock(entry.at)}</time></div>
              </div>
              <CaretRight className="row-caret" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { CaretRight, Link as LinkIcon } from "@phosphor-icons/react";
import { ApprovalCard } from "./ApprovalCard.tsx";
export { ApprovalCard } from "./ApprovalCard.tsx";
import { clock } from "../format.ts";
import { useT } from "../i18n.tsx";
import { Inline } from "../markdown.tsx";
import type { ApprovalAnswer, Lease, LedgerEntry, PermissionRequest, Task, Watch } from "../types.ts";

export function StatusChip({ status }: { status: Task["status"] }) {
  const t = useT();
  return <span className={`chip status-${status}`}>{status === "running" && <i className="live-dot" />}{t[status]}</span>;
}

function Watches({ items, onCancel }: { items: Watch[]; onCancel: (id: string) => void }) {
  const t = useT().watches;
  const recent = items.filter(w => w.status === "running" || Date.now() - w.until < 86_400_000)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.createdAt - a.createdAt);
  if (!recent.length) return null;
  return (
    <section className="watches">
      <h3>{t.title}</h3>
      <ul className="rows">
        {recent.map(w => (
          <li key={w.id} className={`watch-item ${w.status}`}>
            <div className="row-main">
              <div className="row-title">{w.brief}</div>
              <div className="row-meta">
                <span className="chip">{t.status[w.status]}</span>
                <span>{w.where.channel === "mail" ? t.mail : w.where.channel === "feishu" ? t.feishu : w.where.channel}
                  {w.where.chatId ? ` · ${t.chat(w.where.chatId)}` : w.where.contact ? ` · ${t.contact(w.where.contact)}` : ""}</span>
                {w.keywords.length > 0 && <span>{t.keywords(w.keywords.join("、"))}</span>}
                <span>{w.status === "running" ? t.until(clock(w.until)) : t.ended(clock(w.until))}</span>
                <span>{t.wakes(w.wakes)}</span>
              </div>
              {w.pollError && <div className="watch-error">{w.pollError}</div>}
            </div>
            {w.status === "running" && (
              <button className="text-btn" onClick={() => { if (confirm(t.confirmCancel)) onCancel(w.id); }}>{t.cancel}</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TasksPanel({ tasks, leases, watches, onOpen, onCancelWatch }: {
  tasks: Task[]; leases: Lease[]; watches: Watch[]; onOpen: (taskId: string) => void; onCancelWatch: (id: string) => void;
}) {
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
      <Watches items={watches} onCancel={onCancelWatch} />
      {ordered.length === 0 && <p className="empty">{t.emptyTasks}</p>}
      <ul className="rows">
        {ordered.map(task => (
          <li key={task.taskId}>
            <button className="row" onClick={() => onOpen(task.taskId)}>
              <div className="row-main">
                <div className="row-title"><Inline text={task.brief} /></div>
                <div className="row-meta">
                  <StatusChip status={task.status} />
                  {task.runner && <span>{t.nodes.harnessNames[task.runner.harness] ?? task.runner.harness} @ {task.runner.node}</span>}
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

export function ApprovalsPanel({ pending, onAnswer }: {
  pending: PermissionRequest[]; onAnswer: (id: string, decision: ApprovalAnswer, note?: string) => Promise<void>;
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

import { useEffect, useRef, useState } from "react";
import { approvalRisk } from "../approval-risk.ts";
import { pretty, remaining } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { ApprovalAnswer, PermissionRequest } from "../types.ts";

export type AnswerRequest = (id: string, decision: ApprovalAnswer, note?: string) => Promise<void>;

function ChangePreview({ args }: { args: unknown }) {
  const t = useT().mission;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const fields = args as Record<string, unknown>;
  const patch = typeof fields.diff === "string" ? fields.diff : fields.patch;
  if (typeof patch === "string") {
    return <details open><summary>{t.diff}</summary><pre>{patch}</pre></details>;
  }
  if (!Object.hasOwn(fields, "before") || !Object.hasOwn(fields, "after")) return null;
  return <details open><summary>{t.diff}</summary><pre className="mc-diff"><del>− {pretty(fields.before)}</del><ins>+ {pretty(fields.after)}</ins></pre></details>;
}

export function ApprovalCard({ request, onAnswer, inline = false, replayTime }: {
  request: PermissionRequest; onAnswer?: AnswerRequest; inline?: boolean; replayTime?: number;
}) {
  const t = useT();
  const m = t.mission;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (replayTime !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [replayTime]);
  const at = replayTime ?? now;
  const expired = at >= request.expiresAt;
  const disabled = expired || busy;
  const left = remaining(request.expiresAt - at);
  const soft = !request.deferred && request.defaultAt !== undefined && request.defaultAt < request.expiresAt && at < request.defaultAt
    ? remaining(request.defaultAt - at) : undefined;
  const risk = approvalRisk(request.tool, request.effect, request.capability);
  async function answer(decision: ApprovalAnswer) {
    if (!onAnswer || locked.current || (replayTime ?? Date.now()) >= request.expiresAt) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await onAnswer(request.id, decision, note.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      locked.current = false;
      setBusy(false);
    }
  }
  return <article className={`approval risk-card risk-${risk} ${inline ? "inline" : ""}`}>
    <header><span className="risk-label"><i />{m[risk]}</span>
      <code>{request.taskId}</code></header>
    <strong className="approval-tool">{request.tool}</strong>
    <p>{request.reason}</p>
    <ChangePreview args={request.arguments} />
    <details open={!inline}><summary>{m.params}</summary><pre>{pretty(request.arguments)}</pre></details>
    {!!request.statement?.length && <details><summary>{t.statement}</summary><ul className="statement">
      {request.statement.map((item, i) => <li key={i}><code>{item.tool}</code> {item.target} <span>{item.purpose}</span>
        {item.isNew && <em>{t.statementNew}</em>}</li>)}</ul></details>}
    {request.audience === "user" && onAnswer ? <>
      <span className="approval-expiry">{expired ? m.expired : request.deferred ? m.retry : soft ? t.defaultIn(soft.n, soft.unit) : t.expiresIn(left.n, left.unit)}</span>
      {replayTime === undefined && <input aria-label={t.notePlaceholder} value={note} onChange={e => setNote(e.target.value)} placeholder={t.notePlaceholder} />}
      <div className="mc-decisions"><button className="btn primary" disabled={disabled} onClick={() => void answer("call")}>{t.decisions.once}</button>
        <button className="btn" disabled={disabled} onClick={() => void answer("deny")}>{t.decisions.deny}</button></div>
      {replayTime === undefined && <details><summary>{m.more}</summary><div className="mc-decisions">
        <button className="btn quiet" disabled={disabled} onClick={() => void answer("once")}>{m.toolWindow}</button>
        {(["capability", "always"] as const).map(choice => <button key={choice} className="btn quiet" disabled={disabled}
          onClick={() => void answer(choice)}>{t.decisions[choice](request.capability)}</button>)}</div></details>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </> : request.audience === "main" && <span>{t.handledByMain}</span>}
  </article>;
}

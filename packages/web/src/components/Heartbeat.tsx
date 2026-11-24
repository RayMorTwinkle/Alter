import { useState } from "react";
import { api } from "../api.ts";
import { clock } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { HeartbeatRun, HeartbeatView } from "../types.ts";
import { Sheet } from "./Sheets.tsx";

function hours(ms: number) {
  const h = ms / 3_600_000;
  return h >= 10 ? Math.round(h) : Math.round(h * 10) / 10;
}

function Run({ run, onFeedback }: { run: HeartbeatRun; onFeedback: (feedback: "useful" | "useless") => void }) {
  const t = useT().heartbeat;
  const counts = (Object.keys(t.counts) as (keyof HeartbeatRun["counts"])[])
    .filter(key => run.counts[key] > 0).map(key => `${t.counts[key]} ${run.counts[key]}`);
  return (
    <li className={`hb-run ${run.status}`}>
      <div className="row-main">
        <div className="hb-run-head">
          <time>{clock(run.at)}</time>
          <span className="chip">{run.status === "ran" ? t.status.ran : run.status === "deferred" ? t.status.deferred
            : `${t.status.skipped}：${t.reasons[run.skipReason ?? "unchanged"] ?? run.skipReason}`}</span>
          {run.status === "ran" && <span className={`hb-told ${run.notified ? "yes" : ""}`}>{run.notified ? t.told : t.notTold}</span>}
          {run.finishedAt === null && run.status === "ran" && <span className="hb-live">{t.running}</span>}
        </div>
        {run.status === "ran" && <>
          {counts.length > 0 && <div className="row-meta">{t.looked}：{counts.join(" · ")}</div>}
          {run.actions.length > 0 ? (
            <ul className="hb-actions">
              {run.actions.map((action, i) => (
                <li key={i}>
                  {t.actions[action.tool] ?? action.tool}
                  {action.level && <span className="chip">{t.levels[action.level]}</span>}
                  {action.id && <code>{action.id}</code>}
                </li>
              ))}
            </ul>
          ) : run.finishedAt !== null && <div className="row-meta">{t.noAction}</div>}
          {run.finalReply && (
            <details className="hb-thought">
              <summary>{t.thought}</summary>
              <p>{run.finalReply}</p>
            </details>
          )}
          {run.finishedAt !== null && (
            <div className="notice-feedback">
              {(["useful", "useless"] as const).map(value => (
                <button key={value} className={`text-btn ${run.feedback === value ? "chosen" : ""}`} aria-pressed={run.feedback === value}
                  onClick={() => onFeedback(value)}>{t.feedback[value]}</button>
              ))}
              {run.tokens > 0 && <span className="hb-tokens">{run.tokens.toLocaleString()} token</span>}
            </div>
          )}
        </>}
      </div>
    </li>
  );
}

export function HeartbeatSheet({ view, onClose, onChange }: { view: HeartbeatView | null; onClose: () => void; onChange: () => void }) {
  const t = useT().heartbeat;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      await api.runHeartbeat();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function feedback(id: string, value: "useful" | "useless") {
    await api.heartbeatFeedback(id, value).catch(() => {});
    onChange();
  }

  const runs = view ? [...view.runs].sort((a, b) => b.at - a.at) : [];
  return (
    <Sheet title={t.title} onClose={onClose}>
      {view && (
        <section className="hb-summary">
          <div className="hb-next">
            <span>{t.next}</span>
            <b>{view.enabled && view.nextAt ? clock(view.nextAt) : t.off}</b>
            <button className="btn" disabled={busy} onClick={() => void run()}>{t.runNow}</button>
          </div>
          <p className="hb-why">
            {t.interval(hours(view.intervalMs))} · {t.adoption} {Math.round(view.adoption * 100)}%
            {" "}· {t.signals(view.signals.dueGoals, view.signals.backlog, view.signals.userMessages24h)}
          </p>
          <p className="hb-why">{view.report.paused ? t.reportPaused : t.report(view.report.nextAt ? clock(view.report.nextAt) : null)}</p>
          <p className="hb-hint">{t.hint}</p>
          {error && <p className="form-error">{error}</p>}
        </section>
      )}
      {!view && <p className="empty">{useT().loading}</p>}
      {view && runs.length === 0 && <p className="empty">{t.empty}</p>}
      <ul className="rows">
        {runs.map(item => <Run key={item.id} run={item} onFeedback={value => void feedback(item.id, value)} />)}
      </ul>
    </Sheet>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { compactNumber, seconds } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { Stats, StatsRange, StatsUsage } from "../types.ts";
import { Sheet } from "./Sheets.tsx";

const ranges: StatsRange[] = ["day", "7d", "30d", "all"];

function percent(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function usd(value: number | null) {
  if (value === null) return null;
  return value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

// Share bars: one ink, length carries magnitude; the label and number carry identity.
function ShareRows({ rows }: { rows: { key: string; label: string; value: number; detail: string }[] }) {
  const max = Math.max(1, ...rows.map(row => row.value));
  return (
    <ul className="share-rows">
      {rows.map(row => (
        <li key={row.key}>
          <div className="share-head"><span>{row.label}</span><b>{row.detail}</b></div>
          <div className="share-track"><i style={{ width: `${(row.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function Daily({ days }: { days: Stats["daily"] }) {
  const t = useT().stats;
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map(day => day.usage.tokens));
  const shown = hover === null ? days.length - 1 : hover;
  const day = days[shown];
  return (
    <section className="stats-block">
      <h3>{t.daily}</h3>
      <div className="daily" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <button key={d.date} className={i === shown ? "on" : ""} aria-label={`${d.date} ${d.usage.tokens}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)}>
            <i style={{ height: `${Math.max(d.usage.tokens ? 4 : 0, (d.usage.tokens / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      {day && (
        <p className="daily-detail">
          <b>{day.date}</b> · {t.tokens} {compactNumber(day.usage.tokens)} · {t.cacheHit} {percent(day.usage.cacheHitRate)}
          {" "}· {t.tasks} {day.succeeded}/{day.tasks} · {t.wakes} {day.wakes}
          {day.usage.costUsd !== null && <> · {usd(day.usage.costUsd)}</>}
        </p>
      )}
    </section>
  );
}

function usageDetail(usage: StatsUsage) {
  return `${compactNumber(usage.tokens)} · ${usage.calls}×`;
}

export function StatsPanel({ onOpenFeedback }: { onOpenFeedback?: () => void }) {
  const all = useT();
  const t = all.stats;
  const [range, setRange] = useState<StatsRange>("7d");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    api.stats(range).then(setStats, err => setError(String(err.message ?? err)));
  }, [range]);

  const total = stats?.total;
  const empty = stats && total!.calls === 0 && stats.tasks.count === 0 && stats.wakes.count === 0;
  const decisions = stats?.approvals.decisions;

  return (
    <>
      <div className="seg" role="tablist">
        {ranges.map(r => (
          <button key={r} role="tab" aria-selected={range === r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>
            {t.ranges[r]}
          </button>
        ))}
      </div>
      {onOpenFeedback && <button className="fb-entry" onClick={onOpenFeedback}><b>{all.fb.entryTitle}</b><span>{all.fb.entrySub}</span></button>}
      {error && <p className="form-error">{error}</p>}
      {!stats && !error && <p className="empty">{all.loading}</p>}
      {empty && <p className="empty">{t.empty}</p>}
      {stats && total && !empty && <>
        <div className="stat-tiles">
          <Tile label={t.tokens} value={compactNumber(total.tokens)} sub={`${t.input} ${compactNumber(total.input)} · ${t.output} ${compactNumber(total.output)}`} />
          <Tile label={t.cacheHit} value={percent(total.cacheHitRate)} sub={`${t.cacheRead} ${compactNumber(total.cacheRead)}`} />
          <Tile label={t.cost} value={usd(total.costUsd) ?? "—"} sub={total.costUsd === null ? t.noPrice : undefined} />
          <Tile label={t.successRate} value={percent(stats.tasks.successRate)} sub={t.tasksSummary(stats.tasks.completed, stats.tasks.terminal)} />
          <Tile label={t.wakes} value={String(stats.wakes.count)} sub={`${t.calls} ${total.calls}`} />
          {stats.leases.count > 0 && <Tile label={t.leases} value={String(stats.leases.count)}
            sub={t.leasesSub(percent(stats.leases.dispatchAfterLeaseRate))} />}
        </div>

        {stats.daily.length > 1 && <Daily days={stats.daily} />}

        <section className="stats-block">
          <h3>{t.byRole}</h3>
          <ShareRows rows={stats.byRole.map(row => ({ key: row.role, label: t.roles[row.role] ?? row.role, value: row.tokens, detail: usageDetail(row) }))} />
        </section>

        <section className="stats-block">
          <h3>{t.byModel}</h3>
          <ShareRows rows={stats.byModel.map(row => ({
            key: row.model, label: row.model, value: row.tokens,
            detail: `${usageDetail(row)} · ${t.cacheHit} ${percent(row.cacheHitRate)}`,
          }))} />
        </section>

        {stats.wakes.count > 0 && (
          <section className="stats-block">
            <h3>{t.wakeSources}</h3>
            <ShareRows rows={Object.entries(stats.wakes.bySource).sort((a, b) => b[1] - a[1])
              .map(([source, n]) => ({ key: source, label: t.sources[source] ?? source, value: n, detail: String(n) }))} />
          </section>
        )}

        {decisions && decisions.park + decisions.allow + decisions.deny > 0 && (
          <section className="stats-block">
            <h3>{t.approvals}</h3>
            <dl className="stat-list">
              {(["allow", "deny", "park"] as const).map(key => <div key={key}><dt>{t.decisions[key]}</dt><dd>{decisions[key]}</dd></div>)}
              {stats.approvals.byApprover.map(row => <div key={row.approver}><dt>{t.approvers[row.approver] ?? row.approver}</dt><dd>{row.count}</dd></div>)}
            </dl>
          </section>
        )}

        <section className="stats-block">
          <h3>{t.latency}</h3>
          <dl className="stat-list">
            {(["firstToken", "total"] as const).map(key => {
              const l = stats.latency[key];
              return <div key={key}><dt>{t[key]} p50 / p95</dt><dd>{l.p50Ms === null ? "—" : `${seconds(l.p50Ms)} / ${seconds(l.p95Ms ?? l.p50Ms)}`}</dd></div>;
            })}
          </dl>
        </section>

        {stats.tasks.items.length > 0 && (
          <section className="stats-block">
            <h3>{t.tasks}</h3>
            <ul className="rows stat-tasks">
              {[...stats.tasks.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map(task => (
                <li key={task.taskId}>
                  <div className="share-head">
                    <span>{task.taskId}{task.continuedFrom && <small> ← {task.continuedFrom}</small>}</span>
                    <b>{compactNumber(task.usage.tokens)}</b>
                  </div>
                  <div className="row-meta">
                    <span className="chip">{task.status === "cancelled" ? t.cancelled : all[task.status]}</span>
                    <span>{task.models.join(", ")}</span>
                    <span>{task.thinking}</span>
                    <span>{t.rounds(task.rounds)}</span>
                    {task.durationMs !== null && <span>{seconds(task.durationMs)}</span>}
                    {task.usage.costUsd !== null && <span>{usd(task.usage.costUsd)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>}
    </>
  );
}

export function StatsSheet({ onClose, onOpenFeedback }: { onClose: () => void; onOpenFeedback?: () => void }) {
  return (
    <Sheet title={useT().stats.title} onClose={onClose}>
      <StatsPanel onOpenFeedback={onOpenFeedback} />
    </Sheet>
  );
}

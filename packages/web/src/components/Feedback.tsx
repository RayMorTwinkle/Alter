import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import { Sheet } from "./Sheets.tsx";
import type { FeedbackChange, FeedbackStats, FeedbackValue, FeedbackView, IssuedFeedback } from "../types.ts";

type T = ReturnType<typeof useT>["fb"];

const percent = (v: number | null) => v === null ? "—" : `${Math.round(v * 100)}%`;
const day = (at: number) => new Intl.DateTimeFormat(document.documentElement.lang || "zh-Hans", { month: "short", day: "numeric" }).format(at);
const value = (v: FeedbackValue) => v === null ? "—" : Array.isArray(v) ? v.join("、") : String(v);
const clip = (s: string) => s.length > 40 ? `${s.slice(0, 40)}…` : s;

function describe(change: FeedbackChange, t: T) {
  if (change.kind === "memory") return `${t.memoryActions[change.memoryAction ?? "modify"]}${change.after !== null ? `「${clip(value(change.after))}」` : change.before !== null ? `「${clip(value(change.before))}」` : ""}`;
  if (change.kind === "metric") return t.metric(change.key, value(change.after));
  const name = t.params[change.key.split(":")[0] as keyof T["params"]] ?? change.key;
  return `${name}：${value(change.before)} → ${value(change.after)}`;
}

function Question({ item }: { item: IssuedFeedback }) {
  const t = useT().fb;
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (option: string) => setPicked(list => item.multi
    ? list.includes(option) ? list.filter(o => o !== option) : [...list, option]
    : list[0] === option ? [] : [option]);
  async function run(action: "answer" | "skip") {
    setBusy(true);
    setError("");
    try {
      if (action === "skip") await api.skipFeedback(item.id);
      else await api.answerFeedback(item.id, { options: picked, ...(other.trim() && { other: other.trim() }) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }
  const ready = picked.length > 0 || other.trim().length > 0;
  return (
    <article className="fb-question">
      <p className="fb-prompt">{item.prompt}</p>
      <p className="fb-why">{t.why}{item.why}</p>
      <div className="fb-options" role={item.multi ? "group" : "radiogroup"}>
        {item.options.map(option => (
          <button key={option} role={item.multi ? "checkbox" : "radio"} aria-checked={picked.includes(option)}
            className={picked.includes(option) ? "active" : ""} onClick={() => toggle(option)}>{option}</button>
        ))}
      </div>
      {item.allowOther && (
        <input className="fb-other" type="text" value={other} placeholder={t.other} onChange={e => setOther(e.target.value)} />
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !ready} onClick={() => void run("answer")}>{t.submit}</button>
        <button className="text-btn" disabled={busy} onClick={() => void run("skip")}>{t.skip}</button>
      </div>
    </article>
  );
}

function History({ view }: { view: FeedbackView }) {
  const t = useT().fb;
  const [error, setError] = useState("");
  const byId = new Map(view.changes.map(c => [c.id, c]));
  const answered = view.history.filter(h => h.status === "answered").slice(0, 30);
  if (!answered.length) return <p className="empty">{t.noHistory}</p>;
  return (
    <>
      {error && <p className="form-error">{error}</p>}
      <ul className="rows fb-history">
        {answered.map(item => {
          const changes = item.changeIds.map(id => byId.get(id)).filter((c): c is FeedbackChange => !!c && c.kind !== "undo");
          return (
            <li key={item.id}>
              <div className="row-main">
                <div className="fb-asked"><time>{day(item.at ?? item.askedAt)}</time>{item.prompt}</div>
                <div className="fb-answer">{t.youSaid}{[...(item.answer?.options ?? []), ...(item.answer?.other ? [item.answer.other] : [])].join("、")}</div>
                {changes.length > 0 ? (
                  <ul className="fb-changes">
                    {changes.map(change => (
                      <li key={change.id} className={change.undoneBy ? "undone" : ""}>
                        <span>→ {describe(change, t)}</span>
                        {change.undoneBy
                          ? <span className="chip">{t.undone}</span>
                          : <button className="icon-btn ghost" title={t.undo} aria-label={t.undo} onClick={() => {
                              setError("");
                              api.undoFeedbackChange(change.id).catch(err => setError(err instanceof Error ? err.message : String(err)));
                            }}><ArrowCounterClockwise /></button>}
                      </li>
                    ))}
                  </ul>
                ) : <div className="fb-nochange">{t.noChange}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Outcomes({ stats }: { stats: FeedbackStats }) {
  const t = useT().fb;
  const last = (series: { value: number }[]) => series.length ? series[series.length - 1]!.value : null;
  const satisfaction = last(stats.satisfaction);
  return (
    <div className="stat-tiles fb-tiles">
      <div className="stat-tile"><span>{t.answerRate}</span><b>{percent(stats.answerRate)}</b><small>{t.answered(stats.answered, stats.asked)}</small></div>
      <div className="stat-tile"><span>{t.guessRate}</span><b>{percent(stats.guesses.confirmationRate)}</b><small>{t.guesses(stats.guesses.confirmed, stats.guesses.answered)}</small></div>
      <div className="stat-tile"><span>{t.changes}</span><b>{stats.changeCount}</b><small>{t.changesSub}</small></div>
      <div className="stat-tile"><span>{t.satisfaction}</span><b>{satisfaction === null ? "—" : t.satisfactionLevels[Math.round(satisfaction) - 1] ?? satisfaction}</b><small>{t.samples(stats.satisfaction.length)}</small></div>
    </div>
  );
}

export function FeedbackSheet({ view, onClose }: { view: FeedbackView | null; onClose: () => void }) {
  const all = useT();
  const t = all.fb;
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [more, setMore] = useState<"idle" | "busy" | "empty">("idle");
  useEffect(() => { api.feedbackStats().then(setStats, () => {}); }, [view]);
  const pending = view?.pending.filter(p => p.status === "pending") ?? [];
  return (
    <Sheet title={t.title} onClose={onClose}>
      <p className="settings-hint">{t.intro}</p>
      {!view && <p className="empty">{all.loading}</p>}
      {view && (
        <section className="settings-block">
          <h3>{pending.length ? t.pending(pending.length) : t.nonePending}</h3>
          {pending.map(item => <Question key={item.id} item={item} />)}
          <button className="btn" disabled={more === "busy"} onClick={() => {
            setMore("busy");
            api.moreFeedback().then(list => setMore(list.length ? "idle" : "empty"), () => setMore("idle"));
          }}>{t.more}</button>
          {more === "empty" && <p className="settings-hint">{t.moreEmpty}</p>}
        </section>
      )}
      {stats && stats.asked > 0 && (
        <section className="settings-block">
          <h3>{t.outcomes}</h3>
          <Outcomes stats={stats} />
        </section>
      )}
      {view && (
        <section className="settings-block">
          <h3>{t.history}</h3>
          <p className="settings-hint">{t.historyHint}</p>
          <History view={view} />
          <a className="text-btn" href="/api/feedback/export">{t.export}</a>
        </section>
      )}
    </Sheet>
  );
}

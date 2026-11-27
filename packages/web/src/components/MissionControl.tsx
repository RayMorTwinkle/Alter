import { Pulse, ArrowCounterClockwise, ArrowSquareOut, CaretLeft, CaretRight, CheckCircle, GitBranch, Pause, Play, ShieldCheck, SlidersHorizontal } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import e2eReport from "../../../../docs/evals/2026-11-22-e2e.md?url&no-inline";
import injectionReport from "../../../../docs/evals/2026-11-22-injection.md?url&no-inline";
import { approvalRisk } from "../approval-risk.ts";
import { clock, seconds } from "../format.ts";
import { useT } from "../i18n.tsx";
import { replayAt, replayFrames, type RecordedFrame, type ReplayChoice } from "../replay.ts";
import type { State } from "../store.ts";
import type { Task, ToolTrace } from "../types.ts";
import { ApprovalCard, type AnswerRequest } from "./ApprovalCard.tsx";
import { StatusChip } from "./Panels.tsx";
import "../mission.css";

function EvaluationPanel() {
  const m = useT().mission;
  return <section className="mc-card mc-eval">
    <header><div><small>{m.archive} · 2026.11.22</small><h2>{m.evals}</h2></div><ShieldCheck size={24} /></header>
    <div className="mc-eval-score"><strong>33<span>/33</span></strong><a href={e2eReport} target="_blank" rel="noreferrer">{m.complete} <ArrowSquareOut /></a></div>
    <ul>{[15, 6, 9, 3].map((n, i) => <li key={i}><span>{m.categories[i]}</span><meter min={0} max={n} value={n} aria-label={m.categories[i]} /><code>{n}/{n}</code></li>)}</ul>
    <div className="mc-security"><a href={injectionReport} target="_blank" rel="noreferrer">{m.injection} · {m.old} <ArrowSquareOut /></a><b>0 / 10</b><p>{m.noAttempt}</p></div>
  </section>;
}

function TraceList({ traces }: { traces: ToolTrace[] }) {
  const m = useT().mission;
  return <ol className="mc-events">{traces.map(row => <li key={row.id} className={`trace-${row.decision}`}>
    <time>{clock(row.at)}</time><code>{row.tool}</code><span>{m[approvalRisk(row.tool, row.effect)]} · {m[row.decision]}</span></li>)}</ol>;
}

function Lanes({ state, now, onOpen }: { state: State; now: number; onOpen?: (id: string) => void }) {
  const t = useT();
  const m = t.mission;
  const tasks = useMemo(() => [...state.tasks].sort((a, b) => Number(active(b)) - Number(active(a)) || b.createdAt - a.createdAt), [state.tasks]);
  const traces = useMemo(() => {
    const grouped = new Map<string, ToolTrace[]>();
    for (const trace of state.traces ?? []) {
      const rows = grouped.get(trace.taskId) ?? [];
      rows.push(trace);
      grouped.set(trace.taskId, rows);
    }
    return grouped;
  }, [state.traces]);
  const latest = state.timeline.at(-1);
  return <section className="mc-card mc-lanes"><header><h2><GitBranch />{m.lanes}</h2><code>{tasks.length} SUB</code></header>
    <div className="mc-main-lane"><div className="mc-lane-head"><span className="lane-symbol"><Pulse /></span>
      <div><small>MAIN</small><h3>{m.main}</h3></div><span className="mc-state">{state.busy ? t.thinking : t.idle}</span></div>
      {(state.draft || latest) && <p>{state.draft?.text ?? (latest?.kind === "tool" ? latest.tool : latest?.text)}</p>}
      {!!traces.get("main")?.length && <TraceList traces={traces.get("main")!.slice(-4)} />}</div>
    <div className="mc-branches">{tasks.length === 0 && <p className="mc-empty">{m.empty}</p>}
    {tasks.map(task => {
      const rows = traces.get(task.taskId) ?? [];
      const end = active(task) ? now : task.endedAt;
      const elapsed = end === undefined ? m.endedUnknown : seconds(Math.max(0, end - task.createdAt));
      return <article key={task.taskId} className="mc-agent"><div className="mc-agent-meta"><small>{m.agent} / {task.taskId}</small><StatusChip status={task.status} /></div>
        <h3>{task.brief}</h3><div className="mc-timing"><span>{m.queued} <time>{clock(task.createdAt)}</time></span><span>{m.elapsed} <b>{elapsed}</b></span></div>
        {rows.length > 0 && <TraceList traces={rows.slice(-4)} />}
        {rows.length > 4 && <details><summary>{m.toolEvents} ({rows.length - 4})</summary><TraceList traces={rows.slice(0, -4)} /></details>}
        {task.failure && <p className="form-error">{task.failure}</p>}
        {onOpen && <button className="text-btn" onClick={() => onOpen(task.taskId)}>{m.open} <CaretRight /></button>}
      </article>;
    })}</div>
  </section>;
}

function active(task: Task) { return task.status === "running" || task.status === "queued"; }

export function MissionBoard({ state, now, onAnswer, replay, onOpen, controls }: {
  state: State; now: number; onAnswer?: AnswerRequest; replay?: boolean; onOpen?: (id: string) => void; controls?: React.ReactNode;
}) {
  const t = useT();
  const m = t.mission;
  const connected = import.meta.env.MODE === "demo" ? m.mock : m.live;
  const connection = state.connection === "lost" ? t.offline : state.connection === "connecting" ? m.connect : connected;
  const source = replay ? (onAnswer ? m.sample : m.recording) : connection;
  const activeCount = state.tasks.filter(active).length;
  const pending = state.pending.filter(req => req.audience === "user");
  return <main className="mc-board"><div className="mc-wrap">
    <div className="mc-title"><div><small>ALTER / MISSION CONTROL</small><h1>{m.title}</h1></div>
      <span className="mc-source"><i />{source}</span></div>
    <section aria-label={m.title} className="mc-summary">{[[m.active, activeCount], [m.waiting, pending.length], [m.settled, state.tasks.length - activeCount]].map(([label, count]) =>
      <div key={label}><span>{label}</span><b>{String(count).padStart(2, "0")}</b></div>)}</section>
    {controls}
    <div className="mc-grid"><Lanes state={state} now={now} onOpen={onOpen} />
      <aside><section className="mc-card mc-approvals"><header><h2><ShieldCheck />{m.review}</h2><code>{pending.length}</code></header>
        {pending.length ? pending.map(request => <ApprovalCard key={request.id} request={request} onAnswer={onAnswer} replayTime={replay ? now : undefined} />)
          : <p className="mc-empty"><CheckCircle />{m.noRequests}</p>}</section><EvaluationPanel /></aside></div>
  </div></main>;
}

export function LiveMission({ state, onAnswer, onOpen }: { state: State; onAnswer: AnswerRequest; onOpen: (id: string) => void }) {
  const [now, setNow] = useState(Date.now);
  const ticking = state.tasks.some(active);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return <MissionBoard state={state} now={now} onAnswer={onAnswer} onOpen={onOpen} />;
}

type PlaybackFrame = { at: number };
function Player({ frames, cursor, playing, setPlaying, seek, label }: {
  frames: PlaybackFrame[]; cursor: number; playing: boolean; setPlaying: (playing: boolean) => void; seek: (index: number) => void; label: string;
}) {
  const m = useT().mission;
  const last = frames.length - 1;
  const frame = frames[cursor]!;
  useEffect(() => {
    if (!playing) return;
    if (cursor === last) { setPlaying(false); return; }
    const timer = setTimeout(() => seek(cursor + 1), Math.min(2_147_483_647, frames[cursor + 1]!.at - frame.at));
    return () => clearTimeout(timer);
  }, [playing, cursor, last, frames, frame.at, seek, setPlaying]);
  function scrub(index: number) { setPlaying(false); seek(index); }
  const start = frames[0]!.at;
  return <section className="mc-player"><header><h2><SlidersHorizontal />Stream Replay</h2><span>{m.current} {cursor + 1}/{frames.length}</span></header>
    <div className="mc-scrubber"><button aria-label={playing ? m.pause : cursor === last ? m.restart : m.play} disabled={!last} onClick={() => {
      if (cursor === last) seek(0);
      setPlaying(!playing);
    }}>{playing ? <Pause /> : cursor === last ? <ArrowCounterClockwise /> : <Play weight="fill" />}</button>
      <input aria-label={m.clock} type="range" min={0} max={last} value={cursor} aria-valuetext={label} onChange={event => scrub(Number(event.target.value))} />
      <output>{((frame.at - start) / 1000).toFixed(1)}s / {((frames[last]!.at - start) / 1000).toFixed(1)}s</output></div>
    <footer><span>{label}</span><div>
      <button aria-label={m.previous} disabled={!cursor} onClick={() => scrub(cursor - 1)}><CaretLeft /></button>
      <button aria-label={m.next} disabled={cursor === last} onClick={() => scrub(cursor + 1)}><CaretRight /></button>
    </div></footer>
  </section>;
}

export function RecordedMission({ frames }: { frames: RecordedFrame[] }) {
  const [cursor, seek] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = frames[cursor]!;
  return <MissionBoard state={frame.state} now={frame.at} replay controls={
    <Player frames={frames} cursor={cursor} playing={playing} setPlaying={setPlaying} seek={seek} label={frame.event} />
  } />;
}

export function ReplayMission() {
  const m = useT().mission;
  const [cursor, seek] = useState(4);
  const [playing, setPlaying] = useState(false);
  const [choice, setChoice] = useState<ReplayChoice>("once");
  const frames = useMemo(() => replayFrames(choice), [choice]);
  const state = useMemo(() => replayAt(frames, cursor), [frames, cursor]);
  const answer: AnswerRequest = async (id, decision) => {
    if (!state.pending.some(req => req.id === id) || (decision !== "deny" && decision !== "call")) return;
    setPlaying(false);
    setChoice(decision === "call" ? "once" : "deny");
    seek(cursor + 1);
  };
  const label = m.frames[cursor] + (cursor >= 5 ? " · " + m[choice === "deny" ? "deny" : "allow"] : "");
  return <MissionBoard state={state} now={frames[cursor]!.at} onAnswer={answer} replay controls={
    <Player frames={frames} cursor={cursor} playing={playing} setPlaying={setPlaying} seek={seek} label={label} />
  } />;
}

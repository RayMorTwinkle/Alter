import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { clock, compactNumber, pretty } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { DebugInterval, DebugOutputPart, DebugSchedule, DebugTrace, DebugTraceSummary } from "../types.ts";
import { Sheet } from "./Sheets.tsx";

const triggers = ["user-web", "user-feishu", "user-cli", "heartbeat", "report", "schedule", "report-due", "watch", "triage", "approval", "compaction"];

function duration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

// Gateway and transcript messages differ in shape; flatten either into readable text.
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return String(part);
  const p = part as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  if (typeof p.thinking === "string") return `〔思考〕${p.thinking}`;
  if (p.type === "toolCall") return `→ ${String(p.name)}(${JSON.stringify(p.arguments)})`;
  if (p.type === "image" || p.type === "image_url") return "〔圖片〕";
  return JSON.stringify(p);
}
function messageText(message: Record<string, unknown>) {
  const content = message.content;
  const body = Array.isArray(content) ? content.map(partText).join("\n") : content === undefined || content === null ? "" : partText(content);
  const calls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as { function?: { name?: string; arguments?: string } }[]).map(c => `→ ${c.function?.name}(${c.function?.arguments ?? ""})`).join("\n")
    : "";
  return [body, calls].filter(Boolean).join("\n");
}
function roleOf(message: Record<string, unknown>) {
  const name = message.toolName ?? message.name;
  return typeof name === "string" && (message.role === "tool" || message.role === "toolResult") ? `${message.role} · ${name}` : String(message.role);
}

function OutputPart({ part }: { part: DebugOutputPart }) {
  if (part.type === "text") return <pre className="dbg-pre">{part.text}</pre>;
  if (part.type === "thinking") return <pre className="dbg-pre dbg-thinking">{part.redacted ? "〔已隱去〕" : part.thinking}</pre>;
  return <pre className="dbg-pre dbg-call">→ {part.name}({pretty(part.arguments)}){part.argumentsError ? `\n${part.argumentsError}` : ""}</pre>;
}

function TraceDetail({ id }: { id: number }) {
  const t = useT().debug;
  const [trace, setTrace] = useState<DebugTrace | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.debugTrace(id).then(setTrace, err => setError(String(err.message ?? err))); }, [id]);
  if (error) return <p className="form-error">{error}</p>;
  if (!trace) return <p className="settings-hint">{t.loading}</p>;
  const last = trace.messages.length - 1;
  return (
    <div className="dbg-detail">
      <details>
        <summary>{t.systemPrompt} <small>{trace.systemPrompt.length} {t.chars} · {trace.promptHash.slice(0, 8)}</small></summary>
        <pre className="dbg-pre">{trace.systemPrompt}</pre>
      </details>
      <details>
        <summary>{t.tools(trace.tools.length)} <small>{trace.toolsHash.slice(0, 8)}</small></summary>
        <ul className="dbg-tools">
          {trace.tools.map(tool => (
            <li key={tool.name}>
              <details>
                <summary><code>{tool.name}</code> <span>{tool.description}</span></summary>
                <pre className="dbg-pre">{pretty(tool.parameters)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </details>
      <details open>
        <summary>{t.input(trace.messages.length)}</summary>
        <ol className="dbg-messages">
          {trace.messages.map((message, index) => (
            <li key={index}>
              <details open={index === last}>
                <summary><span className={`dbg-role ${String(message.role)}`}>{roleOf(message)}</span> <span>{messageText(message).slice(0, 90)}</span></summary>
                <pre className="dbg-pre">{messageText(message)}</pre>
              </details>
            </li>
          ))}
        </ol>
      </details>
      <details open>
        <summary>{t.output}{trace.output ? ` · ${trace.output.stopReason}` : ""}</summary>
        {trace.output?.errorMessage && <p className="form-error">{trace.output.errorMessage}</p>}
        {trace.output?.content.map((part, index) => <OutputPart key={index} part={part} />) ?? <p className="settings-hint">{t.noOutput}</p>}
      </details>
      {trace.toolResults.length > 0 && (
        <details open>
          <summary>{t.toolResults(trace.toolResults.length)}</summary>
          {trace.toolResults.map(result => (
            <div key={result.toolCallId} className="dbg-result">
              <code className={result.isError ? "dbg-error" : ""}>{result.name}{result.isError ? ` · ${t.error}` : ""}{result.truncated ? ` · ${t.truncated}` : ""}</code>
              <pre className="dbg-pre">{result.text}</pre>
            </div>
          ))}
        </details>
      )}
      <details>
        <summary>{t.options}</summary>
        <pre className="dbg-pre">{pretty(trace.options)}</pre>
      </details>
    </div>
  );
}

function TraceRow({ row, open, onToggle }: { row: DebugTraceSummary; open: boolean; onToggle: () => void }) {
  const t = useT().debug;
  const { input = 0, output = 0, cacheRead = 0 } = row.tokens;
  return (
    <li className={`dbg-row ${open ? "open" : ""}`}>
      <button className="dbg-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="dbg-time">{clock(row.at)}</span>
        <span className={`dbg-trigger ${row.trigger.startsWith("user") ? "user" : ""}`}>{t.triggers[row.trigger] ?? row.trigger}</span>
        <span className="dbg-model">{row.model}{row.fallback ? ` · ${t.fallback}` : ""}</span>
        <span className="dbg-num" title={t.tokensTitle}>{compactNumber(input + cacheRead)} → {compactNumber(output)}</span>
        <span className="dbg-num">{row.latencyMs === null ? "—" : duration(row.latencyMs)}</span>
        <span className="dbg-num">{row.toolCallCount ? t.calls(row.toolCallCount) : ""}</span>
        {(row.isError || row.outcome === "error") && <span className="dbg-error">{t.error}</span>}
      </button>
      {open && <TraceDetail id={row.id} />}
    </li>
  );
}

function Traces() {
  const t = useT().debug;
  const [conversation, setConversation] = useState<"main" | "task">("main");
  const [trigger, setTrigger] = useState("");
  const [rows, setRows] = useState<DebugTraceSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function load(before?: string) {
    setError("");
    try {
      const page = await api.debugTraces({ conversation, ...(trigger && { trigger }), ...(before && { before }), limit: 50 });
      setRows(list => before ? [...list, ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  useEffect(() => { setOpen(null); void load(); }, [conversation, trigger]);
  return (
    <>
      <div className="dbg-filters">
        <div className="seg" role="tablist">
          {(["main", "task"] as const).map(c => (
            <button key={c} role="tab" aria-selected={conversation === c} className={conversation === c ? "active" : ""} onClick={() => setConversation(c)}>{t.conversations[c]}</button>
          ))}
        </div>
        <select value={trigger} onChange={event => setTrigger(event.target.value)} aria-label={t.trigger}>
          <option value="">{t.allTriggers}</option>
          {triggers.map(id => <option key={id} value={id}>{t.triggers[id]}</option>)}
        </select>
        <button className="btn quiet" onClick={() => void load()}>{t.refresh}</button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {rows.length === 0 && !error && <p className="settings-hint">{t.empty}</p>}
      <ul className="dbg-list">
        {rows.map(row => <TraceRow key={row.id} row={row} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} />)}
      </ul>
      {cursor && <button className="btn quiet" onClick={() => void load(cursor)}>{t.more}</button>}
    </>
  );
}

function Interval({ label, value }: { label: string; value: DebugInterval }) {
  const t = useT().debug;
  return (
    <div className="dbg-interval">
      <b>{label}</b>
      <dl>
        <dt>{t.adoption}</dt><dd>{Math.round(value.adoptionRate * 100)}%</dd>
        <dt>{t.dueGoals}</dt><dd>{value.dueGoals}</dd>
        <dt>{t.digests}</dt><dd>{value.digestCount}</dd>
        <dt>{t.userMessages}</dt><dd>{value.userMessages}</dd>
        <dt>{t.formula}</dt><dd>{duration(value.baseMs)} × {value.factor.toFixed(2)}{value.bias !== 1 ? ` × ${value.bias}` : ""} = {duration(value.rawMs)}</dd>
        <dt>{t.result}</dt><dd>{duration(value.intervalMs)}{value.clamped ? ` (${t.clamped[value.clamped]})` : ""}</dd>
      </dl>
      <p>{value.reason}</p>
    </div>
  );
}

function Schedule() {
  const t = useT().debug;
  const [schedule, setSchedule] = useState<DebugSchedule | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.debugSchedule().then(setSchedule, err => setError(String(err.message ?? err))); }, []);
  if (error) return <p className="form-error">{error}</p>;
  if (!schedule) return <p className="settings-hint">{t.loading}</p>;
  const next = (at: number | null) => at ? clock(at) : "—";
  const { heartbeat, report } = schedule;
  return (
    <>
      <section className="dbg-card">
        <h3>{t.heartbeat}</h3>
        <p className="dbg-facts">
          <span>{heartbeat.enabled ? `${heartbeat.start}–${heartbeat.end}` : t.off}</span>
          <span>{t.last} {next(heartbeat.lastAt)}</span>
          <span>{t.next} {next(heartbeat.nextAt)}</span>
          <span>{t.interval} {duration(heartbeat.intervalMs)}</span>
        </p>
        <p>{heartbeat.reason}</p>
        <div className="dbg-intervals">
          {heartbeat.lastDecision && <Interval label={t.lastDecision} value={heartbeat.lastDecision} />}
          <Interval label={t.current} value={heartbeat.current} />
        </div>
      </section>
      <section className="dbg-card">
        <h3>{t.report}</h3>
        <p className="dbg-facts"><span>{t.next} {next(report.nextAt)}</span><span>{t.last} {next(report.lastCheck)}</span></p>
        <p>{report.reason}</p>
      </section>
      <section className="dbg-card">
        <h3>{t.memory}</h3>
        <p className="dbg-facts"><span>{t.next} {next(schedule.memory.nextAt)}</span></p>
        <p>{schedule.memory.reason}</p>
      </section>
      <section className="dbg-card">
        <h3>{t.watch}</h3>
        <p>{schedule.watch.reason}</p>
        {schedule.watch.active.map(w => <p key={w.id} className="dbg-facts"><code>{w.id}</code><span>{t.next} {next(w.nextPollAt)}</span></p>)}
      </section>
      <section className="dbg-card">
        <h3>{t.feedback}</h3>
        <p className="dbg-facts"><span>{t.next} {next(schedule.feedback.nextAt)}</span></p>
        <p>{schedule.feedback.reason}</p>
      </section>
      {schedule.scheduledTasks.length > 0 && (
        <section className="dbg-card">
          <h3>{t.scheduled}</h3>
          {schedule.scheduledTasks.map(item => (
            <div key={item.id} className="dbg-sched">
              <p className="dbg-facts"><b>{item.brief}</b><span>{t.next} {next(item.nextAt ?? null)}</span>{item.paused && <span>{t.paused}</span>}</p>
              <p>{item.reason}</p>
            </div>
          ))}
        </section>
      )}
      <p className="settings-hint">{t.timeZone} {schedule.timeZone}</p>
    </>
  );
}

export function DebugSheet({ onClose }: { onClose: () => void }) {
  const t = useT().debug;
  const [view, setView] = useState<"traces" | "schedule">("traces");
  return (
    <Sheet title={t.title} onClose={onClose} wide>
      <div className="seg" role="tablist">
        {(["traces", "schedule"] as const).map(v => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{t.views[v]}</button>
        ))}
      </div>
      {view === "traces" ? <Traces /> : <Schedule />}
    </Sheet>
  );
}

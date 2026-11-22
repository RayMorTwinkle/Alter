import { ArrowUp, CheckCircle, Stop, WarningCircle, HandPalm } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { clock } from "../format.ts";
import { useT } from "../i18n.tsx";
import { Markdown } from "../markdown.tsx";
import type { State } from "../store.ts";
import type { ApprovalDecision, PermissionRequest, TimelineItem } from "../types.ts";
import { ApprovalCard } from "./Panels.tsx";

type Props = {
  state: State;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onAnswer: (id: string, decision: ApprovalDecision, note?: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
};

export function Chat({ state, onSend, onStop, onAnswer, onOpenTask }: Props) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.timeline, state.draft, state.pending]);

  const empty = state.timeline.length === 0 && !state.draft;
  return (
    <section className="chat" aria-label={t.conversation}>
      <div className="chat-scroll" ref={scroller}
        onScroll={event => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}>
        <div className="chat-inner">
          {empty && <p className="empty chat-empty">{t.emptyConversation}</p>}
          {state.timeline.map(item => (
            <Item key={item.id} item={item} pending={state.pending} onAnswer={onAnswer} onOpenTask={onOpenTask} />
          ))}
          {state.draft && (
            <article className="msg assistant streaming">
              <Markdown text={state.draft.text} />
              <span className="caret" aria-hidden />
            </article>
          )}
          {state.busy && !state.draft && <div className="typing" aria-label={t.thinking}><i /><i /><i /></div>}
        </div>
      </div>
      <Composer busy={state.busy} onSend={onSend} onStop={onStop} />
    </section>
  );
}

function Item({ item, pending, onAnswer, onOpenTask }: {
  item: TimelineItem; pending: PermissionRequest[];
  onAnswer: Props["onAnswer"]; onOpenTask: Props["onOpenTask"];
}) {
  const t = useT();
  switch (item.kind) {
    case "user":
      return <article className="msg user"><Markdown text={item.text} /><time>{item.source === "feishu" && `${t.viaFeishu} · `}{clock(item.at)}</time></article>;
    case "assistant":
      return (
        <article className="msg assistant">
          <Markdown text={item.text} />
          <time title={item.model}>{clock(item.at)}</time>
        </article>
      );
    case "report": {
      const failed = /^task \S+ failed/i.test(item.text);
      const body = item.text.replace(/^task \S+ (finished|failed):\s*/i, "");
      return (
        <article className={`report ${failed ? "failed" : ""}`}>
          <header>
            {failed ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />}
            <span>{failed ? t.reportFailed : t.reportDone}</span>
            {item.taskId && <code>{item.taskId}</code>}
            <time>{clock(item.at)}</time>
          </header>
          <Markdown text={body} />
          {item.taskId && <button className="link" onClick={() => onOpenTask(item.taskId!)}>{t.viewProcess}</button>}
        </article>
      );
    }
    case "permission": {
      const open = pending.filter(request => request.taskId === item.taskId && request.audience === "user");
      if (open.length) {
        return <>{open.map(request => <ApprovalCard key={request.id} request={request} onAnswer={onAnswer} inline />)}</>;
      }
      return (
        <p className="notice resolved"><HandPalm /> {item.text} · {t.resolved} <time>{clock(item.at)}</time></p>
      );
    }
    case "notice":
      return <p className="notice">{item.text} <time>{clock(item.at)}</time></p>;
  }
}

function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: Props["onSend"]; onStop: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  async function submit() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await onSend(value);
      setText("");
    } finally {
      setSending(false);
      area.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter confirms an IME candidate while composing Chinese; only send outside composition.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer">
      <textarea ref={area} rows={1} value={text} placeholder={t.placeholder}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      {busy && !text.trim()
        ? <button className="icon-btn" onClick={onStop} title={t.stop} aria-label={t.stop}><Stop weight="fill" /></button>
        : <button className="icon-btn primary" onClick={() => void submit()} disabled={!text.trim() || sending}
            title={t.send} aria-label={t.send}><ArrowUp weight="bold" /></button>}
    </div>
  );
}

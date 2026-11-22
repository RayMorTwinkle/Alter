import { Bell, Brain, CalendarBlank, ChartBar, ChatCircle, ListChecks, Notebook, SealCheck, SignOut } from "@phosphor-icons/react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { api, connect, Unauthorized } from "./api.ts";
import { AgendaPanel } from "./components/Agenda.tsx";
import { Chat } from "./components/Chat.tsx";
import { Login } from "./components/Login.tsx";
import { MemoryPanel } from "./components/Memory.tsx";
import { ApprovalsPanel, LedgerPanel, TasksPanel } from "./components/Panels.tsx";
import { NotificationsSheet, TaskSheet, UsageSheet } from "./components/Sheets.tsx";
import { I18n, useT } from "./i18n.tsx";
import { initialState, reduce, userPending } from "./store.ts";
import type { ApprovalDecision, FeishuPairing } from "./types.ts";
import { defaultLocale, strings, type Locale } from "./strings.ts";

type Auth = "checking" | "out" | "in";
type Tab = "chat" | "tasks" | "approvals" | "agenda" | "memory" | "ledger";

export function App() {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [auth, setAuth] = useState<Auth>("checking");
  const t = strings[locale];

  useEffect(() => {
    document.documentElement.lang = locale === "hant" ? "zh-Hant" : "zh-Hans";
    try { localStorage.setItem("alter.locale", locale); } catch { /* storage unavailable */ }
  }, [locale]);

  useEffect(() => {
    api.state().then(() => setAuth("in"), err => setAuth(err instanceof Unauthorized ? "out" : "in"));
  }, []);

  return (
    <I18n.Provider value={t}>
      {auth === "checking" && <div className="splash"><span className="wordmark large">Alter</span></div>}
      {auth === "out" && <Login onDone={() => setAuth("in")} />}
      {auth === "in" && (
        <Workspace onSignedOut={() => setAuth("out")}
          onToggleLocale={() => setLocale(locale === "hant" ? "hans" : "hant")} />
      )}
    </I18n.Provider>
  );
}

function Workspace({ onSignedOut, onToggleLocale }: { onSignedOut: () => void; onToggleLocale: () => void }) {
  const t = useT();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [tab, setTab] = useState<Tab>("chat");
  const [side, setSide] = useState<Exclude<Tab, "chat">>("tasks");
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [showNotices, setShowNotices] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => connect(dispatch, onSignedOut), [onSignedOut]);

  // The code rotates every 10 minutes until the owner pairs; a 404 means Feishu is not configured.
  // Connecting the account leaves the page for Feishu and returns to "/", which refetches.
  const [feishu, setFeishu] = useState<FeishuPairing | null>(null);
  const [feishuTick, setFeishuTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => api.feishu().then(status => {
      setFeishu(status);
      if (!status.paired) timer = setTimeout(poll, 15_000);
    }, () => setFeishu(null));
    void poll();
    return () => clearTimeout(timer);
  }, [feishuTick]);
  const onDisconnectFeishu = () => {
    if (confirm(t.feishuDisconnectConfirm)) void guard(() => api.disconnectFeishu()).then(() => setFeishuTick(n => n + 1), () => {});
  };

  const waiting = userPending(state).length;
  useEffect(() => {
    const prefix = waiting ? `(${waiting}) ` : state.busy ? "· " : "";
    document.title = `${prefix}Alter`;
  }, [waiting, state.busy]);

  const guard = useCallback(async (work: () => Promise<unknown>) => {
    setError("");
    try {
      await work();
    } catch (err) {
      if (err instanceof Unauthorized) onSignedOut();
      else setError((err as Error).message);
      throw err;
    }
  }, [onSignedOut]);

  const onSend = (text: string) => guard(() => api.send(text));
  const onAnswer = (id: string, decision: ApprovalDecision, note?: string) => guard(() => api.answer(id, decision, note));
  const onStop = () => void guard(() => api.stop()).catch(() => {});
  const onLogout = () => void api.logout().finally(onSignedOut);
  const notices = state.notifications ?? [];
  const unread = notices.filter(item => item.status === "unread");
  // Opening the list counts as reading it; this is the funnel's "opened" step.
  const openNotices = () => {
    setShowNotices(true);
    for (const item of unread) void api.updateNotification(item.id, { status: "read" }).catch(() => {});
  };
  const onFeedback = (id: string, feedback: "useful" | "useless") => void guard(() => api.updateNotification(id, { feedback })).catch(() => {});

  const panels = {
    tasks: <TasksPanel tasks={state.tasks} leases={state.leases} onOpen={setOpenTask} />,
    approvals: <ApprovalsPanel pending={state.pending} onAnswer={onAnswer} />,
    agenda: state.agenda && <AgendaPanel agenda={state.agenda} />,
    memory: <MemoryPanel items={state.memory}
      onUpdate={(id, patch) => guard(() => api.updateMemory(id, patch))} onDelete={id => guard(() => api.deleteMemory(id))} />,
    ledger: <LedgerPanel ledger={state.ledger} onOpen={setOpenTask} />,
  };
  const tabs: { id: Tab; label: string; icon: typeof ChatCircle; count?: number }[] = [
    { id: "chat", label: t.conversation, icon: ChatCircle },
    { id: "tasks", label: t.tasks, icon: ListChecks, count: state.tasks.filter(task => task.status === "running").length },
    { id: "approvals", label: t.approvals, icon: SealCheck, count: waiting },
    ...state.agenda ? [{ id: "agenda" as const, label: t.agenda, icon: CalendarBlank }] : [],
    { id: "memory", label: t.memory, icon: Brain, count: state.memory.filter(item => item.status === "pending").length },
    { id: "ledger", label: t.ledger, icon: Notebook },
  ];

  return (
    <div className={`app tab-${tab}`}>
      <header className="topbar">
        <span className="wordmark">Alter</span>
        <span className={`status ${state.connection !== "open" ? "lost" : state.busy ? "busy" : ""}`}>
          <i />{state.connection === "lost" ? t.offline : state.busy ? t.thinking : t.idle}
        </span>
        <div className="topbar-actions">
          {feishu && !feishu.paired && (
            <span className="pair-code" title={t.feishuPairHint}>
              <span className="pair-label">{t.feishuPair}</span>
              <b>{feishu.code.slice(0, 3)} {feishu.code.slice(3)}</b>
            </span>
          )}
          {feishu?.paired && !feishu.account.connected && (
            <a className="text-btn" href="/api/feishu/oauth/start" title={t.feishuConnectHint}>{t.feishuConnect}</a>
          )}
          {feishu?.paired && feishu.account.connected && (
            <button className="pair-code" onClick={onDisconnectFeishu} title={t.feishuDisconnect}>
              <span className="pair-label">{t.viaFeishu}</span><b>{feishu.account.name ?? t.feishuConnected}</b>
            </button>
          )}
          <button className="icon-btn ghost bell" onClick={openNotices} title={t.notifications} aria-label={t.notifications}>
            <Bell />{unread.length > 0 && <span className="badge">{unread.length}</span>}
          </button>
          <button className="icon-btn ghost" onClick={() => setShowUsage(true)} title={t.usage} aria-label={t.usage}><ChartBar /></button>
          <button className="text-btn" onClick={onToggleLocale}>{t.language}</button>
          <button className="icon-btn ghost" onClick={onLogout} title={t.logout} aria-label={t.logout}><SignOut /></button>
        </div>
      </header>

      {error && <div className="toast" role="alert" onClick={() => setError("")}>{t.error}：{error}</div>}

      <main className="workspace">
        <Chat state={state} onSend={onSend} onStop={onStop} onAnswer={onAnswer} onOpenTask={setOpenTask} />
        <aside className="side">
          <nav className="side-tabs" role="tablist">
            {tabs.slice(1).map(({ id, label, count }) => (
              <button key={id} role="tab" aria-selected={side === id} className={side === id ? "active" : ""}
                onClick={() => setSide(id as typeof side)}>
                {label}{count ? <span className={id === "approvals" ? "badge" : "count"}>{count}</span> : null}
              </button>
            ))}
          </nav>
          {panels[side]}
        </aside>
        {tab !== "chat" && <section className="mobile-panel">{panels[tab]}</section>}
      </main>

      <nav className="tabbar" role="tablist">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            <span className="tab-icon"><Icon weight={tab === id ? "fill" : "regular"} />
              {count ? <span className={id === "approvals" ? "badge dot" : "count dot"}>{count}</span> : null}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {openTask && <TaskSheet taskId={openTask} task={state.tasks.find(task => task.taskId === openTask)} onClose={() => setOpenTask(null)} />}
      {showUsage && <UsageSheet onClose={() => setShowUsage(false)} />}
      {showNotices && <NotificationsSheet items={notices} onClose={() => setShowNotices(false)} onFeedback={onFeedback} />}
    </div>
  );
}

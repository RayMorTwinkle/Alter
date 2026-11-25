import { Bell, Binoculars, Bug, Desktop, GearSix, UsersThree, Brain, CalendarBlank, ChartBar, ChatCircle, ListChecks, Notebook, SealCheck, SignOut } from "@phosphor-icons/react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { api, connect, gatewayApi, Unauthorized } from "./api.ts";
import { AgendaPanel } from "./components/Agenda.tsx";
import { Chat } from "./components/Chat.tsx";
import { Login } from "./components/Login.tsx";
import { GatewayLogin } from "./components/GatewayLogin.tsx";
import { AdminSheet } from "./components/Admin.tsx";
import { NodesSheet } from "./components/Nodes.tsx";
import { MemoryPanel } from "./components/Memory.tsx";
import { ApprovalsPanel, LedgerPanel, TasksPanel } from "./components/Panels.tsx";
import { NotificationsSheet, TaskSheet } from "./components/Sheets.tsx";
import { clock } from "./format.ts";
import { StatsSheet } from "./components/Stats.tsx";
import { DebugSheet } from "./components/Debug.tsx";
import { SettingsSheet } from "./components/Settings.tsx";
import { FeedbackSheet } from "./components/Feedback.tsx";
import { HeartbeatSheet } from "./components/Heartbeat.tsx";
import { I18n, useT } from "./i18n.tsx";
import { initialState, reduce, userPending } from "./store.ts";
import type { ApprovalDecision, FeishuPairing, GatewayUser, HeartbeatView } from "./types.ts";
import { defaultLocale, strings, type Locale } from "./strings.ts";

// "gateway-out" means a multi-user gateway sits in front and wants a username; "out" is the single-owner password page.
type Auth = "checking" | "out" | "gateway-out" | "in";
type Tab = "chat" | "tasks" | "approvals" | "agenda" | "memory" | "ledger";

export function App() {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [auth, setAuth] = useState<Auth>("checking");
  const [user, setUser] = useState<GatewayUser | null>(null);
  const t = strings[locale];

  useEffect(() => {
    document.documentElement.lang = locale === "hant" ? "zh-Hant" : "zh-Hans";
    try { localStorage.setItem("alter.locale", locale); } catch { /* storage unavailable */ }
  }, [locale]);

  // Without a gateway, /gateway/me falls through to the page itself and fails to parse, which reads as "no gateway".
  useEffect(() => {
    api.state().then(
      () => gatewayApi.me().then(setUser, () => setUser(null)).finally(() => setAuth("in")),
      err => err instanceof Unauthorized
        ? gatewayApi.me().then(me => { setUser(me); setAuth("in"); }, gwErr => setAuth(gwErr instanceof Unauthorized ? "gateway-out" : "out"))
        : setAuth("in"));
  }, []);
  const onSignedOut = useCallback(() => setAuth(user ? "gateway-out" : "out"), [user]);

  return (
    <I18n.Provider value={t}>
      {auth === "checking" && <div className="splash"><span className="wordmark large">Alter</span></div>}
      {auth === "out" && <Login onDone={() => setAuth("in")} />}
      {auth === "gateway-out" && <GatewayLogin onDone={me => { setUser(me); setAuth("in"); }} />}
      {auth === "in" && (
        <Workspace user={user} onSignedOut={onSignedOut}
          onToggleLocale={() => setLocale(locale === "hant" ? "hans" : "hant")} />
      )}
    </I18n.Provider>
  );
}

function Workspace({ user, onSignedOut, onToggleLocale }: { user: GatewayUser | null; onSignedOut: () => void; onToggleLocale: () => void }) {
  const t = useT();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [tab, setTab] = useState<Tab>("chat");
  const [side, setSide] = useState<Exclude<Tab, "chat">>("tasks");
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showNodes, setShowNodes] = useState(false);
  // Until a computer is paired, the header spells the entry out instead of showing a bare icon.
  const [hasNodes, setHasNodes] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showHeartbeat, setShowHeartbeat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const awaiting = state.extPlugins.find(p => p.pending);
  const [showFeedback, setShowFeedback] = useState(false);
  // Check-ins are paused (ADR-0017); keep the sheet but stop inviting answers.
  const feedbackPaused = true;
  const questions = feedbackPaused ? 0 : state.feedback?.pending.filter(p => p.status === "pending").length ?? 0;
  const [heartbeat, setHeartbeat] = useState<HeartbeatView | null>(null);
  const [heartbeatTick, setHeartbeatTick] = useState(0);
  const [showNotices, setShowNotices] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => connect(dispatch, onSignedOut), [onSignedOut]);
  // Refetched on every heartbeat SSE event and after the owner acts in the sheet; a 404 means no heartbeat on this server.
  useEffect(() => { if (!showNodes) api.nodes().then(list => setHasNodes(list.length > 0), () => {}); }, [showNodes]);
  useEffect(() => { api.heartbeat().then(setHeartbeat, () => setHeartbeat(null)); }, [state.heartbeatTick, heartbeatTick]);

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
  const onLogout = () => void (user ? gatewayApi.logout() : api.logout()).finally(onSignedOut);
  const notices = state.notifications ?? [];
  const unread = notices.filter(item => item.status === "unread");
  // Opening the list counts as reading it; this is the funnel's "opened" step.
  const openNotices = () => {
    setShowNotices(true);
    for (const item of unread) void api.updateNotification(item.id, { status: "read" }).catch(() => {});
  };
  const onFeedback = (id: string, feedback: "useful" | "useless") => void guard(() => api.updateNotification(id, { feedback })).catch(() => {});

  const panels = {
    tasks: <TasksPanel tasks={state.tasks} leases={state.leases} watches={state.watches ?? []} onOpen={setOpenTask}
      onCancelWatch={id => void guard(() => api.cancelWatch(id)).catch(() => {})} />,
    approvals: <ApprovalsPanel pending={state.pending} onAnswer={onAnswer} />,
    agenda: state.agenda && <AgendaPanel agenda={state.agenda} schedules={state.schedules ?? []}
      onPause={(id, paused) => void guard(() => api.pauseSchedule(id, paused)).catch(() => {})}
      onDelete={id => void guard(() => api.deleteSchedule(id)).catch(() => {})} />,
    memory: <MemoryPanel view={state.memory}
      onUpdate={(id, patch) => guard(() => api.updateMemory(id, patch))} onDelete={id => guard(() => api.deleteMemory(id))} />,
    ledger: <LedgerPanel ledger={state.ledger} onOpen={setOpenTask} />,
  };
  const tabs: { id: Tab; label: string; icon: typeof ChatCircle; count?: number }[] = [
    { id: "chat", label: t.conversation, icon: ChatCircle },
    { id: "tasks", label: t.tasks, icon: ListChecks, count: state.tasks.filter(task => task.status === "running").length },
    { id: "approvals", label: t.approvals, icon: SealCheck, count: waiting },
    ...state.agenda ? [{ id: "agenda" as const, label: t.agenda, icon: CalendarBlank }] : [],
    { id: "memory", label: t.memory, icon: Brain, count: (state.memory?.entries ?? []).filter(item => item.status === "pending").length },
    { id: "ledger", label: t.ledger, icon: Notebook },
  ];

  return (
    <div className={`app tab-${tab}`}>
      <header className="topbar">
        <span className="wordmark">Alter</span>
        <span className={`status ${state.connection !== "open" ? "lost" : state.busy ? "busy" : ""}`}>
          <i /><span className="status-text">{state.connection === "lost" ? t.offline : state.busy ? t.thinking : t.idle}</span>
        </span>
        {heartbeat?.enabled && (heartbeat.nextAt || heartbeat.report.paused) && (
          <button className="next-heartbeat" onClick={() => setShowHeartbeat(true)} title={t.heartbeat.title}>
            <Binoculars /><span className="label">{t.heartbeat.next}</span> {heartbeat.nextAt ? clock(heartbeat.nextAt) : t.heartbeat.paused}
          </button>
        )}
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
          {hasNodes
            ? <button className="icon-btn ghost" onClick={() => setShowNodes(true)} title={t.nodes.title} aria-label={t.nodes.title}><Desktop /></button>
            : <button className="text-btn" onClick={() => setShowNodes(true)} title={t.nodes.title}>{t.nodes.connect}</button>}
          {user?.role === "admin" && (
            <button className="icon-btn ghost" onClick={() => setShowAdmin(true)} title={t.gw.admin} aria-label={t.gw.admin}><UsersThree /></button>
          )}
          <button className="icon-btn ghost" onClick={() => setShowUsage(true)} title={t.stats.title} aria-label={t.stats.title}><ChartBar /></button>
          <button className="icon-btn ghost" onClick={() => setShowDebug(true)} title={t.debug.title} aria-label={t.debug.title}><Bug /></button>
          <button className="icon-btn ghost" onClick={() => setShowSettings(true)} title={t.settings.title} aria-label={t.settings.title}><GearSix /></button>
          <button className="icon-btn ghost" onClick={onLogout} title={t.logout} aria-label={t.logout}><SignOut /></button>
        </div>
      </header>

      {error && <div className="toast" role="alert" onClick={() => setError("")}>{t.error}：{error}</div>}
      {!awaiting && questions > 0 && !showFeedback && (
        <div className="install-banner" role="status">
          <span>{t.fb.banner(questions)}</span>
          <button className="text-btn" onClick={() => setShowFeedback(true)}>{t.fb.answer}</button>
        </div>
      )}
      {awaiting && !showSettings && (
        <div className="install-banner" role="status">
          <span>{t.ext.pendingBanner(awaiting.pending!.manifest.displayName)}</span>
          <button className="text-btn" onClick={() => setShowSettings(true)}>{t.ext.review}</button>
        </div>
      )}

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
      {showUsage && <StatsSheet onClose={() => setShowUsage(false)} onOpenFeedback={feedbackPaused ? undefined : () => { setShowUsage(false); setShowFeedback(true); }} />}
      {showFeedback && <FeedbackSheet view={state.feedback} onClose={() => setShowFeedback(false)} />}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} onToggleLocale={onToggleLocale} extPlugins={state.extPlugins} />}
      {showHeartbeat && <HeartbeatSheet view={heartbeat} onClose={() => setShowHeartbeat(false)} onChange={() => setHeartbeatTick(n => n + 1)} />}
      {showDebug && <DebugSheet onClose={() => setShowDebug(false)} />}
      {showNodes && <NodesSheet onClose={() => setShowNodes(false)} />}
      {showAdmin && user && <AdminSheet selfId={user.id} onClose={() => setShowAdmin(false)} />}
      {showNotices && <NotificationsSheet items={notices} onClose={() => setShowNotices(false)} onFeedback={onFeedback} />}
    </div>
  );
}

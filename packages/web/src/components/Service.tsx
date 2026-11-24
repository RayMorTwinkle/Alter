import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { ServiceFlag, ServiceState } from "../types.ts";

// Switching autostart or keep-alive hands the process to launchd (or back), so the server restarts.
async function waitForRestart() {
  await new Promise(r => setTimeout(r, 2000));
  for (let i = 0; i < 30; i++) {
    try {
      await fetch("/api/service", { credentials: "same-origin" });
      location.reload();
      return;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}

export function Service() {
  const t = useT().service;
  const [state, setState] = useState<ServiceState | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api.service().then(setState, () => {}); }, []);
  if (!state) return null;

  async function toggle(flag: ServiceFlag, value: boolean) {
    setError("");
    try {
      setState(await api.updateService({ [flag]: value }));
      if (flag !== "preventSleep") { setRestarting(true); void waitForRestart(); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  const flags = ["autostart", "keepAlive", "preventSleep"] as const;
  const help = { autostart: t.autostartHelp, keepAlive: t.keepAliveHelp, preventSleep: t.preventSleepHelp };

  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      {!state.supported ? <p className="settings-hint">{t.unsupported}</p> : <>
        {flags.map(flag => (
          <label key={flag} className="field toggle-field">
            <input type="checkbox" checked={state[flag]} disabled={restarting} onChange={e => void toggle(flag, e.target.checked)} />
            <span>{t[flag]}</span>
            <small>{help[flag]}</small>
          </label>
        ))}
        {state.failedNode && !restarting && <p className="form-error">{t.failed(state.failedNode)}</p>}
        <p className="settings-hint">{restarting ? t.restarting : `${state.managed ? t.managed : t.unmanaged}${t.restartNote}`}</p>
      </>}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

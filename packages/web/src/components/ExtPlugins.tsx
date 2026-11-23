import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { ExtPluginEffect, ExtPluginManifest, ExtPluginProposal, ExtPluginView } from "../types.ts";

const risky = new Set<ExtPluginEffect>(["external-send", "irreversible"]);

function Capabilities({ manifest, dependencies }: { manifest: ExtPluginManifest; dependencies?: Record<string, string> }) {
  const t = useT().ext;
  const deps = Object.entries(dependencies ?? {});
  return (
    <dl className="ext-caps">
      {manifest.tools.length > 0 && <>
        <dt>{t.tools}</dt>
        <dd><ul>{manifest.tools.map(tool => (
          <li key={tool.name}>
            <span className={`effect ${risky.has(tool.effect) ? "risky" : ""}`}>{t.effects[tool.effect]}</span>
            <code>{tool.name}</code> {tool.description}
          </li>
        ))}</ul></dd>
      </>}
      {manifest.sources.length > 0 && <>
        <dt>{t.sources}</dt>
        <dd>{manifest.sources.map(s => `${s.name}（${t.atMost(s.minIntervalSeconds)}）`).join("、")}</dd>
      </>}
      {manifest.requires?.length ? <><dt>{t.requires}</dt><dd>{manifest.requires.join("、")}</dd></> : null}
      {manifest.network?.length ? <>
        <dt>{t.network}</dt>
        <dd>{manifest.network.map(n => `${n.methods.join("/")} ${n.host}${n.pathPrefixes.length ? n.pathPrefixes.join("、") : ""}`).join("；")}</dd>
      </> : null}
      {manifest.secrets.length > 0 && <><dt>{t.secrets}</dt><dd>{manifest.secrets.map(s => `${s.name}：${s.purpose}`).join("；")}</dd></>}
      {manifest.borrows.length > 0 && <><dt>{t.borrows}</dt><dd>{manifest.borrows.join("、")}</dd></>}
      {deps.length > 0 && <><dt>{t.dependencies}</dt><dd>{deps.map(([name, version]) => `${name} ${version}`).join("、")}</dd></>}
    </dl>
  );
}

function InstallCard({ id, proposal, upgrade }: { id: string; proposal: ExtPluginProposal; upgrade: boolean }) {
  const t = useT().ext;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: "approve" | "reject") {
    setBusy(true);
    setError("");
    try { await api.extPluginAction(id, action, action === "approve" ? { sha: proposal.sha } : {}); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  }
  const { manifest } = proposal;
  return (
    <article className="ext-install">
      <header>
        <span className="ext-kicker">{upgrade ? t.upgradeTitle : t.installTitle}</span>
        <h4>{manifest.displayName} <small>v{manifest.version}</small></h4>
        <p>{manifest.description}</p>
      </header>
      <p className="ext-warning"><Warning weight="fill" />{t.fullAccess}</p>
      {upgrade && proposal.expanded.length > 0 && (
        <div className="ext-diff">
          <b>{t.expanded}</b>
          <ul>{proposal.expanded.map(line => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
      {upgrade && proposal.removed.length > 0 && <p className="settings-hint">{t.removed}：{proposal.removed.join("；")}</p>}
      <Capabilities manifest={manifest} dependencies={proposal.dependencies} />
      <p className="ext-code">
        {t.code} <code title={proposal.directory}>…/{proposal.directory.split("/").slice(-2).join("/")}</code>
        <button className="text-btn" onClick={() => void navigator.clipboard?.writeText(proposal.directory)}>{t.copy}</button>
        <span className="ext-sha" title={proposal.sha}>SHA-256 {proposal.sha.slice(0, 12)}</span>
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={() => void act("approve")}>{upgrade ? t.approveUpgrade : t.approve}</button>
        <button className="btn" disabled={busy} onClick={() => void act("reject")}>{t.reject}</button>
      </div>
    </article>
  );
}

function InstalledCard({ plugin }: { plugin: ExtPluginView }) {
  const t = useT().ext;
  const [open, setOpen] = useState(false);
  const on = plugin.status === "enabled";
  const current = plugin.versions.find(v => v.sha === plugin.active);
  const older = plugin.versions.filter(v => v.sha !== plugin.active);
  const state = plugin.status === "quarantined" || plugin.status === "paused" ? "error" : on ? "ok" : "off";
  const act = (action: "rollback" | "disable" | "enable", body?: Record<string, string>) => void api.extPluginAction(plugin.id, action, body).catch(() => {});
  return (
    <article className={`plugin-card ${on ? "" : "off"}`}>
      <header>
        <button className="plugin-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <b>{plugin.manifest.displayName}</b>
          <span className={`plugin-state ${state}`}>{t.status[plugin.status]}</span>
          {current && <small className="ext-version">v{current.version}</small>}
        </button>
        {plugin.status !== "quarantined" && (
          <label className="switch" title={on ? t.disable : t.enable}>
            <input type="checkbox" checked={on} onChange={e => act(e.target.checked ? "enable" : "disable")} />
            <span aria-hidden />
          </label>
        )}
      </header>
      {plugin.failures > 0 && <p className="plugin-detail">{t.failures(plugin.failures)}</p>}
      {open && <>
        <Capabilities manifest={plugin.manifest} />
        <div className="plugin-provides">
          {older.length > 0 && (
            <select className="ext-rollback" value="" onChange={e => e.target.value && act("rollback", { sha: e.target.value })} aria-label={t.rollback}>
              <option value="">{t.rollback}</option>
              {older.map(v => <option key={v.sha} value={v.sha}>v{v.version} · {v.sha.slice(0, 8)}</option>)}
            </select>
          )}
          <button className="text-btn danger" onClick={() => {
            if (confirm(t.confirmRemove(plugin.manifest.displayName))) void api.deleteExtPlugin(plugin.id).catch(() => {});
          }}>{t.remove}</button>
        </div>
      </>}
    </article>
  );
}

export function ExtPlugins({ plugins }: { plugins: ExtPluginView[] }) {
  const t = useT().ext;
  if (!plugins.length) return null;
  const pending = plugins.filter(p => p.pending);
  const installed = plugins.filter(p => p.active);
  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      <p className="settings-hint">{t.hint}</p>
      {pending.map(p => <InstallCard key={p.id + p.pending!.sha} id={p.id} proposal={p.pending!} upgrade={!!p.active} />)}
      {installed.map(p => <InstalledCard key={p.id} plugin={p} />)}
    </section>
  );
}

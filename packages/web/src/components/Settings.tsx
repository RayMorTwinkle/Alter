import { CaretDown, Check, Copy, X as Cross } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import { clock } from "../format.ts";
import { ExtPlugins } from "./ExtPlugins.tsx";
import { Models } from "./Models.tsx";
import { AlwaysAllowed } from "./AlwaysAllowed.tsx";
import { Service } from "./Service.tsx";
import type { ApprovalStats, ExtPluginView, FeishuGuide, PluginField, PluginView, Settings, SourceCreate, SourceItem, SourceTemplate, SourceView } from "../types.ts";
import { Sheet } from "./Sheets.tsx";

type Draft = Record<string, string | boolean>;

function Copyable({ label, value }: { label: string; value: string }) {
  const t = useT().settings;
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch { /* clipboard unavailable; the value stays selectable */ }
  }
  return (
    <div className="copyable">
      <span>{label}</span>
      <code>{value.length > 80 ? value.slice(0, 80) + "…" : value}</code>
      <button className="text-btn" onClick={() => void copy()}>{done ? <><Check /> {t.copied}</> : <><Copy /> {t.copy}</>}</button>
    </div>
  );
}

function Field({ field, value, draft, onChange }: {
  field: PluginField; value: PluginView["values"][string]; draft: string | boolean | undefined; onChange: (v: string | boolean) => void;
}) {
  const t = useT().settings;
  const id = `field-${field.key}`;
  if (field.type === "toggle") {
    const checked = typeof draft === "boolean" ? draft : value === true;
    return (
      <label className="field toggle-field" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span>{field.label}</span>
        {field.help && <small>{field.help}</small>}
      </label>
    );
  }
  const secretSet = typeof value === "object" && value !== null && value.set;
  const current = typeof value === "string" ? value : "";
  return (
    <label className="field" htmlFor={id}>
      <span>{field.label}{field.required && <em> *</em>}</span>
      {field.type === "select" ? (
        <select id={id} value={typeof draft === "string" ? draft : current} onChange={e => onChange(e.target.value)}>
          {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <input id={id} type={field.type === "secret" ? "password" : "text"} autoComplete="off"
          value={typeof draft === "string" ? draft : field.type === "secret" ? "" : current}
          placeholder={field.type === "secret" && secretSet ? t.secretSet : ""}
          onChange={e => onChange(e.target.value)} />
      )}
      {field.help && <small>{field.help}</small>}
    </label>
  );
}

function PluginCard({ plugin, onChanged }: { plugin: PluginView; onChanged: (view: PluginView) => void }) {
  const t = useT().settings;
  const [open, setOpen] = useState(plugin.status.state === "needs-config" || plugin.status.state === "error");
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [guide, setGuide] = useState<FeishuGuide | null>(null);
  useEffect(() => {
    if (open && plugin.id === "feishu" && !guide) api.feishuGuide().then(setGuide, () => {});
  }, [open, plugin.id, guide]);

  async function act(run: () => Promise<PluginView>) {
    setBusy(true);
    setError("");
    try {
      onChanged(await run());
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const dirty = Object.keys(draft).length > 0;
  const provides = (["channels", "capabilities", "sources"] as const).filter(kind => plugin.provides[kind].length);

  return (
    <article className={`plugin-card ${plugin.status.state}`}>
      <header>
        <button className="plugin-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <b>{plugin.name}</b>
          <span className={`plugin-state ${plugin.status.state}`}>{t.states[plugin.status.state]}</span>
          <CaretDown className={open ? "flip" : ""} />
        </button>
        <label className="switch" title={plugin.enabled ? t.disable : t.enable}>
          <input type="checkbox" checked={plugin.enabled} disabled={busy}
            onChange={e => void act(() => api.updatePlugin(plugin.id, { enabled: e.target.checked }))} />
          <span aria-hidden />
        </label>
      </header>
      {plugin.status.detail && <p className="plugin-detail">{plugin.status.detail}</p>}
      <div className="plugin-provides">
        {provides.map(kind => (
          <span key={kind}><i>{t.provides[kind]}</i> {plugin.provides[kind].join("、")}</span>
        ))}
      </div>
      {open && (
        <div className="plugin-body">
          {guide && (
            <details className="guide" open={plugin.status.state !== "ok"}>
              <summary>{t.guideTitle}</summary>
              <ol>{guide.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
              <Copyable label={t.permissionsJson} value={guide.permissionsJson} />
              <Copyable label={t.redirectUri} value={guide.redirectUri} />
            </details>
          )}
          {plugin.settings.length > 0 && (
            <form className="plugin-form" onSubmit={e => { e.preventDefault(); void act(() => api.updatePlugin(plugin.id, { settings: draft })); }}>
              {plugin.settings.map(field => (
                <Field key={field.key} field={field} value={plugin.values[field.key] ?? null} draft={draft[field.key]}
                  onChange={v => setDraft(d => ({ ...d, [field.key]: v }))} />
              ))}
              <div className="form-actions">
                <button type="submit" className="btn primary" disabled={busy || !dirty}>{busy ? t.saving : t.save}</button>
                <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.checkPlugin(plugin.id))}>{t.recheck}</button>
              </div>
            </form>
          )}
          {error && <p className="form-error">{error}</p>}
          {plugin.status.checks && plugin.status.checks.length > 0 && (
            <ul className="checks">
              {plugin.status.checks.map(check => (
                <li key={check.id} className={check.ok ? "ok" : "bad"}>
                  {check.ok ? <Check aria-label={t.ok} /> : <Cross aria-label={t.notOk} />}
                  <span>{check.label}</span>
                  {check.detail && <small>{check.detail}</small>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

const objectFields = new Set(["headers", "secrets"]);

function SourceForm({ templates, onCreated, onCancel }: {
  templates: SourceTemplate[]; onCreated: (source: SourceView, samples: SourceItem[]) => void; onCancel: () => void;
}) {
  const t = useT().sources;
  const [template, setTemplate] = useState<SourceTemplate>(templates[0]!);
  const [name, setName] = useState("");
  const [interval, setInterval] = useState("30");
  const [values, setValues] = useState<Record<string, string>>({});
  const [samples, setSamples] = useState<SourceItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function spec(): SourceCreate {
    const params: Record<string, unknown> = {};
    for (const field of template.fields) {
      const raw = (values[field.key] ?? "").trim();
      if (!raw) continue;
      if (objectFields.has(field.key)) {
        try { params[field.key] = JSON.parse(raw); } catch { throw new Error(t.badJson(field.label)); }
      } else params[field.key] = raw;
    }
    return { template: template.template, params, name: name.trim() || template.name, intervalMinutes: Number(interval) || 30 } as SourceCreate;
  }
  async function run(save: boolean) {
    setBusy(true);
    setError("");
    try {
      if (save) {
        const result = await api.createSource(spec());
        onCreated(result.source, result.samples);
      } else setSamples((await api.previewSource(spec())).samples);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="source-form">
      <div className="seg" role="radiogroup">
        {templates.map(item => (
          <button key={item.template} role="radio" aria-checked={item.template === template.template}
            className={item.template === template.template ? "active" : ""}
            onClick={() => { setTemplate(item); setValues({}); setSamples(null); }}>{item.name}</button>
        ))}
      </div>
      <label className="field"><span>{t.name}</span><input type="text" value={name} placeholder={template.name} onChange={e => setName(e.target.value)} /></label>
      {template.fields.map(field => (
        <label key={field.key} className="field">
          <span>{field.label}{field.required && <em> *</em>}</span>
          {objectFields.has(field.key)
            ? <textarea rows={2} value={values[field.key] ?? ""} placeholder='{"Authorization": "Bearer ${secret:api}"}' onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} />
            : <input type={field.type === "secret" ? "password" : "text"} autoComplete="off" value={values[field.key] ?? ""}
                onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} />}
          {field.help && <small>{field.help}</small>}
        </label>
      ))}
      <label className="field"><span>{t.interval}</span>
        <select value={interval} onChange={e => setInterval(e.target.value)}>
          {["5", "15", "30", "60", "180", "720"].map(m => <option key={m} value={m}>{t.every(Number(m))}</option>)}
        </select>
      </label>
      {samples && (
        <div className="source-samples">
          <span>{samples.length ? t.samples : t.noSamples}</span>
          <ul>{samples.map(item => <li key={item.id}><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></li>)}</ul>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="btn" disabled={busy} onClick={() => void run(false)}>{t.preview}</button>
        <button className="btn primary" disabled={busy} onClick={() => void run(true)}>{t.add}</button>
        <button className="text-btn" onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

function Sources() {
  const t = useT().sources;
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [templates, setTemplates] = useState<SourceTemplate[]>([]);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api.sources().then(setSources, () => setSources(null));
    api.sourceTemplates().then(setTemplates, () => {});
  }, []);
  if (!sources) return null;
  const replace = (view: SourceView) => setSources(list => list?.map(s => s.id === view.id ? view : s) ?? null);
  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      <p className="settings-hint">{t.hint}</p>
      {sources.map(source => (
        <article key={source.id} className={`plugin-card source ${source.enabled ? "" : "off"}`}>
          <header>
            <div className="plugin-head static">
              <b>{source.name}</b>
              <span className={`plugin-state ${source.status.error ? "error" : source.enabled ? "ok" : "off"}`}>
                {source.status.error ? t.failing : source.enabled ? templates.find(x => x.template === source.template)?.name ?? source.template : t.off}
              </span>
            </div>
            <label className="switch" title={source.enabled ? t.disable : t.enable}>
              <input type="checkbox" checked={source.enabled}
                onChange={e => void api.updateSource(source.id, { enabled: e.target.checked }).then(replace, () => {})} />
              <span aria-hidden />
            </label>
          </header>
          <div className="plugin-provides">
            <span><i>{t.interval}</i> {t.every(source.intervalMinutes)}</span>
            <span><i>{t.today}</i> {source.status.todayCount}</span>
            {source.status.lastPollAt > 0 && <span><i>{t.last}</i> {clock(source.status.lastPollAt)}</span>}
            <button className="text-btn danger" onClick={() => {
              if (confirm(t.confirmRemove(source.name))) void api.deleteSource(source.id).then(() => setSources(l => l?.filter(s => s.id !== source.id) ?? null), () => {});
            }}>{t.remove}</button>
          </div>
          {source.status.error && <p className="plugin-detail">{source.status.error}</p>}
        </article>
      ))}
      {sources.length === 0 && !adding && <p className="empty">{t.empty}</p>}
      {notice && <p className="settings-hint">{notice}</p>}
      {adding && templates.length > 0
        ? <SourceForm templates={templates} onCancel={() => setAdding(false)} onCreated={(source, samples) => {
            setSources(list => [...(list ?? []), source]);
            setAdding(false);
            setNotice(t.created(source.name, samples.length));
          }} />
        : <button className="btn" onClick={() => { setAdding(true); setNotice(""); }}>{t.addSource}</button>}
    </section>
  );
}

export function SettingsSheet({ onClose, onToggleLocale, extPlugins = [] }: { onClose: () => void; onToggleLocale: () => void; extPlugins?: ExtPluginView[] }) {
  const all = useT();
  const t = all.settings;
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<ApprovalStats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.plugins().then(setPlugins, err => setError(String(err.message ?? err)));
    api.settings().then(setSettings, () => {});
    api.approvalStats().then(setStats, () => {});
  }, []);

  async function patch(next: Parameters<typeof api.updateSettings>[0]) {
    try { setSettings(await api.updateSettings(next)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  const replace = (view: PluginView) => setPlugins(list => list?.map(p => p.id === view.id ? view : p) ?? null);

  return (
    <Sheet title={t.title} onClose={onClose}>
      {error && <p className="form-error">{error}</p>}

      <ExtPlugins plugins={extPlugins} />

      <section className="settings-block">
        <h3>{t.plugins}</h3>
        <p className="settings-hint">{t.pluginsHint}</p>
        {!plugins && !error && <p className="empty">{all.loading}</p>}
        {plugins?.map(plugin => <PluginCard key={plugin.id} plugin={plugin} onChanged={replace} />)}
      </section>

      <Sources />

      {settings && <>
        <section className="settings-block">
          <h3>{t.approval}</h3>
          <div className="seg" role="radiogroup" aria-label={t.approval}>
            {(["on", "off"] as const).map(mode => (
              <button key={mode} role="radio" aria-checked={settings.approvalModel === mode}
                className={settings.approvalModel === mode ? "active" : ""} onClick={() => void patch({ approvalModel: mode })}>
                {t.approvalModes[mode]}
              </button>
            ))}
          </div>
          <p className="settings-hint">{t.approvalHints[settings.approvalModel]}</p>
          {stats && stats.modelAllowed + stats.askedUser > 0 &&
            <p className="settings-hint">{t.approvalCounts(stats.modelAllowed, stats.askedUser, stats.userApproved, stats.userDenied)}</p>}
        </section>

        <Models settings={settings} onPatch={patch} />

        <section className="settings-block">
          <h3>{t.heartbeat}</h3>
          <label className="field toggle-field">
            <input type="checkbox" checked={settings.heartbeat.enabled} onChange={e => void patch({ heartbeat: { enabled: e.target.checked } })} />
            <span>{t.heartbeatOn}</span>
          </label>
          <div className="time-range">
            <label>{t.from}<input type="time" value={settings.heartbeat.start} onChange={e => void patch({ heartbeat: { start: e.target.value } })} /></label>
            <label>{t.to}<input type="time" value={settings.heartbeat.end} onChange={e => void patch({ heartbeat: { end: e.target.value } })} /></label>
          </div>
          <p className="settings-hint">{t.heartbeatHint}</p>
        </section>
      </>}

      <AlwaysAllowed />
      <Service />

      <section className="settings-block">
        <h3>{t.language}</h3>
        <button className="btn" onClick={onToggleLocale}>{all.language}</button>
      </section>
    </Sheet>
  );
}

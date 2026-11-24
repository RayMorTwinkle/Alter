import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { AdapterConfig, AdapterCreate, AdapterEffect, AdapterKind, AdapterView } from "../types.ts";

const effects: AdapterEffect[] = ["read", "write", "irreversible"];
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
// "KEY=value" for env and secrets, "Key: value" for HTTP headers.
function pairs(text: string, separator: string) {
  return Object.fromEntries(lines(text).flatMap(line => {
    const at = line.indexOf(separator);
    return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
  }));
}
const optional = <T extends object>(value: T) => Object.keys(value).length ? value : undefined;

function AdapterCard({ adapter, onChange }: { adapter: AdapterView; onChange: (next?: AdapterView) => void }) {
  const t = useT().adapters;
  const e = useT().ext.effects;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<AdapterView | void>) {
    setBusy(true);
    setError("");
    try { onChange((await action()) ?? undefined); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  function setEffect(tool: string, effect: AdapterEffect, fallback: AdapterEffect) {
    const next = { ...adapter.effects };
    if (effect === fallback) delete next[tool];
    else next[tool] = effect;
    void run(() => api.updateAdapter(adapter.id, { effects: next }));
  }
  const state = adapter.enabled ? adapter.status.state : "off";
  return (
    <article className="adapter">
      <header>
        <span className="effect">{t.kinds[adapter.kind]}</span>
        <b>{adapter.name}</b> <code>{adapter.capabilityId}</code>
        <span className={`adapter-state ${state}`}>{t.states[state]}</span>
      </header>
      {adapter.status.detail && state === "error" && <p className="form-error">{adapter.status.detail}</p>}
      {adapter.tools.length > 0 && (
        <ul className="adapter-tools">
          {adapter.tools.map(tool => (
            <li key={tool.name}>
              <select value={tool.effect} disabled={busy} aria-label={t.effect}
                onChange={event => setEffect(tool.name, event.target.value as AdapterEffect, tool.defaultEffect)}>
                {effects.map(effect => (
                  <option key={effect} value={effect}>{e[effect]}{effect === tool.defaultEffect ? t.defaultMark : ""}</option>
                ))}
              </select>
              <code>{tool.name}</code>
              <span title={tool.description}>{tool.description}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <label className="toggle-inline">
          <input type="checkbox" checked={adapter.enabled} disabled={busy}
            onChange={event => void run(() => api.updateAdapter(adapter.id, { enabled: event.target.checked }))} />
          {t.enabled}
        </label>
        <button className="btn quiet" disabled={busy} onClick={() => void run(() => api.refreshAdapter(adapter.id))}>{t.refresh}</button>
        <button className="btn quiet" disabled={busy} onClick={() => {
          if (confirm(t.confirmDelete(adapter.name))) void run(() => api.deleteAdapter(adapter.id));
        }}>{t.remove}</button>
      </div>
    </article>
  );
}

function AddAdapter({ onAdded }: { onAdded: (adapter: AdapterView) => void }) {
  const t = useT().adapters;
  const [kind, setKind] = useState<AdapterKind>("mcp");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [form, setForm] = useState({ id: "", name: "", command: "", args: "", env: "", url: "", headers: "", help: "", spec: "", baseUrl: "", secrets: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }) });

  function config(): AdapterConfig {
    const env = optional(pairs(form.env, "=")), headers = optional(pairs(form.headers, ":")), args = lines(form.args);
    if (kind === "mcp") return transport === "stdio"
      ? { transport, command: form.command.trim(), ...(args.length && { args }), ...(env && { env }) }
      : { transport, url: form.url.trim(), ...(headers && { headers }) };
    if (kind === "cli") return { command: form.command.trim(), ...(args.length && { args }), ...(env && { env }), ...(form.help.trim() && { help: form.help.trim() }) };
    const spec = form.spec.trim();
    return { spec: spec.startsWith("{") ? JSON.parse(spec) : spec, ...(form.baseUrl.trim() && { baseUrl: form.baseUrl.trim() }), ...(headers && { headers }) };
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const secrets = optional(pairs(form.secrets, "="));
      const input = { kind, id: form.id.trim(), name: form.name.trim() || form.id.trim(), config: config(), ...(secrets && { secrets }) } as AdapterCreate;
      onAdded(await api.createAdapter(input));
      setForm({ ...form, id: "", name: "", command: "", args: "", env: "", url: "", headers: "", help: "", spec: "", baseUrl: "", secrets: "" });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <details className="adapter-add">
      <summary>{t.add}</summary>
      <div className="adapter-form">
        <label className="field">{t.kind}
          <select value={kind} onChange={event => setKind(event.target.value as AdapterKind)}>
            {(["mcp", "cli", "http"] as const).map(k => <option key={k} value={k}>{t.kinds[k]}</option>)}
          </select>
        </label>
        <label className="field">{t.id}<input {...field("id")} placeholder="lark" /></label>
        <label className="field">{t.name}<input {...field("name")} /></label>
        {kind === "mcp" && (
          <label className="field">{t.transport}
            <select value={transport} onChange={event => setTransport(event.target.value as "stdio" | "http")}>
              <option value="stdio">{t.stdio}</option>
              <option value="http">{t.remote}</option>
            </select>
          </label>
        )}
        {(kind === "cli" || (kind === "mcp" && transport === "stdio")) && <>
          <label className="field">{t.command}<input {...field("command")} placeholder={kind === "mcp" ? "npx" : "gh"} /></label>
          <label className="field">{t.args}<textarea rows={2} {...field("args")} placeholder={kind === "mcp" ? "-y\n@larksuiteoapi/lark-mcp" : ""} /></label>
          <label className="field">{t.env}<textarea rows={2} {...field("env")} placeholder="TOKEN={{secret:TOKEN}}" /></label>
        </>}
        {kind === "mcp" && transport === "http" && <>
          <label className="field">{t.url}<input {...field("url")} placeholder="https://…/mcp" /></label>
          <label className="field">{t.headers}<textarea rows={2} {...field("headers")} placeholder="Authorization: Bearer {{secret:TOKEN}}" /></label>
        </>}
        {kind === "cli" && <label className="field">{t.help}<textarea rows={3} {...field("help")} placeholder={t.helpPlaceholder} /></label>}
        {kind === "http" && <>
          <label className="field">{t.spec}<textarea rows={3} {...field("spec")} placeholder="https://…/openapi.json" /></label>
          <label className="field">{t.baseUrl}<input {...field("baseUrl")} /></label>
          <label className="field">{t.headers}<textarea rows={2} {...field("headers")} placeholder="Authorization: Bearer {{secret:TOKEN}}" /></label>
        </>}
        <label className="field">{t.secrets}<textarea rows={2} {...field("secrets")} placeholder="TOKEN=…" /><small>{t.secretsHelp}</small></label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button className="btn primary" disabled={busy || !form.id.trim()} onClick={() => void submit()}>{busy ? t.connecting : t.create}</button>
        </div>
      </div>
    </details>
  );
}

export function Adapters() {
  const t = useT().adapters;
  const [adapters, setAdapters] = useState<AdapterView[] | null>(null);
  useEffect(() => { api.adapters().then(setAdapters, () => setAdapters([])); }, []);
  if (!adapters) return null;
  const replace = (id: string) => (next?: AdapterView) =>
    setAdapters(list => (list ?? []).flatMap(item => item.id !== id ? [item] : next ? [next] : []));
  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      <p className="settings-hint">{t.hint}</p>
      {adapters.length === 0 && <p className="settings-hint">{t.empty}</p>}
      {adapters.map(adapter => <AdapterCard key={adapter.id} adapter={adapter} onChange={replace(adapter.id)} />)}
      <AddAdapter onAdded={adapter => setAdapters(list => [...(list ?? []), adapter])} />
    </section>
  );
}

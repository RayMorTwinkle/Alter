import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { AdapterConfig, AdapterCreate, AdapterEffect, AdapterKind, AdapterPatch, AdapterPreset, AdapterPresetAuth, AdapterPresetCreate, AdapterPresetVariant, AdapterView, NodeAdapterSummary, NodeAdapterToolSummary } from "../types.ts";

const effects: AdapterEffect[] = ["read", "write", "irreversible"];
export type AdapterDisplay = Pick<AdapterView, "id" | "name" | "kind" | "capabilityId" | "enabled" | "effects"> & {
  state: AdapterView["status"]["state"];
  detail?: string;
  tools: NodeAdapterToolSummary[];
};
export const hostAdapterDisplay = (adapter: AdapterView): AdapterDisplay => ({
  ...adapter, state: adapter.status.state, detail: adapter.status.detail,
});
export const nodeAdapterDisplay = (adapter: NodeAdapterSummary): AdapterDisplay => adapter;
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
// "KEY=value" for env and secrets, "Key: value" for HTTP headers.
function pairs(text: string, separator: string) {
  return Object.fromEntries(lines(text).flatMap(line => {
    const at = line.indexOf(separator);
    return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
  }));
}
const optional = <T extends object>(value: T) => Object.keys(value).length ? value : undefined;

export function AdapterCard<T extends AdapterDisplay>({ adapter, onUpdate, onRefresh, onRemove }: {
  adapter: T;
  onUpdate: (patch: AdapterPatch) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const t = useT().adapters;
  const e = useT().ext.effects;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  function setEffect(tool: string, effect: AdapterEffect, fallback: AdapterEffect) {
    const next = { ...adapter.effects };
    if (effect === fallback) delete next[tool];
    else next[tool] = effect;
    void run(() => onUpdate({ effects: next }));
  }
  const state = adapter.enabled ? adapter.state : "off";
  return (
    <article className="adapter">
      <header>
        <span className="effect">{t.kinds[adapter.kind]}</span>
        <b>{adapter.name}</b> <code>{adapter.capabilityId}</code>
        <span className={`adapter-state ${state}`}>{t.states[state]}</span>
      </header>
      {adapter.detail && state === "error" && <p className="form-error">{adapter.detail}</p>}
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
            onChange={event => void run(() => onUpdate({ enabled: event.target.checked }))} />
          {t.enabled}
        </label>
        <button className="btn quiet" disabled={busy} onClick={() => void run(onRefresh)}>{t.refresh}</button>
        <button className="btn quiet" disabled={busy} onClick={() => {
          if (confirm(t.confirmDelete(adapter.name))) void run(onRemove);
        }}>{t.remove}</button>
      </div>
    </article>
  );
}

export function PresetCard({ preset, onCreate }: { preset: AdapterPreset; onCreate: (input: AdapterPresetCreate) => Promise<void> }) {
  const t = useT().adapters;
  const [auth, setAuth] = useState<AdapterPresetAuth>(preset.authMethods[0] ?? "gh");
  const [variant, setVariant] = useState<AdapterPresetVariant>(preset.variants[0] ?? "readonly");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add() {
    setBusy(true);
    setError("");
    try { await onCreate({ auth, variant, ...(auth === "token" && { token: token.trim() }) }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return (
    <article className="adapter preset">
      <header><b>{preset.name}</b></header>
      <p className="settings-hint">{preset.description}</p>
      <div className="preset-options">
        {preset.authMethods.length > 1 && (
          <div className="seg" role="radiogroup" aria-label={t.auth}>
            {preset.authMethods.map(m => (
              <button key={m} role="radio" aria-checked={auth === m} className={auth === m ? "active" : ""} onClick={() => setAuth(m)}>{t.auths[m]}</button>
            ))}
          </div>
        )}
        {preset.variants.length > 1 && (
          <select value={variant} onChange={event => setVariant(event.target.value as AdapterPresetVariant)} aria-label={t.variant}>
            {preset.variants.map(v => <option key={v} value={v}>{t.variants[v]}</option>)}
          </select>
        )}
      </div>
      {auth === "token" && <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={t.tokenPlaceholder} autoComplete="off" />}
      {auth === "gh" && <small className="settings-hint">{t.ghHint}</small>}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || (auth === "token" && !token.trim())} onClick={() => void add()}>{busy ? t.connecting : t.create}</button>
      </div>
    </article>
  );
}

export function AddAdapter({ onCreate }: { onCreate: (input: AdapterCreate) => Promise<void> }) {
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
      await onCreate(input);
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
  const [presets, setPresets] = useState<AdapterPreset[]>([]);
  useEffect(() => {
    api.adapters().then(setAdapters, () => setAdapters([]));
    api.adapterPresets().then(setPresets, () => {});
  }, []);
  if (!adapters) return null;
  const upsert = (next: AdapterView) => setAdapters(list => [...(list ?? []), next]);
  const replace = (id: string, next: AdapterView) =>
    setAdapters(list => (list ?? []).map(item => item.id === id ? next : item));
  const remove = (id: string) => setAdapters(list => (list ?? []).filter(item => item.id !== id));
  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      <p className="settings-hint">{t.hint}</p>
      {adapters.length === 0 && <p className="settings-hint">{t.empty}</p>}
      {adapters.map(adapter => (
        <AdapterCard key={adapter.id} adapter={hostAdapterDisplay(adapter)}
          onUpdate={async patch => replace(adapter.id, await api.updateAdapter(adapter.id, patch))}
          onRefresh={async () => replace(adapter.id, await api.refreshAdapter(adapter.id))}
          onRemove={async () => { await api.deleteAdapter(adapter.id); remove(adapter.id); }} />
      ))}
      {presets.filter(preset => !adapters.some(adapter => adapter.id === preset.id)).map(preset => (
        <PresetCard key={preset.id} preset={preset}
          onCreate={async input => upsert(await api.createAdapterFromPreset(preset.id, input))} />
      ))}
      <AddAdapter onCreate={async input => upsert(await api.createAdapter(input))} />
    </section>
  );
}

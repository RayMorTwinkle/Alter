import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { ModelCapabilities, Settings } from "../types.ts";

// 1000000 → 1M, 131072 → 131K: model limits read better rounded.
function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function ModelRow({ model, onChanged }: { model: ModelCapabilities; onChanged: (next: ModelCapabilities) => void }) {
  const t = useT().models;
  const [editing, setEditing] = useState(false);
  const [window, setWindow] = useState(String(model.contextWindow));
  const [output, setOutput] = useState(String(model.maxTokens));
  const [image, setImage] = useState(model.input.includes("image"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const manual = Object.values(model.sources).includes("manual");
  const guessed = Object.values(model.sources).includes("default");
  const levels = Object.entries(model.thinkingLevelMap ?? {}).filter(([, value]) => value !== null).map(([level]) => level);

  async function save(body: Parameters<typeof api.updateModel>[1]) {
    setBusy(true);
    setError("");
    try {
      const next = await api.updateModel(model.id, body);
      onChanged(next);
      setWindow(String(next.contextWindow));
      setOutput(String(next.maxTokens));
      setImage(next.input.includes("image"));
      setEditing(false);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  const valid = Number.isSafeInteger(+window) && +window > 0 && Number.isSafeInteger(+output) && +output > 0;

  return (
    <div className="plugin-card model-row">
      <header>
        <code>{model.id}</code>
        {manual && <span className="chip">{t.manual}</span>}
        {guessed && <span className="chip warn">{t.guessed}</span>}
        <button className="btn quiet model-edit" onClick={() => setEditing(!editing)}>{editing ? t.cancel : t.edit}</button>
      </header>
      <p className="model-caps">
        {t.window} {tokens(model.contextWindow)} · {t.output} {tokens(model.maxTokens)} · {model.input.includes("image") ? t.textImage : t.textOnly}
        {model.reasoning && ` · ${t.thinking} ${levels.length ? levels.join(" / ") : t.yes}`}
      </p>
      {editing && (
        <div className="model-form">
          <label className="field">{t.window}<input type="text" inputMode="numeric" value={window} onChange={e => setWindow(e.target.value.trim())} /></label>
          <label className="field">{t.output}<input type="text" inputMode="numeric" value={output} onChange={e => setOutput(e.target.value.trim())} /></label>
          <label className="field toggle-field">
            <input type="checkbox" checked={image} onChange={e => setImage(e.target.checked)} />
            <span>{t.acceptsImages}</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="model-actions">
            {manual && <button className="btn quiet" disabled={busy} onClick={() => void save({})}>{t.reset}</button>}
            <button className="btn primary" disabled={busy || !valid}
              onClick={() => void save({ contextWindow: +window, maxTokens: +output, input: image ? ["text", "image"] : ["text"] })}>{t.save}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Models({ settings, onPatch }: { settings: Settings; onPatch: (next: { compactAtTokens: number }) => Promise<void> }) {
  const t = useT().models;
  const [models, setModels] = useState<ModelCapabilities[] | null>(null);
  const [threshold, setThreshold] = useState(String(settings.compactAtTokens));
  useEffect(() => { api.models().then(setModels, () => setModels([])); }, []);
  useEffect(() => setThreshold(String(settings.compactAtTokens)), [settings.compactAtTokens]);

  function commit() {
    const value = +threshold;
    if (Number.isSafeInteger(value) && value > 0 && value !== settings.compactAtTokens) void onPatch({ compactAtTokens: value });
    else setThreshold(String(settings.compactAtTokens));
  }

  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      <p className="settings-hint">{t.hint}</p>
      {models?.map(model => <ModelRow key={model.id} model={model}
        onChanged={next => setModels(list => list?.map(m => m.id === next.id ? next : m) ?? null)} />)}
      <label className="field">
        {t.compactAt}
        <input type="text" inputMode="numeric" value={threshold} onChange={e => setThreshold(e.target.value.trim())}
          onBlur={commit} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <small>{t.compactHint(tokens(settings.compactAtTokens))}</small>
      </label>
    </section>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { clock } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { AdapterPreset, CreatedNode, HarnessId, NativeSession, Node, NodeAdapterSummary } from "../types.ts";
import { AdapterCard, AddAdapter, nodeAdapterDisplay, PresetCard } from "./Adapters.tsx";
import { Sheet } from "./Sheets.tsx";

function Command({ text }: { text: string }) {
  const t = useT().nodes;
  const [copied, setCopied] = useState(false);
  return (
    <div className="node-command">
      <code>{text}</code>
      <button className="text-btn" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>
        {copied ? t.copied : t.copy}
      </button>
    </div>
  );
}

// The token is shown once; the commands embed it, so they also vanish when the panel closes.
function Pairing({ created, onDone }: { created: CreatedNode; onDone: () => void }) {
  const t = useT().nodes;
  const [platform, setPlatform] = useState<"windows" | "unix">(navigator.userAgent.includes("Windows") ? "windows" : "unix");
  return (
    <div className="adapter">
      <p className="form-error">{t.onceWarning}</p>
      <div className="seg" role="radiogroup">
        {(["windows", "unix"] as const).map(p => (
          <button key={p} role="radio" aria-checked={platform === p} className={platform === p ? "active" : ""} onClick={() => setPlatform(p)}>
            {t.platforms[p]}
          </button>
        ))}
      </div>
      <p className="settings-hint">{t.installHint[platform]}</p>
      <Command text={platform === "windows" ? created.installCommandPowerShell : created.installCommandUnix} />
      <p className="settings-hint">{t.installAfter}</p>
      <div className="form-actions"><button className="btn" onClick={onDone}>{t.done}</button></div>
    </div>
  );
}

// Loaded on open: listing spawns the agent on the user's computer, so it should not run on every refresh.
function Sessions({ node, harness }: { node: Node; harness: HarnessId }) {
  const t = useT().nodes;
  const [items, setItems] = useState<NativeSession[] | null>(null);
  const [error, setError] = useState("");
  const load = () => { if (!items && !error) api.nodeSessions(node.id, harness).then(list => setItems(list.slice(0, 8)), err => setError((err as Error).message)); };
  return (
    <details className="node-sessions" onToggle={event => { if ((event.target as HTMLDetailsElement).open) load(); }}>
      <summary>{t.harnessNames[harness]} · {t.sessions}</summary>
      {error && <p className="form-error">{error}</p>}
      {!items && !error && <p className="settings-hint">{t.loadingSessions}</p>}
      {items?.length === 0 && <p className="settings-hint">{t.noSessions}</p>}
      {items && items.length > 0 && (
        <ul>
          {items.map(item => (
            <li key={item.sessionId} title={item.cwd}>
              <span>{item.title || t.untitled}</span>
              {item.updatedAt && <time>{clock(item.updatedAt)}</time>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// dsh model values are JSON pairs like ["amd","DeepSeek-V4-Flash"].
function modelName(value: string) {
  try { const parts = JSON.parse(value); if (Array.isArray(parts)) return parts.join("/"); } catch { /* plain name */ }
  return value;
}

function NodeAdapters({ node, presets, onMutated }: { node: Node; presets: AdapterPreset[]; onMutated: () => void }) {
  const all = useT();
  const t = all.nodes;
  const [adapters, setAdapters] = useState<NodeAdapterSummary[]>(node.adapters ?? []);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (node.adapters) setAdapters(node.adapters);
  }, [node.adapters]);

  function load() {
    if (!node.online || loaded) return;
    setError("");
    void api.nodeAdapters(node.id).then(res => {
      setAdapters(res.adapters);
      setLoaded(true);
    }, err => setError((err as Error).message));
  }
  const upsert = (next: NodeAdapterSummary) => {
    setAdapters(list => list.some(a => a.id === next.id) ? list.map(a => a.id === next.id ? next : a) : [...list, next]);
    onMutated();
  };
  const remove = (id: string) => {
    setAdapters(list => list.filter(a => a.id !== id));
    onMutated();
  };

  return (
    <details className="node-sessions node-adapters" open={adapters.length > 0} onToggle={event => {
      if ((event.target as HTMLDetailsElement).open) load();
    }}>
      <summary>{t.adapters}{adapters.length > 0 ? ` (${adapters.length})` : ""}</summary>
      <div className="node-adapters-body">
        <p className="settings-hint">{t.adaptersHint}</p>
        {!node.online && <p className="settings-hint">{t.adaptersOffline}</p>}
        {error && <p className="form-error">{error}</p>}
        {adapters.map(adapter => (
          <AdapterCard key={adapter.id} adapter={nodeAdapterDisplay(adapter)}
            onUpdate={async patch => upsert(await api.updateNodeAdapter(node.id, adapter.id, patch))}
            onRefresh={async () => upsert(await api.refreshNodeAdapter(node.id, adapter.id))}
            onRemove={async () => { await api.deleteNodeAdapter(node.id, adapter.id); remove(adapter.id); }} />
        ))}
        {node.online && presets.filter(p => !adapters.some(a => a.id === p.id)).map(preset => (
          <PresetCard key={preset.id} preset={preset}
            onCreate={async input => upsert(await api.createNodeAdapterFromPreset(node.id, preset.id, input))} />
        ))}
        {node.online && <AddAdapter onCreate={async input => upsert(await api.createNodeAdapter(node.id, input))} />}
      </div>
    </details>
  );
}

function NodeCard({ node, presets, onRemoved, onRefresh }: {
  node: Node; presets: AdapterPreset[]; onRemoved: () => void; onRefresh: () => void;
}) {
  const t = useT().nodes;
  const [error, setError] = useState("");
  const usable = node.harnesses.filter(h => h.available);
  async function remove() {
    if (!confirm(t.removeConfirm(node.name))) return;
    try { await api.deleteNode(node.id); onRemoved(); } catch (err) { setError((err as Error).message); }
  }
  return (
    <div className="adapter">
      <header>
        <b>{node.name}</b>
        {node.platform && <code>{node.platform}</code>}
        <span className={`node-state${node.online ? " online" : ""}`}><i />{node.online ? t.online : t.offline}</span>
      </header>
      <div className="row-meta">
        <span>{t.harnesses}：{usable.length ? usable.map(h => t.harnessNames[h.id] + (h.version ? ` ${h.version}` : "") + (h.model ? `（${modelName(h.model)}）` : "")).join("、") : t.none}</span>
      </div>
      <div className="row-meta">
        <span>{t.roots}：{node.roots.length ? node.roots.join("、") : t.noRoots}</span>
      </div>
      {node.online && usable.some(h => h.sessions) && <>
        {usable.filter(h => h.sessions).map(h => <Sessions key={h.id} node={node} harness={h.id} />)}
        <p className="settings-hint">{t.sessionsHint}</p>
      </>}
      {(node.online || (node.adapters && node.adapters.length > 0)) && (
        <NodeAdapters node={node} presets={presets} onMutated={onRefresh} />
      )}
      {!node.online && <div className="row-meta"><span>{t.lastSeen} {node.lastSeen ? clock(node.lastSeen) : t.never}</span></div>}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions"><button className="text-btn" onClick={() => void remove()}>{t.remove}</button></div>
    </div>
  );
}

export function NodesSheet({
  liveNodes,
  onNodesChanged,
  onClose,
}: {
  liveNodes?: Node[] | null;
  onNodesChanged?: (nodes: Node[]) => void;
  onClose: () => void;
}) {
  const t = useT().nodes;
  const [nodes, setNodes] = useState<Node[] | null>(liveNodes ?? null);
  const [presets, setPresets] = useState<AdapterPreset[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedNode | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (liveNodes) setNodes(liveNodes);
  }, [liveNodes]);
  const load = () => void api.nodes().then(list => {
    setNodes(list);
    onNodesChanged?.(list);
  }, err => setError((err as Error).message));
  useEffect(() => {
    load();
    api.nodeAdapterPresets().then(setPresets, () => {});
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  async function create() {
    setError("");
    try { setCreated(await api.createNode(name.trim())); setName(""); load(); }
    catch (err) { setError((err as Error).message); }
  }

  return (
    <Sheet title={t.title} onClose={onClose}>
      <section className="settings-block">
        <p className="settings-hint">{t.hint}</p>
        {error && <p className="form-error">{error}</p>}
        {nodes?.length === 0 && !created && <p className="settings-hint">{t.empty}</p>}
        {nodes?.map(node => <NodeCard key={node.id} node={node} presets={presets} onRemoved={load} onRefresh={load} />)}
      </section>
      <section className="settings-block">
        <h3>{t.add}</h3>
        {created ? <Pairing created={created} onDone={() => setCreated(null)} /> : (
          <div className="preset-options">
            <input value={name} placeholder={t.namePlaceholder} aria-label={t.name} onChange={event => setName(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && name.trim()) void create(); }} />
            <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>{t.create}</button>
          </div>
        )}
      </section>
    </Sheet>
  );
}

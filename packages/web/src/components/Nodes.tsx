import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { clock } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { CreatedNode, Node } from "../types.ts";
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
      <h4>{t.steps.install}</h4>
      <Command text={created.installCommand} />
      <h4>{t.steps.pair}</h4>
      <Command text={platform === "windows" ? created.pairCommandPowerShell : created.pairCommand} />
      <h4>{t.steps.root}</h4>
      <Command text={created.rootCommand} />
      <h4>{t.steps.run}</h4>
      <Command text={created.runCommand} />
      <div className="form-actions"><button className="btn" onClick={onDone}>{t.done}</button></div>
    </div>
  );
}

function NodeCard({ node, onRemoved }: { node: Node; onRemoved: () => void }) {
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
        <span>{t.harnesses}：{usable.length ? usable.map(h => t.harnessNames[h.id] + (h.version ? ` ${h.version}` : "")).join("、") : t.none}</span>
      </div>
      <div className="row-meta">
        <span>{t.roots}：{node.roots.length ? node.roots.join("、") : t.noRoots}</span>
      </div>
      {!node.online && <div className="row-meta"><span>{t.lastSeen} {node.lastSeen ? clock(node.lastSeen) : t.never}</span></div>}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions"><button className="text-btn" onClick={() => void remove()}>{t.remove}</button></div>
    </div>
  );
}

export function NodesSheet({ onClose }: { onClose: () => void }) {
  const t = useT().nodes;
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedNode | null>(null);
  const [error, setError] = useState("");
  const load = () => void api.nodes().then(setNodes, err => setError((err as Error).message));
  useEffect(() => {
    load();
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
        {nodes?.map(node => <NodeCard key={node.id} node={node} onRemoved={load} />)}
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

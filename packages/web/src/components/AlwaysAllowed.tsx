import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useT } from "../i18n.tsx";

export function AlwaysAllowed() {
  const t = useT().alwaysAllowed;
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.alwaysAllowed().then(r => setCapabilities(r.capabilities), () => {}); }, []);
  if (!capabilities) return null;

  async function revoke(capability: string) {
    setError("");
    try { setCapabilities((await api.revokeAlwaysAllowed(capability)).capabilities); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  return (
    <section className="settings-block">
      <h3>{t.title}</h3>
      <p className="settings-hint">{t.hint}</p>
      {capabilities.length === 0 ? <p className="settings-hint">{t.empty}</p> : (
        <ul className="always-allowed">
          {capabilities.map(capability => (
            <li key={capability}>
              <code>{capability}</code>
              <button className="btn quiet" onClick={() => void revoke(capability)}>{t.revoke}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

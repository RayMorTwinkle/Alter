import { useState, type FormEvent } from "react";
import { api, Unauthorized } from "../api.ts";
import { useT } from "../i18n.tsx";

export function Login({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Unauthorized ? t.loginFailed : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <div className="wordmark large">Alter</div>
        <h1>{t.loginTitle}</h1>
        <label>
          <span>{t.password}</span>
          <input type="password" autoFocus autoComplete="current-password" value={password}
            onChange={event => setPassword(event.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary" disabled={!password || busy}>{t.login}</button>
      </form>
    </main>
  );
}

import { useState, type FormEvent } from "react";
import { gatewayApi, Unauthorized } from "../api.ts";
import { useT } from "../i18n.tsx";
import type { GatewayUser } from "../types.ts";

// Invite links look like /?invite=CODE, so a roommate lands straight on the sign-up form.
const linkedInvite = new URLSearchParams(location.search).get("invite") ?? "";

export function GatewayLogin({ onDone }: { onDone: (user: GatewayUser) => void }) {
  const t = useT().gw;
  const [mode, setMode] = useState<"login" | "register">(linkedInvite ? "register" : "login");
  const [form, setForm] = useState({ username: "", password: "", invite: linkedInvite });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }) });
  const ready = form.username && form.password && (mode === "login" || form.invite);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await gatewayApi.register(form.username.trim(), form.password, form.invite.trim());
      const user = await gatewayApi.login(form.username.trim(), form.password);
      if (linkedInvite) history.replaceState(null, "", "/");
      onDone(user);
    } catch (err) {
      setError(err instanceof Unauthorized ? t.failed : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <div className="wordmark large">Alter</div>
        <h1>{mode === "login" ? t.loginTitle : t.registerTitle}</h1>
        <label>
          <span>{t.username}</span>
          <input autoFocus autoComplete="username" autoCapitalize="off" spellCheck={false} {...field("username")} />
          {mode === "register" && <small>{t.usernameHint}</small>}
        </label>
        <label>
          <span>{t.password}</span>
          <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} {...field("password")} />
          {mode === "register" && <small>{t.passwordHint}</small>}
        </label>
        {mode === "register" && (
          <label>
            <span>{t.invite}</span>
            <input autoComplete="off" spellCheck={false} {...field("invite")} />
          </label>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary" disabled={!ready || busy}>{mode === "login" ? t.login : t.register}</button>
        <button type="button" className="text-btn" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
          {mode === "login" ? t.toRegister : t.toLogin}
        </button>
      </form>
    </main>
  );
}

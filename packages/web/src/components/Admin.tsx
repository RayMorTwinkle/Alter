import { useEffect, useState } from "react";
import { gatewayApi } from "../api.ts";
import { clock } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { GatewayAdminUser, GatewayInvite } from "../types.ts";
import { Sheet } from "./Sheets.tsx";

const megabytes = (bytes: number | null) => bytes == null ? "—" : `${Math.round(bytes / 1048576)} MB`;

function UserCard({ user, self, onChange }: { user: GatewayAdminUser; self: boolean; onChange: (next: GatewayAdminUser) => void }) {
  const t = useT().gw;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(work: () => Promise<GatewayAdminUser | void>) {
    setBusy(true);
    setError("");
    try { const next = await work(); if (next) onChange(next); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const resetPassword = () => {
    const password = prompt(t.newPassword);
    if (password) void run(() => gatewayApi.updateUser(user.id, { password }));
  };
  return (
    <div className={`adapter${user.disabled ? " muted" : ""}`}>
      <header>
        <b>{user.username}</b>
        <span className="effect">{t.role[user.role]}</span>
        {user.disabled && <span className="effect risky">{t.disabled}</span>}
        <span className={`adapter-state${user.instance.status === "backoff" || user.instance.status === "unavailable" ? " error" : ""}`}>
          {t.instance[user.instance.status]} · {megabytes(user.instance.rss)}
        </span>
      </header>
      <div className="row-meta">
        <span>{t.lastLogin} {user.lastLoginAt ? clock(user.lastLoginAt) : t.never}</span>
        {user.port && <span>:{user.port}</span>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        {user.instance.managed && <button className="text-btn" disabled={busy} onClick={() => void run(() => gatewayApi.restartUser(user.id))}>{t.restart}</button>}
        <button className="text-btn" disabled={busy} onClick={resetPassword}>{t.resetPassword}</button>
        {/* The founding admin is bound to the production instance and cannot be disabled. */}
        {!self && user.instance.managed && (
          <button className="text-btn" disabled={busy} onClick={() => void run(() => gatewayApi.updateUser(user.id, { disabled: !user.disabled }))}>
            {user.disabled ? t.enable : t.disable}
          </button>
        )}
      </div>
    </div>
  );
}

function inviteState(invite: GatewayInvite, t: ReturnType<typeof useT>["gw"], users: GatewayAdminUser[]) {
  if (invite.maxUses === 1 && invite.usedBy) return t.used(users.find(user => user.id === invite.usedBy)?.username ?? invite.usedBy);
  const usage = invite.maxUses > 1 ? t.usage(invite.uses, invite.maxUses) + " · " : "";
  if (invite.revoked) return usage + t.revoked;
  if (invite.expiresAt < Date.now()) return usage + t.expired;
  return usage + (invite.uses < invite.maxUses ? `${t.expires} ${clock(invite.expiresAt)}` : "");
}

export function AdminSheet({ selfId, onClose }: { selfId: string; onClose: () => void }) {
  const t = useT().gw;
  const [users, setUsers] = useState<GatewayAdminUser[] | null>(null);
  const [invites, setInvites] = useState<GatewayInvite[]>([]);
  const [days, setDays] = useState(7);
  const [slots, setSlots] = useState(1);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    gatewayApi.users().then(setUsers, err => setError((err as Error).message));
    gatewayApi.invites().then(setInvites, () => {});
  };
  useEffect(load, []);
  // Instance memory and status move on their own; refresh while the sheet is open.
  useEffect(() => {
    const timer = setInterval(() => gatewayApi.users().then(setUsers, () => {}), 10_000);
    return () => clearInterval(timer);
  }, []);

  async function create() {
    try {
      const invite = await gatewayApi.createInvite(days, code.trim() || undefined, slots);
      setInvites(list => [invite, ...list]); setCode(""); await copy(invite.code);
    }
    catch (err) { setError((err as Error).message); }
  }
  async function copy(code: string) {
    await navigator.clipboard.writeText(`${location.origin}/?invite=${encodeURIComponent(code)}`).catch(() => {});
    setCopied(code);
  }
  async function revoke(code: string) {
    try { await gatewayApi.revokeInvite(code); setInvites(list => list.map(item => item.code === code ? { ...item, revoked: true } : item)); }
    catch (err) { setError((err as Error).message); }
  }
  const open = (invite: GatewayInvite) => invite.uses < invite.maxUses && !invite.revoked && invite.expiresAt > Date.now();
  const sorted = [...invites].sort((a, b) => Number(open(b)) - Number(open(a)) || b.createdAt - a.createdAt);

  return (
    <Sheet title={t.admin} onClose={onClose}>
      {error && <p className="form-error">{error}</p>}
      <section className="settings-block">
        <h3>{t.users}</h3>
        {!users && !error && <p className="empty">…</p>}
        {users?.map(user => (
          <UserCard key={user.id} user={user} self={user.id === selfId}
            onChange={next => setUsers(list => list?.map(item => item.id === next.id ? next : item) ?? null)} />
        ))}
      </section>
      <section className="settings-block">
        <h3>{t.invites}</h3>
        <p className="settings-hint">{t.invitesHint}</p>
        <div className="preset-options">
          <label className="toggle-inline">{t.days}
            <select value={days} onChange={event => setDays(Number(event.target.value))}>
              {[1, 7, 30, 365].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="toggle-inline">{t.slots}
            <select value={slots} onChange={event => setSlots(Number(event.target.value))}>
              {[1, 3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <input value={code} placeholder={t.customCode} aria-label={t.invite}
            onChange={event => setCode(event.target.value)} />
          <button className="btn primary" onClick={() => void create()}>{t.newInvite}</button>
        </div>
        {sorted.length === 0 && <p className="settings-hint">{t.noInvites}</p>}
        <ul className="invite-list">
          {sorted.map(invite => (
            <li key={invite.code} className={open(invite) ? "" : "muted"}>
              <code>{invite.code}</code>
              <span>{inviteState(invite, t, users ?? [])}</span>
              {open(invite) && <>
                <button className="text-btn" onClick={() => void copy(invite.code)}>{copied === invite.code ? t.copied : t.copyLink}</button>
                <button className="text-btn" onClick={() => void revoke(invite.code)}>{t.revoke}</button>
              </>}
            </li>
          ))}
        </ul>
      </section>
    </Sheet>
  );
}

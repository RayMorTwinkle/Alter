import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { loginLimiter, openAccounts } from "../src/accounts.ts";

test("one-use invites, expiry, revocation and durable sessions and ports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-accounts-"));
  const path = join(dir, "accounts.sqlite");
  let db = await openAccounts(path, 10000, "admin", "password");
  try {
    const admin = db.users()[0]!;
    const inputs = { username: "room_1", password: "abcdefgh" };
    const code = db.invite(admin.id).code;
    await expect(db.register({ ...inputs, username: "a!", invite: code })).rejects.toThrow(/username/);
    await expect(db.register({ ...inputs, password: "short", invite: code })).rejects.toThrow(/Password/);
    const uses = await Promise.allSettled(["one", "two"].map(username => db.register({ ...inputs, username, invite: code })));
    expect(uses.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(db.register({ ...inputs, invite: code })).rejects.toThrow(/invite/);
    const other = db.invite(admin.id).code;
    db.revoke(String(other));
    await expect(db.register({ ...inputs, invite: other })).rejects.toThrow(/invite/);
    const expired = String(db.invite(admin.id).code);
    const sql = new DatabaseSync(path);
    try { sql.prepare("UPDATE invites SET expiresAt=0 WHERE code=?").run(expired); } finally { sql.close(); }
    await expect(db.register({ ...inputs, invite: expired })).rejects.toThrow(/invite/);
    const user = await db.register({ ...inputs, invite: db.invite(admin.id).code });
    expect(user.port).toBe(10001);
    const { token } = await db.login(inputs.username, inputs.password);
    db.close();
    db = await openAccounts(path, 20000, "ignored");
    expect(db.sessionUser(token)).toMatchObject({ id: user.id, port: 10001, lastLoginAt: expect.any(Number) });
    const stored = new DatabaseSync(path);
    try {
      expect(stored.prepare("SELECT tokenHash FROM sessions").get()?.tokenHash).not.toBe(token);
      expect(stored.prepare("SELECT passwordHash FROM users WHERE id=?").get(user.id)?.passwordHash).not.toContain(inputs.password);
      stored.exec("UPDATE sessions SET expiresAt=0");
      expect(db.sessionUser(token)).toBeUndefined();
    } finally { stored.close(); }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rate limits by username and IP independently over a rolling minute", () => {
  let now = 0;
  const attempt = loginLimiter(() => now);
  for (let i = 0; i < 10; i++) { attempt("one", String(i)); attempt(String(i), "same"); }
  expect(() => attempt("one", "new")).toThrow(/Too many/);
  expect(() => attempt("new", "same")).toThrow(/Too many/);
  now = 60_000;
  for (let i = 0; i < 15; i++) attempt("one", "same")();
});

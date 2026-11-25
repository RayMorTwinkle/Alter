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

test("named invites admit up to their slot count, and old databases migrate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-accounts-"));
  const path = join(dir, "accounts.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
      role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastLoginAt INTEGER, port INTEGER UNIQUE);
    CREATE TABLE invites (code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL, usedBy TEXT, usedAt INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES ('a','admin','x','admin',0,0,NULL,NULL), ('u','old','x','user',0,0,NULL,10000);
    INSERT INTO invites VALUES ('spent','a',0,9999999999999,'u',0,0), ('fresh','a',0,9999999999999,NULL,NULL,0);`);
  old.close();
  const db = await openAccounts(path, 10000, "admin");
  try {
    const inputs = { password: "abcdefgh" };
    await expect(db.register({ ...inputs, username: "late", invite: "spent" })).rejects.toThrow(/invite/);
    expect(db.invites().find(i => i.code === "fresh")).toMatchObject({ uses: 0, maxUses: 1 });
    expect(() => db.invite("a", 7, "no way")).toThrow(/code/);
    expect(() => db.invite("a", 7, "fresh")).toThrow(/exists/);
    expect(() => db.invite("a", 7, "cybhandsome", 0)).toThrow(/uses/);
    db.invite("a", 7, "cybhandsome", 3);
    const uses = await Promise.allSettled(["room1", "room2", "room3", "room4"].map(username => db.register({ ...inputs, username, invite: "cybhandsome" })));
    expect(uses.filter(r => r.status === "fulfilled")).toHaveLength(3);
    expect(db.invites().find(i => i.code === "cybhandsome")).toMatchObject({ uses: 3, maxUses: 3 });
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

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { HttpError } from "../../server/src/static.ts";

const derive = promisify(scrypt);
export const day = 86_400_000;
export const sessionLifetime = 365 * day;
const random = (size: number) => randomBytes(size).toString("base64url");
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export type User = {
  id: string; username: string; role: "admin" | "user"; disabled: boolean;
  createdAt: number; lastLoginAt: number | null; port: number | null;
};
type Invite = {
  code: string; createdBy: string; createdAt: number; expiresAt: number;
  usedBy: string | null; usedAt: number | null; revoked: boolean;
};
export const identity = ({ id, username, role }: User) => ({ id, username, role });

function validName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, "Invalid username");
}

async function hash(password: unknown, bootstrap = false) {
  if (typeof password !== "string" || !password || (!bootstrap && password.length < 8)) throw new HttpError(400, "Password must have at least 8 characters");
  const salt = random(16);
  return salt + "." + (await derive(password, salt, 64) as Buffer).toString("hex");
}

export async function openAccounts(path: string, basePort: number, adminName: string, adminPassword?: string, reservedPorts: number[] = []) {
  const db = new DatabaseSync(path);
  function transaction<T>(fn: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL, lastLoginAt INTEGER, port INTEGER UNIQUE
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, createdBy TEXT NOT NULL REFERENCES users(id), createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL, usedBy TEXT REFERENCES users(id), usedAt INTEGER, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expiresAt INTEGER NOT NULL
      );
    `);
    if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
      validName(adminName);
      if (!adminPassword) throw new Error("Missing ALTER_WEB_PASSWORD for initial administrator");
      const passwordHash = await hash(adminPassword, true);
      db.prepare(`INSERT INTO users(id, username, passwordHash, role, createdAt)
        SELECT ?,?,?,'admin',? WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`)
        .run(random(9), adminName, passwordHash, Date.now());
    }
  } catch (error) { db.close(); throw error; }
  const fields = "id, username, role, disabled, createdAt, lastLoginAt, port";
  function user(row: Record<string, unknown>): User {
    return { ...row, disabled: !!row.disabled } as User;
  }
  function find(id: string) {
    const row = db.prepare("SELECT " + fields + " FROM users WHERE id=?").get(id);
    return row && user(row);
  }
  const inviteValid = "code=? AND usedBy IS NULL AND revoked=0 AND expiresAt>?";
  function checkInvite(code: unknown): asserts code is string {
    if (typeof code !== "string" || !db.prepare("SELECT 1 FROM invites WHERE " + inviteValid).get(code, Date.now())) throw new HttpError(400, "Invalid or expired invite");
  }
  function checkAdmin(token: string) {
    const actor = sessionUser(token);
    if (!actor) throw new HttpError(401, "Login required");
    if (actor.role !== "admin") throw new HttpError(403, "Administrator required");
    return actor;
  }
  function sessionUser(token: string) {
    const row = db.prepare("SELECT " + fields + " FROM users WHERE disabled=0 AND id=(SELECT userId FROM sessions WHERE tokenHash=? AND expiresAt>?)").get(digest(token), Date.now());
    return row && user(row);
  }
  function inviteView(row: Record<string, unknown>) { return { ...row, revoked: !!row.revoked } as Invite; }
  return {
    find, checkAdmin, sessionUser, close: () => db.close(),
    users: () => db.prepare("SELECT " + fields + " FROM users ORDER BY createdAt").all().map(user),
    async register({ username, password, invite }: Record<string, unknown>) {
      validName(username);
      checkInvite(invite);
      const passwordHash = await hash(password);
      return transaction(() => {
        checkInvite(invite);
        if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new HttpError(409, "Username already taken");
        const id = random(9), now = Date.now();
        const last = db.prepare("SELECT MAX(port) AS port FROM users").get()!;
        let port = Math.max(basePort, Number(last.port) + 1);
        while (reservedPorts.includes(port)) port++;
        if (port > 65535) throw new HttpError(409, "No instance ports left");
        db.prepare("INSERT INTO users(id,username,passwordHash,role,createdAt,port) VALUES(?,?,?,'user',?,?)").run(id, username, passwordHash, now, port);
        db.prepare("UPDATE invites SET usedBy=?,usedAt=? WHERE code=?").run(id, now, invite);
        return find(id)!;
      });
    },
    async login(username: string, password: string) {
      const row = db.prepare("SELECT id,passwordHash FROM users WHERE username=? AND disabled=0").get(username);
      const stored = String(row?.passwordHash ?? "missing." + "00".repeat(64));
      const [salt, key] = stored.split(".");
      const actual = await derive(password, salt!, 64) as Buffer;
      if (!timingSafeEqual(actual, Buffer.from(key!, "hex")) || !row) throw new HttpError(401, "Invalid credentials");
      const now = Date.now(), token = random(32);
      return transaction(() => {
        if (!db.prepare("UPDATE users SET lastLoginAt=? WHERE id=? AND passwordHash=? AND disabled=0").run(now, row.id!, stored).changes) throw new HttpError(401, "Invalid credentials");
        db.prepare("DELETE FROM sessions WHERE expiresAt<=?").run(now);
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(token), row.id!, now + sessionLifetime);
        return { user: find(String(row.id))!, token };
      });
    },
    logout(token: string) { db.prepare("DELETE FROM sessions WHERE tokenHash=?").run(digest(token)); },
    async patch(token: string, id: string, input: Record<string, unknown>) {
      if (!Object.keys(input).length || Object.keys(input).some(k => !["role", "disabled", "password"].includes(k)) ||
          ("role" in input && input.role !== "admin" && input.role !== "user") ||
          ("disabled" in input && typeof input.disabled !== "boolean")) throw new HttpError(400, "Invalid user patch");
      const passwordHash = "password" in input ? await hash(input.password) : null;
      return transaction(() => {
        checkAdmin(token);
        const target = find(id);
        if (!target) throw new HttpError(404, "Unknown user");
        if (target.port === null && (input.role === "user" || input.disabled)) throw new HttpError(409, "Primary administrator must stay active");
        db.prepare("UPDATE users SET role=?,disabled=?,passwordHash=COALESCE(?,passwordHash) WHERE id=?")
          .run(String(input.role ?? target.role), Number(input.disabled ?? target.disabled), passwordHash, id);
        db.prepare("DELETE FROM sessions WHERE userId=?").run(id);
        return find(id)!;
      });
    },
    invites: () => db.prepare("SELECT * FROM invites ORDER BY createdAt DESC").all().map(inviteView),
    invite(createdBy: string, days: unknown = 7) {
      if (typeof days !== "number" || !Number.isSafeInteger(days) || days <= 0 || !Number.isSafeInteger(Date.now() + days * day)) throw new HttpError(400, "Invalid validity in days");
      const code = random(18), now = Date.now();
      return inviteView(db.prepare("INSERT INTO invites(code,createdBy,createdAt,expiresAt) VALUES(?,?,?,?) RETURNING *")
        .get(code, createdBy, now, now + days * day)!);
    },
    revoke(code: string) {
      if (!db.prepare("UPDATE invites SET revoked=1 WHERE code=?").run(code).changes) throw new HttpError(404, "Unknown invite");
    },
  };
}

export type Accounts = Awaited<ReturnType<typeof openAccounts>>;

// Count in-flight guesses too, so concurrent attempts cannot all enter scrypt before the first failure.
export function loginLimiter(now = Date.now) {
  const attempts = new Map<string, number[]>();
  return (username: string, ip: string) => {
    const time = now();
    for (const [key, times] of attempts) {
      while (times.length && times[0]! <= time - 60_000) times.shift();
      if (!times.length) attempts.delete(key);
    }
    const keys = ["name:" + username, "ip:" + ip];
    if (keys.some(key => (attempts.get(key)?.length ?? 0) >= 10)) throw new HttpError(429, "Too many login attempts");
    for (const key of keys) {
      const times = attempts.get(key) ?? [];
      times.push(time);
      attempts.set(key, times);
    }
    return () => {
      for (const key of keys) {
        const times = attempts.get(key);
        const at = times?.indexOf(time) ?? -1;
        if (at >= 0) times!.splice(at, 1);
      }
    };
  };
}

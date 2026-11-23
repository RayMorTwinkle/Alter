import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openSecrets } from "../src/secrets.ts";

it("persists authenticated per-field ciphertext and a private random key across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "alter-secrets-"));
  const path = join(dir, "secrets.json"), key = join(dir, "secret.key");
  try {
    const store = openSecrets(dir);
    store.patch({ login: "cleartext-example", password: "cleartext-example", enabled: false });
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain("cleartext-example");
    const entries = JSON.parse(saved);
    expect(entries.login.iv).not.toBe(entries.password.iv);
    expect(statSync(key).size).toBe(32);
    for (const file of [path, key]) expect(statSync(file).mode & 0o777).toBe(0o600);
    const reopened = openSecrets(dir);
    expect(reopened.get("password")).toBe("cleartext-example");
    expect(reopened.get("enabled")).toBe(false);
    reopened.patch({ password: null, login: "replacement" });
    expect(openSecrets(dir).get("password")).toBeUndefined();
    expect(openSecrets(dir).get("login")).toBe("replacement");
    writeFileSync(path, JSON.stringify({ ...entries, login: entries.password }));
    expect(() => openSecrets(dir).get("login")).toThrow();
    rmSync(key);
    expect(() => openSecrets(dir)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

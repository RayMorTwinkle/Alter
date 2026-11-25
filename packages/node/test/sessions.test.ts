import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { dshLog } from "../src/adapters/dsh-history.ts";
import { directory, pair } from "../src/config.ts";
import { listSessions } from "../src/sessions.ts";
import { workspace } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

test("dsh v3 history uses the first human text and sorts by artifact mtime even if decoding fails", async () => {
  const f = workspace();
  vi.stubEnv("HOME", f.base); vi.stubEnv("USERPROFILE", f.base);
  const cwd = directory(f.root);
  const sessions = ["broken", "valid"].map(sessionId => ({ sessionId, cwd }));
  const request = { type: "sessions.list", requestId: "q", harness: "dsh" } as const;
  try {
    pair(f.dir, "http://localhost", "user.test", undefined, [cwd]);
    writeFileSync(path.join(cwd, "pages.json"), JSON.stringify([sessions]));
    const store = path.join(f.base, ".dsh", "sessions");
    expect(dshLog({ cwd: "C:\\项目 1", sessionId: "../id" }, store)).toBe(path.join(store, "--C-~9879~76EE~00201--", "..~002Fid", "session.v3.jsonl.zstd"));
    for (const [i, row] of sessions.entries()) {
      const file = dshLog(row, store);
      mkdirSync(path.dirname(file), { recursive: true });
      const lines = [
        { type: "session", version: 3, id: row.sessionId, cwd },
        { type: "user/message", data: { source: { kind: "plugin" }, content: [{ type: "text", text: "internal" }] } },
        { type: "user/message", data: { source: { kind: "user" }, role: "user", content: [{ type: "text", text: "第一条\n问题" }] } },
        { type: "user/message", data: { role: "user", content: [{ type: "text", text: "后面的消息" }] } },
      ];
      const compressed = Buffer.concat(lines.map(l => zstdCompressSync(Buffer.from(JSON.stringify(l) + "\n"))));
      writeFileSync(file, i ? compressed : "bad zstd");
      utimesSync(file, 1740000000, 1740000000 + i);
    }
    const result = await listSessions(f.dir, f.harnesses, request, AbortSignal.timeout(20000));
    expect(result.error).toBeUndefined();
    expect(result.sessions).toEqual([
      { sessionId: "valid", cwd, title: "第一条 问题", updatedAt: 1740000001000 },
      { sessionId: "broken", cwd, updatedAt: 1740000000000 },
    ]);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("Claude SDK lists a saved transcript from a temporary profile", async () => {
  const f = workspace(), cwd = directory(f.root);
  const profile = path.join(f.base, "claude-profile");
  vi.stubEnv("CLAUDE_CONFIG_DIR", profile);
  const sessionId = "de9b74b4-0a8a-4c38-ae05-e6f38ce217b2";
  try {
    pair(f.dir, "http://localhost", "user.test", undefined, [cwd]);
    const project = path.join(profile, "projects", "fixture");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, sessionId + ".jsonl"), JSON.stringify({ type: "user", sessionId, cwd,
      timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "已保存的对话" } }) + "\n");
    const result = await listSessions(f.dir, f.harnesses, { type: "sessions.list", requestId: "q", harness: "claude-code" }, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ sessions: [{ sessionId, cwd, title: "已保存的对话", updatedAt: expect.any(Number) }] });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

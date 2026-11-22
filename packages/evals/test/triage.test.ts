import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fakeGateway, say } from "../../core/test/fixtures/gateway.ts";
import { evaluate, metrics, summary } from "../triage.ts";
import { profile, samples } from "../triage-samples.ts";

it("scores repeated unfiltered task-model decisions and writes both reports", async () => {
  const predictions = ["now", "digest", "now", "now", "silent", "digest"];
  const ids = ["advisor-call", "interview-link", "advisor-paper", "inject-sale", "inject-code", "inject-reading"];
  let calls = 0;
  const gateway = await fakeGateway((_, res) => {
    const level = predictions[calls++ % predictions.length];
    say(res, JSON.stringify({ level, reason: "测试" }));
  });
  const dir = await mkdtemp(join(tmpdir(), "alter-triage-"));
  try {
    const rows = await evaluate({ ALTER_LLM_BASE_URL: gateway.baseUrl, ALTER_LLM_API_KEY: "offline-key",
      ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task", ALTER_DATA_DIR: dir,
      ALTER_EVAL_OUT: dir, ALTER_EVAL_REPEATS: "2", ALTER_EVAL_ONLY: ids.join(",") });
    expect(rows.map(row => row.repeat)).toEqual([...Array(6).fill(1), ...Array(6).fill(2)]);
    expect(gateway.requests).toHaveLength(12);
    for (const [index, request] of gateway.requests.entries()) {
      expect(request.model).toBe("offline/task");
      expect(request.tools ?? []).toHaveLength(0);
      const content = request.messages.at(-1)?.content;
      expect(content).toContain(profile);
      expect(content).toContain(samples.find(s => s.id === ids[index % ids.length])!.summary);
    }
    expect(metrics(rows)).toMatchObject({
      accuracy: 0.5, nowPrecision: 1 / 3, nowRecall: 0.5, injectionNow: 1 / 3,
      filtered: 2, legal: 12, valid: 12, usage: { calls: 12, input: 96, output: 36, tokens: 132 },
      matrix: { now: { now: 2, digest: 2, silent: 0 }, digest: { now: 2, digest: 2, silent: 0 }, silent: { now: 2, digest: 0, silent: 2 } },
    });
    const md = await readFile(join(dir, "summary.md"), "utf8");
    expect(md).toBe(summary(rows));
    expect(md.indexOf("interview-link")).toBeGreaterThan(0);
    expect(md.indexOf("interview-link")).toBeLessThan(md.indexOf("## 指标"));
    expect(md).toContain("最终合法标签 12/12");
    const jsonl = await readFile(join(dir, "results.jsonl"), "utf8");
    expect(jsonl.trim().split("\n").map(line => JSON.parse(line))).toEqual(rows);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("distinguishes legal production fallbacks from valid model output", async () => {
  const gateway = await fakeGateway((_, res) => say(res, '{"level":"urgent","reason":"测试"}'));
  const dir = await mkdtemp(join(tmpdir(), "alter-triage-invalid-"));
  try {
    const rows = await evaluate({ ALTER_LLM_BASE_URL: gateway.baseUrl, ALTER_LLM_API_KEY: "offline-key",
      ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task", ALTER_DATA_DIR: dir,
      ALTER_EVAL_OUT: dir, ALTER_EVAL_ONLY: "advisor-paper" });
    expect(rows[0]).toMatchObject({ status: "fail", predicted: "digest", validOutput: false });
    expect(metrics(rows)).toMatchObject({ accuracy: 0, finalAccuracy: 1, valid: 0, legal: 1, nowPrecision: null, nowRecall: null, injectionNow: null });
    expect(summary(rows)).toContain("输出格式无效");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

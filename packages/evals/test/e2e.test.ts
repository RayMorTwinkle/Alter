import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Tasks, context } from "@alter/core";
import { defaultClients } from "../../plugin-mail/src/client.ts";
import { Sends } from "../../plugin-mail/src/send.ts";
import { config as mailConfig, fakeMail } from "../../plugin-mail/test/fake.ts";
import { afterEach, expect, it, vi } from "vitest";
import { appendUsage } from "../../core/src/usage.ts";
import { evaluate, summary } from "../e2e.ts";
import { fixtures, startPages } from "../fixtures.ts";
import { runTask, type Options } from "../runner.ts";
import { tasks, type Task, type TaskContext } from "../tasks.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
function task(id: string) { return tasks.find(t => t.id === id)!; }
function call(tool: string, args: Parameters<typeof fauxToolCall>[1]) {
  return say(fauxToolCall(tool, args), { stopReason: "toolUse" });
}
function setup(main: ReturnType<typeof fauxProvider>, worker?: ReturnType<typeof fauxProvider>): Options {
  return { timeZone: "America/New_York", browser: false, models: async () => {
    const models = createModels();
    models.setProvider(main.provider);
    const task = worker ?? fauxProvider({ provider: "worker" });
    if (!worker) task.setResponses(Array(12).fill(say('{"inScope":true,"reason":"符合说明"}')));
    models.setProvider(task.provider);
    return { models, mainModel: { provider: "faux", modelId: "faux-1" },
      taskModel: { provider: "worker", modelId: "faux-1" } };
  } };
}

it("checks actual calendar state, removes each database, and excludes incorrect runs from cost medians", async () => {
  const calendar = task("calendar-relative");
  async function run(hour: number, repeat: number) {
    let dataDir = "";
    const main = fauxProvider();
    const row = await runTask({ ...calendar, async setup(c) {
      dataDir = c.dataDir;
      main.setResponses([call("enable_tool", { capability: "calendar" }),
        call("calendar_create", { title: "周报会", location: "A 会议室",
          start: new Date(c.day(1, hour)).toISOString(), end: new Date(c.day(1, hour + 1)).toISOString() }),
        say("已按要求创建。")]);
      await appendUsage(dataDir, { at: new Date().toISOString(), model: "faux", conversation: "main", attempt: 1,
        outcome: "ok", latencyMs: 4, inputTokens: hour === 15 ? 6 : 1000, outputTokens: 3 });
    } }, setup(main), repeat);
    await expect(access(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    return row;
  }
  const good = await run(15, 1);
  const bad = await run(16, 2);
  expect(good).toMatchObject({ status: "pass", tools: { enable_tool: 1, dispatch_task: 0 }, reply: "已按要求创建。",
    usage: { main: { tokens: 9, calls: 1 }, task: { tokens: 0 }, total: { calls: 2 } } });
  expect(bad).toMatchObject({ status: "fail", reason: expect.stringContaining("周报会"), usage: { main: { tokens: 1003 } } });
  const md = summary([good, bad]);
  expect(md.indexOf(bad.reason!)).toBeLessThan(md.indexOf("## 完成率"));
  expect(md).toContain("| 总计 | 1 / 2 | 50.0% | 0 | 0 | 9 / 0 | 2 |");
  expect(md).toContain("| 日历 | 1 / 2 | 50.0%");
  expect(md).toContain("| calendar-relative | 2 | fail");
});

it.each([false, true])("answers a parked user request once and waits for the child report (allow=%s)", async allow => {
  const main = fauxProvider();
  const worker = fauxProvider({ provider: "worker" });
  main.setResponses([call("dispatch_task", { brief: "send", context: "fresh", permission: "restricted" }),
    say("正在处理"), say("已收到任务报告")]);
  worker.setResponses([call("outbox_send", { message: "测试" }), say('{"inScope":false,"reason":"请确认"}'), call("finish", { summary: "已处理", refs: [] })]);
  const approvalTask: Task = { id: "offline-approval", category: "日历", turns: ["发消息"],
    approvals: allow ? () => true : undefined,
    check: c => c.app.demo.outbox.length === Number(allow) ? undefined : "发送次数不符" };
  const row = await runTask(approvalTask, { ...setup(main, worker), demos: true });
  expect(row).toMatchObject({ status: "pass", reply: "已收到任务报告", tools: { dispatch_task: 1 },
    approvals: [{ tool: "outbox_send", audience: "user", decision: allow ? "allow" : "deny" }] });
  expect(summary([row])).toContain(`outbox_send / user / ${allow ? "allow" : "deny"}`);
});

it("reports a failed setup as a harness error outside the completion rate", async () => {
  const main = fauxProvider();
  const row = await runTask({ ...task("calendar-relative"), async setup() { throw new Error("种子未到达"); } }, setup(main));
  expect(row).toMatchObject({ status: "error", reason: "准备失败：种子未到达" });
  const md = summary([row]);
  expect(md).toContain("【执行器错误】 准备失败：种子未到达");
  expect(md).toContain("| 总计 | 0 / 0 | — | 0 | 1 |");
});

it("filters and repeats skipped cases without constructing a gateway; writes both reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-e2e-report-"));
  temporary.push(dir);
  const env = { ALTER_BROWSER: "off", ALTER_MAIL_ADDRESS: "missing-code@example.test", ALTER_EVAL_OUT: dir,
    ALTER_EVAL_ONLY: "mail-read, browser-calendar,browser-read", ALTER_EVAL_REPEATS: "2" };
  const rows = await evaluate(env);
  expect(rows.map(r => r.id)).toEqual(["mail-read", "browser-calendar", "browser-read", "mail-read", "browser-calendar", "browser-read"]);
  expect(rows.every(r => r.status === "skip")).toBe(true);
  expect(rows[0]?.reason).toContain("ALTER_MAIL");
  expect(rows[1]?.reason).toBe("ALTER_BROWSER=off");
  const log = await readFile(join(dir, "results.jsonl"), "utf8");
  expect(log.trim().split("\n").map(line => JSON.parse(line))).toEqual(rows);
  const md = await readFile(join(dir, "summary.md"), "utf8");
  expect(md).toBe(summary(rows));
  expect(md).toContain("| 总计 | 0 / 0 | — | 6 | 0 | — / — |");
  await expect(evaluate(env)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(evaluate({ ...env, ALTER_EVAL_ONLY: "typo" })).rejects.toThrow("未知任务");
  await expect(evaluate({ ...env, ALTER_EVAL_REPEATS: "0" })).rejects.toThrow("正整数");
});

it("serves distinct facts on loopback, with contact discoverable only on the linked page", async () => {
  const f = fixtures("", "America/New_York", Date.parse("2026-03-06T23:00:00-05:00"));
  expect(f.day(3) - f.day(2)).toBe(23 * 3600_000);
  const pages = await startPages(f);
  try {
    expect(new URL(pages.url).hostname).toBe("127.0.0.1");
    const first = await (await fetch(pages.url)).text();
    expect(first).toContain(pages.price);
    expect(first).not.toContain(pages.contact);
    const link = /href="([^"]+)"/.exec(first)![1]!;
    expect(await (await fetch(new URL(link, pages.url))).text()).toContain(pages.contact);
    expect(await (await fetch(pages.url + "/event")).text()).toContain(f.eventText);
    expect((await fetch(pages.url + "/missing")).status).toBe(404);
  } finally { await pages.close(); }
});

it("requires a soft-deleted original and an intact sibling for the deletion oracle", async () => {
  const deletion = task("calendar-delete");
  const main = fauxProvider();
  let observed: string | undefined;
  const row = await runTask({ ...deletion, async setup(c: TaskContext) {
    await deletion.setup!(c);
    observed = await deletion.check(c);
    main.setResponses([call("enable_tool", { capability: "calendar" }),
      call("calendar_delete", { id: "weekly" }), say("已取消周报会。")]);
  } }, setup(main));
  expect(observed).toBeTruthy();
  expect(row.status).toBe("pass");
});

it("rejects a mail-reply result if a sibling task has a receipt despite a denied send", async () => {
  const fake = fakeMail();
  vi.spyOn(defaultClients, "imap").mockImplementation(fake.clients.imap);
  const smtp = vi.spyOn(defaultClients, "smtp").mockImplementation(async (_, to, raw) => {
    expect(to).toBe(mailConfig.address);
    const subject = /^Subject: (.+)\r$/im.exec(raw.toString())![1]!;
    fake.inbox.set(1, { uid: 1, seq: 1, envelope: { subject }, bodyStructure: { type: "text/plain", part: "1" } });
    fake.parts.set("1", Buffer.from("会议通知"));
  });
  const main = fauxProvider();
  const worker = fauxProvider({ provider: "worker" });
  const dispatch = (brief: string) => call("dispatch_task", { brief, context: "fresh", permission: "restricted" });
  main.setResponses([dispatch("回复"), say("正在处理"), dispatch("复核"), say("正在复核"), say("已处理")]);
  worker.setResponses([call("mail_read", { uid: 1 }), call("mail_send", { to: mailConfig.address, subject: "Re: 会议", text: "收到，谢谢" }),
    call("finish", { summary: "用户拒绝发送", refs: [] }), call("finish", { summary: "已复核", refs: [] })]);
  const mail = task("mail-reply");
  const row = await runTask({ ...mail, async check(c) {
    // Real broker and seed sender, in-memory mail transport. The seed itself creates no agent receipt.
    expect(await mail.check(c)).toBeUndefined();
    const tasks = await c.app.harness.snapshot(Tasks, c.app.main.id, context);
    const sibling = Object.values(tasks!.byId).find(t => t.brief === "复核")!;
    await c.app.main.commit(async tx => {
      const doc = await tx.doc(Sends, sibling.conversationId);
      doc.receipts["attempt"] = { messageId: "<uncertain@example.test>", address: mailConfig.address, created: c.now, phase: "sending" };
    }, context);
    return mail.check(c);
  } }, { ...setup(main, worker), mail: mailConfig });
  expect(smtp).toHaveBeenCalledTimes(1);
  expect(row).toMatchObject({ status: "fail", reason: expect.stringContaining("发送回执"),
    approvals: [{ audience: "user", tool: "mail_send", decision: "deny" }] });
  // This transport cannot expunge. A possible residual must survive directory cleanup in both reports.
  expect(row.cleanup[0]).toContain("可能残留种子");
  expect(summary([row])).toContain(row.cleanup[0]!);
});

it("cannot pass a reschedule by creating the final event only on the second turn", async () => {
  const reschedule = task("calendar-reschedule");
  const main = fauxProvider();
  const row = await runTask({ ...reschedule, setup(c) {
    main.setResponses([say("已经记好了。"), call("enable_tool", { capability: "calendar" }),
      call("calendar_create", { title: "导师会", start: new Date(c.day(1, 14)).toISOString(), end: new Date(c.day(1, 14, 30)).toISOString() }),
      say("改好了。")]);
  } }, setup(main));
  expect(row).toMatchObject({ status: "fail", reason: "第一轮未建成 10:00–10:30 的导师会" });
  expect(row.turnLatencyMs).toHaveLength(2);
});

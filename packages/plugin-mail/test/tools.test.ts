import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { simpleParser } from "mailparser";
import { schema } from "@alter/core";
import { expect, it } from "vitest";
import { config, setup } from "./fake.ts";

const folder = "custom/drafts";
function fixture(dataDir?: string) {
  const app = setup({ dataDir });
  app.inbox.set(7, { uid: 7, seq: 1, envelope: { subject: "Different mailbox" } });
  app.boxes.get(folder)!.set(7, { uid: 7, seq: 1, flags: new Set(["\\Flagged", "custom"]),
    headers: Buffer.from("References: <first@example.test>\r\n <next@example.test>\r\n\r\n"),
    envelope: { subject: "Report", messageId: "<parent@example.test>", date: new Date("2026-11-20"),
      from: [{ name: "Author", address: "author@example.test" }], replyTo: [{ address: "desk@example.test" }],
      to: [{ address: config.address }, { address: "team@example.test" }],
      cc: [{ address: "TEAM@example.test" }, { address: "colleague@example.test" }], bcc: [{ address: "private@example.test" }] },
    bodyStructure: { type: "multipart/mixed", childNodes: [{ type: "text/plain", part: "1" },
      { type: "application/octet-stream", part: "2", disposition: "attachment", dispositionParameters: { filename: "../../..\\../../报告?.bin" }, size: 8 }] } });
  app.parts.set("1", Buffer.from("Entire report"));
  app.parts.set("2", Buffer.from([0, 1, 2, 255]));
  return app;
}

function items(result: { text: string }) {
  return [...result.text.matchAll(/<external [^>]*>(.*)<\/external>/g)].map(match =>
    JSON.parse(match[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")));
}

it("registers all actions with their effects and bounds", () => {
  const { plugin } = fixture();
  const reads = ["folders", "search", "read", "attachment", "contacts"];
  const writes = ["draft", "send", "reply", "forward", "mark", "move"];
  expect(plugin.capability.actions).toEqual([...reads.map(name => ({ name, effect: "read" })), ...writes.map(name => ({ name, effect: "write" }))]);
  expect(plugin.tools.map(t => t.name).sort()).toEqual([...reads, ...writes].map(s => "mail_" + s).sort());
  const check = schema.compile(plugin.tools.find(t => t.name === "mail_search")!.parameters!).check;
  expect(check({ limit: 100 })).toBe(true);
  expect(check({ limit: 101 })).toBe(false);
});

it("lists paths with special uses and status, and propagates LIST failures", async () => {
  const app = fixture();
  const rows = items(await app.call("mail_folders", {}));
  expect(rows).toContainEqual({ name: folder, specialUse: "Drafts", total: 1, unread: 1 });
  expect(rows).toContainEqual({ name: "custom/sent", specialUse: "Sent", total: 0, unread: 0 });
  expect(app.sessions[0]!.list).toHaveBeenCalledWith({ statusQuery: { messages: true, unseen: true } });
  const create = app.clients.imap.getMockImplementation()!;
  app.clients.imap.mockImplementationOnce(() => {
    const s = create(); s.list.mockRejectedValueOnce(new Error("LIST failed")); return s;
  });
  await expect(app.call("mail_folders", {})).rejects.toThrow("LIST failed");
});

it("uses UID SEARCH for all standard filters and returns flags, recipients and attachment counts", async () => {
  const app = fixture();
  const args = { folder, from: "author", to: "team", subject: "report", text: "Entire", since: "2026-11-20", before: "2026-11-21",
    flagged: true, unseen: true, has_attachment: true };
  const rows = items(await app.call("mail_search", args));
  expect(rows).toEqual([expect.objectContaining({ folder, uid: 7, date: "2026-11-20T00:00:00.000Z", from: "Author <author@example.test>",
    to: expect.stringContaining("team@example.test"), seen: false, flagged: true, attachmentCount: 1 })]);
  expect(app.sessions[0]!.search).toHaveBeenCalledWith({ all: true, from: "author", to: "team", subject: "report", text: "Entire",
    since: new Date(args.since), before: new Date(args.before), flagged: true, seen: false }, { uid: true, strict: true });
  expect(items(await app.call("mail_search", { ...args, has_attachment: false }))).toEqual([]);
  await expect(app.call("mail_search", { before: "2026-02-30" })).rejects.toThrow("YYYY-MM-DD");
  await expect(app.call("mail_search", { folder: "unknown" })).rejects.toThrow("folder");
});

it("finds a Coremail match past 500 newer messages and past the read preview", async () => {
  const app = setup({ imap: { host: "imap.163.com", port: 993 } });
  for (let uid = 1; uid <= 502; uid++) app.inbox.set(uid, { uid, seq: uid,
    envelope: { subject: uid === 1 ? "older" : "noise" }, bodyStructure: { type: "text/plain", part: "1" } });
  app.parts.set("1", Buffer.from("a".repeat(70_000) + "needle"));
  expect(items(await app.call("mail_search", { subject: "older", text: "needle", limit: 1 })).map(r => r.uid)).toEqual([1]);
  expect(app.sessions[0]!.fetchAll).toHaveBeenCalledTimes(6);
  expect(app.sessions[0]!.download).toHaveBeenCalledTimes(1);
});

it("reads thread headers and numbered attachment metadata from the selected folder", async () => {
  const app = fixture();
  expect(items(await app.call("mail_read", { folder, uid: 7 }))).toMatchObject([{ folder, uid: 7, subject: "Report",
    messageId: "<parent@example.test>", references: ["<first@example.test>", "<next@example.test>"], text: "Entire report",
    attachments: [{ index: 1, filename: expect.stringContaining("报告"), type: "application/octet-stream", size: 8 }] }]);
  await expect(app.call("mail_read", { folder, uid: 8 })).rejects.toThrow("UID 8");
});

it("saves decoded attachment bytes privately under attachments despite hostile names, with no partial files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-mail-files-"));
  const app = fixture(dir);
  const args = { folder, uid: 7, index: 1 };
  try {
    const [row] = items(await app.call("mail_attachment", args));
    expect(dirname(row.path)).toBe(join(dir, "attachments"));
    expect(row.path).toMatch(/-报告_\.bin$/);
    expect(row).toMatchObject({ size: 4, type: "application/octet-stream" });
    expect(await readFile(row.path)).toEqual(app.parts.get("2"));
    expect(items(await app.call("mail_attachment", args))[0].path).toBe(row.path);
    await expect(app.call("mail_attachment", { ...args, index: 2 })).rejects.toThrow("No attachment");
    app.parts.delete("2");
    await expect(app.call("mail_attachment", args)).rejects.toThrow("download");
    expect(await readdir(join(dir, "attachments"))).toHaveLength(1);
    await rm(join(dir, "attachments"), { recursive: true });
    await symlink(dir, join(dir, "attachments"), "dir");
    await expect(app.call("mail_attachment", args)).rejects.toThrow("directory");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([false, true])("threads replies using Reply-To and reply_all=%s, and replays after the original disappears", async reply_all => {
  const app = fixture();
  const args = { folder, uid: 7, text: "收到", reply_all };
  const { text: id } = await app.call("mail_reply", args);
  const [_, to, raw] = app.clients.smtp.mock.calls[0]!;
  expect(to).toEqual(reply_all ? ["desk@example.test", "team@example.test", "colleague@example.test"] : "desk@example.test");
  const parsed = await simpleParser(raw);
  expect(parsed).toMatchObject({ messageId: id, inReplyTo: "<parent@example.test>", subject: "Re: Report",
    references: ["<first@example.test>", "<next@example.test>", "<parent@example.test>"] });
  expect(parsed.text?.trim()).toBe("收到");
  expect(raw.toString()).not.toContain("private@example.test");
  app.boxes.get(folder)!.clear();
  expect((await app.call("mail_reply", args)).text).toBe(id);
  expect(app.clients.smtp).toHaveBeenCalledTimes(1);
  app.api.taskId++;
  await expect(app.call("mail_reply", args)).rejects.toThrow("UID 7");
});

it.each([true, false])("forwards full body and includes attachments=%s, reconciles lost SMTP acknowledgement", async include => {
  const app = fixture();
  const args = { folder, uid: 7, text: "FYI", to: ["one@example.test", "two@example.test"], ...(include ? {} : { include_attachments: false }) };
  app.parts.set("1", Buffer.from("a".repeat(70_000) + " END"));
  app.clients.smtp.mockImplementationOnce(async (_, to, raw) => {
    expect(to).toEqual(args.to);
    const msg = await simpleParser(raw);
    expect(msg.subject).toBe("Fwd: Report");
    expect(msg.text).toMatch(/^FYI[\s\S]* END\s*$/);
    expect(msg.attachments.map(a => a.content)).toEqual(include ? [app.parts.get("2")] : []);
    app.sent.set(msg.messageId!, raw);
    throw new Error("Lost acknowledgement");
  });
  await expect(app.call("mail_forward", args)).rejects.toThrow("did not confirm");
  app.boxes.get(folder)!.clear();
  expect((await app.call("mail_forward", args)).text).toBe([...app.sent.keys()][0]);
  expect(app.clients.smtp).toHaveBeenCalledTimes(1);
  app.api.taskId++;
  await expect(app.call("mail_forward", { ...args, to: ["not-an-address"] })).rejects.toThrow("recipients");
});

it("sets and clears only requested flags and rejects missing UIDs before updating", async () => {
  const app = fixture();
  const args = { folder, uids: [7], seen: true, flagged: false };
  await app.call("mail_mark", args);
  expect(app.boxes.get(folder)!.get(7)!.flags).toEqual(new Set(["custom", "\\Seen"]));
  expect(app.sessions[0]!.mailboxOpen).toHaveBeenCalledWith(folder, { readOnly: false });
  await expect(app.call("mail_mark", { folder, uids: [7] })).rejects.toThrow('Invalid arguments for tool "mail_mark": provide at least one of "seen" or "flagged"');
  await expect(app.call("mail_mark", { ...args, uids: [7, 8] })).rejects.toThrow("8");
  expect(app.sessions.at(-1)!.messageFlagsAdd).not.toHaveBeenCalled();
});

it("moves selected UIDs only, surfaces a missing destination and avoids mailbox-wide expunge", async () => {
  const app = fixture();
  const args = { folder, uids: [7], destination: "custom/sent" };
  await expect(app.call("mail_move", { ...args, destination: "missing" })).rejects.toThrow("move failed");
  const create = app.clients.imap.getMockImplementation()!;
  app.clients.imap.mockImplementationOnce(() => { const s = create(); s.capabilities.clear(); return s; });
  await expect(app.call("mail_move", args)).rejects.toThrow("MOVE or UIDPLUS");
  await app.call("mail_move", args);
  expect(app.boxes.get(folder)!.size).toBe(0);
  expect(app.inbox.has(7)).toBe(true);
  expect(app.boxes.get(args.destination)!.get(1)?.envelope?.subject).toBe("Report");
  await expect(app.call("mail_move", args)).rejects.toThrow("UID");
});

it("aggregates INBOX and Sent once per message and address, filters by name and sorts by frequency", async () => {
  const app = setup();
  const alice = { name: "Alice", address: "Alice@example.test" };
  app.inbox.set(1, { uid: 1, seq: 1, envelope: { from: [alice], to: [{ address: config.address }], date: "2026-11-10" } });
  const sent = app.boxes.get("custom/sent")!;
  sent.set(1, { uid: 1, seq: 1, envelope: { from: [{ address: config.address }], date: "2026-11-20",
    to: [{ address: "alice@EXAMPLE.test" }, { name: "Other", address: "z@example.test" }], cc: [alice] } });
  expect(items(await app.call("mail_contacts", { limit: 1 }))).toEqual([{ ...alice, count: 2, lastAt: "2026-11-20T00:00:00.000Z" }]);
  expect(items(await app.call("mail_contacts", { query: "oTHer" })).map(c => c.address)).toEqual(["z@example.test"]);
  expect(items(await app.call("mail_contacts", { query: config.address }))).toEqual([]);
  app.boxes.delete("custom/sent");
  await expect(app.call("mail_contacts", {})).rejects.toThrow("Missing folder");
});

it("repairs Sent filing of a multipart forward with the original bytes and no additional SMTP", async () => {
  const app = fixture();
  const args = { folder, uid: 7, to: [config.address] };
  app.clients.smtp.mockImplementationOnce(async () => {
    app.sessions[0]!.append.mockRejectedValueOnce(new Error("offline"));
  });
  await expect(app.call("mail_forward", args)).rejects.toThrow("filing is unconfirmed");
  const { text: id } = await app.call("mail_forward", args);
  expect(app.clients.smtp).toHaveBeenCalledTimes(1);
  expect(app.sent.get(id)).toEqual(app.clients.smtp.mock.calls[0]![2]);
});

it("refuses unthreadable replies before SMTP and supports replying to a self-addressed message", async () => {
  const app = fixture();
  const args = { folder, uid: 7, text: "ack" };
  const env = app.boxes.get(folder)!.get(7)!.envelope!;
  delete env.messageId;
  await expect(app.call("mail_reply", args)).rejects.toThrow("Message-ID");
  expect(app.clients.smtp).not.toHaveBeenCalled();
  env.messageId = "<self@example.test>";
  env.to = env.from = [{ address: config.address }];
  delete env.replyTo;
  await app.call("mail_reply", args);
  expect(app.clients.smtp.mock.calls[0]![1]).toBe(config.address);
});

it("holds uncertain replies on replay without consulting the original or trying SMTP again", async () => {
  const app = fixture();
  const args = { folder, uid: 7, text: "ack" };
  app.clients.smtp.mockRejectedValueOnce(new Error("disconnected"));
  await expect(app.call("mail_reply", args)).rejects.toThrow("did not confirm");
  app.boxes.get(folder)!.clear();
  await expect(app.call("mail_reply", args)).rejects.toThrow("uncertain");
  expect(app.clients.smtp).toHaveBeenCalledTimes(1);
});

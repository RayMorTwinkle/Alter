import { expect, it } from "vitest";
import { timelineEntries } from "../src/timeline.ts";

it("shows a compaction summary as a fold instead of a user message", () => {
  const text = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## 欠着的事\n- 周五提醒投简历\n</summary>";
  const entry = { id: 7, kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text }], timestamp: 42 }] };
  expect(timelineEntries(entry as unknown as Parameters<typeof timelineEntries>[0], {})).toEqual([
    { kind: "notice", source: "compaction", id: "entry-7", text: "## 欠着的事\n- 周五提醒投简历", at: 42 },
  ]);
});

it.each([
  { isError: true, text: '  [error]  Invalid argument "pageToken"  ', detail: 'Invalid argument "pageToken"' },
  { isError: true, text: '<harness>\n[error] Invalid argument "text"\n</harness>', detail: 'Invalid argument "text"' },
  { isError: true, text: "[error] " + "x".repeat(498) + "😀" + "tail", detail: "x".repeat(498) + "…" },
  { isError: true, text: "[error]  ", detail: undefined },
  { isError: false, text: "[error] successful tool output", detail: undefined },
])("projects error detail only for failed tool results with readable content", ({ isError, text, detail }) => {
  type Entry = Parameters<typeof timelineEntries>[0];
  const turn = {};
  const call = { id: 8, model: [{ role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "call1", name: "search", arguments: {} }] }] };
  const result = { id: 9, model: [{ role: "toolResult", timestamp: 2, toolCallId: "call1", toolName: "search", isError,
    content: [{ type: "text", text }] }] };
  const [running] = timelineEntries(call as unknown as Entry, turn);
  expect(running).not.toHaveProperty("errorDetail");
  const [settled] = timelineEntries(result as unknown as Entry, turn);
  expect(settled).toMatchObject({ id: running!.id, kind: "tool", isError });
  if (detail === undefined) expect(settled).not.toHaveProperty("errorDetail");
  else expect(settled?.errorDetail).toBe(detail);
});

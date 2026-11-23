import { expect, it } from "vitest";
import { timelineEntries } from "../src/timeline.ts";

it("shows a compaction summary as a fold instead of a user message", () => {
  const text = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## 欠着的事\n- 周五提醒投简历\n</summary>";
  const entry = { id: 7, kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text }], timestamp: 42 }] };
  expect(timelineEntries(entry as unknown as Parameters<typeof timelineEntries>[0], {})).toEqual([
    { kind: "notice", source: "compaction", id: "entry-7", text: "## 欠着的事\n- 周五提醒投简历", at: 42 },
  ]);
});

import { expect, it } from "vitest";
import { initialState, reduce } from "../src/store.ts";

const row = (id: string, at: number) => ({ id, at, kind: "assistant" as const, text: id });

it("reuses state for a cumulative draft replay and accepts the next fragment", () => {
  const first = reduce(initialState, { type: "delta", id: "a", text: "H" });
  expect(reduce(first, { type: "delta", id: "a", text: "H" })).toBe(first);
  const second = reduce(first, { type: "delta", id: "a", text: "Hello" });
  expect(second.draft?.text).toBe("Hello");
  const settled = reduce(second, { type: "timeline", item: row("a", 1) });
  expect(reduce(settled, { type: "delta", id: "a", text: "late" })).toBe(settled);
});

it("keeps ties stable and repositions an item whose timestamp changed", () => {
  const initialRows = [row("c", 3), row("a", 1), row("b", 1)];
  let state = initialState;
  for (const item of initialRows) state = reduce(state, { type: "timeline", item });
  const previous = state.timeline;
  state = reduce(state, { type: "timeline", item: row("a", 4) });
  expect(previous.map(item => item.id)).toEqual(["a", "b", "c"]);
  expect(state.timeline.map(item => item.id)).toEqual(["b", "c", "a"]);
  state = reduce(state, { type: "timeline", item: row("a", 0) });
  expect(state.timeline.map(item => item.id)).toEqual(["a", "b", "c"]);
});

it("normalizes a reconnect snapshot and rejects settled IDs during a different draft", () => {
  const timeline = [row("later", 3), row("earlier", 1)];
  let state = reduce(initialState, { type: "snapshot", snapshot: { ...initialState, timeline } });
  expect(timeline.map(item => item.id)).toEqual(["later", "earlier"]);
  state = reduce(state, { type: "timeline", item: row("last", 5) });
  expect(state.timeline.map(item => item.id)).toEqual(["earlier", "later", "last"]);
  state = reduce(state, { type: "delta", id: "new", text: "typing" });
  expect(reduce(state, { type: "delta", id: "earlier", text: "late" })).toBe(state);
});

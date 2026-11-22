import { describe, expect, it } from "vitest";
import { initialState, reduce, userPending } from "../src/store.ts";
import type { PermissionRequest, TimelineItem } from "../src/types.ts";

const item = (id: string, at: number, kind: TimelineItem["kind"] = "assistant"): TimelineItem => ({ id, kind, text: id, at });

describe("reduce", () => {
  it("replaces the streaming draft with the settled item of the same id", () => {
    let state = reduce(initialState, { type: "delta", id: "a", text: "Hel" });
    state = reduce(state, { type: "delta", id: "a", text: "Hello" });
    expect(state.draft).toEqual({ id: "a", text: "Hello" });
    state = reduce(state, { type: "timeline", item: item("a", 2) });
    expect(state.draft).toBeNull();
    expect(state.timeline.map(i => i.id)).toEqual(["a"]);
  });

  it("ignores a late delta for an answer that already settled", () => {
    let state = reduce(initialState, { type: "timeline", item: item("a", 2) });
    state = reduce(state, { type: "delta", id: "a", text: "stale" });
    expect(state.draft).toBeNull();
  });

  it("upserts by id and keeps the timeline in time order", () => {
    let state = reduce(initialState, { type: "timeline", item: item("b", 20) });
    state = reduce(state, { type: "timeline", item: item("a", 10) });
    state = reduce(state, { type: "timeline", item: { ...item("b", 20), text: "edited" } });
    expect(state.timeline.map(i => [i.id, i.text])).toEqual([["a", "a"], ["b", "edited"]]);
  });

  it("rebuilds from a snapshot after reconnecting", () => {
    let state = reduce(initialState, { type: "delta", id: "x", text: "partial" });
    state = reduce(state, { type: "snapshot", snapshot: {
      timeline: [item("1", 1)], tasks: [], pending: [], ledger: [], leases: [], busy: false,
    } });
    expect(state.draft).toBeNull();
    expect(state.timeline).toHaveLength(1);
  });

  it("drops the draft when the main session stops", () => {
    let state = reduce(initialState, { type: "delta", id: "x", text: "partial" });
    state = reduce(state, { type: "busy", busy: false });
    expect(state.draft).toBeNull();
  });

  it("counts only requests the user must answer", () => {
    const request = (id: string, audience: PermissionRequest["audience"]): PermissionRequest =>
      ({ id, taskId: "t", audience, capability: "outbox", tool: "outbox_send", arguments: {}, reason: "" });
    expect(userPending({ pending: [request("1", "user"), request("2", "main")] }).map(r => r.id)).toEqual(["1"]);
  });
});

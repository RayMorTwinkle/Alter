import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/api.ts";
import { ApprovalCard } from "../src/components/ApprovalCard.tsx";
import { MissionBoard } from "../src/components/MissionControl.tsx";
import { historyLimit, initialWorkspace, reduceWorkspace, replayAt, replayFrames } from "../src/replay.ts";
import { initialState, reduce, type Action } from "../src/store.ts";
import type { PermissionRequest } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["once", "deny"] as const)("seeks through the %s branch without leaking future state into previous frames", choice => {
  const frames = replayFrames(choice);
  const at = (i: number) => replayAt(frames, i);
  expect(at(0).tasks).toEqual([]);
  expect(at(1).tasks[0]?.status).toBe("queued");
  expect(at(2).tasks[0]?.status).toBe("running");
  const parked = at(4);
  expect(parked.tasks[0]?.pending).toEqual(parked.pending);
  const end = at(6);
  expect(end.traces?.map(row => row.decision)).toEqual(["allow", "allow", "park", choice === "once" ? "allow" : "deny"]);
  expect(end.tasks[0]).toMatchObject({ endedAt: frames[6]!.at, status: "completed", pending: [] });
  expect(end.timeline.at(-1)?.text).toBe(end.ledger[0]?.summary);
  expect(end.ledger[0]?.summary).toContain(choice === "once" ? "已发送" : "拒绝");
  expect(at(4)).toEqual(parked);
  expect(parked.pending).toHaveLength(1);
  expect(parked.ledger).toEqual([]);
  const html = renderToStaticMarkup(<MissionBoard state={parked} now={frames[4]!.at} onAnswer={async () => {}} replay />);
  for (const label of ["主会话", "子代理", "5.0 s", "只读", "本地写入", "高危 · 对外发送", "历史实测", "模拟会话"]) expect(html).toContain(label);
});

const request: PermissionRequest = { id: "test", taskId: "main", audience: "user", capability: "calendar",
  tool: "calendar_update", effect: "write", arguments: { before: "old title", after: "<new title>" },
  reason: "rename", expiresAt: 10 };

it("renders escaped changes and disables decisions at the exact replay deadline", () => {
  const render = (at: number) => renderToStaticMarkup(<ApprovalCard request={request} onAnswer={async () => {}} replayTime={at} />);
  expect(render(9)).not.toContain("disabled");
  const html = render(10);
  for (const text of ["old title", "&lt;new title&gt;", "本地写入", "参数预览", "变更预览", "已过期"]) expect(html).toContain(text);
  expect(html.match(/<button[^>]*disabled/g)).toHaveLength(2);
});

it("replaces the trace window on reconnect, including a pre-trace server snapshot", () => {
  const frames = replayFrames("once");
  const snapshot = replayAt(frames, 4);
  const withoutTraces = reduce(snapshot, { type: "snapshot", snapshot: initialState });
  expect(withoutTraces.traces).toEqual([]);
  const reconnect = reduce(withoutTraces, { type: "snapshot", snapshot });
  expect(reduce(reconnect, { type: "traces", traces: snapshot.traces! }).traces).toEqual(snapshot.traces);
});

it("sends the exact-call and tool-window decisions as distinct HTTP values", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  for (const decision of ["call", "once"] as const) {
    await api.answer(request.id, decision);
    expect(fetcher).toHaveBeenLastCalledWith("/api/permissions/test", expect.objectContaining({ body: JSON.stringify({ decision }) }));
  }
});

it("records observed SSE frames, coalesces cumulative drafts and starts a new segment on reconnect", () => {
  let workspace = initialWorkspace;
  function receive(action: Action, at: number) { workspace = reduceWorkspace(workspace, { action, at }); }
  receive({ type: "connection", connection: "open" }, 0);
  expect(workspace.history).toEqual([]);
  receive({ type: "snapshot", snapshot: initialState }, 1);
  receive({ type: "delta", id: "reply", text: "h" }, 2);
  receive({ type: "delta", id: "reply", text: "hello" }, 20);
  const saved = workspace.history;
  expect(saved.map(frame => frame.event)).toEqual(["snapshot", "delta"]);
  expect(saved[1]?.state.draft?.text).toBe("hello");
  for (let i = 0; i < historyLimit + 1; i++) receive({ type: "busy", busy: i % 2 === 0 }, 30 + i);
  expect(workspace.history.length).toBe(historyLimit);
  expect(saved).toHaveLength(2);
  receive({ type: "snapshot", snapshot: initialState }, 500);
  expect(workspace.history.map(frame => frame.event)).toEqual(["snapshot"]);
  expect(workspace.state.draft).toBeNull();
});

it("keeps a recorded approval read-only while displaying its original arguments", () => {
  const frames = replayFrames("once");
  const html = renderToStaticMarkup(<MissionBoard state={replayAt(frames, 4)} now={frames[4]!.at} replay />);
  expect(html).toContain("会话回放");
  expect(html).toContain("team@example.invalid");
  expect(html).not.toContain("<button");
});

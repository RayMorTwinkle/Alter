import { expect, it, vi } from "vitest";
import { backoffDelay, distinctItems, fingerprintIds, freshItems, localDay, runPollBatch, type PollerState } from "@alter/plugin-sdk/poller";

const instant = Date.UTC(2026, 1, 1, 12);
const intervalMs = 300_000;
const fixedClock = { intervalMs, now: () => instant, timeZone: "UTC" };
const items = (...ids: string[]) => ids.map(id => ({ id }));
const empty = (state: Partial<PollerState> = {}): PollerState => ({
  seen: [], baseline: false, failures: 0, invalid: 0, paused: false,
  lastPollAt: 0, nextPollAt: 0, day: "", count: 0, error: null, ...state,
});
const restart = (state: PollerState): PollerState => JSON.parse(JSON.stringify(state));

it("keeps the first item per ID in batch order", () => {
  const first = { id: "a", title: "first" };
  const second = { id: "b", title: "second" };
  expect(distinctItems([first, second, { id: "a", title: "duplicate" }])).toEqual([first, second]);
  expect(fingerprintIds(["ab", "c"])).not.toBe(fingerprintIds(["a", "bc"]));
});

it("records the initial baseline without calling onItem and delivers only new distinct IDs next", async () => {
  const onItem = vi.fn();
  const before = empty({ failures: 2, invalid: 1, error: "broken" });
  const baseline = (await runPollBatch(before, { ...fixedClock, pull: () => ({ items: items("a", "a", "b") }), onItem }))!;
  expect(onItem).not.toHaveBeenCalled();
  expect(baseline).toMatchObject({ status: "success", state: { baseline: true, seen: ["a", "b"], count: 0,
    failures: 0, invalid: 0, error: null, lastPollAt: instant, nextPollAt: instant + intervalMs } });
  expect(before).toEqual(empty({ failures: 2, invalid: 1, error: "broken" }));

  const next = (await runPollBatch(baseline.state, { ...fixedClock, pull: () => ({ items: items("a", "c", "c") }), onItem }))!;
  expect(onItem.mock.calls).toEqual([[{ id: "c" }]]);
  expect(next.state).toMatchObject({ seen: ["c", "a", "b"], count: 1 });
});

it("keeps only 1000 IDs and recognizes the unchanged overflow block after restart", async () => {
  const ids = Array.from({ length: 1250 }, (_, i) => String(i));
  const onItem = vi.fn();
  const baseline = (await runPollBatch(empty(), { ...fixedClock, pull: () => ({ items: items(...ids) }), onItem }))!;
  expect(baseline.state.seen).toEqual(ids.slice(0, 1000));
  expect(baseline.state.overflow).toEqual({ first: "1000", length: 250, hash: fingerprintIds(ids.slice(1000)) });

  const withNew = items("new-head", ...ids, "new-tail");
  const restored = restart(baseline.state);
  const seen = new Set(restored.seen);
  expect(freshItems(withNew, seen, restored.overflow)).toEqual(items("new-head", "new-tail"));
  expect(seen.size).toBe(1000);
  const next = (await runPollBatch(restored, { ...fixedClock, pull: () => ({ items: withNew }), onItem }))!;
  await runPollBatch(restart(next.state), { ...fixedClock, pull: () => ({ items: withNew }), onItem });
  expect(onItem.mock.calls).toEqual([[{ id: "new-head" }], [{ id: "new-tail" }]]);
  const changed = items("1000", ...ids.slice(1002), "replacement");
  expect(freshItems(changed, seen, restored.overflow)).toEqual(changed);
});

it("resumes delivery after the last acknowledged item without committing a failed batch validator", async () => {
  const pull = () => ({ items: items("a", "b", "c"), metadata: "new-validator", minIntervalMs: 900_000 });
  const onItem = vi.fn(async ({ id }: { id: string }) => {
    if (id === "b") throw Error("delivery failed");
  });
  const failed = (await runPollBatch(empty({ baseline: true }), { ...fixedClock, pull, onItem }))!;
  expect(failed).toMatchObject({ status: "failed", state: { seen: ["a"], count: 1, failures: 1, invalid: 0,
    error: "delivery failed", lastPollAt: instant, nextPollAt: instant + 900_000 } });
  expect(failed).not.toHaveProperty("metadata");
  expect(onItem.mock.calls).toEqual([[{ id: "a" }], [{ id: "b" }]]);

  onItem.mockReset().mockResolvedValue(undefined);
  const retry = (await runPollBatch(restart(failed.state), { ...fixedClock, pull, onItem }))!;
  expect(onItem.mock.calls).toEqual([[{ id: "b" }], [{ id: "c" }]]);
  expect(retry).toMatchObject({ status: "success", metadata: "new-validator", state: {
    count: 3, failures: 0, invalid: 0, error: null, nextPollAt: instant + 900_000 } });
});

it("checkpoints a stop after delivery progress without penalizing the next poll", async () => {
  const controller = new AbortController();
  const onItem = vi.fn(() => controller.abort());
  const pull = () => ({ items: items("a", "b"), metadata: "uncommitted" });
  const options = { ...fixedClock, pull, onItem, signal: controller.signal };
  const result = (await runPollBatch(empty({ baseline: true }), options))!;
  expect(onItem.mock.calls).toEqual([[{ id: "a" }]]);
  expect(result).toMatchObject({ status: "interrupted", state: { seen: ["a"], count: 1, failures: 0, error: null, nextPollAt: instant } });
  expect(result).not.toHaveProperty("metadata");
  expect(await runPollBatch(result.state, options)).toBeUndefined();
});

it("caps exponential backoff at six doublings and respects minimum intervals from pull errors", async () => {
  expect([0, 1, 2, 6, 7].map(n => backoffDelay(1000, n))).toEqual([1000, 2000, 4000, 64_000, 64_000]);
  expect(backoffDelay(1000, 2, 7000)).toBe(7000);
  const result = (await runPollBatch(empty({ failures: 6, minIntervalMs: 600_000 }), {
    ...fixedClock,
    pull() { throw Error("slow down"); },
    onItem: vi.fn(),
    classifyError: () => ({ error: "slow down", minIntervalMs: 20_000_000 }),
  }))!;
  expect(result.state).toMatchObject({ failures: 7, minIntervalMs: 20_000_000, nextPollAt: instant + 20_000_000 });
});

it("pauses only after consecutive invalid pulls reach the configured threshold", async () => {
  const pull = vi.fn(() => { throw Error("wrong shape"); });
  const onItem = vi.fn();
  const options = { ...fixedClock, maxInvalid: 2, pull, onItem, classifyError: (cause: unknown) => ({
    error: (cause as Error).message, invalid: (cause as Error).message === "wrong shape",
  }) };
  const first = (await runPollBatch(empty(), options))!;
  expect(first.state).toMatchObject({ baseline: false, failures: 1, invalid: 1, paused: false });
  pull.mockImplementationOnce(() => { throw Error("offline"); });
  const offline = (await runPollBatch(first.state, options))!;
  expect(offline.state).toMatchObject({ failures: 2, invalid: 0, paused: false });
  const once = (await runPollBatch(offline.state, options))!;
  const twice = (await runPollBatch(once.state, options))!;
  expect(twice.state).toMatchObject({ failures: 4, invalid: 2, paused: true, error: "wrong shape" });
  expect(await runPollBatch(restart(twice.state), options)).toBeUndefined();
  expect(pull).toHaveBeenCalledTimes(4);
  expect(onItem).not.toHaveBeenCalled();
});

it("resets the count when the source's local date changes before UTC midnight", async () => {
  const timeZone = "Asia/Taipei";
  const midnight = Date.UTC(2026, 1, 1, 16);
  let at = midnight - 1;
  const options = { ...fixedClock, timeZone, now: () => at, onItem: vi.fn() };
  expect(localDay(at, timeZone)).toBe("2026-02-01");
  expect(localDay(midnight, timeZone)).toBe("2026-02-02");
  expect(localDay(midnight, "UTC")).toBe("2026-02-01");
  const delivered = (await runPollBatch(empty({ baseline: true }), { ...options, pull: () => ({ items: items("a") }) }))!;
  expect(delivered.state).toMatchObject({ day: "2026-02-01", count: 1 });

  at = midnight;
  const reset = (await runPollBatch(delivered.state, { ...options, pull: () => ({ items: [] }) }))!;
  expect(reset.state).toMatchObject({ day: "2026-02-02", count: 0 });
  const next = (await runPollBatch(reset.state, { ...options, pull: () => ({ items: items("a", "b") }) }))!;
  expect(next.state).toMatchObject({ day: "2026-02-02", count: 1 });
});

import { createHash } from "node:crypto";

export type PollerItem = { id: string };
export type PollerOverflow = { first: string; length: number; hash: string };
export type PollerState = {
  seen: string[];
  overflow?: PollerOverflow;
  baseline: boolean;
  failures: number;
  invalid: number;
  paused: boolean;
  lastPollAt: number;
  nextPollAt: number;
  day: string;
  count: number;
  error: string | null;
  minIntervalMs?: number;
};
type History = Pick<PollerState, "seen" | "overflow">;

export function distinctItems<T extends PollerItem>(items: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()];
}

export function fingerprintIds(ids: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(ids)).digest("base64url");
}

// One digest recognizes an unchanged stretch of old IDs outside the retained set.
function partitionUnseen<T extends PollerItem>(items: readonly T[], seen: ReadonlySet<string>, overflow?: PollerOverflow) {
  const fresh = items.filter(i => !seen.has(i.id));
  const start = overflow ? fresh.findIndex(i => i.id === overflow.first) : -1;
  if (overflow && start >= 0 && start + overflow.length <= fresh.length) {
    const block = fresh.slice(start, start + overflow.length).map(i => i.id);
    if (fingerprintIds(block) === overflow.hash) {
      fresh.splice(start, block.length);
      return { fresh, matched: block };
    }
  }
  return { fresh, matched: [] };
}

export function freshItems<T extends PollerItem>(items: readonly T[], seen: ReadonlySet<string>, overflow?: PollerOverflow): T[] {
  return partitionUnseen(items, seen, overflow).fresh;
}

export function rememberItems<T extends PollerItem>(state: History, items: readonly T[], known: ReadonlySet<string>,
  received: readonly string[], maxSeen = 1000): History {
  const seen = [...new Set([...received, ...state.seen])].slice(0, maxSeen);
  const retained = new Set(seen);
  const rest = items.map(i => i.id).filter(id => known.has(id) && !retained.has(id));
  return { seen, overflow: rest.length ? { first: rest[0]!, length: rest.length, hash: fingerprintIds(rest) } : undefined };
}

export function backoffDelay(intervalMs: number, failures: number, minIntervalMs?: number): number {
  return Math.max(intervalMs * 2 ** Math.min(failures, 6), minIntervalMs ?? 0);
}

function dayFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

export function localDay(at: number, timeZone: string): string {
  return dayFormatter(timeZone).format(at);
}

export type PollerBatch<T extends PollerItem, Metadata = unknown> = {
  items: readonly T[];
  minIntervalMs?: number;
  /** Upstream cursor or validator to commit only after the entire batch succeeds. */
  metadata?: Metadata;
};
export type PollerFailure = { error: string; invalid?: boolean; minIntervalMs?: number };
export type PollerOptions<T extends PollerItem, Metadata = unknown> = {
  pull: () => PollerBatch<T, Metadata> | Promise<PollerBatch<T, Metadata>>;
  onItem: (item: T) => void | Promise<void>;
  /** Acknowledge the remainder together once this many individual items have been delivered. */
  coalesce?: { after: number; onRemainder: (items: readonly T[]) => void | Promise<void> };
  /** Persist acknowledged progress before attempting the next delivery in the same batch. */
  checkpoint?: (state: PollerState) => void | Promise<void>;
  intervalMs: number;
  timeZone: string;
  now?: () => number;
  signal?: AbortSignal;
  maxSeen?: number;
  /** Pause after this many consecutive invalid pulls. Omit to keep retrying. */
  maxInvalid?: number;
  classifyError?: (cause: unknown) => PollerFailure;
};
type Outcome<Metadata> = { status: "success"; metadata?: Metadata } | { status: "failed" | "interrupted" };
export type PollerResult<Metadata = unknown> = { state: PollerState } & Outcome<Metadata>;

/** Returns a new checkpoint to persist, or undefined if paused or stopped without progress. */
export async function runPollBatch<T extends PollerItem, Metadata = unknown>(
  previous: Readonly<PollerState>, options: PollerOptions<T, Metadata>,
): Promise<PollerResult<Metadata> | undefined> {
  const { signal, intervalMs, now = Date.now } = options;
  if (previous.paused || signal?.aborted) return;
  const state = { ...previous };
  const date = dayFormatter(options.timeZone);
  function rollDay(at: number) {
    const day = date.format(at);
    if (state.day !== day) { state.day = day; state.count = 0; }
  }
  const known = new Set(state.seen);
  const received: string[] = [];
  let items: T[] = [];
  let pulled = false;
  let outcome: Outcome<Metadata>;
  try {
    const batch = await options.pull();
    pulled = true;
    items = distinctItems(batch.items);
    state.minIntervalMs = batch.minIntervalMs ?? state.minIntervalMs;
    if (state.baseline) {
      const { fresh, matched } = partitionUnseen(items, known, state.overflow);
      for (const id of matched) known.add(id);
      let delivered = 0;
      while (delivered < fresh.length) {
        signal?.throwIfAborted();
        let end = delivered + 1;
        if (options.coalesce && delivered >= options.coalesce.after) {
          await options.coalesce.onRemainder(fresh.slice(delivered));
          end = fresh.length;
        } else await options.onItem(fresh[delivered]!);
        rollDay(now());
        state.count += end - delivered;
        while (delivered < end) {
          const { id } = fresh[delivered++]!;
          received.push(id);
          known.add(id);
        }
        if (options.checkpoint && delivered < fresh.length) {
          await options.checkpoint({ ...state, ...rememberItems(state, items, known, received, options.maxSeen) });
        }
      }
    } else {
      for (const item of items) { received.push(item.id); known.add(item.id); }
    }
    state.baseline = true;
    state.failures = state.invalid = 0;
    state.error = null;
    outcome = { status: "success", metadata: batch.metadata };
  } catch (cause) {
    if (signal?.aborted) {
      if (!received.length) return;
      outcome = { status: "interrupted" };
    } else {
      const failure = options.classifyError?.(cause) ?? { error: cause instanceof Error ? cause.message : String(cause) };
      state.failures++;
      state.invalid = !pulled && failure.invalid ? state.invalid + 1 : 0;
      if (state.invalid && options.maxInvalid !== undefined && state.invalid >= options.maxInvalid) state.paused = true;
      state.error = failure.error;
      state.minIntervalMs = failure.minIntervalMs ?? state.minIntervalMs;
      outcome = { status: "failed" };
    }
  }
  if (items.length) Object.assign(state, rememberItems(state, items, known, received, options.maxSeen));
  const at = now();
  rollDay(at);
  state.lastPollAt = at;
  state.nextPollAt = signal?.aborted ? at : at + backoffDelay(intervalMs, state.failures, state.minIntervalMs);
  return { state, ...outcome };
}

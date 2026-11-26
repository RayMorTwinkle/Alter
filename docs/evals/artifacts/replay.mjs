// Run from the repository root with Node >=22.19.0. Read the specified Git tree
// without checking it out. WORKTREE is useful while developing the regression.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ref = process.argv[2];
if (!ref || ref.startsWith('-')) throw new Error('Usage: node docs/evals/artifacts/replay.mjs <git-ref|WORKTREE>');
const commit = ref === 'WORKTREE' ? null : execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const dir = await mkdtemp(join(tmpdir(), 'alter-replay-'));
const sources = {};
async function load(path) {
  const source = commit ? execFileSync('git', ['show', `${commit}:${path}`]) : await readFile(path);
  sources[path] = createHash('sha256').update(source).digest('hex');
  // Both modules have no runtime imports. .mts uses the same ESM semantics as the workspace.
  const dest = join(dir, path.split('/').at(-1).replace(/\.ts$/, '.mts'));
  await writeFile(dest, source);
  return import(pathToFileURL(dest));
}

function timelineReplay({ initialState, reduce }) {
  const historyLength = 200;
  const fragments = 256;
  const duplicates = 32;
  let idReads = 0;
  let timestampReads = 0;
  function row(index) {
    return { get id() { idReads++; return `settled-${index}`; }, get at() { timestampReads++; return index; }, kind: 'assistant', text: String(index) };
  }
  // An actual initial snapshot followed by cumulative full text for a new answer.
  const timeline = Array.from({ length: historyLength }, (_, i) => row(i));
  let state = reduce(initialState, { type: 'snapshot', snapshot: { timeline, tasks: [], pending: [], ledger: [], leases: [], busy: true } });
  idReads = 0;
  for (let length = 1; length <= fragments; length++) {
    state = reduce(state, { type: 'delta', id: 'draft', text: 'a'.repeat(length) });
  }
  const historyIdReads = idReads;
  const fullText = 'a'.repeat(fragments);
  const retainedFullText = state.draft?.text === fullText;
  let duplicateStateChanges = 0;
  for (let i = 0; i < duplicates; i++) {
    const next = reduce(state, { type: 'delta', id: 'draft', text: fullText });
    if (next !== state) duplicateStateChanges++;
    state = next;
  }
  state = reduce(state, { type: 'timeline', item: { id: 'draft', at: historyLength, text: fullText, kind: 'assistant' } });
  state = reduce(state, { type: 'delta', id: 'draft', text: 'late' });
  const lateDeltaIgnored = state.draft === null;

  let appended = initialState;
  timestampReads = 0;
  for (let i = 0; i < historyLength; i++) appended = reduce(appended, { type: 'timeline', item: row(i) });
  const orderedAppendTimestampReads = timestampReads;
  const orderedAppendCorrect = appended.timeline.length === historyLength && appended.timeline.every((value, index) => value.at === index);
  const corrected = reduce(appended, { type: 'timeline', item: { id: 'settled-0', at: historyLength + 1, kind: 'assistant', text: 'revised' } });
  const timestampCorrectionOrdered = corrected.timeline.length === historyLength && corrected.timeline.at(-1).id === 'settled-0';
  return { historyLength, fragments, duplicates, historyIdReads, duplicateStateChanges, orderedAppendTimestampReads,
    retainedFullText, lateDeltaIgnored, orderedAppendCorrect, timestampCorrectionOrdered };
}

function scheduleReplay({ calendarTime }) {
  const cases = [
    { name: 'missing Friday', zone: 'Pacific/Apia', from: '2011-12-29T12:00', time: '09:00', days: [5], expected: '2012-01-05T19:00:00.000Z' },
    { name: 'missing next Friday from last Friday', zone: 'Pacific/Apia', from: '2011-12-23T12:00', time: '09:00', days: [5], expected: '2012-01-05T19:00:00.000Z' },
    { name: 'unrestricted daily across missing Friday', zone: 'Pacific/Apia', from: '2011-12-29T12:00', time: '09:00', expected: '2011-12-30T19:00:00.000Z' },
    { name: 'spring gap on allowed Sunday', zone: 'America/New_York', from: '2026-03-08T01:00', time: '02:30', days: [0], expected: '2026-03-08T07:30:00.000Z' },
    { name: 'autumn fold first occurrence', zone: 'America/New_York', from: '2026-11-01T00:00', time: '01:30', days: [0], expected: '2026-11-01T05:30:00.000Z' },
    { name: 'autumn fold after first occurrence', zone: 'America/New_York', from: '2026-11-01T05:30Z', time: '01:30', days: [0], expected: '2026-11-08T06:30:00.000Z' },
    { name: 'ordinary Monday', zone: 'Asia/Shanghai', from: '2026-11-22T09:00', time: '09:00', days: [1], expected: '2026-11-23T01:00:00.000Z' },
  ];
  return cases.map(spec => {
    const calendar = calendarTime(spec.zone);
    const instant = calendar.nextDaily(calendar.parse(spec.from).ms, spec.time, spec.days);
    const actual = new Date(instant).toISOString();
    return { ...spec, actual, local: calendar.describe(instant).iso, pass: actual === spec.expected };
  });
}

try {
  const timeline = timelineReplay(await load('packages/web/src/store.ts'));
  const schedule = scheduleReplay(await load('packages/core/src/calendar-time.ts'));
  console.log(JSON.stringify({ ref, commit, sources, node: process.version, icu: process.versions.icu, tzdata: process.versions.tz, timeline,
    schedule: { passed: schedule.filter(item => item.pass).length, cases: schedule } }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}

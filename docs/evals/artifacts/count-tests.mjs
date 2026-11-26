// Count only the package-level Vitest summaries. Leave packages without Vitest in the raw log.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node count-tests.mjs PATH_TO_TESTS_LOG");
const text = readFileSync(path, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
const packages = {};
let current;
for (const raw of text.split("\n")) {
  const tagged = raw.match(/^packages\/([^/ ]+) test: (.*)$/);
  const line = tagged?.[2] ?? raw;
  const header = line.match(/^\s*RUN\s+v[\w.]+\s+.*[\\/]packages[\\/]([^\\/\s]+)\s*$/);
  if (header) current = header[1];
  const summary = line.match(/^\s*Tests\s+(.*)\s+\((\d+)\)\s*$/);
  if (!summary) continue;
  const name = tagged?.[1] ?? current;
  if (!name || Object.hasOwn(packages, name)) throw new Error("Unattributed or repeated package summary");
  const statuses = Object.fromEntries([...summary[1].matchAll(/(\d+) (passed|failed|skipped|todo)/g)]
    .map(([, count, status]) => [status, Number(count)]));
  if (Object.values(statuses).reduce((a, b) => a + b, 0) !== Number(summary[2])) throw new Error("Unexpected test summary");
  packages[name] = statuses;
}
if (!Object.keys(packages).length) throw new Error("No Vitest summaries found");
const total = {};
for (const statuses of Object.values(packages)) {
  for (const [status, count] of Object.entries(statuses)) total[status] = (total[status] ?? 0) + count;
}
console.log(JSON.stringify({ packages, total }, null, 2));

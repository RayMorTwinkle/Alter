import { expect, it } from "vitest";
import { judgeSamples } from "../judge-samples.ts";
import { metrics, summary } from "../judge.ts";

it("reports contextual and context-free judgments with their own denominators", () => {
  const ids = ["search-open-bing", "search-fill-ref", "search-fill-other-site", "rename-same-id-other-title", "inj-context-title"];
  const rows = judgeSamples.filter(s => ids.includes(s.id)).map(sample => ({
    ...sample, repeat: 1, reason: "fixture", latencyMs: 1, predicted: true, status: sample.expected ? "pass" as const : "fail" as const,
  }));
  expect(metrics(rows).falseApprovals).toHaveLength(3);
  const md = summary(rows);
  expect(md).toContain("| in-scope | 2/2（100.0%） | 1/1（100.0%） | 1/1（100.0%） |");
  expect(md).toContain("| out-of-scope | 0/2（0.0%） | 0/2（0.0%） | — |");
});

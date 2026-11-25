import type { ApprovalAnswer, HarnessId, TaskStart } from "@alter/node-protocol";
import { compile, oneOf } from "@earendil-works/pi-schema";
import { conversationDoc } from "./runtime.ts";

export const harnessSchema = oneOf(["claude-code", "codex", "opencode", "dsh"] as const satisfies readonly HarnessId[]);
export const validHarness = compile(harnessSchema);
export type NodeRunner = { node: string; harness: HarnessId; session?: string };
export type NodeRun = {
  ackSeq: number;
  start: TaskStart;
  stopping?: true;
  messages: { id: string; text: string; sent?: true }[];
  approvals: Record<string, { answer?: ApprovalAnswer }>;
  latestText?: string;
  latestTool?: { name: string; arguments: string };
};
export const NodeRuns = conversationDoc<{ byId: Record<string, NodeRun> }>("node-runs", () => ({ byId: {} }));

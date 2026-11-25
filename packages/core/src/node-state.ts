import type { ApprovalAnswer, HarnessId, TaskStart } from "@alter/node-protocol";
import { conversationDoc } from "./runtime.ts";

export type NodeRunner = { node: string; harness: HarnessId };
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

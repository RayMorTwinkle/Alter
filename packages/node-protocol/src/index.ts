// Wire contract between the Alter hub (a user's instance) and a node on that user's computer.
// Spec and rationale: docs/architecture/node-protocol.md, ADR-0026.

export const protocolVersion = 1;

/** Path the node opens a WebSocket to, relative to the gateway origin. */
export const connectPath = "/api/node/connect";

export type HarnessId = "claude-code" | "codex" | "opencode";
export type Permission = "restricted" | "auto" | "full";
export type Effect = "read" | "write" | "irreversible";
export type TaskStatus = "completed" | "failed" | "interrupted";
export type ApprovalDecision = "once" | "capability" | "always" | "deny";

export type Harness = { id: HarnessId; version?: string; available: boolean; detail?: string };
export type Report = { summary: string; refs: { kind: string; ref: string }[] };
export type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number };

// ---- node → hub ----------------------------------------------------------

export type Hello = {
  type: "hello"; protocol: number; nodeId: string; name: string;
  platform: "darwin" | "win32" | "linux"; nodeVersion: string; harnesses: Harness[];
  /** Workspace roots the user allowed this node to work in. */
  roots: string[];
  /** Tasks still running or finished while disconnected, so the hub can reconcile. */
  tasks: { taskId: string; state: "running" | "ended"; lastSeq: number }[];
};

export type TaskEventKind = "text" | "thinking" | "tool_call" | "tool_result" | "status";
export type TaskEvent = {
  type: "task.event"; taskId: string; seq: number; at: number; kind: TaskEventKind;
  text?: string; tool?: string; args?: unknown; isError?: boolean;
};

export type ApprovalRequest = {
  type: "approval.request"; taskId: string; requestId: string; seq: number; at: number;
  /** Harness-native tool name, e.g. "Bash", "Edit", "exec_command". */
  tool: string; args: unknown; effect: Effect; summary: string;
};

export type TaskEnd = {
  type: "task.end"; taskId: string; seq: number; at: number; status: TaskStatus; report: Report;
  /** Where the report came from: the finish tool, the last assistant message, or the failure. */
  reportSource: "finish" | "last_message" | "failure";
  nativeSessionId?: string; usage?: Usage;
};

export type Pong = { type: "pong"; at: number };

export type NodeMessage = Hello | TaskEvent | ApprovalRequest | TaskEnd | Pong;

// ---- hub → node ----------------------------------------------------------

export type Welcome = { type: "welcome"; protocol: number; userId: string; ackSeq: Record<string, number> };

export type TaskStart = {
  type: "task.start"; taskId: string; harness: HarnessId; brief: string; permission: Permission;
  /** Absolute path inside one of the node's roots; the node rejects anything else. */
  cwd?: string;
  /** Resume a previous native session for continue_from. */
  resume?: string;
  thinking?: "low" | "medium" | "high" | "max";
};

export type TaskMessage = { type: "task.message"; taskId: string; text: string };
export type TaskStop = { type: "task.stop"; taskId: string; reason?: string };
export type ApprovalAnswer = { type: "approval.answer"; taskId: string; requestId: string; decision: ApprovalDecision; note?: string };
export type Ack = { type: "ack"; taskId: string; seq: number };
export type Ping = { type: "ping"; at: number };
export type Rejected = { type: "rejected"; reason: string };

export type HubMessage = Welcome | TaskStart | TaskMessage | TaskStop | ApprovalAnswer | Ack | Ping | Rejected;

/** Node tokens are `<userId>.<secret>`; the gateway routes by userId, the instance verifies the secret. */
export function parseNodeToken(token: string): { userId: string; secret: string } | undefined {
  const at = token.indexOf(".");
  if (at <= 0 || at === token.length - 1) return undefined;
  return { userId: token.slice(0, at), secret: token.slice(at + 1) };
}

import type { Effect, ApprovalAnswer, TaskStart, TaskEvent, TaskStatus, Usage } from "@alter/node-protocol";

export type Outcome = { status: TaskStatus; reason?: string; usage?: Usage };
export type Event = Pick<TaskEvent, "kind" | "text" | "tool" | "args" | "isError">;
export type Sink = {
  event(event: Event): void;
  assistant(text: string): void;
  session(id: string): void;
  approve(tool: string, args: unknown, signal?: AbortSignal, effect?: Effect): Promise<Pick<ApprovalAnswer, "decision" | "note">>;
  turn(outcome: Outcome): void;
};
export type Input = TaskStart & { cwd: string; executable: string; model?: string; finish: { command: string; args: string[] } };
export interface RunningTask {
  message(text: string): void | Promise<void>;
  stop(interrupt: boolean): Promise<void>;
}
export interface HarnessAdapter { start(task: Input, sink: Sink): RunningTask }

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runEgo } from "../src/ego.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function child() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

it("passes the script only on stdin and collects UTF-8 stdout", async () => {
  const proc = child();
  const script = 'console.log("some argument")';
  const running = runEgo(script);
  expect(spawn).toHaveBeenCalledWith("ego-browser", ["nodejs"], { stdio: "pipe" });
  expect(proc.stdin.read().toString()).toBe(script);
  const bytes = Buffer.from("示例");
  proc.stdout.write(bytes.subarray(0, 2));
  proc.stdout.write(bytes.subarray(2));
  proc.emit("close", 0, null);
  await expect(running).resolves.toBe("示例");
});

it("reports a failing exit with only the last 2048 stderr characters", async () => {
  const proc = child();
  const running = runEgo("example");
  proc.stderr.write("discarded" + "x".repeat(2048));
  proc.stderr.write("error");
  proc.emit("close", 2, null);
  await expect(running).rejects.toThrow(new Error("ego-browser exited (2): " + "x".repeat(2043) + "error"));
});

it("kills the child and reports timeout at 90 seconds", async () => {
  vi.useFakeTimers();
  const proc = child();
  const running = runEgo("example");
  vi.advanceTimersByTime(90_000);
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(running).rejects.toThrow("90 seconds");
  proc.emit("close", null, "SIGKILL");
});

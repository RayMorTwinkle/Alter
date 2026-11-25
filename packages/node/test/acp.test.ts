import { describe, expect, it } from "vitest";
import { permissionEnv } from "../src/adapters/acp.ts";

describe("permission tiers reach the agent process", () => {
  it("maps tiers to dsh sandbox modes and opencode permission config", () => {
    expect(permissionEnv("dsh", "restricted", {}).DSH_PERMISSION_MODE).toBe("read-only");
    expect(permissionEnv("dsh", "full", {}).DSH_PERMISSION_MODE).toBe("danger-full-access");
    expect(JSON.parse(permissionEnv("opencode", "restricted", {}).OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { edit: "ask", bash: "ask", webfetch: "ask" } });
    expect(JSON.parse(permissionEnv("opencode", "auto", {}).OPENCODE_CONFIG_CONTENT!).permission.bash).toBe("ask");
  });
});

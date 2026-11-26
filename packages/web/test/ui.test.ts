import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { AdapterCard, hostAdapterDisplay, nodeAdapterDisplay } from "../src/components/Adapters.tsx";
import { ToolCall, formatArgs } from "../src/components/Chat.tsx";
import { I18n } from "../src/i18n.tsx";
import { strings } from "../src/strings.ts";
import type { AdapterView, NodeAdapterSummary, TimelineItem } from "../src/types.ts";

describe("formatArgs", () => {
  it("pretty-prints valid JSON arguments and ignores empty objects", () => {
    expect(formatArgs("{}")).toBe("");
    expect(formatArgs(undefined)).toBe("");
    expect(formatArgs('{"brief":"查天气","permission":"restricted"}')).toContain('"permission": "restricted"');
  });

  it("keeps raw text when arguments are malformed JSON", () => {
    expect(formatArgs("{broken")).toBe("{broken");
  });
});

describe("ToolCall", () => {
  const renderTool = (item: TimelineItem) => renderToStaticMarkup(
    createElement(I18n.Provider, { value: strings.hans }, createElement(ToolCall, { item, onOpenTask: () => {} })),
  );

  it("shows readable errorDetail right under failed tool calls", () => {
    const html = renderTool({
      id: "t1",
      kind: "tool",
      text: "",
      at: 1000,
      tool: "dispatch_task",
      args: '{"brief":"查日程"}',
      isError: true,
      errorDetail: 'missing required arguments "context" and "permission"',
    });
    expect(html).toContain("dispatch_task");
    expect(html).toContain("出错");
    expect(html).toContain("tool-error-detail");
    expect(html).toContain("missing required arguments");
    expect(html).toContain("tool-toggle");
  });

  it("omits error banner and args toggle when succeeded with empty args", () => {
    const html = renderTool({
      id: "t2",
      kind: "tool",
      text: "",
      at: 2000,
      tool: "memory_read",
      args: "{}",
      isError: false,
    });
    expect(html).not.toContain("tool-error-detail");
    expect(html).not.toContain("tool-toggle");
  });
});

describe("i18n console coverage", () => {
  it("defines all console tabs and role hints in both locales", () => {
    for (const locale of [strings.hans, strings.hant]) {
      expect(Object.keys(locale.console.tabs)).toEqual(["capabilities", "models", "proactive", "observability", "system"]);
      expect(locale.console.restrictedAdaptersHint.length).toBeGreaterThan(10);
      expect(locale.toolCallDetail.showArgs).toBeTruthy();
      expect(locale.nodes.adaptersOffline).toBeTruthy();
    }
  });
});

describe("AdapterCard shared host/node rendering", () => {
  const noop = async () => {};
  const tools = [{ name: "ping", description: "Check connection", effect: "read" as const, defaultEffect: "read" as const, inputSchema: {} }];

  it("renders both host AdapterView and NodeAdapterSummary consistently", () => {
    const host: AdapterView = {
      id: "h1", name: "Host Tool", kind: "cli", capabilityId: "cli-h1", enabled: true,
      config: { command: "echo" }, secretNames: [], status: { state: "ok" }, tools, effects: {},
    };
    const node: NodeAdapterSummary = {
      id: "n1", name: "Node Tool", kind: "mcp", capabilityId: "node-n1-abc", enabled: true,
      state: "error", detail: "Connection refused", tools, effects: {},
    };
    const render = (display: ReturnType<typeof hostAdapterDisplay>) => renderToStaticMarkup(
      createElement(I18n.Provider, { value: strings.hans },
        createElement(AdapterCard, { adapter: display, onUpdate: noop, onRefresh: noop, onRemove: noop })),
    );
    const hostHtml = render(hostAdapterDisplay(host));
    const nodeHtml = render(nodeAdapterDisplay(node));
    expect(hostHtml).toContain("Host Tool");
    expect(hostHtml).toContain("cli-h1");
    expect(hostHtml).toContain("已连接");
    expect(nodeHtml).toContain("Node Tool");
    expect(nodeHtml).toContain("node-n1-abc");
    expect(nodeHtml).toContain("出错");
    expect(nodeHtml).toContain("Connection refused");
  });
});

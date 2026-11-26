import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { ToolCall, formatArgs } from "../src/components/Chat.tsx";
import { I18n } from "../src/i18n.tsx";
import { strings } from "../src/strings.ts";
import type { TimelineItem } from "../src/types.ts";

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
    }
  });
});

import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { parseBlocks, renderInline } from "../src/markdown.tsx";

describe("parseBlocks", () => {
  it("splits paragraphs, lists, quotes, headings and code", () => {
    const blocks = parseBlocks("# Title\n\nline one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```\ncode()\n```");
    expect(blocks.map(b => b.type)).toEqual(["h", "p", "list", "list", "quote", "code"]);
    expect(blocks[1]).toEqual({ type: "p", text: "line one\nline two" });
    expect(blocks[2]).toEqual({ type: "list", ordered: false, items: ["a", "b"] });
    expect(blocks[3]).toEqual({ type: "list", ordered: true, items: ["x", "y"] });
    expect(blocks[5]).toEqual({ type: "code", text: "code()" });
  });

  it("keeps an unterminated code fence while streaming", () => {
    expect(parseBlocks("```\npartial")).toEqual([{ type: "code", text: "partial" }]);
  });
});

describe("renderInline", () => {
  it("never turns markup into elements other than the supported ones", () => {
    const nodes = renderInline('<img src=x onerror="alert(1)"> **bold**');
    expect(nodes[0]).toBe('<img src=x onerror="alert(1)"> ');
    expect(isValidElement(nodes[1]) && nodes[1].type).toBe("strong");
  });

  it("links only http(s) URLs", () => {
    const nodes = renderInline("[a](javascript:alert(1)) and https://example.com/x");
    const links = nodes.filter(n => isValidElement(n) && n.type === "a");
    expect(links).toHaveLength(1);
    expect(isValidElement(links[0]) && (links[0].props as { href: string }).href).toBe("https://example.com/x");
  });
});

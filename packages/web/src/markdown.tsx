import { Fragment, type ReactNode } from "react";

// A small Markdown subset rendered as React elements (never innerHTML): model output is untrusted.

export type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[]; start?: number };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      blocks.push({ type: "code", text: body.join("\n") });
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    const listItem = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/;
    const first = listItem.exec(line);
    if (first) {
      const ordered = first[2] !== undefined;
      const items: string[] = [];
      for (let m; i < lines.length && (m = listItem.exec(lines[i]!)) && (m[2] !== undefined) === ordered; i++) items.push(m[3]!);
      // Keep the source numbering: models often separate "1)" and "2)" with blank lines.
      blocks.push(ordered && first[2] !== "1" ? { type: "list", ordered, items, start: Number(first[2]) } : { type: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const body: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|>|\s*([-*]|\d+[.)])\s)/.test(lines[i]!); i++) body.push(lines[i]!);
    blocks.push({ type: "p", text: body.join("\n") });
  }
  return blocks;
}

const inlinePattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()（）]+)/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    if (match.index > last) out.push(...withBreaks(text.slice(last, match.index), out.length));
    const [whole, code, bold, link, href, bare] = match;
    const key = out.length;
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    else if (link) out.push(<a key={key} href={href} target="_blank" rel="noreferrer">{link.slice(1, link.indexOf("]"))}</a>);
    else if (bare) out.push(<a key={key} href={bare} target="_blank" rel="noreferrer">{bare}</a>);
    last = match.index + whole.length;
  }
  if (last < text.length) out.push(...withBreaks(text.slice(last), out.length));
  return out;
}

function withBreaks(text: string, offset: number): ReactNode[] {
  return text.split("\n").flatMap((part, index) =>
    index === 0 ? [part] : [<br key={`br${offset}-${index}`} />, part]);
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((block, index) => {
        switch (block.type) {
          case "p": return <p key={index}>{renderInline(block.text)}</p>;
          case "h": return <p key={index} className={`md-h md-h${block.level}`}>{renderInline(block.text)}</p>;
          case "quote": return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
          case "code": return <pre key={index}><code>{block.text}</code></pre>;
          case "list": {
            const items = block.items.map((item, n) => <li key={n}>{renderInline(item)}</li>);
            return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
        }
      })}
    </div>
  );
}

export function Inline({ text }: { text: string }) {
  return <Fragment>{renderInline(text)}</Fragment>;
}

import { parseFeed as parse } from "@alter/plugin-sdk";
import { SourceError } from "./config.ts";
export { link, plain } from "@alter/plugin-sdk";

export function parseFeed(xml: string, base: string) {
  try { return parse(xml, base); }
  catch { throw new SourceError("Invalid RSS or Atom feed", 502); }
}

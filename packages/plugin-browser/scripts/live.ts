import { randomUUID } from "node:crypto";
import { actions, createSpace, runEgo, view } from "../src/ego.ts";

const name = `Alter live ${randomUUID()}`;
const id = await createSpace(runEgo, name);
async function step(label: string, action: string, close = false) {
  const result = await view(runEgo, name, id, action, 12_000, close);
  if (!result) throw new Error("Live space disappeared");
  console.log(label, result.text.length, "characters");
  if (result.isError) throw new Error(`${label} failed`);
  return result.text;
}
try {
  await step("open", actions.open("https://example.com"));
  // example.com lists several languages, so the link sits below the first viewport.
  const snapshot = await step("scroll", actions.scroll("down"));
  const link = snapshot.match(/Learn more|More information/i)?.[0];
  console.log("link", link);
  if (!link) throw new Error("Example Domain link missing from viewport");
  await step("click", actions.click("text=" + link));
} finally {
  await step("close", "", true);
}

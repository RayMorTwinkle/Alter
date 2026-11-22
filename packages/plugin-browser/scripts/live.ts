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
  const snapshot = await step("snapshot", "");
  const link = snapshot.match(/Learn more|More information/i)?.[0];
  if (!link) throw new Error("Example Domain link missing from viewport");
  await step("click", actions.click("text=" + link));
} finally {
  await step("close", "", true);
}

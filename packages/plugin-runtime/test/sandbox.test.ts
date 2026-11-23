import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "../src/process.ts";
import { fixture, manifest } from "./fixtures.ts";

it.runIf(process.platform === "darwin")("starts Node in real Seatbelt, denies host file IO, subprocesses and direct loopback", async () => {
  const { pkg, data } = fixture();
  const file = fileURLToPath(new URL("../../../package.json", import.meta.url));
  const marker = join(data, "outside.txt");
  writeFileSync(join(pkg, "index.mjs"), `
    import fs from "node:fs";
    import { spawnSync } from "node:child_process";
    import net from "node:net";
    export default { tools:{
      ready:()=>"ready",
      read:({file})=>{try {fs.readFileSync(file);return "allowed"} catch{return "denied"}},
      write:({path})=>{try {fs.writeFileSync(path,"bad");return "allowed"} catch{return "denied"}},
      child:()=>{try {return spawnSync("/usr/bin/true").status === 0 ? "allowed":"denied"} catch{return "denied"}},
      socket:({port})=>new Promise(resolve=>{const s=net.connect(port,"127.0.0.1",()=>{s.destroy();resolve("allowed")});
        s.on("error",()=>resolve("denied"))}),
    }}`);
  const invoke = (name: string, args = {}) => run(pkg, manifest.resources, { kind: "tools", name, args }, async () => null, new AbortController().signal, []);
  await expect(invoke("ready")).resolves.toBe("ready");
  await expect(invoke("read", { file })).resolves.toBe("denied");
  await expect(invoke("write", { path: marker })).resolves.toBe("denied");
  await expect(invoke("child")).resolves.toBe("denied");
  const listener = createServer(s => s.destroy());
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  try {
    const address = listener.address();
    expect(await invoke("socket", { port: typeof address === "object" && address?.port }).catch(e => {
      if (!(e instanceof Error) || !e.message.includes("killed by the system")) throw e;
      return "denied";
    })).toBe("denied");
  } finally { listener.close();}
  expect(existsSync(marker)).toBe(false); expect(readFileSync(file, "utf8")).toContain('"alter"');
  await expect(invoke("ready")).resolves.toBe("ready");
});

// Builds the single-file node that the web app serves at /node/, next to its installers.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "../web/dist/node"));
mkdirSync(out, { recursive: true });
await build({
  input: join(here, "src/cli.ts"),
  platform: "node",
  transform: { define: { __ALTER_BUNDLE__: "true" } },
  output: { file: join(out, "alter-node.mjs"), format: "esm", codeSplitting: false, minify: true },
  logLevel: "warn",
});
for (const name of ["install.ps1", "install.sh"]) copyFileSync(join(here, "install", name), join(out, name));

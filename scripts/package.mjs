import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid plugin version");
const output = `releases/content-workbench-${version}.zip`;
await mkdir("releases", { recursive: true });
const temporary = output.replace(/\.zip$/, ".tmp.zip");
await rm(temporary, { force: true });
execFileSync(
  "zip",
  [
    "-rq",
    "../" + temporary,
    "main.js",
    "manifest.json",
    "styles.css",
    "assets",
    "README.md",
    "VALIDATION.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses",
  ],
  { cwd: "dist" },
);
await rename(temporary, output);
const hash = createHash("sha256")
  .update(await readFile(output))
  .digest("hex");
await writeFile(output + ".sha256", `${hash}  ${output.split("/").pop()}\n`);
console.log(output);
console.log(`SHA-256: ${hash}`);

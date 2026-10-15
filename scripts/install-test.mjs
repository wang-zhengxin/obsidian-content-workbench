import { mkdir, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
const root = "test-vault/.obsidian";
if (
  existsSync(root + "/community-plugins.json") ||
  existsSync(root + "/app.json")
) {
  throw new Error(
    "test-vault 已有 Obsidian 配置；拒绝覆盖。更新现有库时请仅复制 dist/ 中的插件文件。",
  );
}
await mkdir(root + "/plugins/content-workbench", { recursive: true });
for (const file of [
  "main.js",
  "manifest.json",
  "styles.css",
  "assets",
  "README.md",
  "VALIDATION.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "licenses",
])
  await cp("dist/" + file, root + "/plugins/content-workbench/" + file, {
    recursive: true,
  });
await writeFile(
  root + "/community-plugins.json",
  JSON.stringify(["content-workbench"]),
);
await writeFile(
  root + "/core-plugins.json",
  JSON.stringify([
    "file-explorer",
    "global-search",
    "switcher",
    "backlink",
    "properties",
    "page-preview",
    "templates",
    "note-composer",
    "command-palette",
    "outline",
    "word-count",
    "bases",
  ]),
);
await writeFile(
  root + "/app.json",
  JSON.stringify({ legacyEditor: false, cssTheme: "", theme: "obsidian" }),
);
console.log("Installed to isolated test-vault");

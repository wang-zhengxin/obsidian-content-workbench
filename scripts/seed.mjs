import { build } from "esbuild";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { stringify } from "yaml";
if (existsSync("test-vault")) {
  throw new Error(
    "test-vault 已存在；为保护笔记和配置，拒绝覆盖。请在新的源码副本中创建演示库。",
  );
}
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/fixtures.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/fixtures.mjs",
});
const { fixtureArticles } = await import("../dist/fixtures.mjs");
for (const article of fixtureArticles()) {
  const path = "test-vault/" + article.path;
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const body = article.markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  await writeFile(
    path,
    "---\n" + stringify(article.frontmatter) + "---\n" + body,
  );
}
await copyFile("examples/sample-cover.png", "test-vault/内容/示例封面.png");
await mkdir("test-vault/.obsidian/plugins/content-workbench", {
  recursive: true,
});
await writeFile(
  "test-vault/.obsidian/plugins/content-workbench/data.json",
  JSON.stringify({ author: "林", contentFolder: "内容" }),
);
await writeFile(
  "test-vault/开始使用.md",
  "# 内容创作工作台测试库\n\n使用命令面板，运行 **Content Workbench: 打开内容创作看板**。\n\n这是独立开发测试库，示例文章和测试修改不会影响日常笔记库。\n",
);
console.log("Seeded 12 Markdown articles");

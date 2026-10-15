import { build, context } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const watching = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/main.tsx"],
  bundle: true,
  external: ["obsidian", "electron", "node:*"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "dist/main.js",
  sourcemap: watching,
  minify: !watching,
  define: {
    "process.env.NODE_ENV": watching ? '"development"' : '"production"',
  },
  jsx: "automatic",
  logLevel: "info",
};
if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else await build(options);
await copyFile("manifest.json", "dist/manifest.json");
await copyFile("src/styles.css", "dist/styles.css");
await cp("assets", "dist/assets", { recursive: true });
await copyFile("examples/sample-cover.png", "dist/sample-cover.png");

for (const file of [
  "README.md",
  "VALIDATION.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
])
  await copyFile(file, "dist/" + file);
await cp("licenses", "dist/licenses", { recursive: true });

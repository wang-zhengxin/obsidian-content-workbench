import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
await build({
  entryPoints: ["src/browser.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/preview.js",
  jsx: "automatic",
});
const html =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>内容创作工作台预览</title><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;width:100%;margin:0} .preview-notice{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 18px;color:#fff;background:#303038;border:1px solid #8b5cf6;border-radius:8px;z-index:99999;font:13px system-ui}</style><div id="root"></div><script type="module" src="/preview.js"></script></html>';
if (process.argv.includes("--build-only")) process.exit(0);
const root = resolve("dist");
createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }
    const path = resolve(root, "." + decodeURIComponent(req.url.split("?")[0]));
    if (!path.startsWith(root + "/")) {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readFile(path);
    res.setHeader(
      "Content-Type",
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      }[extname(path)] || "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(4317, "127.0.0.1", () =>
  console.log("Preview at http://127.0.0.1:4317"),
);

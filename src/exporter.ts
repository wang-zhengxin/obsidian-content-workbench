import { marked } from "marked";
import { parse, stringify } from "yaml";
import type {
  Article,
  AssetReader,
  Config,
  Snapshot,
  Asset,
  Binding,
} from "./domain";
import { sha256, toBase64, normalizeDir } from "./domain";

export function splitMarkdown(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm = parse(match[1]);
  if (fm !== null && (typeof fm !== "object" || Array.isArray(fm)))
    throw new Error("文章属性必须是 YAML 对象");
  return { frontmatter: fm ?? {}, body: raw.slice(match[0].length) };
}
export function stripMarkup(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/[#*_>`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const mimeByExt: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};
function remote(src: string): boolean {
  return /^https?:\/\//i.test(src);
}
function relative(from: string, to: string): string {
  const a = from.split("/").slice(0, -1),
    b = to.split("/");
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => ".."), ...b]
    .join("/")
    .split("/")
    .map((s) => (s === ".." ? s : encodeURIComponent(s)))
    .join("/");
}
function articlePath(
  article: Article,
  config: Config,
  bindings: Binding[],
): string {
  const target =
    config.github.owner + "/" + config.github.repo + "@" + config.github.branch;
  const bound = bindings.find(
    (b) =>
      b.articleId === article.id &&
      b.channel === "github" &&
      b.target === target,
  )?.remotePath;
  if (bound) return normalizeDir(bound);
  const safe = (value: string) => value.trim().replace(/[\\/:*?"<>|]/g, "-");
  const values: Record<string, string> = {
    id: safe(article.id),
    title: safe(article.title),
    slug: safe(String(article.frontmatter.slug || article.id)),
  };
  const template = (config.github.pathTemplate || "{id}.md").replace(
    /\{([^}]+)\}/g,
    (_, key) => {
      if (!(key in values)) throw new Error("不支持的路径模板字段：" + key);
      return values[key];
    },
  );
  const path = normalizeDir(
    [config.github.contentDir, template].filter(Boolean).join("/"),
  );
  if (!path.endsWith(".md")) throw new Error("文章路径模板必须以 .md 结尾");
  return path;
}
function maskCode(body: string): {
  text: string;
  restore: (text: string) => string;
} {
  const saved: string[] = [];
  const save = (value: string) => {
    const key = "\uE000cwCode" + saved.length + "\uE001";
    saved.push(value);
    return key;
  };
  const lines = body.split("\n"),
    output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence) {
      output.push(lines[i]);
      continue;
    }
    const block = [lines[i]];
    while (++i < lines.length) {
      block.push(lines[i]);
      const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (
        close &&
        close[1][0] === fence[1][0] &&
        close[1].length >= fence[1].length
      )
        break;
    }
    output.push(save(block.join("\n")));
  }
  const text = output
    .join("\n")
    .replace(/(`+)([\s\S]*?)\1(?!`)/g, (m) => save(m));
  return {
    text,
    restore: (value) =>
      value.replace(
        /\uE000cwCode(\d+)\uE001/g,
        (_, index) => saved[Number(index)],
      ),
  };
}
export async function prepareSnapshot(
  article: Article,
  config: Config,
  reader: AssetReader,
  selected: Article[],
  bindings: Binding[] = [],
): Promise<Snapshot> {
  if (article.duplicateId) throw new Error("文章 ID 重复，请先修复后再交付");
  const { frontmatter, body } = splitMarkdown(article.markdown);
  const preserveHtmlStyles = frontmatter.wechat_preserve_styles === true;
  const path = articlePath(article, config, bindings);
  const warnings: string[] = [];
  const assets: Asset[] = [];
  const code = maskCode(body);
  let output = code.text;
  async function image(
    src: string,
    role: "body" | "cover" = "body",
  ): Promise<string> {
    src = src.trim().replace(/^<|>$/g, "");
    if (remote(src)) {
      warnings.push(`外部图片需要微信上传：${src}`);
      return src;
    }
    if (/^(data|file|app|obsidian):/i.test(src))
      throw new Error("图片引用无法导出：" + src);
    const asset = await reader.readAsset(src, article.path);
    if (!asset) throw new Error("找不到图片：" + src);
    const ext = asset.path.split(".").pop()?.toLowerCase() ?? "";
    const mime = mimeByExt[ext];
    if (!mime) throw new Error("不支持的图片类型：" + src);
    const hash = await sha256(asset.bytes);
    const target = [normalizeDir(config.github.assetDir), hash + "." + ext]
      .filter(Boolean)
      .join("/");
    if (!assets.some((a) => a.path === target && a.role === role))
      assets.push({
        path: target,
        source: src,
        mime,
        base64: toBase64(asset.bytes),
        hash,
        size: asset.bytes.length,
        role,
      });
    return relative(path, target);
  }
  const wikiImages = [...output.matchAll(/!\[\[([^\]]+)\]\]/g)];
  for (const m of wikiImages) {
    const [src, alt] = m[1].split("|");
    if (!mimeByExt[src.split(".").pop()?.toLowerCase() ?? ""]) continue;
    const dest = await image(src);
    output = output.replace(
      m[0],
      `![${alt && !/^\d/.test(alt) ? alt : ""}](${dest})`,
    );
  }
  const standardImages = [
    ...output.matchAll(/!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g),
  ];
  for (const m of standardImages) {
    if (assets.some((a) => relative(path, a.path) === m[2])) continue;
    const dest = await image(m[2]);
    output = output.replace(m[0], `![${m[1]}](${dest})`);
  }
  if (/<img\b/i.test(output)) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(output, "text/html");
    const replacements = new Map<string, string>();
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src || replacements.has(src)) continue;
      replacements.set(src, await image(src));
    }
    output = output.replace(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, (tag) => {
      const img = parser.parseFromString(tag, "text/html").querySelector("img");
      const dest = img && replacements.get(img.getAttribute("src") || "");
      if (!img || !dest) return tag;
      img.setAttribute("src", dest);
      return img.outerHTML;
    });
  }
  const wikiNotes = [
    ...output.matchAll(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g),
  ];
  for (const m of wikiNotes) {
    const resolved = reader.resolveNote(m[2].split("#")[0], article.path);
    const found = selected.find((a) => a.path === resolved);
    let value = m[3] || m[2];
    if (found && !m[1]) {
      const dest = articlePath(found, config, bindings);
      value = `[${value}](${relative(path, dest)})`;
    } else
      warnings.push(
        `${m[1] ? "嵌入笔记未包含在导出中" : "内部链接未包含在本次导出中"}：${m[2]}`,
      );
    output = output.replace(m[0], value);
  }
  let cover = "";
  if (article.cover) {
    try {
      cover = await image(article.cover, "cover");
    } catch (e) {
      cover = article.cover;
      warnings.push(
        "微信封面不可用：" + (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  output = code.restore(output);
  const safe: Record<string, unknown> = {};
  for (const key of config.exportProperties)
    if (frontmatter[key] !== undefined) safe[key] = frontmatter[key];
  safe.title = article.title;
  const markdown = "---\n" + stringify(safe) + "---\n\n" + output;
  if (/```(?:mermaid)|\$\$|(?<!\\)\$[^$\n]+\$/.test(output))
    warnings.push("微信首版暂不支持 Mermaid / 数学公式图片化，请先转换为图片");
  const html = await marked.parse(output, { gfm: true });
  const hash = await sha256(
    JSON.stringify({
      markdown,
      cover,
      assets: assets.map((a) => ({ path: a.path, hash: a.hash, role: a.role })),
      ...(preserveHtmlStyles ? { preserveHtmlStyles: true } : {}),
    }),
  );
  const revisionHash = await sha256(
    JSON.stringify({
      body,
      properties: safe,
      title: article.title,
      summary: article.summary,
      cover: article.cover,
      ...(preserveHtmlStyles ? { preserveHtmlStyles: true } : {}),
      assets: assets.map((a) => ({
        source: a.source,
        hash: a.hash,
        role: a.role,
      })),
    }),
  );
  return {
    articleId: article.id,
    sourcePath: article.path,
    title: article.title,
    summary: article.summary,
    cover,
    markdown,
    html,
    ...(preserveHtmlStyles ? { preserveHtmlStyles: true } : {}),
    assets,
    hash,
    revisionHash,
    createdAt: new Date().toISOString(),
    warnings,
    githubPath: path,
  };
}
export function previewHtml(snapshot: Snapshot): string {
  let html = snapshot.html;
  for (const a of snapshot.assets) {
    html = html
      .split(relative(snapshot.githubPath, a.path))
      .join(`data:${a.mime};base64,${a.base64}`);
  }
  return html;
}
export function inlineWechatStyles(html: string, preserve = false): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles: Record<string, string> = {
    h1: "font-size:26px;font-weight:700;margin:28px 0 16px;",
    h2: "font-size:22px;font-weight:700;margin:26px 0 14px;",
    h3: "font-size:19px;font-weight:600;margin:22px 0 12px;",
    p: "margin:16px 0;line-height:1.85;",
    blockquote:
      "margin:18px 0;padding:8px 16px;border-left:3px solid #8b5cf6;background:#f6f4fa;color:#666;",
    pre: "padding:16px;overflow:auto;background:#f5f5f7;border-radius:8px;white-space:pre-wrap;",
    code: "font-family:monospace;font-size:13px;",
    table: "border-collapse:collapse;width:100%;font-size:14px;",
    th: "border:1px solid #ddd;padding:8px;background:#f5f5f7;",
    td: "border:1px solid #ddd;padding:8px;",
    img: "max-width:100%;height:auto;display:block;margin:18px auto;",
    ul: "padding-left:24px;",
    ol: "padding-left:24px;",
    li: "line-height:1.8;margin:6px 0;",
    a: "color:#6f42c1;text-decoration:underline;",
    hr: "border:0;border-top:1px solid #ddd;margin:24px 0;",
  };
  for (const el of doc.body.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    const original = (el as HTMLElement).style;
    const authored = Array.from(original)
      .flatMap((property) => {
        const value = original.getPropertyValue(property);
        const allowed =
          /^(?:color|background(?:-color)?|font(?:-family|-size|-weight|-style)?|line-height|text-align|text-decoration(?:-color|-line|-style)?|letter-spacing|border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?|border-radius|border-collapse|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|(?:max-|min-)?(?:width|height)|display|vertical-align|white-space|word-break|overflow(?:-x|-y)?)$/.test(
            property,
          );
        return allowed && !/url\s*\(|expression\s*\(|javascript:/i.test(value)
          ? [`${property}:${value};`]
          : [];
      })
      .join("");
    for (const attr of [...el.attributes])
      if (
        !["src", "href", "alt", "title", "colspan", "rowspan"].includes(
          attr.name,
        )
      )
        el.removeAttribute(attr.name);
    if (preserve && authored) el.setAttribute("style", authored);
    else if (!preserve && styles[tag]) el.setAttribute("style", styles[tag]);
  }
  return `<section style="font-size:16px;color:#333;line-height:1.85;font-family:system-ui,sans-serif;">${doc.body.innerHTML}</section>`;
}

import { describe, it, expect } from "vitest";
import { prepareSnapshot, splitMarkdown, stripMarkup } from "../src/exporter";
import { DEFAULT_CONFIG, type AssetReader } from "../src/domain";
import { fixtureArticles } from "../src/fixtures";
const reader: AssetReader = {
  readAsset: async (src) =>
    src === "图片 中文.png"
      ? { path: src, bytes: new Uint8Array([1, 2, 3]) }
      : null,
  resolveNote: (link) => (link === "target" ? "内容/target.md" : null),
};
describe("portable content export", () => {
  it("exports allowed properties, rewrites local images and selected wikilinks", async () => {
    const a = fixtureArticles()[0];
    a.cover = "图片 中文.png";
    a.markdown =
      "---\ntitle: 文档\nowner: secret author\nappSecret: should-not-leak\ntags: [设计]\n---\n\n![[图片 中文.png]]\n[[target|目标]]\n![[private-note]]";
    const target = { ...a, id: "target", path: "内容/target.md" };
    const s = await prepareSnapshot(a, DEFAULT_CONFIG, reader, [a, target]);
    expect(s.markdown).not.toContain("appSecret");
    expect(s.markdown).not.toContain("owner:");
    expect(s.markdown).toContain("tags:");
    expect(s.markdown).toMatch(/\.\.\/assets\/[a-f0-9]{64}\.png/);
    expect(s.markdown).toContain("[目标](target.md)");
    expect(s.assets).toHaveLength(2);
    expect(s.warnings.some((w) => w.includes("private-note"))).toBe(true);
  });
  it("fails missing assets rather than dropping them", async () => {
    const a = fixtureArticles()[0];
    a.cover = "";
    a.markdown = "![[missing.png]]";
    await expect(
      prepareSnapshot(a, DEFAULT_CONFIG, reader, [a]),
    ).rejects.toThrow("找不到图片");
  });
  it("hash changes when an attachment changes", async () => {
    const a = fixtureArticles()[0];
    a.cover = "";
    a.markdown = "![[图片 中文.png]]";
    const first = await prepareSnapshot(a, DEFAULT_CONFIG, reader, [a]);
    const next = await prepareSnapshot(
      a,
      DEFAULT_CONFIG,
      {
        ...reader,
        readAsset: async () => ({
          path: "图片 中文.png",
          bytes: new Uint8Array([4, 5]),
        }),
      },
      [a],
    );
    expect(first.hash).not.toBe(next.hash);
  });
  it("rejects invalid yaml, preserves body, and warns unsupported syntax", async () => {
    expect(() => splitMarkdown("---\na: [\n---\nbody")).toThrow();
    expect(splitMarkdown("---\na: b\n---\nbody").body).toBe("body");
    const a = fixtureArticles()[0];
    a.cover = "";
    a.markdown = "```mermaid\ngraph LR\n```";
    const s = await prepareSnapshot(a, DEFAULT_CONFIG, reader, [a]);
    expect(s.warnings.join()).toContain("Mermaid");
  });
  it("uses text summary without rendering scripts", () => {
    expect(stripMarkup("# 标题\n**正文**\n![[image.png]]")).toBe("标题 正文");
  });
});

describe("export scope and path stability", () => {
  it("preserves wiki syntax inside code without exporting those assets", async () => {
    const a = fixtureArticles()[0];
    a.cover = "";
    a.markdown =
      "```md\n![[private.png]] [[target]]\n```\n`![[inline-secret.png]]`\n![[图片 中文.png]]";
    const s = await prepareSnapshot(a, DEFAULT_CONFIG, reader, [a]);
    expect(s.markdown).toContain("![[private.png]] [[target]]");
    expect(s.markdown).toContain("`![[inline-secret.png]]`");
    expect(s.assets).toHaveLength(1);
  });
  it("uses a configurable path template and preserves an already-bound path", async () => {
    const a = fixtureArticles()[0];
    a.cover = "";
    a.markdown = "# body";
    a.frontmatter.slug = "portable";
    const config = structuredClone(DEFAULT_CONFIG);
    config.github.pathTemplate = "{slug}/index.md";
    const first = await prepareSnapshot(a, config, reader, [a]);
    expect(first.githubPath).toBe("content/portable/index.md");
    a.frontmatter.slug = "renamed";
    const bound = await prepareSnapshot(
      a,
      config,
      reader,
      [a],
      [
        {
          articleId: a.id,
          channel: "github",
          target: "/@main",
          remoteId: "commit",
          hash: "h",
          at: "",
          url: "",
          remotePath: first.githubPath,
        },
      ],
    );
    expect(bound.githubPath).toBe(first.githubPath);
    config.github.pathTemplate = "../{id}.md";
    await expect(prepareSnapshot(a, config, reader, [a])).rejects.toThrow(
      "目录",
    );
  });
});

describe("channel-specific cover preparation", () => {
  it("warns on an unavailable WeChat cover without blocking Markdown export", async () => {
    const a = fixtureArticles()[0];
    a.cover = "missing-cover.png";
    a.markdown = "# body without images";
    const result = await prepareSnapshot(a, DEFAULT_CONFIG, reader, [a]);
    expect(result.markdown).toContain("# body without images");
    expect(result.warnings.join()).toContain("微信封面不可用");
    expect(result.cover).toBe("missing-cover.png");
  });
});

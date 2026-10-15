// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSnapshot, inlineWechatStyles } from "../src/exporter";
import { DEFAULT_CONFIG } from "../src/domain";
import { fixtureArticles } from "../src/fixtures";

afterEach(() => vi.unstubAllGlobals());
describe("HTML article delivery", () => {
  it("exports HTML images with their styles, deduplicates the cover and leaves code alone", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const article = fixtureArticles()[0];
    article.cover = "图 片.png";
    article.markdown =
      '---\nwechat_preserve_styles: true\n---\n<section><h2 style="text-align:center;color:#2563eb">标题</h2><img src="图 片.png" alt="示例" style="margin:22px auto"></section>\n\n```html\n<img src="private.png">\n```';
    const readAsset = vi.fn(async (source: string) =>
      source === "图 片.png"
        ? { path: source, bytes: new Uint8Array([1, 2, 3]) }
        : null,
    );
    const snapshot = await prepareSnapshot(
      article,
      DEFAULT_CONFIG,
      { readAsset, resolveNote: () => null },
      [article],
    );
    expect(snapshot.preserveHtmlStyles).toBe(true);
    expect(snapshot.assets.map((a) => a.role)).toEqual(["body", "cover"]);
    expect(new Set(snapshot.assets.map((a) => a.path)).size).toBe(1);
    expect(snapshot.html).toMatch(/src="\.\.\/assets\/[a-f0-9]{64}\.png"/);
    expect(snapshot.html).toContain("margin:22px auto");
    expect(snapshot.markdown).toContain('<img src="private.png">');
    expect(readAsset).not.toHaveBeenCalledWith(
      "private.png",
      expect.anything(),
    );
  });
  it("preserves approved author styles only when opted in and strips remote CSS and event handlers", () => {
    const html =
      '<section style="font-size:16.5px;line-height:2"><h2 style="text-align:center;color:#2563eb;font-size:18px;position:fixed;background-image:url(https://example.com/track)" onclick="bad()">标题</h2><p style="margin:14px 0;text-align:justify">正文</p></section>';
    const preserved = new DOMParser().parseFromString(
      inlineWechatStyles(html, true),
      "text/html",
    );
    const h2 = preserved.querySelector("h2")!;
    expect(h2.style.fontSize).toBe("18px");
    expect(h2.style.textAlign).toBe("center");
    expect(h2.style.position).toBe("");
    expect(h2.style.backgroundImage).toBe("");
    expect(h2.hasAttribute("onclick")).toBe(false);
    expect(preserved.querySelector("p")!.style.margin).toBe("14px 0px");
    const defaults = new DOMParser().parseFromString(
      inlineWechatStyles(html),
      "text/html",
    );
    expect(defaults.querySelector("h2")!.style.fontSize).toBe("22px");
  });
});

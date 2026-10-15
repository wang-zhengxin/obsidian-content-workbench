// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { WechatConnector, multipart } from "../src/connectors/wechat";
import {
  DEFAULT_CONFIG,
  DeliveryUnknown,
  type Transport,
  type Snapshot,
} from "../src/domain";
const s: Snapshot = {
  articleId: "a",
  sourcePath: "a.md",
  title: "A",
  summary: "summary",
  cover: "",
  markdown: "# A",
  html: '<p>hello</p><img src="../assets/a.png"><script>bad()</script>',
  assets: [
    {
      path: "assets/a.png",
      source: "a.png",
      mime: "image/png",
      base64: "AQID",
      hash: "hash",
      size: 3,
      role: "body",
    },
  ],
  hash: "hash",
  createdAt: "2026-10-12",
  warnings: [],
  githubPath: "content/a.md",
};
class WechatServer implements Transport {
  requests: { url: string; body: unknown }[] = [];
  fail = false;
  imageUrl = "https://mmbiz.qpic.cn/a.png";
  draft: Record<string, unknown> | undefined;
  async request(r: Parameters<Transport["request"]>[0]) {
    this.requests.push({ url: r.url, body: r.body });
    if (r.url.includes("draft/add") && this.fail) throw new Error("timeout");
    let json: unknown = {};
    if (r.url.includes("stable_token"))
      json = { access_token: "token", expires_in: 7200 };
    else if (r.url.includes("media/uploadimg")) json = { url: this.imageUrl };
    else if (r.url.includes("material/add_material"))
      json = { media_id: "cover-id" };
    else if (r.url.includes("draft/add")) {
      this.draft = JSON.parse(r.body as string).articles[0];
      json = { media_id: "draft-id" };
    } else if (r.url.includes("draft/update")) {
      this.draft = JSON.parse(r.body as string).articles;
      json = { errcode: 0 };
    } else if (r.url.includes("draft/get"))
      json = { news_item: this.draft ? [this.draft] : [] };
    return { status: 200, json, text: "" };
  }
}
const api = (server: WechatServer) =>
  new WechatConnector(
    server,
    { ...DEFAULT_CONFIG.wechat, appId: "app" },
    "secret",
  );
describe("WeChat draft delivery", () => {
  it("stops invalid credentials before any upload or draft write", async () => {
    const calls: string[] = [];
    const transport: Transport = {
      request: async (r) => {
        calls.push(r.url);
        return {
          status: 200,
          json: { errcode: 40125, errmsg: "invalid appsecret" },
          text: "",
        };
      },
    };
    await expect(
      new WechatConnector(
        transport,
        { ...DEFAULT_CONFIG.wechat, appId: "app" },
        "invalid",
      ).sync(s, undefined, () => {}),
    ).rejects.toThrow("40125");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("stable_token");
  });
  it("refreshes an explicitly expired token once, then creates only one draft", async () => {
    const server = new WechatServer();
    let rejected = false;
    const transport: Transport = {
      request: async (r) => {
        if (r.url.includes("draft/add") && !rejected) {
          rejected = true;
          server.requests.push({ url: r.url, body: r.body });
          return {
            status: 200,
            json: { errcode: 42001, errmsg: "access_token expired" },
            text: "",
          };
        }
        return server.request(r);
      },
    };
    const connector = new WechatConnector(
      transport,
      { ...DEFAULT_CONFIG.wechat, appId: "app" },
      "secret",
    );
    expect((await connector.sync(s, undefined, () => {})).remoteId).toBe(
      "draft-id",
    );
    expect(
      server.requests.filter((r) => r.url.includes("stable_token")),
    ).toHaveLength(2);
    expect(
      server.requests.filter((r) => r.url.includes("draft/add")),
    ).toHaveLength(2);
    expect(server.draft!.title).toBe(s.title);
  });
  it.each([45009, 40014])(
    "does not loop on quota errors or a repeatedly invalid token (%s)",
    async (errcode) => {
      const server = new WechatServer();
      const transport: Transport = {
        request: async (r) => {
          if (r.url.includes("draft/add")) {
            server.requests.push({ url: r.url, body: r.body });
            return {
              status: 200,
              json: { errcode, errmsg: "rejected" },
              text: "",
            };
          }
          return server.request(r);
        },
      };
      await expect(
        new WechatConnector(
          transport,
          { ...DEFAULT_CONFIG.wechat, appId: "app" },
          "secret",
        ).sync(s, undefined, () => {}),
      ).rejects.toThrow(String(errcode));
      expect(
        server.requests.filter((r) => r.url.includes("draft/add")),
      ).toHaveLength(errcode === 45009 ? 1 : 2);
      expect(server.draft).toBeUndefined();
    },
  );
  it.each([
    { status: 200, json: null },
    { status: 503, json: { errcode: 40014 } },
  ])(
    "keeps uncertain draft responses unknown without retrying ($status)",
    async (response) => {
      const server = new WechatServer();
      const transport: Transport = {
        request: async (r) => {
          if (r.url.includes("draft/add")) {
            server.requests.push({ url: r.url, body: r.body });
            return { ...response, text: "" };
          }
          return server.request(r);
        },
      };
      await expect(
        new WechatConnector(
          transport,
          { ...DEFAULT_CONFIG.wechat, appId: "app" },
          "secret",
        ).sync(s, undefined, () => {}),
      ).rejects.toBeInstanceOf(DeliveryUnknown);
      expect(
        server.requests.filter((r) => r.url.includes("draft/add")),
      ).toHaveLength(1);
      expect(
        server.requests.filter((r) => r.url.includes("stable_token")),
      ).toHaveLength(1);
    },
  );
  it("uploads an authored HTML layout and verifies it with the same layout policy", async () => {
    const server = new WechatServer();
    const connector = api(server);
    const rich = {
      ...s,
      preserveHtmlStyles: true,
      html: '<section style="font-size:16.5px;line-height:2"><h2 style="color:#2563eb;text-align:center;font-size:18px">HTML 标题</h2><p style="margin:14px 0">hello</p><img src="../assets/a.png" style="margin:22px auto"></section>',
    };
    await connector.sync(rich, undefined, () => {});
    const content = new DOMParser().parseFromString(
      String(server.draft!.content),
      "text/html",
    );
    expect(content.querySelector("h2")!.style.textAlign).toBe("center");
    expect(content.querySelector("h2")!.style.fontSize).toBe("18px");
    expect(content.querySelector("img")!.src).toBe(server.imageUrl);
    expect((await connector.verify(rich, "draft-id")).matches).toBe(true);
  });
  it("reads back the selected draft and verifies images, cover and content without mutations", async () => {
    const server = new WechatServer();
    const connector = api(server);
    await connector.sync(s, undefined, () => {});
    const before = server.requests.length;
    const result = await connector.verify(s, "draft-id");
    expect(result.matches).toBe(true);
    expect(result.html).not.toContain("<script");
    expect(server.requests.slice(before)).toHaveLength(1);
    expect(server.requests[before].url).toContain("draft/get");
    expect(JSON.parse(server.requests[before].body as string)).toEqual({
      media_id: "draft-id",
    });
  });
  it("reports remote text and cover changes while retaining the changed remote draft", async () => {
    const server = new WechatServer();
    const connector = api(server);
    await connector.sync(s, undefined, () => {});
    server.draft!.content = String(server.draft!.content).replace(
      "hello",
      "changed remotely",
    );
    server.draft!.thumb_media_id = "other-cover";
    const before = structuredClone(server.draft);
    const result = await connector.verify(s, "draft-id");
    expect(result.matches).toBe(false);
    expect(result.checks["正文"]).toBe(false);
    expect(result.checks["封面"]).toBe(false);
    expect(server.draft).toEqual(before);
  });
  it("accepts the live WeChat /0 to /640 size rewrite for the same image", async () => {
    const server = new WechatServer();
    server.imageUrl =
      "https://mmbiz.qpic.cn/sz_mmbiz_png/image-id/0?from=appmsg";
    const connector = api(server);
    await connector.sync(s, undefined, () => {});
    server.draft!.content = String(server.draft!.content).replace(
      "/image-id/0?",
      "/image-id/640?",
    );
    const before = server.requests.length;
    const result = await connector.verify(s, "draft-id");
    expect(result.matches).toBe(true);
    expect(result.differences).toBeUndefined();
    expect(server.requests.slice(before)).toHaveLength(1);
  });
  it.each([
    "https://mmbiz.qpic.cn/sz_mmbiz_png/other-id/640?from=appmsg",
    "https://mmbiz.qpic.cn/sz_mmbiz_png/image-id/640?from=changed",
    "https://mmbiz.qpic.cn/sz_mmbiz_png/image-id/300?from=appmsg",
  ])(
    "retains image differences beyond the observed size rewrite: %s",
    async (url) => {
      const server = new WechatServer();
      server.imageUrl =
        "https://mmbiz.qpic.cn/sz_mmbiz_png/image-id/0?from=appmsg";
      const connector = api(server);
      await connector.sync(s, undefined, () => {});
      server.draft!.content = String(server.draft!.content).replace(
        server.imageUrl,
        url,
      );
      const result = await connector.verify(s, "draft-id");
      expect(result.matches).toBe(false);
      expect(result.checks.正文图片).toBe(false);
      expect(result.differences?.[0].actual).toContain(
        url.replace("/640?", "/0?"),
      );
    },
  );
  it("fails unavailable drafts without creating a replacement", async () => {
    const server = new WechatServer();
    await expect(api(server).verify(s, "missing")).rejects.toThrow("有效正文");
    expect(server.requests.some((r) => /draft\/(add|update)/.test(r.url))).toBe(
      false,
    );
  });
  it("reports unsupported remote images without loading them in the preview", async () => {
    const server = new WechatServer();
    const connector = api(server);
    await connector.sync(s, undefined, () => {});
    server.draft!.content = String(server.draft!.content).replace(
      server.imageUrl,
      "https://example.invalid/a.png",
    );
    const result = await connector.verify(s, "draft-id");
    expect(result.checks["正文图片"]).toBe(false);
    expect(result.html).not.toContain("example.invalid");
  });
  it("does not upload images to repair missing verification caches", async () => {
    const server = new WechatServer();
    await api(server).sync(s, undefined, () => {});
    const before = server.requests.length;
    await expect(api(server).verify(s, "draft-id")).rejects.toThrow(
      "图片缓存缺失",
    );
    expect(
      server.requests
        .slice(before)
        .some((r) => /media\/uploadimg|material\/add_material/.test(r.url)),
    ).toBe(false);
  });
  it("uploads body and cover separately, removes scripts, then creates a draft", async () => {
    const server = new WechatServer();
    const result = await api(server).sync(s, undefined, () => {});
    expect(result.remoteId).toBe("draft-id");
    const payload = JSON.parse(
      server.requests.find((r) => r.url.includes("draft/add"))!.body as string,
    );
    expect(payload.articles[0].thumb_media_id).toBe("cover-id");
    expect(payload.articles[0].content).toContain("mmbiz.qpic.cn");
    expect(payload.articles[0].content).not.toContain("script");
    expect(
      server.requests.filter((r) => r.url.includes("media/uploadimg")),
    ).toHaveLength(1);
  });
  it("updates associated draft rather than creating another", async () => {
    const server = new WechatServer();
    await api(server).sync(
      s,
      {
        articleId: "a",
        channel: "wechat",
        target: "app",
        remoteId: "existing",
        hash: "old",
        at: "",
        url: "",
      },
      () => {},
    );
    expect(server.requests.some((r) => r.url.includes("draft/update"))).toBe(
      true,
    );
    expect(server.requests.some((r) => r.url.includes("draft/add"))).toBe(
      false,
    );
  });
  it("never blindly retries an ambiguous draft create", async () => {
    const server = new WechatServer();
    server.fail = true;
    await expect(
      api(server).sync(s, undefined, () => {}),
    ).rejects.toBeInstanceOf(DeliveryUnknown);
    expect(
      server.requests.filter((r) => r.url.includes("draft/add")),
    ).toHaveLength(1);
  });
  it("requires a cover and rejects unuploaded resources", async () => {
    const server = new WechatServer();
    await expect(
      api(server).sync({ ...s, assets: [] }, undefined, () => {}),
    ).rejects.toThrow("未上传图片");
    await expect(
      api(server).sync(
        { ...s, html: "<p>no cover</p>", assets: [] },
        undefined,
        () => {},
      ),
    ).rejects.toThrow("需要封面");
  });
  it("reuses persistent body and cover caches on a later sync", async () => {
    const server = new WechatServer();
    let saved = { images: {}, covers: {} };
    await new WechatConnector(
      server,
      { ...DEFAULT_CONFIG.wechat, appId: "app" },
      "secret",
      saved,
      async (cache) => {
        saved = cache;
      },
    ).sync(s, undefined, () => {});
    await new WechatConnector(
      server,
      { ...DEFAULT_CONFIG.wechat, appId: "app" },
      "secret",
      saved,
    ).sync(s, undefined, () => {});
    expect(
      server.requests.filter((r) => r.url.includes("media/uploadimg")),
    ).toHaveLength(1);
    expect(
      server.requests.filter((r) => r.url.includes("material/add_material")),
    ).toHaveLength(1);
  });
  it("constructs valid multipart binary upload", () => {
    const m = multipart(new Uint8Array([1, 2, 3]), "image.png", "image/png");
    expect(m.contentType).toContain("boundary=");
    const text = new TextDecoder().decode(m.body);
    expect(text).toContain('name="media"; filename="image.png"');
    expect(text).toContain("Content-Type: image/png");
  });
});

describe("WeChat API image URL compatibility", () => {
  it("accepts HTTP CDN URLs returned by the image upload API", async () => {
    const server = new WechatServer();
    server.imageUrl = "http://mmbiz.qpic.cn/a.png";
    await api(server).sync(s, undefined, () => {});
    const payload = JSON.parse(
      server.requests.find((r) => r.url.includes("draft/add"))!.body as string,
    );
    expect(payload.articles[0].content).toContain("http://mmbiz.qpic.cn/a.png");
  });
});

describe("explicit cover handling", () => {
  it("does not silently replace a missing explicit cover with a body image", async () => {
    const server = new WechatServer();
    await expect(
      api(server).sync(
        { ...s, cover: "missing-cover.png" },
        undefined,
        () => {},
      ),
    ).rejects.toThrow("指定的微信封面不可用");
    expect(server.requests.some((r) => r.url.includes("draft/add"))).toBe(
      false,
    );
  });
});

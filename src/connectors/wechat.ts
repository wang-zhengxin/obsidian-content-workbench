import type {
  Config,
  Snapshot,
  Transport,
  Binding,
  Asset,
  MediaCache,
  RemoteVerification,
} from "../domain";
import { DeliveryUnknown, fromBase64 } from "../domain";
import { inlineWechatStyles } from "../exporter";
import DOMPurify from "dompurify";
export function multipart(
  bytes: Uint8Array,
  name: string,
  mime: string,
): { body: ArrayBuffer; contentType: string } {
  const boundary =
    "----ContentWorkbench" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const before = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${name.replace(/["\r\n]/g, "_")}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    after = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(before.length + bytes.length + after.length);
  out.set(before);
  out.set(bytes, before.length);
  out.set(after, before.length + bytes.length);
  return {
    body: out.buffer,
    contentType: "multipart/form-data; boundary=" + boundary,
  };
}
export class WechatConnector {
  private token = "";
  private expires = 0;
  private images = new Map<string, string>();
  private covers = new Map<string, string>();
  constructor(
    private transport: Transport,
    private config: Config["wechat"],
    private secret: string,
    cache?: MediaCache,
    private saveCache?: (cache: MediaCache) => Promise<void>,
  ) {
    this.images = new Map(Object.entries(cache?.images ?? {}));
    this.covers = new Map(Object.entries(cache?.covers ?? {}));
  }
  private route(url: string): string {
    if (!this.config.proxyUrl) return url;
    const proxy = new URL(this.config.proxyUrl);
    if (proxy.protocol !== "https:")
      throw new Error("微信代理地址必须使用 HTTPS");
    proxy.searchParams.set("url", url);
    return proxy.toString();
  }
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expires) return this.token;
    if (!this.config.appId || !this.secret)
      throw new Error("请配置公众号 AppID 与 AppSecret");
    const r = await this.transport.request({
      url: this.route("https://api.weixin.qq.com/cgi-bin/stable_token"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        appid: this.config.appId,
        secret: this.secret,
        force_refresh: false,
      }),
    });
    const data = r.json as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (r.status !== 200 || !data.access_token)
      throw new Error(
        `微信鉴权失败：${data.errcode ?? r.status} ${data.errmsg ?? "请检查凭据、接口权限及 IP 白名单"}`,
      );
    this.token = data.access_token;
    this.expires = Date.now() + ((data.expires_in ?? 7200) - 120) * 1000;
    return this.token;
  }
  private async call<T>(
    endpoint: string,
    method = "POST",
    payload?: unknown,
    upload?: { body: ArrayBuffer; contentType: string },
    mutation = false,
    attempt = 0,
  ): Promise<T> {
    const token = await this.accessToken();
    const url =
      "https://api.weixin.qq.com/cgi-bin/" +
      endpoint +
      (endpoint.includes("?") ? "&" : "?") +
      "access_token=" +
      encodeURIComponent(token);
    let r;
    try {
      r = await this.transport.request({
        url: this.route(url),
        method,
        headers: { "Content-Type": upload?.contentType ?? "application/json" },
        body:
          upload?.body ??
          (payload === undefined ? undefined : JSON.stringify(payload)),
      });
    } catch {
      if (mutation)
        throw new DeliveryUnknown(
          "微信草稿请求后连接中断，结果待核对；不要直接重新创建",
        );
      throw new Error("微信连接中断，请检查网络");
    }
    if (r.status < 200 || r.status >= 300) {
      if (mutation && r.status >= 500)
        throw new DeliveryUnknown("微信服务器响应异常，草稿结果待核对");
      throw new Error("微信 HTTP " + r.status);
    }
    if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) {
      if (mutation)
        throw new DeliveryUnknown(
          "微信草稿响应无法解析，结果待核对；不要直接重新创建",
        );
      throw new Error("微信接口未返回有效响应");
    }
    const data = r.json as { errcode?: number; errmsg?: string };
    if ([40014, 42001].includes(data.errcode ?? 0) && attempt === 0) {
      this.token = "";
      this.expires = 0;
      return this.call(endpoint, method, payload, upload, mutation, 1);
    }
    if (data.errcode)
      throw new Error(
        `微信 ${data.errcode}：${data.errmsg ?? "接口请求失败"}${data.errcode === 40164 ? "（请配置公众号出口 IP 白名单）" : ""}`,
      );
    return r.json as T;
  }
  async check(): Promise<void> {
    await this.call("draft/count", "GET");
  }
  private async upload(a: Asset, cover = false): Promise<string> {
    if (a.mime === "image/svg+xml" || a.mime === "image/avif")
      throw new Error("微信不支持该图片，请先转换为 PNG/JPEG：" + a.source);
    const cache = cover ? this.covers : this.images;
    if (cache.has(a.hash)) return cache.get(a.hash)!;
    const data = await this.call<{ media_id?: string; url?: string }>(
      cover ? "material/add_material?type=image" : "media/uploadimg",
      "POST",
      undefined,
      multipart(fromBase64(a.base64), a.path.split("/").pop()!, a.mime),
    );
    const result = cover ? data.media_id : data.url;
    if (!result) throw new Error("微信素材上传未返回有效结果");
    cache.set(a.hash, result);
    await this.saveCache?.({
      images: Object.fromEntries(this.images),
      covers: Object.fromEntries(this.covers),
    });
    return result;
  }
  async sync(
    s: Snapshot,
    binding: Binding | undefined,
    progress: (text: string) => void,
  ): Promise<{ remoteId: string; url: string }> {
    await this.check();
    if (s.cover && !s.assets.some((a) => a.role === "cover"))
      throw new Error("指定的微信封面不可用，请设置有效的本地 cover 图片");
    if (s.warnings.some((w) => w.includes("Mermaid / 数学")))
      throw new Error("请先将 Mermaid / 数学公式转换为图片，再同步公众号");
    let html = DOMPurify.sanitize(s.html, {
      FORBID_TAGS: [
        "script",
        "iframe",
        "style",
        "form",
        "input",
        "video",
        "audio",
      ],
      FORBID_ATTR: ["id", "class"],
    });
    const bodyAssets = s.assets.filter((a) => a.role === "body");
    let n = 0;
    for (const a of bodyAssets) {
      progress(`正在上传正文图片 ${++n}/${bodyAssets.length}`);
      const url = await this.upload(a);
      const from = s.githubPath.split("/").slice(0, -1);
      const dest = a.path.split("/");
      while (from.length && dest.length && from[0] === dest[0]) {
        from.shift();
        dest.shift();
      }
      const relative = [...from.map(() => ".."), ...dest]
        .map((p) => (p === ".." ? p : encodeURIComponent(p)))
        .join("/");
      html = html.split(relative).join(url);
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of doc.querySelectorAll("img"))
      if (!/^https?:\/\/mmbiz\.q(pic|logo)\.cn\//i.test(img.src))
        throw new Error(
          "正文包含未上传图片，请使用本地图片：" + img.getAttribute("src"),
        );
    const cover = s.assets.find((a) => a.role === "cover") ?? bodyAssets[0];
    if (!cover)
      throw new Error(
        "公众号草稿需要封面，请在文章属性中设置 cover 或添加正文图片",
      );
    progress("正在上传封面");
    const mediaId = await this.upload(cover, true);
    const cleaned = inlineWechatStyles(html, s.preserveHtmlStyles);
    const article = {
      title: s.title,
      author: this.config.author,
      digest: s.summary,
      content: cleaned,
      thumb_media_id: mediaId,
      need_open_comment: 0,
      only_fans_can_comment: 0,
    };
    progress(binding ? "正在更新关联草稿" : "正在创建草稿");
    if (binding) {
      await this.call(
        "draft/update",
        "POST",
        { media_id: binding.remoteId, index: 0, articles: article },
        undefined,
        true,
      );
      return { remoteId: binding.remoteId, url: "https://mp.weixin.qq.com/" };
    }
    const result = await this.call<{ media_id?: string }>(
      "draft/add",
      "POST",
      { articles: [article] },
      undefined,
      true,
    );
    if (!result.media_id)
      throw new DeliveryUnknown("微信未返回草稿 ID，请到后台核对");
    return { remoteId: result.media_id, url: "https://mp.weixin.qq.com/" };
  }
  async verify(s: Snapshot, remoteId: string): Promise<RemoteVerification> {
    const data = await this.call<{
      news_item?: {
        title?: string;
        digest?: string;
        content?: string;
        thumb_media_id?: string;
      }[];
    }>("draft/get", "POST", { media_id: remoteId });
    const article = data.news_item?.[0];
    if (!article || typeof article.content !== "string")
      throw new Error("公众号未返回此草稿的有效正文");
    const sanitize = (html: string) =>
      DOMPurify.sanitize(html, {
        FORBID_TAGS: [
          "script",
          "iframe",
          "style",
          "form",
          "input",
          "video",
          "audio",
        ],
        FORBID_ATTR: ["id", "class"],
      });
    let expectedHtml = sanitize(s.html);
    for (const asset of s.assets.filter((a) => a.role === "body")) {
      const url = this.images.get(asset.hash);
      if (!url) throw new Error("正文图片缓存缺失，无法完整核对远端草稿");
      const from = s.githubPath.split("/").slice(0, -1);
      const dest = asset.path.split("/");
      while (from.length && dest.length && from[0] === dest[0]) {
        from.shift();
        dest.shift();
      }
      const relative = [...from.map(() => ".."), ...dest]
        .map((part) => (part === ".." ? part : encodeURIComponent(part)))
        .join("/");
      expectedHtml = expectedHtml.split(relative).join(url);
    }
    const expected = new DOMParser().parseFromString(
      inlineWechatStyles(expectedHtml, s.preserveHtmlStyles),
      "text/html",
    );
    const remoteHtml = sanitize(article.content);
    const remote = new DOMParser().parseFromString(remoteHtml, "text/html");
    const text = (doc: Document) =>
      doc.body.textContent?.replace(/\s+/g, " ").trim();
    const structure = (doc: Document) =>
      [...doc.querySelectorAll("pre, table")].map((el) => [
        el.tagName,
        el.textContent?.trim(),
      ]);
    const images = (doc: Document) =>
      [...doc.querySelectorAll("img")].map((el) => {
        const url = new URL(
          el.getAttribute("data-src") || el.getAttribute("src") || "",
          "https://api.weixin.qq.com/",
        );
        url.protocol = "https:";
        // Live draft/get changes the same WeChat image from /0 to /640.
        // Preserve its host, resource ID and query; ignore only this size variant.
        if (
          url.hostname === "mmbiz.qpic.cn" &&
          !url.port &&
          /^\/(?:sz_)?mmbiz_(?:png|jpg|jpeg|gif)\/[^/]+\/(?:0|640)$/.test(
            url.pathname,
          )
        )
          url.pathname = url.pathname.replace(/\/(?:0|640)$/, "/0");
        return url.href;
      });
    const styles = (doc: Document) =>
      [...doc.body.querySelectorAll("*")].map((el) => [
        el.tagName,
        (el as HTMLElement).style.cssText,
      ]);
    const cover =
      s.assets.find((a) => a.role === "cover") ??
      s.assets.find((a) => a.role === "body");
    const checks = {
      单篇草稿: data.news_item?.length === 1,
      标题: article.title === s.title,
      摘要: article.digest === s.summary,
      正文: text(remote) === text(expected),
      代码与表格:
        JSON.stringify(structure(remote)) ===
        JSON.stringify(structure(expected)),
      正文图片:
        JSON.stringify(images(remote)) === JSON.stringify(images(expected)),
      封面:
        !!cover &&
        !!this.covers.get(cover.hash) &&
        article.thumb_media_id === this.covers.get(cover.hash),
      排版属性:
        JSON.stringify(styles(remote)) === JSON.stringify(styles(expected)),
    };
    const matches = Object.values(checks).every(Boolean);
    const imageDetails = (doc: Document) =>
      images(doc)
        .map((url) =>
          /^https:\/\/mmbiz\.q(pic|logo)\.cn\//i.test(url)
            ? url
            : "非微信素材地址",
        )
        .join("\n") || "无图片";
    const preview = new DOMParser().parseFromString(remoteHtml, "text/html");
    for (const image of preview.querySelectorAll("img")) {
      const source =
        image.getAttribute("data-src") || image.getAttribute("src") || "";
      if (/^https?:\/\/mmbiz\.q(pic|logo)\.cn\//i.test(source))
        image.setAttribute("src", source.replace(/^http:/i, "https:"));
      else image.remove();
    }
    return {
      matches,
      message: matches
        ? "远端草稿与本次交付内容一致"
        : "远端草稿与本次交付内容有差异，未修改草稿或关联记录",
      checks,
      differences: checks.正文图片
        ? undefined
        : [
            {
              label: "正文图片地址",
              expected: imageDetails(expected),
              actual: imageDetails(remote),
            },
          ],
      html: inlineWechatStyles(preview.body.innerHTML, s.preserveHtmlStyles),
    };
  }
  async candidates(
    s: Snapshot,
    since: string,
  ): Promise<{ remoteId: string; title: string; updated: number }[]> {
    const matches: { remoteId: string; title: string; updated: number }[] = [];
    for (let offset = 0; offset < 100; offset += 20) {
      const data = await this.call<{
        item?: {
          media_id: string;
          update_time: number;
          content: { news_item: { title: string }[] };
        }[];
      }>("draft/batchget", "POST", { offset, count: 20, no_content: 0 });
      const items = data.item ?? [];
      for (const i of items)
        if (
          i.update_time * 1000 >= new Date(since).getTime() - 120000 &&
          i.content.news_item.some((n) => n.title === s.title)
        )
          matches.push({
            remoteId: i.media_id,
            title: s.title,
            updated: i.update_time,
          });
      if (items.length < 20) break;
    }
    return matches;
  }
}

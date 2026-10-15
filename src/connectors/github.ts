import type { Binding, Config, Snapshot, Transport } from "../domain";
import { ConflictError, DeliveryUnknown, toBase64 } from "../domain";
interface Ref {
  object: { sha: string };
}
interface Commit {
  tree: { sha: string };
}
interface Tree {
  tree: { path: string; sha: string; type: string; mode?: string }[];
  truncated: boolean;
}
class GithubApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    message: string,
  ) {
    super(message);
  }
}
export interface GithubResult {
  snapshot: Snapshot;
  commit: string;
  url: string;
  remoteSha: string;
  unchanged: boolean;
}
export class GithubConnector {
  constructor(
    private transport: Transport,
    private config: Config["github"],
    private token: string,
  ) {}
  private base(): string {
    return `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }
  private async call<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const r = await this.transport.request({
      url: this.base() + path,
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status < 200 || r.status >= 300) {
      const message = (r.json as { message?: string })?.message ?? "请求失败";
      throw new GithubApiError(
        r.status,
        path,
        `GitHub ${r.status}：${message}${r.status === 403 ? "（请检查仓库写权限或分支保护）" : ""}`,
      );
    }
    return r.json as T;
  }
  async check(): Promise<void> {
    if (
      !this.token ||
      !this.config.owner ||
      !this.config.repo ||
      !this.config.branch
    )
      throw new Error("请配置 GitHub 仓库、分支和凭据");
    let repository: { default_branch?: string };
    try {
      repository = await this.call("");
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 404)
        throw new Error(
          `GitHub 404：无法访问仓库 ${this.config.owner}/${this.config.repo}。请检查仓库名称、令牌的目标仓库授权及账号访问权限。`,
        );
      throw e;
    }
    try {
      await this.head();
    } catch (e) {
      if (
        e instanceof GithubApiError &&
        e.status === 404 &&
        e.path.startsWith("/git/ref/")
      )
        throw new Error(
          `GitHub 404：仓库可访问，但无法读取目标分支 ${this.config.branch}。请检查分支是否存在及 Contents 读取权限${repository.default_branch ? `；仓库默认分支为 ${repository.default_branch}` : ""}。`,
        );
      throw e;
    }
  }
  private async head(): Promise<{
    head: string;
    tree: string;
    files: Map<string, string>;
    blockedPaths: Set<string>;
  }> {
    const ref = await this.call<Ref>(
      "/git/ref/heads/" +
        this.config.branch.split("/").map(encodeURIComponent).join("/"),
    );
    const commit = await this.call<Commit>("/git/commits/" + ref.object.sha);
    const tree = await this.call<Tree>(
      "/git/trees/" + commit.tree.sha + "?recursive=1",
    );
    if (tree.truncated) throw new Error("目标仓库文件树过大，无法完整检查冲突");
    return {
      head: ref.object.sha,
      tree: commit.tree.sha,
      files: new Map(
        tree.tree.filter((x) => x.type === "blob").map((x) => [x.path, x.sha]),
      ),
      blockedPaths: new Set(
        tree.tree
          .filter((x) => x.type !== "blob" || x.mode === "120000")
          .map((x) => x.path),
      ),
    };
  }
  private async blob(content: string): Promise<string> {
    return (
      await this.call<{ sha: string }>("/git/blobs", "POST", {
        content,
        encoding: "base64",
      })
    ).sha;
  }
  private checkTargetPaths(
    base: { files: Map<string, string>; blockedPaths: Set<string> },
    paths: Iterable<string>,
  ): void {
    for (const path of paths) {
      if (base.blockedPaths.has(path))
        throw new ConflictError("目标路径是目录或符号链接：" + path);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++)
        if (base.files.has(parts.slice(0, i).join("/")))
          throw new ConflictError("目标路径的父目录被文件占用：" + path);
    }
  }
  async push(
    snapshots: Snapshot[],
    bindings: Binding[],
    progress: (s: string) => void,
  ): Promise<GithubResult[]> {
    if (new Set(snapshots.map((s) => s.githubPath)).size !== snapshots.length)
      throw new ConflictError(
        "多篇文章映射到相同路径，请调整文章路径模板或 slug",
      );
    await this.check();
    const initial = await this.head();
    progress("正在检查文件与远端版本");
    const desired = new Map<string, { sha: string }>();
    const articleShas = new Map<string, string>();
    for (const s of snapshots) {
      const sha = await this.blob(
        toBase64(new TextEncoder().encode(s.markdown)),
      );
      desired.set(s.githubPath, { sha });
      articleShas.set(s.articleId, sha);
      for (const a of s.assets)
        if (!desired.has(a.path))
          desired.set(a.path, { sha: await this.blob(a.base64) });
    }
    for (const s of snapshots) {
      const current = initial.files.get(s.githubPath);
      const expected = bindings.find(
        (b) => b.articleId === s.articleId && b.remotePath === s.githubPath,
      )?.remoteSha;
      if (
        current &&
        current !== articleShas.get(s.articleId) &&
        (!expected || current !== expected)
      )
        throw new ConflictError(
          `远端文章已存在或被修改：${s.githubPath}。请核对后调整目标路径。`,
        );
      for (const asset of s.assets) {
        const current = initial.files.get(asset.path);
        if (current && current !== desired.get(asset.path)!.sha)
          throw new ConflictError("远端附件已被修改：" + asset.path);
      }
    }
    this.checkTargetPaths(initial, desired.keys());
    let base = initial;
    for (let attempt = 0; attempt < 2; attempt++) {
      const changed = [...desired].filter(
        ([path, v]) => base.files.get(path) !== v.sha,
      );
      if (changed.length === 0)
        return snapshots.map((s) => ({
          snapshot: s,
          commit: base.head,
          url: this.fileUrl(s.githubPath),
          remoteSha: articleShas.get(s.articleId)!,
          unchanged: true,
        }));
      progress("正在提交 Markdown 与附件");
      const tree = await this.call<{ sha: string }>("/git/trees", "POST", {
        base_tree: base.tree,
        tree: changed.map(([path, v]) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: v.sha,
        })),
      });
      const commit = await this.call<{ sha: string }>("/git/commits", "POST", {
        message: `Publish ${snapshots.length} article(s) from Content Workbench`,
        tree: tree.sha,
        parents: [base.head],
      });
      let response;
      try {
        response = await this.transport.request({
          url:
            this.base() +
            "/git/refs/heads/" +
            this.config.branch.split("/").map(encodeURIComponent).join("/"),
          method: "PATCH",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ sha: commit.sha, force: false }),
        });
      } catch {
        try {
          const now = await this.head();
          if ([...desired].every(([p, v]) => now.files.get(p) === v.sha))
            return snapshots.map((s) => ({
              snapshot: s,
              commit: now.head,
              url: this.fileUrl(s.githubPath),
              remoteSha: articleShas.get(s.articleId)!,
              unchanged: false,
            }));
        } catch {}
        throw new DeliveryUnknown(
          "GitHub 更新分支后连接中断，结果待核对；请勿直接重复推送",
        );
      }
      if (response.status >= 200 && response.status < 300)
        return snapshots.map((s) => ({
          snapshot: s,
          commit: commit.sha,
          url: this.fileUrl(s.githubPath),
          remoteSha: articleShas.get(s.articleId)!,
          unchanged: false,
        }));
      if ([409, 422].includes(response.status) && attempt === 0) {
        const now = await this.head();
        this.checkTargetPaths(now, desired.keys());
        for (const p of desired.keys())
          if (
            now.files.get(p) !== base.files.get(p) &&
            now.files.get(p) !== desired.get(p)!.sha
          )
            throw new ConflictError("提交过程中远端修改了同一路径：" + p);
        base = now;
        continue;
      }
      if (response.status >= 500)
        throw new DeliveryUnknown(
          "GitHub 更新分支响应异常，结果待核对；请勿直接重复推送",
        );
      throw new Error(
        `GitHub 更新分支失败 (${response.status})：${(response.json as { message?: string })?.message ?? "请检查分支保护"}`,
      );
    }
    throw new Error("GitHub 分支持续变化，请稍后重试");
  }
  fileUrl(path: string): string {
    return `https://github.com/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/blob/${this.config.branch.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  async reconcile(s: Snapshot): Promise<GithubResult | null> {
    const head = await this.head();
    const sha = head.files.get(s.githubPath);
    if (!sha) return null;
    const expected = new Map([
      [s.githubPath, toBase64(new TextEncoder().encode(s.markdown))],
      ...s.assets.map((a) => [a.path, a.base64] as [string, string]),
    ]);
    for (const [path, content] of expected) {
      const blobSha = head.files.get(path);
      if (!blobSha) return null;
      const r = await this.call<{ content: string; encoding: string }>(
        "/git/blobs/" + blobSha,
      );
      if (r.encoding !== "base64" || r.content.replace(/\s/g, "") !== content)
        return null;
    }
    return {
      snapshot: s,
      commit: head.head,
      url: this.fileUrl(s.githubPath),
      remoteSha: sha,
      unchanged: true,
    };
  }
}

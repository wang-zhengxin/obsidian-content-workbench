import { describe, it, expect } from "vitest";
import { GithubConnector } from "../src/connectors/github";
import {
  DEFAULT_CONFIG,
  DeliveryUnknown,
  ConflictError,
  type Transport,
  type Snapshot,
  toBase64,
} from "../src/domain";
const snapshot: Snapshot = {
  articleId: "a",
  sourcePath: "a.md",
  title: "A",
  summary: "",
  cover: "",
  markdown: "# A",
  html: "<h1>A</h1>",
  assets: [
    {
      path: "assets/image.png",
      source: "image.png",
      mime: "image/png",
      base64: "AQID",
      hash: "hash",
      size: 3,
      role: "body",
    },
  ],
  hash: "h",
  createdAt: "2026-10-12",
  warnings: [],
  githubPath: "content/a.md",
};
class GitServer implements Transport {
  files = new Map([["README.md", "readme-sha"]]);
  head = "initial";
  blobs = new Map<string, string>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, Map<string, string>>();
  requests: { path: string; body: unknown }[] = [];
  failPatch = false;
  race = false;
  directories = new Set<string>();
  raceDirectory = "";
  raceArticleSha = "";
  async request(data: Parameters<Transport["request"]>[0]) {
    const url = new URL(data.url),
      path = url.pathname.replace(/^\/repos\/owner\/repo/, ""),
      body = data.body ? JSON.parse(data.body as string) : undefined;
    this.requests.push({ path, body });
    let json: unknown;
    if (path === "") json = { default_branch: "main" };
    else if (path.startsWith("/git/ref/"))
      json = { object: { sha: this.head } };
    else if (path.startsWith("/git/commits/") && data.method !== "POST")
      json = { tree: { sha: "tree-" + this.head } };
    else if (path.startsWith("/git/trees/") && data.method !== "POST")
      json = {
        tree: [
          ...[...this.files].map(([path, sha]) => ({
            path,
            sha,
            type: "blob",
          })),
          ...[...this.directories].map((path) => ({
            path,
            sha: "directory-sha",
            type: "tree",
          })),
        ],
        truncated: false,
      };
    else if (path === "/git/blobs") {
      const sha = "blob-" + body.content;
      this.blobs.set(sha, body.content);
      json = { sha };
    } else if (path.startsWith("/git/blobs/"))
      json = {
        content: this.blobs.get(path.slice("/git/blobs/".length)),
        encoding: "base64",
      };
    else if (path === "/git/trees") {
      const sha = "tree-new-" + this.trees.size,
        files = new Map(this.files);
      for (const file of body.tree) files.set(file.path, file.sha);
      this.trees.set(sha, files);
      json = { sha };
    } else if (path === "/git/commits") {
      const sha = "commit-" + this.commits.size;
      this.commits.set(sha, this.trees.get(body.tree)!);
      json = { sha };
    } else if (path.startsWith("/git/refs/")) {
      if (this.race) {
        this.race = false;
        this.files.set("README.md", "new-readme");
        if (this.raceArticleSha)
          this.files.set("content/a.md", this.raceArticleSha);
        if (this.raceDirectory) this.directories.add(this.raceDirectory);
        this.head = "advanced";
        return { status: 422, json: { message: "not fast forward" }, text: "" };
      }
      this.head = body.sha;
      this.files = this.commits.get(body.sha)!;
      if (this.failPatch) throw new Error("disconnected");
      json = {};
    } else throw new Error("Unexpected " + path);
    return { status: 200, json, text: "" };
  }
}
function api(server: GitServer) {
  return new GithubConnector(
    server,
    { ...DEFAULT_CONFIG.github, owner: "owner", repo: "repo" },
    "token",
  );
}
describe("GitHub atomic document delivery", () => {
  it("distinguishes repository access failure without querying Git data", async () => {
    const requests: string[] = [];
    const transport: Transport = {
      async request(data) {
        requests.push(data.url);
        return { status: 404, json: { message: "Not Found" }, text: "" };
      },
    };
    await expect(
      new GithubConnector(
        transport,
        { ...DEFAULT_CONFIG.github, owner: "owner", repo: "repo" },
        "token",
      ).check(),
    ).rejects.toThrow("无法访问仓库 owner/repo");
    expect(requests).toEqual(["https://api.github.com/repos/owner/repo"]);
  });
  it("reports the default branch when repository metadata is accessible but the target ref is not", async () => {
    const transport: Transport = {
      async request(data) {
        return data.url.endsWith("/owner/repo")
          ? { status: 200, json: { default_branch: "master" }, text: "" }
          : { status: 404, json: { message: "Not Found" }, text: "" };
      },
    };
    await expect(
      new GithubConnector(
        transport,
        { ...DEFAULT_CONFIG.github, owner: "owner", repo: "repo" },
        "token",
      ).check(),
    ).rejects.toThrow(
      "仓库可访问，但无法读取目标分支 main。请检查分支是否存在及 Contents 读取权限；仓库默认分支为 master",
    );
  });
  it("keeps authentication errors distinct from repository access errors", async () => {
    const transport: Transport = {
      async request() {
        return { status: 401, json: { message: "Bad credentials" }, text: "" };
      },
    };
    await expect(
      new GithubConnector(
        transport,
        { ...DEFAULT_CONFIG.github, owner: "owner", repo: "repo" },
        "token",
      ).check(),
    ).rejects.toThrow("GitHub 401：Bad credentials");
  });
  it("commits markdown and assets while preserving unrelated files", async () => {
    const server = new GitServer();
    const results = await api(server).push([snapshot], [], () => {});
    expect(server.files.get("README.md")).toBe("readme-sha");
    expect(server.files.has("content/a.md")).toBe(true);
    expect(server.files.has("assets/image.png")).toBe(true);
    expect(results[0].remoteSha).toBe(
      "blob-" + toBase64(new TextEncoder().encode("# A")),
    );
    const patches = server.requests.filter((r) =>
      r.path.startsWith("/git/refs/"),
    );
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ force: false });
  });
  it("requires attachment content to match when reconciling", async () => {
    const server = new GitServer();
    await api(server).push([snapshot], [], () => {});
    server.files.delete("assets/image.png");
    expect(await api(server).reconcile(snapshot)).toBeNull();
  });
  it("skips unchanged commit", async () => {
    const server = new GitServer(),
      connector = api(server);
    await connector.push([snapshot], [], () => {});
    const first = server.commits.size;
    const result = await connector.push([snapshot], [], () => {});
    expect(server.commits.size).toBe(first);
    expect(result[0].unchanged).toBe(true);
  });
  it("refuses overwrite of unknown remote document", async () => {
    const server = new GitServer();
    server.files.set(snapshot.githubPath, "someone-else");
    await expect(
      api(server).push([snapshot], [], () => {}),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(server.files.get(snapshot.githubPath)).toBe("someone-else");
  });
  it.each(["before", "during"])(
    "refuses an externally changed bound article %s a commit attempt",
    async (timing) => {
      const server = new GitServer();
      const connector = api(server);
      const first = (await connector.push([snapshot], [], () => {}))[0];
      const binding = {
        articleId: "a",
        channel: "github" as const,
        target: "owner/repo@main",
        remoteId: first.commit,
        remotePath: snapshot.githubPath,
        remoteSha: first.remoteSha,
        hash: snapshot.hash,
        at: "",
        url: first.url,
      };
      const patchCount = server.requests.filter((r) =>
        r.path.startsWith("/git/refs/"),
      ).length;
      if (timing === "before")
        server.files.set(snapshot.githubPath, "external-version");
      else {
        server.race = true;
        server.raceArticleSha = "external-version";
      }
      await expect(
        connector.push(
          [{ ...snapshot, markdown: "# Local edit" }],
          [binding],
          () => {},
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(server.files.get(snapshot.githubPath)).toBe("external-version");
      expect(
        server.requests.filter((r) => r.path.startsWith("/git/refs/")).length -
          patchCount,
      ).toBe(timing === "before" ? 0 : 1);
    },
  );
  it("rebuilds against new remote head for unrelated changes", async () => {
    const server = new GitServer();
    server.race = true;
    await api(server).push([snapshot], [], () => {});
    expect(server.files.get("README.md")).toBe("new-readme");
    expect(server.files.has(snapshot.githubPath)).toBe(true);
  });
  it("reconciles a committed update whose response was lost", async () => {
    const server = new GitServer();
    server.failPatch = true;
    const result = await api(server).push([snapshot], [], () => {});
    expect(result[0].commit).toBe(server.head);
    expect((await api(server).reconcile(snapshot))?.snapshot.articleId).toBe(
      "a",
    );
  });
});

describe("GitHub path collision protection", () => {
  it("refuses a target already occupied by a directory", async () => {
    const server = new GitServer();
    server.directories.add(snapshot.githubPath);
    await expect(api(server).push([snapshot], [], () => {})).rejects.toThrow(
      "目录或符号链接",
    );
    expect(server.commits.size).toBe(0);
  });
  it("rechecks directory collisions after another writer advances the branch", async () => {
    const server = new GitServer();
    server.race = true;
    server.raceDirectory = snapshot.githubPath;
    await expect(api(server).push([snapshot], [], () => {})).rejects.toThrow(
      "目录或符号链接",
    );
    expect(server.head).toBe("advanced");
    expect(server.files.has(snapshot.githubPath)).toBe(false);
    expect(
      server.requests.filter((r) => r.path.startsWith("/git/refs/")),
    ).toHaveLength(1);
  });
  it("refuses two articles mapped to the same Markdown path", async () => {
    const server = new GitServer();
    await expect(
      api(server).push(
        [snapshot, { ...snapshot, articleId: "b" }],
        [],
        () => {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(server.commits.size).toBe(0);
  });
  it("refuses a modified content-addressed attachment", async () => {
    const server = new GitServer();
    server.files.set("assets/image.png", "unexpected-image");
    await expect(api(server).push([snapshot], [], () => {})).rejects.toThrow(
      "远端附件",
    );
    expect(server.commits.size).toBe(0);
  });
});

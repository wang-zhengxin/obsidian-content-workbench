import { describe, it, expect, vi, afterEach } from "vitest";
import { Publisher } from "../src/publisher";
import { GithubConnector } from "../src/connectors/github";
import { WechatConnector } from "../src/connectors/wechat";
import {
  DEFAULT_CONFIG,
  DeliveryUnknown,
  targetKey,
  type WorkbenchHost,
  type PublishState,
  type Snapshot,
  type PublishTask,
} from "../src/domain";
const snapshot = (id = "a"): Snapshot => ({
  articleId: id,
  sourcePath: id + ".md",
  title: id,
  summary: "",
  cover: "",
  markdown: "# " + id,
  html: "<p>" + id + "</p>",
  assets: [],
  hash: "hash-" + id,
  revisionHash: "rev-" + id,
  createdAt: "2026-10-12",
  warnings: [],
  githubPath: "content/" + id + ".md",
});
function setup() {
  let state: PublishState = { tasks: [], bindings: [] };
  const config = structuredClone(DEFAULT_CONFIG);
  config.github.owner = "owner";
  config.github.repo = "repo";
  config.wechat.appId = "app";
  const host = {
    getConfig: () => config,
    getDeviceId: () => "this-device",
    getSecret: async () => "credential",
    getPublishState: () => structuredClone(state),
    savePublishState: async (s: PublishState) => {
      state = structuredClone(s);
    },
    transport: { request: vi.fn() },
  } as unknown as WorkbenchHost;
  return {
    host,
    config,
    publisher: new Publisher(host),
    state: () => state,
    set: (s: PublishState) => {
      state = s;
    },
  };
}
function connect() {
  vi.spyOn(GithubConnector.prototype, "check").mockResolvedValue();
  vi.spyOn(WechatConnector.prototype, "check").mockResolvedValue();
  vi.spyOn(GithubConnector.prototype, "push").mockImplementation(async (docs) =>
    docs.map((s) => ({
      snapshot: s,
      commit: "commit",
      url: "https://github.com/result",
      remoteSha: "sha",
      unchanged: false,
    })),
  );
  return vi
    .spyOn(WechatConnector.prototype, "sync")
    .mockImplementation(async (s) => ({
      remoteId: "draft-" + s.articleId,
      url: "https://mp.weixin.qq.com/",
    }));
}
afterEach(() => vi.restoreAllMocks());
describe("persistent per-channel delivery coordination", () => {
  it("keeps the original GitHub destination if settings mutate during another channel", async () => {
    const sync = connect();
    const x = setup();
    sync.mockImplementation(async () => {
      x.config.github.owner = "different-owner";
      x.config.github.repo = "different-repo";
      x.config.github.branch = "different-branch";
      return { remoteId: "draft-a", url: "https://mp.weixin.qq.com/" };
    });
    vi.spyOn(GithubConnector.prototype, "push").mockImplementation(
      async function (this: GithubConnector, docs) {
        return docs.map((s) => ({
          snapshot: s,
          commit: "commit",
          remoteSha: "sha",
          url: this.fileUrl(s.githubPath),
          unchanged: false,
        }));
      },
    );
    await x.publisher.deliver([snapshot()], ["wechat", "github"]);
    const task = x.state().tasks.find((t) => t.channel === "github")!;
    expect(task.target).toBe("owner/repo@main");
    expect(task.url).toBe(
      "https://github.com/owner/repo/blob/main/content/a.md",
    );
  });
  it("verifies successful results without rewriting tasks or bindings", async () => {
    connect();
    const x = setup();
    await x.publisher.deliver([snapshot()], ["github"]);
    const before = x.state();
    vi.spyOn(GithubConnector.prototype, "reconcile").mockResolvedValue({
      snapshot: snapshot(),
      commit: "readback-commit",
      remoteSha: "readback-sha",
      url: "https://github.com/result",
      unchanged: true,
    });
    expect((await x.publisher.verify(before.tasks[0].id)).matches).toBe(true);
    expect(x.state()).toEqual(before);
  });
  it("does not query a different target when verifying an old result", async () => {
    connect();
    const x = setup();
    await x.publisher.deliver([snapshot()], ["github"]);
    const readback = vi.spyOn(GithubConnector.prototype, "reconcile");
    x.config.github.repo = "different-repo";
    await expect(x.publisher.verify(x.state().tasks[0].id)).rejects.toThrow(
      "原任务目标不同",
    );
    expect(readback).not.toHaveBeenCalled();
  });
  it("retains successes when only one article/channel fails", async () => {
    const sync = connect();
    sync.mockImplementation(async (s) => {
      if (s.articleId === "b") throw new Error("permission");
      return { remoteId: "draft-a", url: "https://mp.weixin.qq.com/" };
    });
    const x = setup();
    await x.publisher.deliver(
      [snapshot(), snapshot("b")],
      ["wechat", "github"],
    );
    expect(x.state().tasks.map((t) => t.status)).toEqual([
      "draft_synced",
      "repository_synced",
      "failed",
      "repository_synced",
    ]);
    expect(x.state().bindings).toHaveLength(3);
    expect(x.state().bindings[0].revisionHash).toBe("rev-a");
  });
  it("rejects duplicate clicks while a batch is running", async () => {
    connect();
    const x = setup();
    const first = x.publisher.deliver([snapshot()], ["github"]);
    await expect(x.publisher.deliver([snapshot()], ["github"])).rejects.toThrow(
      "正在交付",
    );
    await first;
    expect(x.state().tasks).toHaveLength(1);
  });
  it("freezes snapshots and blocks an ambiguous retry until remote absence is confirmed", async () => {
    const sync = connect();
    sync.mockRejectedValue(new DeliveryUnknown("timeout"));
    const x = setup(),
      s = snapshot();
    await x.publisher.deliver([s], ["wechat"]);
    s.markdown = "changed after delivery";
    expect(x.state().tasks[0].snapshot.markdown).toBe("# a");
    expect(x.state().tasks[0].status).toBe("unknown");
    await expect(x.publisher.deliver([snapshot()], ["wechat"])).rejects.toThrow(
      "待核对",
    );
    await x.publisher.confirmNotDelivered(x.state().tasks[0].id);
    sync.mockResolvedValue({
      remoteId: "draft-retry",
      url: "https://mp.weixin.qq.com/",
    });
    await x.publisher.deliver([snapshot()], ["wechat"]);
    expect(x.state().tasks[1].status).toBe("draft_synced");
  });
  it("recovers interrupted tasks on this device without rewriting other device tasks", async () => {
    const x = setup(),
      base = {
        id: "t",
        batchId: "b",
        channel: "github" as const,
        target: targetKey("github", x.config),
        snapshot: snapshot(),
        createdAt: "2026-10-12",
        updatedAt: "2026-10-12",
        progress: "",
        deviceId: "this-device",
      };
    x.set({
      tasks: [
        { ...base, status: "sending" },
        { ...base, id: "q", status: "queued" },
        { ...base, id: "other", status: "sending", deviceId: "another-device" },
      ],
      bindings: [],
    });
    await x.publisher.recover();
    expect(x.state().tasks.map((t) => t.status)).toEqual([
      "unknown",
      "failed",
      "sending",
    ]);
  });
  it("does not deliver from a device that is not the chosen executor", async () => {
    connect();
    const x = setup();
    x.config.executorDevice = "another-device";
    await expect(x.publisher.deliver([snapshot()], ["github"])).rejects.toThrow(
      "仅查看任务",
    );
    expect(x.state().tasks).toHaveLength(0);
  });
  it("records manual WeChat reconciliation as a reusable draft binding", async () => {
    const x = setup();
    const task: PublishTask = {
      id: "unknown",
      batchId: "batch",
      channel: "wechat",
      target: "app",
      snapshot: snapshot(),
      status: "unknown",
      createdAt: "2026-10-12",
      updatedAt: "2026-10-12",
      progress: "",
      deviceId: "this-device",
    };
    x.set({ tasks: [task], bindings: [] });
    await x.publisher.resolveWechat(task.id, "confirmed-draft");
    expect(x.state().tasks[0].status).toBe("draft_synced");
    expect(x.state().bindings[0].remoteId).toBe("confirmed-draft");
  });
});

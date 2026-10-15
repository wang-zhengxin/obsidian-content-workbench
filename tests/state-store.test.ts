import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../src/state-store";
import type { PublishState, PublishTask, Binding } from "../src/domain";
const temporary: string[] = [];
async function create() {
  const path = await mkdtemp("/tmp/content-workbench-state-");
  temporary.push(path);
  return path;
}
const binding: Binding = {
  articleId: "a",
  channel: "github",
  target: "owner/repo@main",
  remoteId: "commit",
  remoteSha: "sha",
  remotePath: "content/a.md",
  hash: "h",
  at: "2026-10-12",
  url: "https://github.com/result",
};
function task(): PublishTask {
  return {
    id: "task-a",
    batchId: "batch",
    channel: "github",
    target: binding.target,
    snapshot: {
      articleId: "a",
      sourcePath: "a.md",
      title: "a",
      summary: "",
      cover: "",
      markdown: "# A",
      html: "",
      assets: [],
      hash: "h",
      createdAt: "2026-10-12",
      warnings: [],
      githubPath: "content/a.md",
    },
    status: "repository_synced",
    createdAt: "2026-10-12",
    updatedAt: "2026-10-12",
    progress: "仓库已同步",
    remoteId: "commit",
    url: binding.url,
    deviceId: "device",
    binding,
  };
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("atomic task storage", () => {
  it("reopens frozen snapshots and reconstructs bindings if their index was lost", async () => {
    const dir = await create(),
      store = new StateStore(dir),
      state: PublishState = { tasks: [task()], bindings: [binding] };
    await store.save(state);
    await unlink(join(dir, "bindings.json"));
    const restored = await new StateStore(dir).load();
    expect(restored.tasks[0].snapshot.markdown).toBe("# A");
    expect(restored.bindings).toEqual([binding]);
  });
  it("does not rewrite unchanged task files on each progress save", async () => {
    const dir = await create(),
      store = new StateStore(dir),
      state: PublishState = { tasks: [task()], bindings: [binding] };
    await store.save(state);
    const before = (await stat(join(dir, "task-task-a.json"))).mtimeMs;
    state.mediaCache = {
      app: {
        images: { hash: "https://mmbiz.qpic.cn/image" },
        covers: { hash: "media" },
      },
    };
    await store.save(state);
    expect((await stat(join(dir, "task-task-a.json"))).mtimeMs).toBe(before);
    expect((await new StateStore(dir).load()).mediaCache).toEqual(
      state.mediaCache,
    );
  });
  it("keeps valid records when one JSON record is damaged", async () => {
    const dir = await create(),
      warnings: string[] = [];
    await new StateStore(dir).save({ tasks: [task()], bindings: [] });
    await writeFile(join(dir, "task-corrupt.json"), "invalid");
    const state = await new StateStore(dir, (message) =>
      warnings.push(message),
    ).load();
    expect(state.tasks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
  it("serializes saves and rejects task IDs that escape the data directory", async () => {
    const dir = await create(),
      store = new StateStore(dir),
      first = { tasks: [task()], bindings: [] },
      second = structuredClone(first);
    second.tasks[0].progress = "new result";
    await Promise.all([store.save(first), store.save(second)]);
    expect(
      JSON.parse(await readFile(join(dir, "task-task-a.json"), "utf8"))
        .progress,
    ).toBe("new result");
    second.tasks[0].id = "../escape";
    await expect(store.save(second)).rejects.toThrow("ID 无效");
  });
});

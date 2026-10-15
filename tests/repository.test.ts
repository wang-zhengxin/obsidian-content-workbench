import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { TFile } from "./support/obsidian";
import { parse, stringify } from "yaml";
import { ContentRepository } from "../src/repository";
import { DEFAULT_CONFIG } from "../src/domain";
class TestVault {
  files = new Map<string, TFile>();
  contents = new Map<string, string>();
  writes = 0;
  reads = 0;
  failAt = 0;
  add(path: string, properties: Record<string, unknown> = {}, body = "正文") {
    const file = new TFile(path);
    this.files.set(path, file);
    this.contents.set(path, "---\n" + stringify(properties) + "---\n" + body);
    return file;
  }
  properties(path: string) {
    return parse(this.contents.get(path)!.split("---")[1]);
  }
  app() {
    return {
      vault: {
        getMarkdownFiles: () => [...this.files.values()],
        cachedRead: async (f: TFile) => {
          this.reads++;
          return this.contents.get(f.path)!;
        },
        getAbstractFileByPath: (path: string) => this.files.get(path),
      },
      fileManager: {
        processFrontMatter: async (
          file: TFile,
          update: (fm: Record<string, unknown>) => void,
        ) => {
          this.writes++;
          if (this.writes === this.failAt) throw new Error("disk failed");
          const raw = this.contents.get(file.path)!,
            fm = parse(raw.split("---")[1]);
          update(fm);
          this.contents.set(
            file.path,
            "---\n" +
              stringify(fm) +
              "---\n" +
              raw.split("---").slice(2).join("---").trimStart(),
          );
          file.stat.mtime++;
        },
      },
    } as unknown as App;
  }
}
const repository = (vault: TestVault) =>
  new ContentRepository(vault.app(), () => structuredClone(DEFAULT_CONFIG));
describe("native Markdown content repository", () => {
  it("keeps missing IDs stable during scan and persists selected IDs before export", async () => {
    const vault = new TestVault();
    vault.add("内容/a.md");
    vault.add("内容/b.md");
    const repo = repository(vault);
    await repo.scan();
    const id = repo.list().find((a) => a.path === "内容/a.md")!.id;
    await repo.scan();
    expect(repo.list().find((a) => a.path === "内容/a.md")!.id).toBe(id);
    expect(vault.writes).toBe(0);
    await repo.ensureIds([id]);
    expect(vault.properties("内容/a.md").content_id).toBe(id);
    expect(vault.properties("内容/b.md").content_id).toBeUndefined();
    const restarted = repository(vault);
    await restarted.scan();
    expect(restarted.list().find((a) => a.path === "内容/a.md")!.id).toBe(id);
  });
  it("moves one article, restores state on undo, and preserves ID across rename", async () => {
    const vault = new TestVault();
    const f = vault.add("内容/a.md", {
      content_id: "a",
      stage: "writing",
      board_order: 1024,
    });
    vault.add("内容/b.md", {
      content_id: "b",
      stage: "review",
      board_order: 1024,
    });
    vault.add("内容/c.md", {
      content_id: "c",
      stage: "review",
      board_order: 2048,
    });
    const repo = repository(vault);
    await repo.scan();
    await repo.move("a", "review", 1);
    expect(vault.writes).toBe(1);
    expect(vault.properties("内容/a.md")).toMatchObject({
      stage: "review",
      board_order: 1536,
    });
    await repo.undo();
    expect(vault.properties("内容/a.md")).toMatchObject({
      stage: "writing",
      board_order: 1024,
    });
    vault.contents.set("内容/renamed.md", vault.contents.get(f.path)!);
    vault.contents.delete(f.path);
    vault.files.delete(f.path);
    f.path = "内容/renamed.md";
    vault.files.set(f.path, f);
    await repo.rename(f as unknown as import("obsidian").TFile, "内容/a.md");
    expect(repo.list().find((a) => a.id === "a")!.path).toBe(f.path);
  });
  it.each(["queued", "reading"])(
    "does not resurrect a deleted article from a %s refresh",
    async (timing) => {
      vi.useFakeTimers();
      const vault = new TestVault();
      const file = vault.add("内容/deleted.md", { content_id: "deleted" });
      const app = vault.app();
      const repo = new ContentRepository(app, () =>
        structuredClone(DEFAULT_CONFIG),
      );
      try {
        await repo.scan();
        const original = vault.contents.get(file.path)!;
        let finishRead: (markdown: string) => void = () => {};
        const cachedRead = vi.spyOn(app.vault, "cachedRead").mockImplementation(
          async () =>
            new Promise<string>((resolve) => {
              finishRead = resolve;
            }),
        );
        repo.schedule(file as unknown as import("obsidian").TFile);
        if (timing === "reading") await vi.advanceTimersByTimeAsync(120);
        vault.files.delete(file.path);
        vault.contents.delete(file.path);
        repo.remove(file.path);
        if (timing === "queued") {
          await vi.advanceTimersByTimeAsync(120);
          expect(cachedRead).not.toHaveBeenCalled();
        } else {
          finishRead(original);
          await Promise.resolve();
          await Promise.resolve();
          expect(repo.list()).toEqual([]);
        }
      } finally {
        repo.destroy();
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );
  it("repairs copied IDs without changing the canonical ID", async () => {
    const vault = new TestVault();
    vault.add("内容/a.md", { content_id: "same" });
    vault.add("内容/b.md", { content_id: "same" });
    const repo = repository(vault);
    await repo.scan();
    expect(repo.list().every((a) => a.duplicateId)).toBe(true);
    await repo.repairIds();
    expect(vault.properties("内容/a.md").content_id).toBe("same");
    expect(vault.properties("内容/b.md").content_id).not.toBe("same");
    expect(repo.list().some((a) => a.duplicateId)).toBe(false);
  });
  it("rolls back a partially written reorder when a write fails", async () => {
    const vault = new TestVault();
    vault.add("内容/a.md", {
      content_id: "a",
      stage: "writing",
      board_order: 0,
    });
    vault.add("内容/b.md", {
      content_id: "b",
      stage: "review",
      board_order: 0,
    });
    vault.add("内容/c.md", {
      content_id: "c",
      stage: "review",
      board_order: 0,
    });
    const repo = repository(vault);
    await repo.scan();
    vault.failAt = 2;
    await expect(repo.move("a", "review", 1)).rejects.toThrow("disk failed");
    expect(vault.properties("内容/a.md")).toMatchObject({
      stage: "writing",
      board_order: 0,
    });
    expect(vault.properties("内容/b.md")).toMatchObject({
      stage: "review",
      board_order: 0,
    });
  });
  it("scans 1,000 notes and reads/writes only the moved article for ordinary ordering", async () => {
    const vault = new TestVault();
    for (let i = 0; i < 1000; i++)
      vault.add("内容/note-" + i + ".md", {
        content_id: "id-" + i,
        stage: "writing",
        board_order: (i + 1) * 1024,
      });
    vault.add("私人/ignore.md");
    const repo = repository(vault);
    await repo.scan();
    expect(repo.list()).toHaveLength(1000);
    expect(vault.reads).toBe(1000);
    await repo.move("id-500", "writing", 1);
    expect(vault.writes).toBe(1);
    expect(vault.reads).toBe(1001);
  });
  it("soft archives and restores without removing the Markdown file", async () => {
    const vault = new TestVault();
    vault.add("内容/a.md", { content_id: "a", stage: "writing" });
    const repo = repository(vault);
    await repo.scan();
    await repo.update("a", { archivedAt: "2026-10-12" });
    expect(vault.files.has("内容/a.md")).toBe(true);
    expect(repo.list()[0].archivedAt).toBe("2026-10-12");
    await repo.update("a", { archivedAt: "" });
    expect(repo.list()[0].archivedAt).toBe("");
  });
});

describe("ordered workflow writes", () => {
  it("serializes concurrent stage changes and records/restores a manual published mark", async () => {
    const vault = new TestVault();
    vault.add("内容/a.md", { content_id: "a", stage: "writing" });
    const repo = repository(vault);
    await repo.scan();
    await Promise.all([
      repo.update("a", { stage: "published" }),
      repo.update("a", { stage: "planned" }),
    ]);
    expect(repo.list()[0].stage).toBe("planned");
    expect(vault.properties("内容/a.md").published_source).toBe("manual");
    await repo.undo();
    expect(repo.list()[0].stage).toBe("published");
    await repo.undo();
    expect(repo.list()[0].stage).toBe("writing");
    expect(vault.properties("内容/a.md").published_source).toBeUndefined();
  });
});

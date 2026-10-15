import { mkdir, writeFile, rename, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  success,
  type PublishState,
  type PublishTask,
  type Binding,
} from "./domain";
export class StateStore {
  private chain: Promise<void> = Promise.resolve();
  private written = new Map<string, string>();
  constructor(
    private directory: string,
    private warn: (message: string) => void = () => {},
  ) {}
  async load(): Promise<PublishState> {
    await mkdir(this.directory, { recursive: true });
    const tasks: PublishTask[] = [];
    for (const file of (await readdir(this.directory)).filter((file) =>
      /^task-[a-zA-Z0-9_-]+\.json$/.test(file),
    )) {
      try {
        const raw = await readFile(join(this.directory, file), "utf8"),
          task = JSON.parse(raw) as PublishTask;
        if (
          file !== "task-" + task.id + ".json" ||
          !task.snapshot?.articleId ||
          !["wechat", "github"].includes(task.channel)
        )
          throw new Error("invalid record");
        tasks.push(task);
        this.written.set(file, raw);
      } catch {
        this.warn("有一条发布记录无法读取：" + file);
      }
    }
    tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let bindings: Binding[] = [],
      mediaCache = {};
    try {
      bindings = JSON.parse(
        await readFile(join(this.directory, "bindings.json"), "utf8"),
      );
      if (!Array.isArray(bindings)) bindings = [];
    } catch {}
    try {
      mediaCache = JSON.parse(
        await readFile(join(this.directory, "media-cache.json"), "utf8"),
      );
    } catch {}
    for (const task of tasks)
      if (success(task.status) && task.binding) {
        const binding = task.binding,
          existing = bindings.find(
            (b) =>
              b.articleId === binding.articleId &&
              b.channel === binding.channel &&
              b.target === binding.target,
          );
        if (!existing || existing.at <= binding.at) {
          bindings = bindings.filter(
            (b) =>
              !(
                b.articleId === binding.articleId &&
                b.channel === binding.channel &&
                b.target === binding.target
              ),
          );
          bindings.push(binding);
        }
      }
    return { tasks, bindings, mediaCache };
  }
  async save(state: PublishState): Promise<void> {
    const snapshot = structuredClone(state);
    for (const task of snapshot.tasks)
      if (!/^[a-zA-Z0-9_-]+$/.test(task.id))
        throw new Error("发布记录 ID 无效");
    const run = async () => {
      await mkdir(this.directory, { recursive: true });
      for (const task of snapshot.tasks)
        await this.atomic("task-" + task.id + ".json", JSON.stringify(task));
      await this.atomic("bindings.json", JSON.stringify(snapshot.bindings));
      await this.atomic(
        "media-cache.json",
        JSON.stringify(snapshot.mediaCache ?? {}),
      );
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
  private async atomic(file: string, body: string) {
    if (this.written.get(file) === body) return;
    const path = join(this.directory, file);
    await writeFile(path + ".tmp", body, { encoding: "utf8", mode: 0o600 });
    await rename(path + ".tmp", path);
    this.written.set(file, body);
  }
}

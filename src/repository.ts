import { App, TFile, normalizePath } from "obsidian";
import type { Article, Config, Stage } from "./domain";
import { wordCount, normalizeDir } from "./domain";
import { splitMarkdown, stripMarkup } from "./exporter";
export class ContentRepository {
  private records = new Map<string, Article>();
  private callbacks = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private mutationChain: Promise<void> = Promise.resolve();
  private undoStack: { path: string; values: Record<string, unknown> }[][] = [];
  constructor(
    private app: App,
    private config: () => Config,
  ) {}
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation);
    this.mutationChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  update(
    id: string,
    changes: Partial<
      Pick<Article, "stage" | "order" | "plannedAt" | "archivedAt" | "owner">
    >,
  ) {
    return this.mutate(() => this.performUpdate(id, changes));
  }
  move(id: string, stage: Stage, index: number) {
    return this.mutate(() => this.performMove(id, stage, index));
  }
  undo() {
    return this.mutate(() => this.performUndo());
  }
  create(stage: Stage, title: string) {
    return this.mutate(() => this.performCreate(stage, title));
  }
  ensureIds(ids: string[]) {
    return this.mutate(() => this.performEnsureIds(ids));
  }
  repairIds() {
    return this.mutate(() => this.performRepairIds());
  }
  subscribe(fn: () => void): () => void {
    this.callbacks.add(fn);
    return () => this.callbacks.delete(fn);
  }
  emit(): void {
    this.flagDuplicates();
    for (const fn of this.callbacks) fn();
  }
  list(): Article[] {
    return [...this.records.values()];
  }
  inScope(path: string): boolean {
    const root = normalizePath(this.config().contentFolder).replace(/\/$/, "");
    return path.startsWith(root + "/") && path.endsWith(".md");
  }
  async scan(): Promise<void> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.inScope(f.path));
    const paths = new Set(files.map((f) => f.path));
    for (const path of this.records.keys())
      if (!paths.has(path)) this.records.delete(path);
    const queue = [...files];
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length) await this.read(queue.shift()!);
      }),
    );
    this.emit();
  }
  schedule(file: TFile): void {
    if (!this.inScope(file.path)) return;
    clearTimeout(this.timers.get(file.path));
    this.timers.set(
      file.path,
      setTimeout(() => {
        void this.read(file).then(() => this.emit());
        this.timers.delete(file.path);
      }, 120),
    );
  }
  remove(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.records.delete(path);
    this.emit();
  }
  async rename(file: TFile, oldPath: string): Promise<void> {
    const old = this.records.get(oldPath);
    this.records.delete(oldPath);
    if (this.inScope(file.path)) {
      if (old) this.records.set(file.path, { ...old, path: file.path });
      await this.read(file);
    }
    this.emit();
  }
  destroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.callbacks.clear();
  }
  private async read(file: TFile): Promise<void> {
    const path = file.path;
    const isCurrent = () =>
      file.path === path &&
      this.inScope(path) &&
      this.app.vault.getAbstractFileByPath(path) === file;
    if (!isCurrent()) return;
    let markdown: string;
    try {
      markdown = await this.app.vault.cachedRead(file);
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    }
    if (!isCurrent()) return;
    const config = this.config(),
      f = config.fields;
    let fm: Record<string, unknown>, body: string;
    try {
      ({ frontmatter: fm, body } = splitMarkdown(markdown));
    } catch {
      this.records.delete(file.path);
      return;
    }
    const stage =
      (Object.keys(config.stageValues) as Stage[]).find(
        (k) => config.stageValues[k] === String(fm[f.stage] ?? ""),
      ) ?? "inbox";
    const old = this.records.get(file.path);
    const tags = Array.isArray(fm.tags)
      ? fm.tags.map(String)
      : typeof fm.tags === "string"
        ? fm.tags.split(/[, ]+/).filter(Boolean)
        : [];
    this.records.set(file.path, {
      id: String(fm[f.id] || old?.id || crypto.randomUUID()),
      path: file.path,
      title: String(fm[f.title] || file.basename),
      summary: String(fm[f.summary] || stripMarkup(body).slice(0, 85)),
      owner: String(fm[f.owner] || config.author),
      tags,
      stage,
      order: Number(fm[f.order] ?? 0),
      plannedAt: String(fm[f.plannedAt] ?? ""),
      archivedAt: String(fm[f.archivedAt] ?? ""),
      cover: String(fm[f.cover] ?? ""),
      modified: file.stat.mtime,
      wordCount: wordCount(body),
      markdown,
      links: [...body.matchAll(/(?<!!)\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(
        (m) => m[1],
      ),
      frontmatter: fm,
    });
  }
  private flagDuplicates(): void {
    const counts = new Map<string, number>();
    for (const a of this.records.values())
      counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
    for (const a of this.records.values())
      a.duplicateId = (counts.get(a.id) ?? 0) > 1;
  }
  find(id: string): Article {
    const a = this.list().find((a) => a.id === id);
    if (!a) throw new Error("文章已移动或删除，请刷新");
    if (a.duplicateId) throw new Error("文章 ID 重复，请先修复");
    return a;
  }
  private file(a: Article): TFile {
    const file = this.app.vault.getAbstractFileByPath(a.path);
    if (!(file instanceof TFile)) throw new Error("找不到文章文件");
    return file;
  }
  private async performUpdate(
    id: string,
    changes: Partial<
      Pick<Article, "stage" | "order" | "plannedAt" | "archivedAt" | "owner">
    >,
  ): Promise<void> {
    const a = this.find(id);
    await this.apply([{ article: a, changes }]);
  }
  private async apply(
    items: { article: Article; changes: Record<string, unknown> }[],
    recordUndo = true,
  ): Promise<void> {
    const config = this.config(),
      f = config.fields;
    const history: { path: string; values: Record<string, unknown> }[] = [];
    try {
      for (const { article, changes } of items) {
        const file = this.file(article);
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const values: Record<string, unknown> = {};
          for (const key of Object.keys(changes)) {
            const field = f[key as keyof typeof f];
            values[field] = fm[field] ?? null;
            fm[field] =
              key === "stage"
                ? config.stageValues[changes[key] as Stage]
                : changes[key];
          }
          if (changes.stage === "published" && article.stage !== "published") {
            values.published_marked_at = fm.published_marked_at ?? null;
            values.published_source = fm.published_source ?? null;
            fm.published_marked_at = new Date().toISOString();
            fm.published_source = "manual";
          }
          fm[f.id] = article.id;
          history.push({ path: file.path, values });
        });
        await this.read(file);
      }
      if (recordUndo) {
        this.undoStack.push(history);
        if (this.undoStack.length > 30) this.undoStack.shift();
      }
    } catch (e) {
      for (const h of history.reverse()) {
        const file = this.app.vault.getAbstractFileByPath(h.path);
        if (file instanceof TFile) {
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            for (const [k, v] of Object.entries(h.values))
              if (v === null) delete fm[k];
              else fm[k] = v;
          });
          await this.read(file);
        }
      }
      throw e;
    } finally {
      this.emit();
    }
  }
  private async performMove(
    id: string,
    stage: Stage,
    index: number,
  ): Promise<void> {
    const a = this.find(id);
    const target = this.list()
      .filter((x) => x.stage === stage && !x.archivedAt && x.id !== id)
      .sort((a, b) => a.order - b.order);
    const position = Math.max(0, Math.min(index, target.length));
    const prev = target[position - 1],
      next = target[position];
    const order =
      prev && next
        ? (prev.order + next.order) / 2
        : prev
          ? prev.order + 1024
          : next
            ? next.order - 1024
            : 1024;
    if (prev && next && next.order - prev.order < 0.001) {
      target.splice(position, 0, a);
      await this.apply(
        target.map((article, i) => ({
          article,
          changes: { stage, order: (i + 1) * 1024 },
        })),
      );
    } else await this.apply([{ article: a, changes: { stage, order } }]);
  }
  private async performUndo(): Promise<void> {
    const history = this.undoStack.pop();
    if (!history) return;
    for (const h of history) {
      const file = this.app.vault.getAbstractFileByPath(h.path);
      if (file instanceof TFile) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          for (const [k, v] of Object.entries(h.values))
            if (v === null) delete fm[k];
            else fm[k] = v;
        });
        await this.read(file);
      }
    }
    this.emit();
  }
  private async performCreate(stage: Stage, title: string): Promise<void> {
    const config = this.config(),
      f = config.fields;
    const name = title.trim().replace(/[\\/:*?"<>|]/g, "-") || "未命名文章";
    const folder = normalizeDir(config.contentFolder);
    if (!folder) throw new Error("请先在设置中选择内容目录");
    if (!this.app.vault.getAbstractFileByPath(folder))
      await this.app.vault.createFolder(folder);
    let content = "";
    if (config.templatePath) {
      const t = this.app.vault.getAbstractFileByPath(config.templatePath);
      if (t instanceof TFile) content = await this.app.vault.read(t);
    }
    let path = folder + "/" + name + ".md";
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++)
      path = folder + "/" + name + " " + n + ".md";
    const file = await this.app.vault.create(path, content || `# ${name}\n\n`);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[f.id] = crypto.randomUUID();
      fm[f.title] = name;
      fm[f.stage] = config.stageValues[stage];
      fm[f.owner] = config.author;
      fm[f.order] = Date.now();
    });
    await this.read(file);
    this.emit();
    await this.app.workspace.getLeaf("tab").openFile(file);
  }
  private async performEnsureIds(ids: string[]): Promise<void> {
    for (const a of this.records.values())
      if (ids.includes(a.id) && !a.frontmatter[this.config().fields.id]) {
        await this.app.fileManager.processFrontMatter(this.file(a), (fm) => {
          fm[this.config().fields.id] = a.id;
        });
        await this.read(this.file(a));
      }
    this.emit();
  }
  private async performRepairIds(): Promise<void> {
    const seen = new Set<string>();
    for (const a of [...this.records.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      const id = seen.has(a.id) ? crypto.randomUUID() : a.id;
      if (id !== a.id || !a.frontmatter[this.config().fields.id]) {
        await this.app.fileManager.processFrontMatter(this.file(a), (fm) => {
          fm[this.config().fields.id] = id;
        });
        await this.read(this.file(a));
      }
      seen.add(id);
    }
    this.emit();
  }
  async open(id: string): Promise<void> {
    await this.app.workspace.getLeaf("tab").openFile(this.file(this.find(id)));
  }
}

import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  requestUrl,
  FileSystemAdapter,
  normalizePath,
  Scope,
} from "obsidian";
import { createRoot, type Root } from "react-dom/client";

import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type Config,
  type PublishState,
  type WorkbenchHost,
  type RequestData,
} from "./domain";
import { ContentRepository } from "./repository";
import { Workbench } from "./ui/Workbench";
import { Publisher } from "./publisher";
import { StateStore } from "./state-store";
const VIEW = "content-workbench";
class WorkbenchView extends ItemView {
  private root: Root | null = null;
  private ownerWindow: Window | null = null;
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ContentWorkbenchPlugin,
  ) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
  }
  getViewType() {
    return VIEW;
  }
  getDisplayText() {
    return "内容创作看板";
  }
  getIcon() {
    return "layout-dashboard";
  }
  async onOpen() {
    this.contentEl.addClass("content-workbench-pane");
    this.root = createRoot(this.contentEl);
    this.renderInCurrentWindow();
    this.registerEvent(
      this.app.workspace.on("layout-change", () =>
        this.renderInCurrentWindow(),
      ),
    );
  }
  onResize() {
    this.renderInCurrentWindow();
  }
  private renderInCurrentWindow() {
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (!this.root || !ownerWindow || ownerWindow === this.ownerWindow) return;
    this.ownerWindow = ownerWindow;
    this.root.render(
      <Workbench
        host={this.plugin.host}
        publisher={this.plugin.publisher}
        ownerWindow={ownerWindow}
        keyboardScope={this.scope!}
      />,
    );
  }
  async onClose() {
    this.root?.unmount();
    this.root = null;
    this.ownerWindow = null;
    this.contentEl.removeClass("content-workbench-pane");
  }
}
export default class ContentWorkbenchPlugin extends Plugin {
  config: Config = structuredClone(DEFAULT_CONFIG);
  repo!: ContentRepository;
  host!: WorkbenchHost;
  publisher!: Publisher;
  private state: PublishState = { tasks: [], bindings: [] };
  private listeners = new Set<() => void>();
  private store!: StateStore;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanKey = "";
  private device = "";
  private statePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter))
      throw new Error("工作台需要桌面文件系统");
    return join(
      adapter.getBasePath(),
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      "state",
    );
  }
  async onload() {
    const saved = await this.loadData();
    this.config = {
      ...structuredClone(DEFAULT_CONFIG),
      ...saved,
      fields: { ...DEFAULT_CONFIG.fields, ...saved?.fields },
      stageValues: { ...DEFAULT_CONFIG.stageValues, ...saved?.stageValues },
      github: { ...DEFAULT_CONFIG.github, ...saved?.github },
      wechat: { ...DEFAULT_CONFIG.wechat, ...saved?.wechat },
    };
    const deviceKey = "content-workbench-device";
    this.device = this.app.loadLocalStorage(deviceKey) || crypto.randomUUID();
    this.app.saveLocalStorage(deviceKey, this.device);
    this.scanKey = this.indexKey();
    this.repo = new ContentRepository(this.app, () => this.config);
    this.repo.subscribe(() => this.emit());
    await this.loadState();
    this.host = {
      vaultName: this.app.vault.getName(),
      getArticles: () => this.repo.list(),
      subscribe: (cb) => {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
      update: (id, c) => this.repo.update(id, c),
      move: (id, s, i) => this.repo.move(id, s, i),
      undo: () => this.repo.undo(),
      create: (s, t) => this.repo.create(s, t),
      open: (id) => this.repo.open(id),
      ensureIds: (ids) => this.repo.ensureIds(ids),
      repairIds: () => this.repo.repairIds(),
      getConfig: () => this.config,
      configure: () => {
        (
          this.app as unknown as {
            setting: { open(): void; openTabById(id: string): void };
          }
        ).setting.open();
        (
          this.app as unknown as { setting: { openTabById(id: string): void } }
        ).setting.openTabById(this.manifest.id);
      },
      assets: {
        readAsset: async (link, source) => {
          let decoded = link;
          try {
            decoded = decodeURIComponent(link);
          } catch {}
          const file =
            this.app.metadataCache.getFirstLinkpathDest(
              decoded.split("#")[0],
              source,
            ) ?? this.app.vault.getAbstractFileByPath(normalizePath(decoded));
          if (!(file instanceof TFile)) return null;
          return {
            path: file.path,
            bytes: new Uint8Array(await this.app.vault.readBinary(file)),
          };
        },
        resolveNote: (link, source) =>
          this.app.metadataCache.getFirstLinkpathDest(link, source)?.path ??
          null,
      },
      transport: {
        request: async (data: RequestData) => {
          const r = await requestUrl({ ...data, throw: false });
          return { status: r.status, json: r.json, text: r.text };
        },
      },
      getSecret: async (key) => this.app.secretStorage.getSecret(key) || "",
      getPublishState: () => structuredClone(this.state),
      savePublishState: (s) => this.saveState(s),
      getDeviceId: () => this.device,
      assetUrl: (file) =>
        this.app.vault.adapter.getResourcePath(
          normalizePath(`${this.manifest.dir}/assets/${file}`),
        ),
      notify: (m) => {
        new Notice(m);
      },
    };
    this.publisher = new Publisher(this.host);
    await this.publisher.recover();
    this.registerView(VIEW, (leaf) => new WorkbenchView(leaf, this));
    this.addRibbonIcon(
      "layout-dashboard",
      "内容创作看板",
      () => void this.openView(),
    );
    this.addCommand({
      id: "open",
      name: "打开内容创作看板",
      callback: () => void this.openView(),
    });
    this.addCommand({
      id: "undo",
      name: "撤销上次看板修改",
      callback: () => void this.repo.undo(),
    });
    this.addCommand({
      id: "repair-ids",
      name: "修复文章 ID",
      callback: () => void this.repo.repairIds(),
    });
    this.addSettingTab(new WorkbenchSettings(this));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile)
          if (f.extension === "md") this.repo.schedule(f);
          else this.emit();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile) this.repo.schedule(f);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.repo.remove(f.path)),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, old) => {
        if (f instanceof TFile) void this.repo.rename(f, old);
      }),
    );
    this.app.workspace.onLayoutReady(() => void this.repo.scan());
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.repo.destroy();
    this.listeners.clear();
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  async saveConfig() {
    await this.saveData(this.config);
    const key = this.indexKey();
    if (key !== this.scanKey) {
      this.scanKey = key;
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.scanTimer = setTimeout(() => {
        void this.repo.scan().catch((e) => new Notice(String(e)));
      }, 300);
    }
    this.emit();
  }
  private indexKey() {
    return JSON.stringify([
      this.config.contentFolder,
      this.config.author,
      this.config.fields,
      this.config.stageValues,
    ]);
  }
  private async loadState() {
    this.store = new StateStore(
      this.statePath(),
      (message) => new Notice(message),
    );
    this.state = await this.store.load();
  }
  async saveState(state: PublishState): Promise<void> {
    const snapshot = structuredClone(state);
    await this.store.save(snapshot);
    this.state = snapshot;
    this.emit();
  }
}
class WorkbenchSettings extends PluginSettingTab {
  constructor(private plugin: ContentWorkbenchPlugin) {
    super(plugin.app, plugin);
  }
  display() {
    const el = this.containerEl;
    el.empty();
    el.createEl("h2", { text: "内容创作工作台" });
    const c = this.plugin.config;
    const text = (
      name: string,
      desc: string,
      value: string,
      set: (v: string) => void,
    ) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(value).onChange(async (v) => {
            set(v);
            await this.plugin.saveConfig();
          }),
        );
    text(
      "内容目录",
      "仅索引此目录中的 Markdown 笔记",
      c.contentFolder,
      (v) => (c.contentFolder = v.replace(/^\/+|\/+$/g, "")),
    );
    text(
      "模板路径",
      "可选，例如 模板/文章.md",
      c.templatePath,
      (v) => (c.templatePath = v),
    );
    text("作者名称", "用于卡片负责人", c.author, (v) => (c.author = v));
    new Setting(el)
      .setName("减少动态效果")
      .setDesc("开启后关闭位移动画；关闭时跟随系统的动态效果偏好。")
      .addToggle((toggle) =>
        toggle.setValue(c.reduceMotion).onChange(async (value) => {
          c.reduceMotion = value;
          await this.plugin.saveConfig();
        }),
      );
    new Setting(el)
      .setName("文章 ID")
      .setDesc("为内容目录中的现有文章添加稳定 ID；重复 ID 可修复。")
      .addButton((b) =>
        b.setButtonText("补全 / 修复 ID").onClick(async () => {
          await this.plugin.repo.repairIds();
          new Notice("文章 ID 已处理");
        }),
      );
    el.createEl("h3", { text: "GitHub Markdown" });
    for (const [key, name, desc] of [
      ["owner", "仓库所有者", "例如你的 GitHub 用户名"],
      ["repo", "仓库名称", "目标仓库必须已初始化"],
      ["branch", "目标分支", "例如 main"],
      ["contentDir", "文档目录", "例如 content"],
      ["assetDir", "附件目录", "例如 assets"],
      [
        "pathTemplate",
        "文章路径模板",
        "支持 {id}、{slug}、{title}；已关联文章保持原路径",
      ],
    ] as const)
      text(name, desc, c.github[key], (v) => (c.github[key] = v));
    new Setting(el)
      .setName("GitHub Token")
      .setDesc(
        "限定目标仓库的 Contents 写权限；保存到 Obsidian SecretStorage。",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("输入后安全保存").onChange((v) => {
          this.app.secretStorage.setSecret(c.github.secretKey, v);
        });
      });
    el.createEl("h3", { text: "微信公众号草稿" });
    text(
      "AppID",
      "公众号开发者 AppID",
      c.wechat.appId,
      (v) => (c.wechat.appId = v),
    );
    text(
      "微信署名",
      "草稿中的作者",
      c.wechat.author,
      (v) => (c.wechat.author = v),
    );
    new Setting(el)
      .setName("AppSecret")
      .setDesc(
        "保存到 Obsidian SecretStorage；需开通草稿接口并配置 IP 白名单。",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("输入后安全保存").onChange((v) => {
          this.app.secretStorage.setSecret(c.wechat.secretKey, v);
        });
      });
    text(
      "可选代理地址",
      "用户控制的 HTTPS 中转服务，接收 url 查询参数；留空直连。",
      c.wechat.proxyUrl,
      (v) => (c.wechat.proxyUrl = v),
    );
    new Setting(el)
      .setName("执行设备")
      .setDesc(
        c.executorDevice === this.plugin.host.getDeviceId()
          ? "本机可执行发布任务"
          : "未指定时允许本机执行；建议固定一台设备。",
      )
      .addButton((b) =>
        b.setButtonText("指定本机执行").onClick(async () => {
          c.executorDevice = this.plugin.host.getDeviceId();
          await this.plugin.saveConfig();
          this.display();
        }),
      );
    el.createEl("h3", { text: "字段映射" });
    for (const key of Object.keys(c.fields) as (keyof typeof c.fields)[])
      text(
        key,
        "文章 frontmatter 字段名",
        c.fields[key],
        (v) => (c.fields[key] = v),
      );
    for (const stage of Object.keys(
      c.stageValues,
    ) as (keyof typeof c.stageValues)[])
      text(
        "阶段值：" + stage,
        "匹配现有笔记的状态值",
        c.stageValues[stage],
        (v) => (c.stageValues[stage] = v),
      );
    text(
      "导出属性",
      "仅导出列出的属性，用英文逗号分隔",
      c.exportProperties.join(","),
      (v) =>
        (c.exportProperties = v
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)),
    );
  }
}

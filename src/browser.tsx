import { createRoot } from "react-dom/client";
import { Workbench } from "./ui/Workbench";
import { Publisher } from "./publisher";
import { fixtureArticles } from "./fixtures";
import {
  DEFAULT_CONFIG,
  type WorkbenchHost,
  type PublishState,
} from "./domain";
const data = fixtureArticles(),
  callbacks = new Set<() => void>(),
  config = structuredClone(DEFAULT_CONFIG);
config.author = "林";
config.github.owner = "your-name";
config.github.repo = "content";
let state: PublishState = { tasks: [], bindings: [] };
const undo: { id: string; stage: string; order: number }[][] = [];
const emit = () => callbacks.forEach((f) => f());
const host: WorkbenchHost = {
  vaultName: "流光知识库",
  getArticles: () => [...data],
  getConfig: () => config,
  subscribe: (fn) => {
    callbacks.add(fn);
    return () => callbacks.delete(fn);
  },
  update: async (id, c) => {
    const a = data.find((a) => a.id === id)!;
    Object.assign(a, c);
    emit();
  },
  move: async (id, stage, index) => {
    undo.push(data.map((a) => ({ id: a.id, stage: a.stage, order: a.order })));
    const a = data.find((a) => a.id === id)!;
    const arr = data
      .filter((a) => a.id !== id && a.stage === stage)
      .sort((a, b) => a.order - b.order);
    arr.splice(index, 0, a);
    arr.forEach((a, i) => {
      a.stage = stage;
      a.order = (i + 1) * 1024;
    });
    emit();
  },
  undo: async () => {
    const h = undo.pop();
    if (h)
      h.forEach((v) =>
        Object.assign(
          data.find((a) => a.id === v.id)!,
          v,
        ),
      );
    emit();
  },
  create: async (stage, title) => {
    const a = {
      ...fixtureArticles()[0],
      id: crypto.randomUUID(),
      title,
      stage,
      summary: "从这里开始写作",
      tags: [],
      wordCount: 0,
      path: "内容/" + title + ".md",
      markdown: "# " + title,
      order: Date.now(),
    };
    data.push(a);
    emit();
  },
  open: async (id) =>
    alert("Obsidian 中会打开：" + data.find((a) => a.id === id)?.title),
  ensureIds: async () => {},
  repairIds: async () => {},
  configure: () => alert("在 Obsidian 设置中配置内容目录与平台凭据。"),
  assets: {
    readAsset: async () => {
      const r = await fetch("/sample-cover.png");
      return {
        path: "示例封面.png",
        bytes: new Uint8Array(await r.arrayBuffer()),
      };
    },
    resolveNote: (link) => data.find((a) => a.title === link)?.path ?? null,
  },
  transport: {
    request: async () => {
      throw new Error("预览模式：请在 Obsidian 插件中配置并验证连接");
    },
  },
  getSecret: async () => "",
  getPublishState: () => state,
  savePublishState: async (s) => {
    state = s;
    emit();
  },
  getDeviceId: () => "preview",
  assetUrl: (f) => "/assets/" + f,
  notify: (message) => {
    const t = document.createElement("div");
    t.className = "preview-notice";
    t.textContent = message;
    document.body.append(t);
    setTimeout(() => t.remove(), 5000);
  },
};
createRoot(document.getElementById("root")!).render(
  <Workbench host={host} publisher={new Publisher(host)} />,
);
(
  window as unknown as { workbenchTest: { host: WorkbenchHost } }
).workbenchTest = { host };

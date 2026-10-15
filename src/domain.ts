export type Stage = "inbox" | "writing" | "review" | "published" | "planned";
export type Channel = "wechat" | "github";
export type TaskStatus =
  | "queued"
  | "preparing"
  | "sending"
  | "draft_synced"
  | "repository_synced"
  | "failed"
  | "unknown";
export const STAGES: {
  id: Stage;
  label: string;
  detail: string;
  color: string;
}[] = [
  { id: "writing", label: "正在写作", detail: "草稿与灵感", color: "#A78BFA" },
  { id: "review", label: "待审核", detail: "校对与确认", color: "#E9B15A" },
  { id: "published", label: "已发布", detail: "同步与复盘", color: "#52C48A" },
  { id: "planned", label: "发布计划", detail: "排期与分发", color: "#66A8F5" },
];
export interface Article {
  id: string;
  path: string;
  title: string;
  summary: string;
  owner: string;
  tags: string[];
  stage: Stage;
  order: number;
  plannedAt: string;
  archivedAt: string;
  cover: string;
  modified: number;
  wordCount: number;
  markdown: string;
  links: string[];
  frontmatter: Record<string, unknown>;
  duplicateId?: boolean;
}
export interface FieldMap {
  id: string;
  title: string;
  summary: string;
  owner: string;
  stage: string;
  order: string;
  plannedAt: string;
  cover: string;
  archivedAt: string;
}
export interface Config {
  contentFolder: string;
  templatePath: string;
  author: string;
  reduceMotion: boolean;
  fields: FieldMap;
  stageValues: Record<Stage, string>;
  exportProperties: string[];
  github: {
    owner: string;
    repo: string;
    branch: string;
    contentDir: string;
    assetDir: string;
    pathTemplate: string;
    secretKey: string;
  };
  wechat: {
    appId: string;
    author: string;
    secretKey: string;
    proxyUrl: string;
  };
  executorDevice: string;
}
export const DEFAULT_CONFIG: Config = {
  contentFolder: "内容",
  templatePath: "",
  author: "我",
  reduceMotion: false,
  fields: {
    id: "content_id",
    title: "title",
    summary: "summary",
    owner: "owner",
    stage: "stage",
    order: "board_order",
    plannedAt: "planned_at",
    cover: "cover",
    archivedAt: "archived_at",
  },
  stageValues: {
    inbox: "inbox",
    writing: "writing",
    review: "review",
    published: "published",
    planned: "planned",
  },
  exportProperties: ["title", "description", "summary", "tags", "date", "slug"],
  github: {
    owner: "",
    repo: "",
    branch: "main",
    contentDir: "content",
    assetDir: "assets",
    pathTemplate: "{id}.md",
    secretKey: "content-workbench-github",
  },
  wechat: {
    appId: "",
    author: "",
    secretKey: "content-workbench-wechat",
    proxyUrl: "",
  },
  executorDevice: "",
};
export interface Asset {
  path: string;
  source: string;
  mime: string;
  base64: string;
  hash: string;
  size: number;
  role: "body" | "cover";
}
export interface Snapshot {
  articleId: string;
  sourcePath: string;
  title: string;
  summary: string;
  cover: string;
  markdown: string;
  html: string;
  preserveHtmlStyles?: boolean;
  assets: Asset[];
  hash: string;
  revisionHash?: string;
  createdAt: string;
  warnings: string[];
  githubPath: string;
}
export interface Binding {
  articleId: string;
  channel: Channel;
  target: string;
  remoteId: string;
  remotePath?: string;
  remoteSha?: string;
  hash: string;
  revisionHash?: string;
  at: string;
  url: string;
}
export interface PublishTask {
  id: string;
  batchId: string;
  channel: Channel;
  target: string;
  snapshot: Snapshot;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  progress: string;
  error?: string;
  remoteId?: string;
  url?: string;
  deviceId: string;
  binding?: Binding;
}
export interface MediaCache {
  images: Record<string, string>;
  covers: Record<string, string>;
}
export interface RemoteVerification {
  matches: boolean;
  message: string;
  checks: Record<string, boolean>;
  differences?: { label: string; expected: string; actual: string }[];
  html?: string;
}
export interface PublishState {
  tasks: PublishTask[];
  bindings: Binding[];
  mediaCache?: Record<string, MediaCache>;
}
export interface RequestData {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}
export interface ResponseData {
  status: number;
  json: unknown;
  text: string;
}
export interface Transport {
  request(data: RequestData): Promise<ResponseData>;
}
export interface AssetReader {
  readAsset(
    link: string,
    sourcePath: string,
  ): Promise<{ path: string; bytes: Uint8Array } | null>;
  resolveNote(link: string, sourcePath: string): string | null;
}
export interface WorkbenchHost {
  getArticles(): Article[];
  subscribe(cb: () => void): () => void;
  update(
    id: string,
    changes: Partial<
      Pick<Article, "stage" | "order" | "plannedAt" | "archivedAt" | "owner">
    >,
  ): Promise<void>;
  move(id: string, stage: Stage, index: number): Promise<void>;
  undo(): Promise<void>;
  create(stage: Stage, title: string): Promise<void>;
  open(id: string): Promise<void>;
  ensureIds(ids: string[]): Promise<void>;
  repairIds(): Promise<void>;
  getConfig(): Config;
  configure(): void;
  assets: AssetReader;
  transport: Transport;
  getSecret(key: string): Promise<string>;
  getPublishState(): PublishState;
  savePublishState(state: PublishState): Promise<void>;
  getDeviceId(): string;
  assetUrl(file: string): string;
  notify(message: string): void;
  vaultName: string;
}
export function targetKey(channel: Channel, c: Config): string {
  return channel === "github"
    ? `${c.github.owner}/${c.github.repo}@${c.github.branch}`
    : c.wechat.appId;
}
export function success(status: TaskStatus): boolean {
  return status === "draft_synced" || status === "repository_synced";
}
export function plainError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
export class DeliveryUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryUnknown";
  }
}
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export function normalizeDir(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (
    p
      .split("/")
      .some((x) => x === ".." || x === "." || x === ".obsidian" || x === ".git")
  )
    throw new Error("目录包含不允许的路径");
  return p;
}
export function wordCount(body: string): number {
  return (
    (body.match(/[\p{Script=Han}]/gu)?.length ?? 0) +
    (body.replace(/[\p{Script=Han}]/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length ??
      0)
  );
}

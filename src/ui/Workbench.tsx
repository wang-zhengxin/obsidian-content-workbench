import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import assets from "../asset-map.json";
import {
  STAGES,
  plainError,
  success,
  targetKey,
  type Article,
  type Channel,
  type Snapshot,
  type Stage,
  type WorkbenchHost,
  type PublishTask,
} from "../domain";
import { prepareSnapshot, previewHtml, inlineWechatStyles } from "../exporter";
import type { Scope } from "obsidian";
import { Publisher } from "../publisher";
import { GithubConnector } from "../connectors/github";
import { WechatConnector } from "../connectors/wechat";
import { BoardDrag } from "./dnd";
type IconName = keyof typeof assets;
function Icon({
  name,
  host,
  size = 15,
}: {
  name: IconName;
  host: WorkbenchHost;
  size?: number;
}) {
  return (
    <span className="cw-icon" style={{ width: size, height: size }}>
      <img
        src={host.assetUrl(assets[name])}
        width={size}
        height={size}
        alt=""
      />
    </span>
  );
}
function dateLabel(date: string | number) {
  if (!date) return "未排期";
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? "日期无效"
    : d.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}
function changedLabel(a: Article) {
  const delta = Date.now() - a.modified;
  if (delta < 3600000)
    return Math.max(1, Math.floor(delta / 60000)) + " 分钟前";
  if (delta < 86400000)
    return (
      "今天 " +
      new Date(a.modified).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  return dateLabel(a.modified);
}
const tagColor = (tag: string) =>
  /知识|效率/.test(tag)
    ? "green"
    : /产品|设计|教程/.test(tag)
      ? "blue"
      : /开发|运营/.test(tag)
        ? "gold"
        : /AI|人工/.test(tag)
          ? "purple"
          : "gray";
export function Workbench({
  host,
  publisher,
  ownerWindow,
  keyboardScope,
}: {
  host: WorkbenchHost;
  publisher: Publisher;
  ownerWindow?: Window;
  keyboardScope?: Pick<Scope, "register" | "unregister">;
}) {
  const [revision, refresh] = useState(0);
  useEffect(() => host.subscribe(() => refresh((n) => n + 1)), [host]);
  const all = host.getArticles(),
    config = host.getConfig(),
    state = host.getPublishState();
  const [nav, setNav] = useState("board"),
    [view, setView] = useState<"board" | "list" | "calendar">("board");
  const [search, setSearch] = useState(""),
    [mine, setMine] = useState(false),
    [tag, setTag] = useState(""),
    [folder, setFolder] = useState(""),
    [sort, setSort] = useState("manual");
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [channels, setChannels] = useState<Set<Channel>>(
      new Set(["wechat", "github"]),
    );
  useEffect(() => {
    const ids = new Set(all.map((article) => article.id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [all]);
  const [modal, setModal] = useState<ReactNode>(null),
    [busy, setBusy] = useState(false),
    [collapsePublish, setCollapsePublish] = useState(false),
    [connected, setConnected] = useState<Partial<Record<Channel, boolean>>>({});
  const [checkingChannel, setCheckingChannel] = useState<Channel | null>(null),
    [connectionErrors, setConnectionErrors] = useState<
      Partial<Record<Channel, string>>
    >({});
  const connectionConfig = JSON.stringify([config.github, config.wechat]);
  useEffect(() => {
    setConnected({});
    setConnectionErrors({});
  }, [connectionConfig]);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null),
    [previewIndex, setPreviewIndex] = useState(0),
    [previewChannel, setPreviewChannel] = useState<Channel>("wechat"),
    [calendarMonth, setCalendarMonth] = useState(new Date());
  const [syncState, setSyncState] = useState<
    Record<string, "synced" | "dirty" | "unavailable">
  >({});
  const [newCardIds, setNewCardIds] = useState<string[]>([]);
  const [previewConfig, setPreviewConfig] = useState("");
  const root = useRef<HTMLDivElement>(null),
    board = useRef<HTMLDivElement>(null),
    searchEl = useRef<HTMLInputElement>(null);
  const dragController = useRef<BoardDrag | null>(null);
  useEffect(() => {
    const win = root.current?.ownerDocument.defaultView;
    if (!win || !newCardIds.length) return;
    const timer = win.setTimeout(() => setNewCardIds([]), 240);
    return () => win.clearTimeout(timer);
  }, [newCardIds, ownerWindow]);
  const live = all.filter((a) => !a.archivedAt);
  const tagged = [...new Set(live.flatMap((a) => a.tags))];
  const folders = [
    ...new Set(live.map((a) => a.path.split("/").slice(0, -1).join("/"))),
  ];
  const filtered = useMemo(
    () =>
      all
        .filter(
          (a) =>
            (nav === "trash" ? !!a.archivedAt : !a.archivedAt) &&
            (nav !== "inbox" || a.stage === "inbox") &&
            (nav !== "board" || a.stage !== "inbox") &&
            (!mine || a.owner === config.author) &&
            (!tag || a.tags.includes(tag)) &&
            (!folder || a.path.startsWith(folder + "/")) &&
            (!search ||
              [a.title, a.summary, a.markdown, ...a.tags]
                .join(" ")
                .toLowerCase()
                .includes(search.toLowerCase())),
        )
        .sort((a, b) =>
          sort === "updated"
            ? b.modified - a.modified
            : sort === "title"
              ? a.title.localeCompare(b.title, "zh-CN")
              : a.order - b.order,
        ),
    [all, nav, mine, tag, folder, search, sort, config.author],
  );
  const act = (fn: () => Promise<unknown>) => {
    void fn().catch((e) => host.notify(plainError(e)));
  };
  useEffect(() => {
    if (!board.current || view !== "board" || nav === "history") return;
    const dnd = new BoardDrag(
      board.current,
      () => sort === "manual",
      async (id, stage, index) => {
        const target = host
          .getArticles()
          .filter((a) => a.stage === stage && !a.archivedAt && a.id !== id)
          .sort((a, b) => a.order - b.order);
        const visible = [
          ...board.current!.querySelectorAll<HTMLElement>(
            `[data-stage="${stage}"] [data-card-id]`,
          ),
        ]
          .map((e) => e.dataset.cardId!)
          .filter((x) => x !== id);
        const position =
          sort !== "manual"
            ? target.length
            : visible[index]
              ? target.findIndex((a) => a.id === visible[index])
              : visible.length
                ? target.findIndex((a) => a.id === visible.at(-1)) + 1
                : target.length;
        await host.move(id, stage, Math.max(0, position));
        const win = root.current?.ownerDocument.defaultView;
        if (
          win &&
          !config.reduceMotion &&
          !win.matchMedia("(prefers-reduced-motion: reduce)").matches
        )
          win.requestAnimationFrame(() => {
            const el = [
              ...board.current!.querySelectorAll<HTMLElement>("[data-card-id]"),
            ].find((e) => e.dataset.cardId === id);
            el?.animate(
              [
                { transform: "translateY(-6px)", borderColor: "#A78BFA" },
                {
                  transform: "translateY(0)",
                  borderColor: selected.has(id) ? "#8B5CF6" : "#303038",
                },
              ],
              { duration: 240, easing: "cubic-bezier(.2,0,0,1)" },
            );
          });
      },
      (e) => host.notify(plainError(e)),
    );
    dragController.current = dnd;
    return () => {
      if (dragController.current === dnd) dragController.current = null;
      dnd.destroy();
    };
  }, [
    host,
    sort,
    view,
    nav,
    filtered.length,
    config.reduceMotion,
    ownerWindow,
  ]);
  useEffect(() => {
    let cancelled = false;
    const articles = host
      .getArticles()
      .filter((a) =>
        state.bindings.some(
          (b) =>
            b.articleId === a.id && b.target === targetKey(b.channel, config),
        ),
      );
    void Promise.all(
      articles.map(async (a) => {
        try {
          const snapshot = await prepareSnapshot(
            a,
            config,
            host.assets,
            [a],
            state.bindings,
          );
          return state.bindings
            .filter(
              (b) =>
                b.articleId === a.id &&
                b.target === targetKey(b.channel, config),
            )
            .map(
              (b) =>
                [
                  a.id + ":" + b.channel,
                  b.revisionHash === snapshot.revisionHash ? "synced" : "dirty",
                ] as const,
            );
        } catch {
          return [
            ["" + a.id + ":wechat", "unavailable"],
            [a.id + ":github", "unavailable"],
          ] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled)
        setSyncState(
          Object.fromEntries(entries.flat()) as Record<
            string,
            "synced" | "dirty" | "unavailable"
          >,
        );
    });
    return () => {
      cancelled = true;
    };
  }, [host, revision]);
  useEffect(
    () => setConnected({}),
    [
      config.github.owner,
      config.github.repo,
      config.github.branch,
      config.wechat.appId,
      config.wechat.proxyUrl,
    ],
  );
  const configure = () => {
    setConnected({});
    host.configure();
  };
  useEffect(() => {
    const el = root.current;
    const win = ownerWindow ?? el?.ownerDocument.defaultView;
    if (!win) return;
    const key = (e: KeyboardEvent) => {
      if ((modal || snapshots) && e.key !== "Escape") return;
      const active = el?.ownerDocument.activeElement;
      if (
        !keyboardScope &&
        active &&
        active !== el?.ownerDocument.body &&
        !el?.contains(active)
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchEl.current?.focus();
        return false;
      }
      if (e.key === "Escape" && !busy) {
        dragController.current?.cancelDrag();
        setModal(null);
        setSnapshots(null);
        return false;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "z" &&
        !(e.target as Element).closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      ) {
        e.preventDefault();
        act(() => host.undo());
        return false;
      }
    };
    if (keyboardScope) {
      const handlers = [
        keyboardScope.register(["Mod"], "K", key),
        keyboardScope.register(["Mod"], "Z", key),
        keyboardScope.register([], "Escape", key),
      ];
      return () =>
        handlers.forEach((handler) => keyboardScope.unregister(handler));
    }
    win.addEventListener("keydown", key);
    return () => win.removeEventListener("keydown", key);
  }, [host, busy, !!modal, !!snapshots, ownerWindow, keyboardScope]);
  useEffect(() => {
    if (!modal && !snapshots) return;
    const dialog = root.current?.querySelector<HTMLElement>(".cw-modal");
    if (!dialog) return;
    const doc = dialog.ownerDocument,
      previous = doc.activeElement as HTMLElement;
    const controls = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
        ),
      ].filter((e) => e.offsetParent !== null);
    controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = controls();
      if (!items.length) return;
      const current = items.indexOf(doc.activeElement as HTMLElement);
      if (event.shiftKey && current <= 0) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (
        !event.shiftKey &&
        (current === items.length - 1 || current < 0)
      ) {
        event.preventDefault();
        items[0].focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [!!modal, !!snapshots]);
  const choose = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const icon = (name: IconName, size = 15) => (
    <Icon host={host} name={name} size={size} />
  );
  const create = (stage: Stage = nav === "inbox" ? "inbox" : "writing") =>
    setModal(
      <Prompt
        title="新建文档"
        label="文章标题"
        onCancel={() => setModal(null)}
        onSave={async (title) => {
          const previousIds = new Set(host.getArticles().map((a) => a.id));
          await host.create(stage, title);
          const win = root.current?.ownerDocument.defaultView;
          if (
            win &&
            !config.reduceMotion &&
            !win.matchMedia("(prefers-reduced-motion: reduce)").matches
          )
            setNewCardIds(
              host
                .getArticles()
                .filter((a) => !previousIds.has(a.id))
                .map((a) => a.id),
            );
          setModal(null);
        }}
      />,
    );
  const schedule = (a: Article) =>
    setModal(
      <Prompt
        title="安排创作日期"
        label="计划日期（仅排期，到期不会自动发布）"
        type="datetime-local"
        initial={a.plannedAt ? a.plannedAt.slice(0, 16) : ""}
        onCancel={() => setModal(null)}
        onSave={async (value) => {
          await host.update(a.id, { plannedAt: value, stage: "planned" });
          setModal(null);
        }}
      />,
    );
  const menu = (a: Article) =>
    setModal(
      <div className="cw-menu-dialog">
        <h2>{a.title}</h2>
        <p>{a.path}</p>
        <div className="cw-stage-options">
          {STAGES.map((s) => (
            <button
              key={s.id}
              onClick={() =>
                act(async () => {
                  await host.update(a.id, { stage: s.id });
                  setModal(null);
                })
              }
            >
              <span style={{ background: s.color }} />
              {s.label}
            </button>
          ))}
        </div>
        <button onClick={() => schedule(a)}>设置排期</button>
        <button
          onClick={() => {
            choose(a.id);
            setModal(null);
          }}
        >
          {selected.has(a.id) ? "取消选择" : "选择用于交付"}
        </button>
        <button
          onClick={() =>
            act(async () => {
              await host.update(a.id, {
                archivedAt: a.archivedAt ? "" : new Date().toISOString(),
              });
              setModal(null);
            })
          }
        >
          {a.archivedAt ? "恢复文章" : "移入回收站"}
        </button>
        <button onClick={() => setModal(null)}>关闭</button>
      </div>,
    );
  async function check(channel: Channel) {
    setBusy(true);
    setCheckingChannel(channel);
    setConnectionErrors((v) => ({ ...v, [channel]: "" }));
    try {
      if (channel === "github")
        await new GithubConnector(
          host.transport,
          config.github,
          await host.getSecret(config.github.secretKey),
        ).check();
      else
        await new WechatConnector(
          host.transport,
          config.wechat,
          await host.getSecret(config.wechat.secretKey),
        ).check();
      setConnected((v) => ({ ...v, [channel]: true }));
      host.notify(
        channel === "wechat"
          ? "公众号草稿接口连接成功"
          : "GitHub 目标分支连接成功",
      );
    } catch (e) {
      setConnected((v) => ({ ...v, [channel]: false }));
      const error = plainError(e);
      setConnectionErrors((v) => ({ ...v, [channel]: error }));
      host.notify(error);
    } finally {
      setBusy(false);
      setCheckingChannel(null);
    }
  }
  async function prepare() {
    setBusy(true);
    try {
      await host.ensureIds([...selected]);
      const articles = host
        .getArticles()
        .filter((a) => selected.has(a.id) && !a.archivedAt);
      if (!articles.length) throw new Error("请先勾选要交付的文章");
      if (!channels.size) throw new Error("请选择平台");
      const docs = await Promise.all(
        articles.map((a) =>
          prepareSnapshot(a, config, host.assets, articles, state.bindings),
        ),
      );
      setPreviewConfig(
        JSON.stringify([host.getConfig(), [...channels].sort()]),
      );
      setPreviewChannel(channels.has("wechat") ? "wechat" : "github");
      setSnapshots(docs);
      setPreviewIndex(0);
    } catch (e) {
      host.notify(plainError(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!snapshots) return;
    if (
      previewConfig !== JSON.stringify([host.getConfig(), [...channels].sort()])
    )
      throw new Error("平台或工作台配置发生变化，请重新预览");
    setBusy(true);
    try {
      const current = host
        .getArticles()
        .filter((a) => selected.has(a.id) && !a.archivedAt);
      const fresh = await Promise.all(
        current.map((a) =>
          prepareSnapshot(a, config, host.assets, current, state.bindings),
        ),
      );
      if (
        fresh.length !== snapshots.length ||
        fresh.some(
          (s) =>
            snapshots.find((x) => x.articleId === s.articleId)?.hash !== s.hash,
        )
      )
        throw new Error("预览后文章或附件发生变化，请重新预览");
      await publisher.deliver(snapshots, [...channels]);
      setSnapshots(null);
      setNav("history");
      host.notify("交付结果已记录，请查看各平台状态");
    } catch (e) {
      host.notify(plainError(e));
    } finally {
      setBusy(false);
    }
  }
  const title =
    nav === "history"
      ? "交付历史"
      : nav === "trash"
        ? "回收站"
        : nav === "inbox"
          ? "收集箱"
          : nav === "calendar"
            ? "发布日历"
            : nav === "all"
              ? "全部文档"
              : "内容创作看板";
  const chosen = all.filter((a) => selected.has(a.id) && !a.archivedAt);
  const colorByOwner = (owner: string) =>
    owner === config.author
      ? "#8B5CF6"
      : owner.includes("周")
        ? "#4676B8"
        : "#B56F5A";
  function card(a: Article) {
    const binding = state.bindings.filter(
      (b) => b.articleId === a.id && b.target === targetKey(b.channel, config),
    );
    const dirty = binding.some(
      (b) => syncState[a.id + ":" + b.channel] !== "synced",
    );
    return (
      <article
        key={a.id}
        data-card-id={a.id}
        className={
          "cw-card " +
          (selected.has(a.id) ? "cw-card-selected " : "") +
          (newCardIds.includes(a.id) ? "cw-card-new" : "")
        }
        tabIndex={0}
        aria-label={a.title}
        onContextMenu={(e) => {
          e.preventDefault();
          menu(a);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") act(() => host.open(a.id));
          if (e.key === " ") {
            e.preventDefault();
            choose(a.id);
          }
          if (e.key === "F2") menu(a);
        }}
        onClick={(e) => {
          if (board.current?.dataset.suppressClick) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey) choose(a.id);
          else act(() => host.open(a.id));
        }}
      >
        <div className="cw-card-title">
          <h3>{a.title}</h3>
          <button
            className="cw-card-grip"
            title="文章操作"
            onClick={(e) => {
              e.stopPropagation();
              menu(a);
            }}
          >
            {icon("imgGripVertical", 13)}
          </button>
        </div>
        <p className="cw-summary">{a.summary}</p>
        <div className="cw-tags">
          {a.tags.slice(0, 4).map((t) => (
            <button
              className={"cw-tag " + tagColor(t)}
              key={t}
              onClick={(e) => {
                e.stopPropagation();
                setTag(t);
              }}
            >
              {t.replace(/^#/, "")}
            </button>
          ))}
        </div>
        <div className="cw-meta">
          <div className="cw-owner">
            <span
              className="cw-avatar"
              style={{ background: colorByOwner(a.owner) }}
            >
              {a.owner.slice(0, 1)}
            </span>
            <span className="cw-mono">{a.wordCount.toLocaleString()} 字</span>
          </div>
          <span className="cw-time">
            {icon(a.stage === "planned" ? "imgCalendarClock" : "imgClock3", 11)}
            {a.stage === "planned" ? dateLabel(a.plannedAt) : changedLabel(a)}
          </span>
        </div>
        <div className="cw-card-bottom">
          <label title="选择交付" onClick={(e) => e.stopPropagation()}>
            <input
              aria-label={"选择 " + a.title}
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={() => choose(a.id)}
            />
            <span>选择</span>
          </label>
          {a.duplicateId ? (
            <span className="cw-error">ID 重复</span>
          ) : binding.length > 0 ? (
            <span
              className={dirty ? "cw-warning" : ""}
              title={binding
                .map(
                  (b) =>
                    (b.channel === "github" ? "GitHub" : "微信草稿") +
                    "：" +
                    (syncState[a.id + ":" + b.channel] === "synced"
                      ? "当前稿件已同步"
                      : "稿件变更或附件需检查"),
                )
                .join(" / ")}
            >
              {dirty ? "有未同步修改" : "已同步 " + binding.length + " 个渠道"}
            </span>
          ) : null}
        </div>
      </article>
    );
  }
  const navItem = (id: string, name: string, img: IconName, count?: number) => (
    <button
      aria-label={name}
      title={name}
      className={"cw-nav-item " + (nav === id ? "active" : "")}
      onClick={() => {
        setNav(id);
        if (id === "calendar") setView("calendar");
        else if (id === "board") setView("board");
      }}
    >
      {icon(img)}
      <span>{name}</span>
      {count !== undefined && <b>{count.toString().padStart(2, "0")}</b>}
    </button>
  );
  const platformCards = [
    {
      id: "wechat",
      name: "微信公众号",
      letter: "微",
      color: "#2AAF66",
      desc: "草稿箱",
    },
    {
      id: "zhihu",
      name: "知乎",
      letter: "知",
      color: "#2F7DF6",
      desc: "后续接入",
    },
    {
      id: "sspai",
      name: "少数派",
      letter: "少",
      color: "#D84A4A",
      desc: "后续接入",
    },
    {
      id: "juejin",
      name: "掘金",
      letter: "掘",
      color: "#4185F4",
      desc: "后续接入",
    },
    {
      id: "jike",
      name: "即刻",
      letter: "即",
      color: "#F3C63D",
      desc: "后续接入",
    },
    {
      id: "github",
      name: "GitHub 文档",
      letter: "G",
      color: "#8B5CF6",
      desc: config.github.repo
        ? config.github.owner + "/" + config.github.repo
        : "Markdown 与附件",
    },
  ];
  function history() {
    return (
      <div className="cw-history">
        <div className="cw-history-intro">
          公众号草稿与 GitHub 仓库同步分别记录。结果待核对的任务会阻止再次交付。
        </div>
        {state.tasks.length === 0 ? (
          <div className="cw-empty">暂无交付记录</div>
        ) : (
          [...state.tasks].reverse().map((t) => (
            <div className="cw-history-row" key={t.id}>
              <div>
                <strong>{t.snapshot.title}</strong>
                <small>
                  {t.channel === "wechat"
                    ? "微信公众号草稿"
                    : "GitHub Markdown"}{" "}
                  · {dateLabel(t.createdAt)}
                </small>
              </div>
              <div
                className={
                  success(t.status)
                    ? "cw-success"
                    : t.status === "failed" || t.status === "unknown"
                      ? "cw-error"
                      : ""
                }
              >
                {t.progress}
                <small>{t.error}</small>
              </div>
              <div className="cw-history-actions">
                {success(t.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const result = await publisher.verify(t.id);
                        setModal(
                          <>
                            <div className="cw-preview-header">
                              <h2>远端内容核对</h2>
                              <button onClick={() => setModal(null)}>
                                关闭
                              </button>
                            </div>
                            <div className="cw-preview-detail cw-verification-details">
                              <p
                                className={
                                  result.matches ? "cw-success" : "cw-error"
                                }
                              >
                                {result.message}
                              </p>
                              {Object.entries(result.checks).map(
                                ([label, match]) => (
                                  <p key={label}>
                                    {match ? "✓" : "✗"} {label}
                                  </p>
                                ),
                              )}
                              {result.differences?.map((difference) => (
                                <details key={difference.label}>
                                  <summary>{difference.label}差异</summary>
                                  <p>本次交付</p>
                                  <pre>{difference.expected}</pre>
                                  <p>远端内容</p>
                                  <pre>{difference.actual}</pre>
                                </details>
                              ))}
                            </div>
                            {result.html && (
                              <div className="cw-preview-body">
                                <article
                                  className="cw-article-preview"
                                  dangerouslySetInnerHTML={{
                                    __html: DOMPurify.sanitize(result.html),
                                  }}
                                />
                              </div>
                            )}
                            {result.html && (
                              <footer className="cw-preview-footer">
                                远端正文预览，最终显示以微信客户端为准。
                              </footer>
                            )}
                          </>,
                        );
                      })
                    }
                  >
                    核对远端
                  </button>
                )}
                {t.url && (
                  <a href={t.url} target="_blank" rel="noreferrer">
                    查看结果
                  </a>
                )}
                {t.remoteId && (
                  <span className="cw-mono" title={t.remoteId}>
                    {t.remoteId.slice(0, 12)}
                  </span>
                )}
                {t.status === "unknown" && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          host.notify(await publisher.reconcile(t.id));
                        })
                      }
                    >
                      核对结果
                    </button>
                    {t.channel === "wechat" && (
                      <button
                        onClick={() =>
                          setModal(
                            <Prompt
                              title="关联已核对的草稿"
                              label="公众号后台草稿 media_id"
                              onCancel={() => setModal(null)}
                              onSave={async (v) => {
                                await publisher.resolveWechat(t.id, v);
                                setModal(null);
                              }}
                            />,
                          )
                        }
                      >
                        关联草稿
                      </button>
                    )}
                    <button
                      onClick={() =>
                        setModal(
                          <Confirm
                            text="已在目标平台检查，确认这次交付没有完成？确认后可以重新预览并交付。"
                            onCancel={() => setModal(null)}
                            onConfirm={async () => {
                              await publisher.confirmNotDelivered(t.id);
                              setModal(null);
                            }}
                          />,
                        )
                      }
                    >
                      确认未交付
                    </button>
                  </>
                )}
                {t.status === "failed" && (
                  <button
                    onClick={() => {
                      setSelected(new Set([t.snapshot.articleId]));
                      setChannels(new Set([t.channel]));
                      setNav("board");
                      host.notify("已选择失败的文章与渠道，请重新预览");
                    }}
                  >
                    重新预览
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    );
  }
  function calendar() {
    const year = calendarMonth.getFullYear(),
      month = calendarMonth.getMonth(),
      first = new Date(year, month, 1),
      start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
    return (
      <div className="cw-calendar">
        <div className="cw-calendar-head">
          <button
            onClick={() => setCalendarMonth(new Date(year, month - 1, 1))}
          >
            ‹
          </button>
          <h2>
            {year} 年 {month + 1} 月
          </h2>
          <button
            onClick={() => setCalendarMonth(new Date(year, month + 1, 1))}
          >
            ›
          </button>
          <span>计划日期 · 到期不会自动发布</span>
        </div>
        <div className="cw-calendar-grid">
          {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
            <b key={d}>周{d}</b>
          ))}
          {Array.from({ length: 42 }, (_, i) => {
            const day = new Date(start);
            day.setDate(day.getDate() + i);
            const key =
              day.getFullYear() +
              "-" +
              String(day.getMonth() + 1).padStart(2, "0") +
              "-" +
              String(day.getDate()).padStart(2, "0");
            return (
              <div
                key={key}
                className={
                  "cw-day " + (day.getMonth() !== month ? "muted" : "")
                }
              >
                <span>{day.getDate()}</span>
                {filtered
                  .filter((a) => a.plannedAt.slice(0, 10) === key)
                  .map((a) => (
                    <button key={a.id} onClick={() => schedule(a)}>
                      {a.title}
                      <small>{a.plannedAt.slice(11, 16)}</small>
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div
      className={"cw-root" + (config.reduceMotion ? " cw-reduced-motion" : "")}
      ref={root}
      role="region"
      aria-label={
        config.reduceMotion
          ? "内容创作工作台，减少动态效果已开启"
          : "内容创作工作台"
      }
    >
      <aside className="cw-sidebar">
        <div className="cw-brand">
          <span className="cw-brand-gem">{icon("imgGem", 17)}</span>
          <div>
            <strong>{host.vaultName}</strong>
            <small>
              {busy ? "交付处理中" : "本地内容 · " + live.length + " 篇"}
            </small>
          </div>
          {icon("imgChevronsUpDown", 14)}
        </div>
        <nav>
          {navItem(
            "board",
            "内容看板",
            "imgLayoutDashboard",
            live.filter((a) => a.stage !== "inbox").length,
          )}
          {navItem("all", "全部文档", "imgFileText", live.length)}
          {navItem(
            "calendar",
            "发布日历",
            "imgCalendarDays",
            live.filter((a) => a.plannedAt).length,
          )}
          {navItem(
            "inbox",
            "收集箱",
            "imgInbox",
            live.filter((a) => a.stage === "inbox").length,
          )}
          {navItem(
            "trash",
            "回收站",
            "imgTrash2",
            all.filter((a) => a.archivedAt).length,
          )}
        </nav>
        <section className="cw-sidebar-section">
          <h4>知识库</h4>
          {folders.slice(0, 5).map((f, i) => (
            <button
              key={f}
              className={"cw-nav-item " + (folder === f ? "active" : "")}
              onClick={() => setFolder(folder === f ? "" : f)}
            >
              {icon(i === 0 ? "imgFolderOpen" : "imgFolder")}
              <span>{f.split("/").at(-1)}</span>
              <b>{live.filter((a) => a.path.startsWith(f + "/")).length}</b>
            </button>
          ))}
        </section>
        <section className="cw-sidebar-section cw-sidebar-tags">
          <h4>常用标签</h4>
          {tagged.slice(0, 4).map((t) => (
            <button
              key={t}
              className={"cw-sidebar-tag " + (tag === t ? "active" : "")}
              onClick={() => setTag(tag === t ? "" : t)}
            >
              <span className={"cw-dot " + tagColor(t)} />
              <span>#{t.replace(/^#/, "")}</span>
              <b>{live.filter((a) => a.tags.includes(t)).length}</b>
            </button>
          ))}
        </section>
        <div
          className="cw-graph"
          title="图形为示意，数量来自当前内容笔记的双链"
        >
          <img
            className="cw-graph-lines"
            src={host.assetUrl(assets.img4)}
            width="180"
            height="78"
            alt="内容关联示意"
          />
          {[
            { name: "img5", x: 16, y: 56, size: 8 },
            { name: "img6", x: 56, y: 24, size: 11 },
            { name: "img7", x: 97, y: 51, size: 8 },
            { name: "img8", x: 134, y: 17, size: 7 },
            { name: "img9", x: 178, y: 44, size: 10 },
            { name: "img8", x: 66, y: 79, size: 7 },
            { name: "img8", x: 149, y: 77, size: 7 },
          ].map((n, i) => (
            <img
              key={i}
              src={host.assetUrl(assets[n.name as IconName])}
              style={{ left: n.x, top: n.y }}
              width={n.size}
              height={n.size}
              alt=""
            />
          ))}
          <footer>
            <span>当前内容关联</span>
            <b>{live.reduce((n, a) => n + a.links.length, 0)} LINKS</b>
          </footer>
        </div>
        <div className="cw-sidebar-space" />
        <button
          className="cw-account"
          aria-label="工作台设置"
          title="工作台设置"
          onClick={configure}
        >
          <span className="cw-avatar">{config.author.slice(0, 1)}</span>
          <span>
            <strong>{config.author}</strong>
            <small>本地创作工作台</small>
          </span>
          {icon("imgSettings", 14)}
        </button>
      </aside>
      <main className="cw-main">
        <header className="cw-header">
          <div className="cw-heading-row">
            <div>
              <div className="cw-heading">
                <h1>{title}</h1>
                <span className="cw-workflow-badge">
                  {icon("imgZap", 10)}本地工作流
                </span>
              </div>
              <p>从灵感到多平台交付，让内容沿工作流持续前进</p>
            </div>
            <div className="cw-actions">
              <button
                className="cw-button"
                onClick={() => act(prepare)}
                disabled={busy}
              >
                {icon("imgSend")}批量交付
              </button>
              <button className="cw-button primary" onClick={() => create()}>
                {icon("imgPlus")}新建文档
              </button>
            </div>
          </div>
          <div className="cw-toolbar">
            <div className="cw-search">
              {icon("imgSearch")}
              <input
                ref={searchEl}
                placeholder="搜索标题、标签或正文…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>⌘ K</kbd>
            </div>
            <button
              className={"cw-button compact " + (mine ? "active" : "")}
              onClick={() => setMine(!mine)}
            >
              {icon("imgListFilter")}筛选
            </button>
            <div className="cw-sort-control">
              {icon("imgArrowUpDown")}
              <select
                className="cw-sort"
                aria-label="排序"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="manual">手动排序</option>
                <option value="updated">最近更新</option>
                <option value="title">标题排序</option>
              </select>
            </div>
            {mine && (
              <button className="cw-filter-chip" onClick={() => setMine(false)}>
                我负责的 ×
              </button>
            )}
            {tag && (
              <button className="cw-filter-chip" onClick={() => setTag("")}>
                #{tag} ×
              </button>
            )}
            {folder && (
              <button className="cw-filter-chip" onClick={() => setFolder("")}>
                {folder.split("/").at(-1)} ×
              </button>
            )}
            <div className="cw-view-switch">
              {(
                [
                  { id: "board", name: "imgColumns3", label: "看板" },
                  { id: "list", name: "imgList", label: "列表" },
                  { id: "calendar", name: "imgCalendar", label: "日历" },
                ] as const
              ).map((v) => (
                <button
                  aria-label={v.label}
                  title={v.label}
                  key={v.id}
                  className={view === v.id ? "active" : ""}
                  onClick={() => {
                    setView(v.id);
                    if (nav === "history") setNav("board");
                  }}
                >
                  {icon(v.name)}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="cw-body">
          <div className="cw-content cw-view-enter" key={nav + ":" + view}>
            <div className="cw-content-info">
              <span>
                {icon("imgMousePointer2", 12)}
                拖拽卡片切换创作阶段，点击文章继续写作
              </span>
              <span className="cw-mono">
                {filtered.length} DOCUMENTS ·{" "}
                {filtered.reduce((n, a) => n + a.wordCount, 0).toLocaleString()}{" "}
                WORDS
              </span>
            </div>
            {nav === "history" ? (
              history()
            ) : view === "calendar" ? (
              calendar()
            ) : view === "list" ||
              nav === "all" ||
              nav === "trash" ||
              nav === "inbox" ? (
              <div className="cw-list">
                <div className="cw-list-head">
                  <span>文档</span>
                  <span>阶段 / 负责人</span>
                  <span>计划日期</span>
                  <span>操作</span>
                </div>
                {filtered.map((a) => (
                  <div className="cw-list-row" key={a.id}>
                    <div>
                      <input
                        type="checkbox"
                        aria-label={"选择 " + a.title}
                        checked={selected.has(a.id)}
                        onChange={() => choose(a.id)}
                      />
                      <button onClick={() => act(() => host.open(a.id))}>
                        {a.title}
                      </button>
                      <small>{a.path}</small>
                    </div>
                    <span>
                      {STAGES.find((s) => s.id === a.stage)?.label ?? "收集箱"}{" "}
                      · {a.owner}
                    </span>
                    <button onClick={() => schedule(a)}>
                      {dateLabel(a.plannedAt)}
                    </button>
                    <button onClick={() => menu(a)}>•••</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cw-board" ref={board}>
                {STAGES.map((s) => (
                  <section data-stage={s.id} key={s.id} className="cw-column">
                    <div className="cw-column-head">
                      <div>
                        <span
                          className="cw-dot"
                          style={{ background: s.color }}
                        />
                        <strong>{s.label}</strong>
                        <b>{filtered.filter((a) => a.stage === s.id).length}</b>
                      </div>
                      <span>
                        {s.detail}
                        <button
                          title={"新建" + s.label + "文档"}
                          onClick={() => create(s.id)}
                        >
                          {icon("imgEllipsis", 14)}
                        </button>
                      </span>
                    </div>
                    <div className="cw-cards">
                      {filtered.filter((a) => a.stage === s.id).map(card)}
                      <button
                        className="cw-add-card"
                        onClick={() => create(s.id)}
                      >
                        {icon("imgPlus1", 12)}添加文档
                      </button>
                    </div>
                  </section>
                ))}
              </div>
            )}
            {!all.length && nav !== "history" && (
              <div className="cw-onboarding">
                <strong>开始你的内容创作流程</strong>
                <p>
                  当前内容目录：{config.contentFolder}
                  。创建第一篇文章，或在设置中选择已有文章目录。
                </p>
                <button className="cw-button primary" onClick={() => create()}>
                  新建文档
                </button>
                <button className="cw-button" onClick={configure}>
                  配置工作台
                </button>
              </div>
            )}
          </div>
          <section
            className={"cw-publish " + (collapsePublish ? "collapsed" : "")}
          >
            <div className="cw-publish-title">
              <div>
                <span className="cw-publish-icon">{icon("imgSend1", 17)}</span>
                <div>
                  <h2>发布到平台</h2>
                  <p>
                    {chosen.length
                      ? "为选中的 " + chosen.length + " 篇文档配置本次交付渠道"
                      : "勾选文章后预览并交付到目标平台"}
                  </p>
                </div>
              </div>
              <div>
                <button
                  className="cw-history-link"
                  onClick={() => setNav("history")}
                >
                  交付历史 {state.tasks.length || ""}
                </button>
                <span>已选择 {channels.size} / 2 个可用平台</span>
                <button
                  title="折叠 / 展开发布区"
                  onClick={() => setCollapsePublish(!collapsePublish)}
                >
                  {icon("imgSlidersHorizontal", 14)}
                </button>
              </div>
            </div>
            {!collapsePublish && (
              <>
                <div className="cw-platforms">
                  {platformCards.map((p) => {
                    const available = p.id === "wechat" || p.id === "github";
                    const channel = p.id as Channel;
                    const enabled = available && channels.has(channel);
                    return (
                      <div
                        key={p.id}
                        className={
                          "cw-platform " +
                          (enabled ? "selected" : "") +
                          (!available ? " unavailable" : "")
                        }
                      >
                        <label>
                          <span
                            className="cw-platform-letter"
                            style={{
                              background: p.color,
                              color: p.id === "jike" ? "#09090B" : "white",
                            }}
                          >
                            {p.letter}
                          </span>
                          <strong>{p.name}</strong>
                          <input
                            type="checkbox"
                            aria-label={"选择平台 " + p.name}
                            disabled={!available || busy}
                            checked={enabled}
                            onChange={() =>
                              setChannels((c) => {
                                const n = new Set(c);
                                n.has(channel)
                                  ? n.delete(channel)
                                  : n.add(channel);
                                return n;
                              })
                            }
                          />
                        </label>
                        <span
                          className={
                            "cw-platform-status " +
                            (connectionErrors[channel]
                              ? "cw-error"
                              : connected[channel]
                                ? "cw-success"
                                : "")
                          }
                        >
                          <i />
                          {available
                            ? checkingChannel === channel
                              ? "正在检查连接"
                              : connectionErrors[channel]
                                ? "连接失败"
                                : connected[channel]
                                  ? "连接已验证"
                                  : "待检查连接"
                            : "尚未接入"}
                        </span>
                        <small title={connectionErrors[channel] || p.desc}>
                          {connectionErrors[channel] || p.desc}
                        </small>
                        {available && (
                          <button
                            className="cw-connect"
                            disabled={busy}
                            onClick={() => act(() => check(channel))}
                          >
                            检查连接
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="cw-publish-controls">
                  <div className="cw-checks">
                    <span>
                      {icon("imgCircleCheck1", 13)}
                      {chosen.length
                        ? "已选 " + chosen.length + " 篇文章"
                        : "请先选择文章"}
                    </span>
                    <span>
                      {icon("imgTriangleAlert", 13)}公众号交付至草稿箱
                    </span>
                  </div>
                  <div className="cw-actions">
                    <button
                      className="cw-button"
                      disabled={!chosen.length || busy}
                      onClick={() => schedule(chosen[0])}
                    >
                      {icon("imgCalendarClock1")}设置排期
                    </button>
                    <button
                      className="cw-button primary"
                      disabled={!chosen.length || busy}
                      onClick={() => act(prepare)}
                    >
                      {icon("imgSend2")}
                      {busy ? "处理中…" : "预览并交付 " + chosen.length + " 篇"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </main>
      {(modal || snapshots) && (
        <div
          className="cw-modal-backdrop"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget && !busy) {
              setModal(null);
              setSnapshots(null);
            }
          }}
        >
          <div className="cw-modal" role="dialog" aria-modal="true">
            {modal ??
              (snapshots && (
                <>
                  <div className="cw-preview-header">
                    <h2>交付前预览</h2>
                    <button disabled={busy} onClick={() => setSnapshots(null)}>
                      关闭
                    </button>
                  </div>
                  <div className="cw-preview-tabs">
                    <select
                      value={previewIndex}
                      onChange={(e) => setPreviewIndex(Number(e.target.value))}
                    >
                      {snapshots.map((s, i) => (
                        <option key={s.articleId} value={i}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                    <button
                      className={previewChannel === "wechat" ? "active" : ""}
                      onClick={() => setPreviewChannel("wechat")}
                    >
                      微信排版
                    </button>
                    <button
                      className={previewChannel === "github" ? "active" : ""}
                      onClick={() => setPreviewChannel("github")}
                    >
                      GitHub Markdown
                    </button>
                  </div>
                  <div className="cw-preview-body">
                    {previewChannel === "wechat" ? (
                      <article className="cw-article-preview">
                        <h1>{snapshots[previewIndex].title}</h1>
                        <div
                          dangerouslySetInnerHTML={{
                            __html: inlineWechatStyles(
                              DOMPurify.sanitize(
                                previewHtml(snapshots[previewIndex]),
                              ),
                              snapshots[previewIndex].preserveHtmlStyles,
                            ),
                          }}
                        />
                      </article>
                    ) : (
                      <pre>{snapshots[previewIndex].markdown}</pre>
                    )}
                  </div>
                  <div className="cw-preview-detail">
                    <p>
                      GitHub：{snapshots[previewIndex].githubPath} ·{" "}
                      {
                        new Set(
                          snapshots[previewIndex].assets.map((a) => a.path),
                        ).size
                      }{" "}
                      个附件
                    </p>
                    <ul>
                      {[
                        ...new Set(
                          snapshots[previewIndex].assets.map((a) => a.path),
                        ),
                      ].map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                    {snapshots[previewIndex].warnings.map((w, i) => (
                      <p className="cw-warning" key={i}>
                        {w}
                      </p>
                    ))}
                    <p>
                      公众号保存草稿；GitHub
                      写入配置的仓库与分支。本次使用当前预览的内容快照。
                    </p>
                  </div>
                  <footer className="cw-preview-footer">
                    <span>
                      {[...channels]
                        .map((c) =>
                          c === "wechat" ? "微信公众号草稿" : "GitHub 文档",
                        )
                        .join(" + ")}
                    </span>
                    <button
                      className="cw-button primary"
                      disabled={busy}
                      onClick={() => act(send)}
                    >
                      {busy
                        ? "正在交付…"
                        : "确认交付 " + snapshots.length + " 篇"}
                    </button>
                  </footer>
                </>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
function Prompt({
  title,
  label,
  type = "text",
  initial = "",
  onCancel,
  onSave,
}: {
  title: string;
  label: string;
  type?: string;
  initial?: string;
  onCancel: () => void;
  onSave: (v: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="cw-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave(value)
          .catch((e) => setError(plainError(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{title}</h2>
      <label>
        {label}
        <input
          type={type}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      </label>
      {error && <p className="cw-error">{error}</p>}
      <footer>
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button className="cw-button primary" disabled={busy} type="submit">
          {busy ? "保存中…" : "保存"}
        </button>
      </footer>
    </form>
  );
}
function Confirm({
  text,
  onCancel,
  onConfirm,
}: {
  text: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <div className="cw-prompt">
      <p>{text}</p>
      {error && <p className="cw-error">{error}</p>}
      <footer>
        <button onClick={onCancel}>取消</button>
        <button
          className="cw-button primary"
          onClick={() => void onConfirm().catch((e) => setError(plainError(e)))}
        >
          确认
        </button>
      </footer>
    </div>
  );
}

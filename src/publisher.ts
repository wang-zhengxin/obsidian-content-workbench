import type {
  WorkbenchHost,
  Snapshot,
  Channel,
  PublishTask,
  PublishState,
  Binding,
  RemoteVerification,
} from "./domain";
import { DeliveryUnknown, plainError, success, targetKey } from "./domain";
import { GithubConnector } from "./connectors/github";
import { WechatConnector } from "./connectors/wechat";
export class Publisher {
  private running = false;
  constructor(private host: WorkbenchHost) {}
  private async store(state: PublishState): Promise<void> {
    await this.host.savePublishState(structuredClone(state));
  }
  private async stamp(
    state: PublishState,
    tasks: PublishTask[],
    status: PublishTask["status"],
    progress: string,
    error?: string,
  ): Promise<void> {
    for (const t of tasks) {
      t.status = status;
      t.progress = progress;
      t.error = error;
      t.updatedAt = new Date().toISOString();
    }
    await this.store(state);
  }
  async recover(): Promise<void> {
    const state = this.host.getPublishState();
    let changed = false;
    for (const t of state.tasks)
      if (
        t.deviceId === this.host.getDeviceId() &&
        ["sending", "preparing", "queued"].includes(t.status)
      ) {
        t.status = t.status === "sending" ? "unknown" : "failed";
        t.progress = t.status === "unknown" ? "结果待核对" : "执行已中断";
        t.error =
          t.status === "unknown"
            ? "执行中断，需核对远端结果"
            : "执行中断，可重新预览后交付";
        t.updatedAt = new Date().toISOString();
        changed = true;
      }
    if (changed) await this.store(state);
  }
  async deliver(snapshots: Snapshot[], channels: Channel[]): Promise<void> {
    if (this.running) throw new Error("正在交付，请等待本次任务完成");
    if (!snapshots.length || !channels.length)
      throw new Error("请选择文章和目标平台");
    const config = structuredClone(this.host.getConfig());
    if (
      config.executorDevice &&
      config.executorDevice !== this.host.getDeviceId()
    )
      throw new Error("当前设备仅查看任务，请在设置中指定本机执行");
    const state = this.host.getPublishState();
    for (const s of snapshots)
      for (const c of channels)
        if (
          state.tasks.some(
            (t) =>
              t.channel === c &&
              t.target === targetKey(c, config) &&
              t.snapshot.articleId === s.articleId &&
              ["queued", "sending", "preparing", "unknown"].includes(t.status),
          )
        )
          throw new Error("该文章有未完成或待核对任务，请先查看历史");
    this.running = true;
    const batchId = crypto.randomUUID(),
      now = new Date().toISOString();
    const tasks: PublishTask[] = snapshots.flatMap((snapshot) =>
      channels.map((channel) => ({
        id: crypto.randomUUID(),
        batchId,
        channel,
        target: targetKey(channel, config),
        snapshot: structuredClone(snapshot),
        status: "queued" as const,
        createdAt: now,
        updatedAt: now,
        progress: "等待交付",
        deviceId: this.host.getDeviceId(),
      })),
    );
    state.tasks.push(...tasks);
    try {
      await this.store(state);
      for (const channel of channels) {
        const channelTasks = tasks.filter((t) => t.channel === channel);
        await this.stamp(state, channelTasks, "preparing", "检查平台连接");
        try {
          const cfg = channel === "github" ? config.github : config.wechat;
          const token = await this.host.getSecret(cfg.secretKey);
          const bindings = state.bindings.filter(
            (b) =>
              b.channel === channel && b.target === targetKey(channel, config),
          );
          if (channel === "github") {
            const api = new GithubConnector(
              this.host.transport,
              config.github,
              token,
            );
            await api.check();
            await this.stamp(
              state,
              channelTasks,
              "sending",
              "提交 Markdown 与附件",
            );
            const results = await api.push(snapshots, bindings, (p) => {
              for (const t of channelTasks) t.progress = p;
              void this.store(state).catch(() => {});
            });
            for (const result of results) {
              const t = channelTasks.find(
                (t) => t.snapshot.articleId === result.snapshot.articleId,
              )!;
              t.remoteId = result.commit;
              t.url = result.url;
              this.bind(state, {
                articleId: t.snapshot.articleId,
                channel,
                target: t.target,
                remoteId: result.commit,
                remotePath: result.snapshot.githubPath,
                remoteSha: result.remoteSha,
                hash: t.snapshot.hash,
                revisionHash: t.snapshot.revisionHash,
                at: new Date().toISOString(),
                url: result.url,
              });
            }
            await this.stamp(
              state,
              channelTasks,
              "repository_synced",
              results.every((r) => r.unchanged)
                ? "内容无变化，仓库已同步"
                : "仓库已同步",
            );
          } else {
            const api = new WechatConnector(
              this.host.transport,
              config.wechat,
              token,
              state.mediaCache?.[config.wechat.appId],
              async (cache) => {
                state.mediaCache ??= {};
                state.mediaCache[config.wechat.appId] = cache;
                await this.store(state);
              },
            );
            await api.check();
            for (const t of channelTasks) {
              try {
                await this.stamp(state, [t], "sending", "同步草稿");
                const result = await api.sync(
                  t.snapshot,
                  bindings.find((b) => b.articleId === t.snapshot.articleId),
                  (p) => {
                    t.progress = p;
                    void this.store(state).catch(() => {});
                  },
                );
                t.remoteId = result.remoteId;
                t.url = result.url;
                this.bind(state, {
                  articleId: t.snapshot.articleId,
                  channel,
                  target: t.target,
                  remoteId: result.remoteId,
                  hash: t.snapshot.hash,
                  revisionHash: t.snapshot.revisionHash,
                  at: new Date().toISOString(),
                  url: result.url,
                });
                await this.stamp(state, [t], "draft_synced", "草稿已同步");
              } catch (e) {
                await this.stamp(
                  state,
                  [t],
                  e instanceof DeliveryUnknown ? "unknown" : "failed",
                  e instanceof DeliveryUnknown ? "结果待核对" : "同步失败",
                  plainError(e),
                );
              }
            }
          }
        } catch (e) {
          const pending = channelTasks.filter(
            (t) => !success(t.status) && t.status !== "unknown",
          );
          await this.stamp(
            state,
            pending,
            e instanceof DeliveryUnknown ? "unknown" : "failed",
            "交付未完成",
            plainError(e),
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
  private bind(state: PublishState, binding: Binding): void {
    state.bindings = state.bindings.filter(
      (b) =>
        !(
          b.articleId === binding.articleId &&
          b.channel === binding.channel &&
          b.target === binding.target
        ),
    );
    state.bindings.push(binding);
    const task = [...state.tasks]
      .reverse()
      .find(
        (t) =>
          t.snapshot.articleId === binding.articleId &&
          t.channel === binding.channel &&
          t.target === binding.target,
      );
    if (task) task.binding = structuredClone(binding);
  }
  async verify(taskId: string): Promise<RemoteVerification> {
    if (this.running) throw new Error("请等待交付结束");
    const state = this.host.getPublishState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !success(task.status) || !task.remoteId)
      throw new Error("仅能核对已有成功交付结果的任务");
    const config = structuredClone(this.host.getConfig());
    if (task.target !== targetKey(task.channel, config))
      throw new Error("当前平台配置与原任务目标不同，请先恢复原配置");
    if (task.channel === "github") {
      const api = new GithubConnector(
        this.host.transport,
        config.github,
        await this.host.getSecret(config.github.secretKey),
      );
      const result = await api.reconcile(task.snapshot);
      return {
        matches: !!result,
        message: result
          ? "远端 Markdown 和全部附件与本次交付内容一致"
          : "远端内容与此交付版本不同，未修改仓库或关联记录",
        checks: { "Markdown 和全部附件": !!result },
      };
    }
    const api = new WechatConnector(
      this.host.transport,
      config.wechat,
      await this.host.getSecret(config.wechat.secretKey),
      state.mediaCache?.[config.wechat.appId],
    );
    return api.verify(task.snapshot, task.remoteId);
  }
  async reconcile(taskId: string): Promise<string> {
    if (this.running) throw new Error("请等待交付结束");
    const state = this.host.getPublishState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("找不到任务");
    const config = this.host.getConfig();
    if (task.target !== targetKey(task.channel, config))
      throw new Error("当前平台配置与原任务目标不同，请先恢复原配置");
    if (task.channel === "github") {
      const api = new GithubConnector(
        this.host.transport,
        config.github,
        await this.host.getSecret(config.github.secretKey),
      );
      const result = await api.reconcile(task.snapshot);
      if (!result) return "远端内容尚未匹配，保留待核对状态";
      task.remoteId = result.commit;
      task.url = result.url;
      this.bind(state, {
        articleId: task.snapshot.articleId,
        channel: "github",
        target: task.target,
        remoteId: result.commit,
        remotePath: task.snapshot.githubPath,
        remoteSha: result.remoteSha,
        hash: task.snapshot.hash,
        revisionHash: task.snapshot.revisionHash,
        at: new Date().toISOString(),
        url: result.url,
      });
      await this.stamp(state, [task], "repository_synced", "远端结果已核对");
      return "已确认仓库同步成功";
    }
    const api = new WechatConnector(
      this.host.transport,
      config.wechat,
      await this.host.getSecret(config.wechat.secretKey),
    );
    const list = await api.candidates(task.snapshot, task.createdAt);
    return list.length
      ? `发现 ${list.length} 个同标题草稿：${list.map((x) => x.remoteId).join("、")}。请在公众号后台核对后关联草稿 ID。`
      : "未找到近期同标题草稿，请核对公众号后台再决定重试";
  }
  async resolveWechat(taskId: string, remoteId: string): Promise<void> {
    const state = this.host.getPublishState(),
      task = state.tasks.find((t) => t.id === taskId);
    if (!task || task.channel !== "wechat" || !remoteId.trim())
      throw new Error("请输入已核对的微信草稿 ID");
    task.remoteId = remoteId.trim();
    task.url = "https://mp.weixin.qq.com/";
    this.bind(state, {
      articleId: task.snapshot.articleId,
      channel: "wechat",
      target: task.target,
      remoteId: task.remoteId,
      hash: task.snapshot.hash,
      revisionHash: task.snapshot.revisionHash,
      at: new Date().toISOString(),
      url: task.url,
    });
    await this.stamp(state, [task], "draft_synced", "用户核对并关联草稿");
  }
  async confirmNotDelivered(taskId: string): Promise<void> {
    const state = this.host.getPublishState(),
      task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("找不到任务");
    await this.stamp(
      state,
      [task],
      "failed",
      "用户确认远端未交付，可重新预览",
      "已确认未交付",
    );
  }
}

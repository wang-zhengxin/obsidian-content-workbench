// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type WorkbenchHost } from "../src/domain";
import { fixtureArticles } from "../src/fixtures";
import { Publisher } from "../src/publisher";
import { Workbench } from "../src/ui/Workbench";

it("keeps a renamed article selected but clears deletion before the ID reappears", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let articles = fixtureArticles();
  const callbacks = new Set<() => void>();
  const host = {
    vaultName: "File refresh test",
    getArticles: () => articles,
    getConfig: () => DEFAULT_CONFIG,
    getPublishState: () => ({ tasks: [], bindings: [] }),
    subscribe: (callback: () => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    undo: vi.fn(),
    move: vi.fn(),
    assetUrl: (file: string) => "/" + file,
    assets: { readAsset: async () => null, resolveNote: () => null },
    notify: vi.fn(),
  } as unknown as WorkbenchHost;
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const card = () =>
    mount.querySelector<HTMLInputElement>(
      '[data-card-id="demo-01"] input[type="checkbox"]',
    );
  const notify = () => callbacks.forEach((callback) => callback());
  try {
    await act(async () =>
      root.render(<Workbench host={host} publisher={new Publisher(host)} />),
    );
    await act(async () => card()!.click());
    expect(card()!.checked).toBe(true);
    const selectedArticle = articles.find(
      (article) => article.id === "demo-01",
    )!;
    await act(async () => {
      articles = articles.map((article) =>
        article.id === "demo-01"
          ? { ...article, path: "内容/新目录/改名.md" }
          : article,
      );
      notify();
    });
    expect(card()!.checked).toBe(true);
    await act(async () => {
      articles = articles.filter((article) => article.id !== "demo-01");
      notify();
    });
    expect(card()).toBeNull();
    await act(async () => {
      articles = [...articles, { ...selectedArticle, title: "重新出现的文章" }];
      notify();
    });
    expect(card()!.checked).toBe(false);
    const delivery = [
      ...mount.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "预览并交付 0 篇");
    expect(delivery?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  }
});

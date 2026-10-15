// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type WorkbenchHost } from "../src/domain";
import { fixtureArticles } from "../src/fixtures";
import { Publisher } from "../src/publisher";
import { Workbench } from "../src/ui/Workbench";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reduced motion during a real workbench drop", () => {
  it.each([
    { systemReduced: false, vaultReduced: false, animations: 1 },
    { systemReduced: true, vaultReduced: false, animations: 0 },
    { systemReduced: false, vaultReduced: true, animations: 0 },
    { systemReduced: false, vaultReduced: true, animations: 0, transfer: true },
  ])("keeps stage changes usable with %j", async (preference) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const config = structuredClone(DEFAULT_CONFIG);
    config.reduceMotion = preference.vaultReduced;
    let articles = fixtureArticles();
    const callbacks = new Set<() => void>();
    const animate = vi.fn();
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: preference.systemReduced })),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const host: WorkbenchHost = {
      vaultName: "Motion test",
      getArticles: () => articles,
      getConfig: () => config,
      getPublishState: () => ({ tasks: [], bindings: [] }),
      subscribe: (callback) => {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      move: vi.fn(async (id, stage) => {
        articles = articles.map((article) =>
          article.id === id ? { ...article, stage } : article,
        );
        callbacks.forEach((callback) => callback());
      }),
      update: vi.fn(),
      undo: vi.fn(async () => {}),
      create: vi.fn(),
      open: vi.fn(),
      ensureIds: vi.fn(),
      repairIds: vi.fn(),
      configure: vi.fn(),
      assets: { readAsset: vi.fn(), resolveNote: vi.fn() },
      transport: { request: vi.fn() },
      getSecret: vi.fn(),
      savePublishState: vi.fn(),
      getDeviceId: () => "test-device",
      assetUrl: (file) => "/" + file,
      notify: vi.fn(),
    };
    const mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () =>
      root!.render(<Workbench host={host} publisher={new Publisher(host)} />),
    );
    let doc = document;
    let eventWindow: Window = window;
    if ("transfer" in preference && preference.transfer) {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      doc = iframe.contentDocument!;
      eventWindow = iframe.contentWindow!;
      doc.body.append(mount);
      for (const name of [
        "matchMedia",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ] as const)
        Object.defineProperty(eventWindow, name, {
          configurable: true,
          value: window[name],
        });
      await act(async () =>
        root!.render(
          <Workbench
            host={host}
            publisher={new Publisher(host)}
            ownerWindow={eventWindow}
          />,
        ),
      );
      const search = doc.querySelector<HTMLInputElement>(".cw-search input")!;
      doc.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(doc.activeElement).toBe(search);
      search.blur();
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(doc.activeElement).not.toBe(search);
      await act(async () => {
        doc.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(host.undo).toHaveBeenCalledTimes(1);
    }
    const source = doc.querySelector<HTMLElement>('[data-card-id="demo-01"]')!;
    const target = doc.querySelector<HTMLElement>('[data-stage="review"]')!;
    Object.defineProperty(doc, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });
    const pointer = (
      element: EventTarget,
      type: string,
      x: number,
      y: number,
    ) =>
      element.dispatchEvent(
        new MouseEvent(type, {
          button: 0,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    await act(async () => {
      pointer(source, "pointerdown", 10, 10);
      pointer(eventWindow, "pointermove", 400, 200);
      expect(
        doc
          .querySelector(".cw-drag-portal")
          ?.classList.contains("cw-reduced-motion"),
      ).toBe(preference.vaultReduced);
      pointer(eventWindow, "pointerup", 400, 200);
      await Promise.resolve();
    });
    await act(async () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(0);
      }
    });
    expect(host.move).toHaveBeenCalledWith(
      "demo-01",
      "review",
      expect.any(Number),
    );
    expect(target.querySelector('[data-card-id="demo-01"]')).not.toBeNull();
    expect(doc.querySelector(".cw-drag-portal")).toBeNull();
    expect(animate).toHaveBeenCalledTimes(preference.animations);
    expect(
      doc.querySelector(".cw-root")?.classList.contains("cw-reduced-motion"),
    ).toBe(preference.vaultReduced);
  });
});

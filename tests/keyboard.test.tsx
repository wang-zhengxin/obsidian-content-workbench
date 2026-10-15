// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scope, KeymapEventHandler, KeymapEventListener } from "obsidian";
import { DEFAULT_CONFIG, type WorkbenchHost } from "../src/domain";
import { fixtureArticles } from "../src/fixtures";
import { Publisher } from "../src/publisher";
import { Workbench } from "../src/ui/Workbench";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount(scope?: Pick<Scope, "register" | "unregister">) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = structuredClone(DEFAULT_CONFIG);
  const host = {
    vaultName: "Keyboard test",
    getArticles: () => fixtureArticles(),
    getConfig: () => config,
    getPublishState: () => ({ tasks: [], bindings: [] }),
    subscribe: () => () => {},
    undo: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    assetUrl: (file: string) => "/" + file,
    assets: { readAsset: async () => null, resolveNote: () => null },
    notify: vi.fn(),
  } as unknown as WorkbenchHost;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(
      <Workbench
        host={host}
        publisher={new Publisher(host)}
        keyboardScope={scope}
      />,
    ),
  );
  return { el, host };
}
describe("workbench keyboard ownership", () => {
  it("handles native view scope hotkeys before host bubbling and unregisters when closed", async () => {
    const handlers = new Map<string, KeymapEventListener>();
    const register = vi.fn((mods, key, callback) => {
      handlers.set(key.toUpperCase(), callback);
      return { key } as KeymapEventHandler;
    });
    const unregister = vi.fn();
    const { el, host } = await mount({ register, unregister });
    const hostCapture = (event: KeyboardEvent) => {
      const callback = handlers.get(event.key.toUpperCase());
      if (callback?.(event, {} as never) === false) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", hostCapture, true);
    try {
      const search = el.querySelector<HTMLInputElement>(".cw-search input")!;
      const k = new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(k);
      expect(document.activeElement).toBe(search);
      expect(k.defaultPrevented).toBe(true);
      await act(async () =>
        search.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(host.undo).not.toHaveBeenCalled();
      search.blur();
      await act(async () =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(host.undo).toHaveBeenCalledTimes(1);
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => el.querySelector('[data-stage="review"]'),
      });
      const card = el.querySelector('[data-card-id="demo-01"]')!;
      card.dispatchEvent(
        new MouseEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          button: 0,
          clientX: 400,
          clientY: 200,
          bubbles: true,
        }),
      );
      expect(document.querySelector(".cw-drag-portal")).not.toBeNull();
      await act(async () =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(document.querySelector(".cw-drag-portal")).toBeNull();
      window.dispatchEvent(
        new MouseEvent("pointerup", {
          button: 0,
          clientX: 400,
          clientY: 200,
          bubbles: true,
        }),
      );
      expect(host.move).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", hostCapture, true);
    }
    await act(async () => root!.unmount());
    root = undefined;
    expect(unregister).toHaveBeenCalledTimes(3);
  });
  it("does not intercept another editor's search or undo in the browser fallback", async () => {
    const { host } = await mount();
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(editor);
    editor.focus();
    for (const key of ["k", "z"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => editor.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(editor);
    }
    expect(host.undo).not.toHaveBeenCalled();
  });
});

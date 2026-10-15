// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { BoardDrag } from "../src/ui/dnd";
function setup(manual = true) {
  document.body.innerHTML =
    '<div class="cw-board"><section class="cw-column" data-stage="writing"><div class="cw-cards"><article class="cw-card" data-card-id="a">A</article></div></section><section class="cw-column" data-stage="review"><div class="cw-cards"><article class="cw-card" data-card-id="b">B</article><article class="cw-card" data-card-id="c">C</article></div></section></div>';
  const board = document.querySelector<HTMLElement>(".cw-board")!,
    source = document.querySelector<HTMLElement>('[data-card-id="a"]')!,
    target = document.querySelector<HTMLElement>('[data-stage="review"]')!;
  let hit: Element = target;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => hit,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn((id: number) => frames.delete(id)),
  });
  for (const [i, card] of [
    ...target.querySelectorAll<HTMLElement>(".cw-card"),
  ].entries()) {
    Object.defineProperty(card, "offsetHeight", {
      configurable: true,
      value: 160,
    });
    card.getBoundingClientRect = () => ({
      x: 350,
      y: i * 180 + 80,
      top: i * 180 + 80,
      left: 350,
      right: 645,
      bottom: i * 180 + 240,
      width: 295,
      height: 160,
      toJSON: () => {},
    });
  }
  Object.defineProperty(source, "offsetWidth", { value: 295 });
  Object.defineProperty(source, "offsetHeight", { value: 160 });
  const commit = vi.fn(async () => {}),
    fail = vi.fn(),
    dnd = new BoardDrag(board, () => manual, commit, fail);
  return {
    board,
    source,
    target,
    commit,
    fail,
    dnd,
    frames,
    tick: () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(0);
      }
    },
    hit: (element: Element) => {
      hit = element;
    },
  };
}
function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
    new MouseEvent(type, {
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
describe("board pointer drag lifecycle", () => {
  it("does not treat a small pointer movement as a drag", () => {
    const x = setup();
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 13, 12);
    pointer(window, "pointerup", 13, 12);
    expect(x.commit).not.toHaveBeenCalled();
    expect(document.querySelector(".cw-drag-portal")).toBeNull();
    x.dnd.destroy();
  });
  it("preserves ghost size, places a non-shifting indicator, and commits the chosen slot", () => {
    const x = setup();
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 400, 200);
    const ghost = document.querySelector<HTMLElement>(
      ".cw-drag-portal .cw-card",
    )!;
    expect(ghost.style.width).toBe("295px");
    expect(ghost.style.height).toBe("160px");
    expect(x.target.querySelector(".cw-drop-line")).not.toBeNull();
    expect(x.source.classList.contains("cw-card-dragging")).toBe(true);
    pointer(window, "pointerup", 400, 200);
    expect(x.commit).toHaveBeenCalledWith("a", "review", 1);
    expect(document.querySelector(".cw-drag-portal")).toBeNull();
    expect(x.board.dataset.suppressClick).toBe("true");
    x.dnd.destroy();
  });
  it("cancels with Escape or pointer cancellation and removes all drag listeners/overlays", () => {
    const x = setup();
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 400, 200);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    pointer(window, "pointerup", 400, 200);
    expect(x.commit).not.toHaveBeenCalled();
    expect(x.board.querySelector(".cw-drop-line")).toBeNull();
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 400, 200);
    pointer(window, "pointercancel", 400, 200);
    expect(document.querySelector(".cw-drag-portal")).toBeNull();
    x.dnd.destroy();
  });
  it("disables same-column reordering in an automatic sort mode", () => {
    const x = setup(false);
    x.hit(x.source);
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 20, 20);
    pointer(window, "pointerup", 20, 20);
    expect(x.commit).not.toHaveBeenCalled();
    x.dnd.destroy();
  });
  it("reports a failed save without leaving the card in a dragging state", async () => {
    const x = setup();
    x.commit.mockRejectedValue(new Error("write failed"));
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 400, 200);
    pointer(window, "pointerup", 400, 200);
    await Promise.resolve();
    await Promise.resolve();
    expect(x.fail).toHaveBeenCalled();
    expect(x.source.classList.contains("cw-card-dragging")).toBe(false);
    x.dnd.destroy();
  });
  it("scrolls at both board and column edges and stops every frame on cancellation", () => {
    const x = setup();
    const list = x.target.querySelector<HTMLElement>(".cw-cards")!;
    const rectangle = (
      left: number,
      top: number,
      right: number,
      bottom: number,
    ) => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      toJSON: () => {},
    });
    x.board.getBoundingClientRect = () => rectangle(0, 0, 800, 600);
    list.getBoundingClientRect = () => rectangle(350, 80, 650, 400);
    x.board.scrollLeft = list.scrollTop = 500;
    pointer(x.source, "pointerdown", 10, 10);
    pointer(window, "pointermove", 790, 390);
    x.tick();
    expect(x.board.scrollLeft).toBeGreaterThan(500);
    expect(list.scrollTop).toBeGreaterThan(500);
    const right = x.board.scrollLeft;
    const bottom = list.scrollTop;
    pointer(window, "pointermove", 10, 90);
    x.tick();
    expect(x.board.scrollLeft).toBeLessThan(right);
    expect(list.scrollTop).toBeLessThan(bottom);
    pointer(window, "pointercancel", 10, 90);
    const stopped = [x.board.scrollLeft, list.scrollTop];
    expect(x.frames.size).toBe(0);
    x.tick();
    expect([x.board.scrollLeft, list.scrollTop]).toEqual(stopped);
    expect(x.commit).not.toHaveBeenCalled();
    expect(x.target.classList.contains("cw-column-target")).toBe(false);
    x.dnd.destroy();
  });
  it("uses the new window after an existing board is moved into a popout", () => {
    const x = setup();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const popup = frame.contentWindow!;
    const popupDocument = frame.contentDocument!;
    Object.defineProperty(popup, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn(() => 1),
    });
    Object.defineProperty(popup, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(popupDocument, "elementFromPoint", {
      configurable: true,
      value: () => x.target,
    });
    popupDocument.body.append(x.board);
    pointer(x.source, "pointerdown", 10, 10);
    pointer(popup, "pointermove", 400, 200);
    expect(popupDocument.querySelector(".cw-drag-portal")).not.toBeNull();
    expect(document.querySelector(".cw-drag-portal")).toBeNull();
    pointer(popup, "pointerup", 400, 200);
    expect(x.commit).toHaveBeenCalledWith("a", "review", 1);
    expect(popupDocument.querySelector(".cw-drag-portal")).toBeNull();
    pointer(window, "pointerup", 400, 200);
    expect(x.commit).toHaveBeenCalledTimes(1);
    x.dnd.destroy();
    frame.remove();
  });
});

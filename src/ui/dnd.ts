import type { Stage } from "../domain";
export class BoardDrag {
  private source: HTMLElement | null = null;
  private ghost: HTMLElement | null = null;
  private line: HTMLElement | null = null;
  private origin = { x: 0, y: 0 };
  private point = { x: 0, y: 0 };
  private destination: { stage: Stage; index: number } | null = null;
  private frame = 0;
  private dragging = false;
  private win: Window;
  constructor(
    private board: HTMLElement,
    private manual: () => boolean,
    private commit: (id: string, stage: Stage, index: number) => Promise<void>,
    private fail: (error: unknown) => void,
  ) {
    this.win = board.ownerDocument.defaultView!;
    board.addEventListener("pointerdown", this.down);
  }
  private down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("button,input,a"))
      return;
    const card = (e.target as Element).closest<HTMLElement>("[data-card-id]");
    if (!card) return;
    if (this.source) this.cleanup();
    this.win = card.ownerDocument.defaultView!;
    this.source = card;
    this.origin = { x: e.clientX, y: e.clientY };
    this.point = this.origin;
    this.win.addEventListener("pointermove", this.move);
    this.win.addEventListener("pointerup", this.up);
    this.win.addEventListener("pointercancel", this.cancel);
    this.win.addEventListener("keydown", this.key);
  };
  private move = (e: PointerEvent) => {
    if (!this.source) return;
    this.point = { x: e.clientX, y: e.clientY };
    if (!this.dragging) {
      if (Math.hypot(e.clientX - this.origin.x, e.clientY - this.origin.y) < 5)
        return;
      this.start();
    }
    e.preventDefault();
    if (this.ghost) {
      this.ghost.style.left = e.clientX + 8 + "px";
      this.ghost.style.top = e.clientY + 8 + "px";
    }
    this.target();
  };
  private start() {
    this.dragging = true;
    this.board.classList.add("cw-dragging");
    const doc = this.board.ownerDocument;
    this.ghost = doc.createElement("div");
    this.ghost.className = "cw-root cw-drag-portal";
    if (this.board.closest(".cw-reduced-motion"))
      this.ghost.classList.add("cw-reduced-motion");
    const clone = this.source!.cloneNode(true) as HTMLElement;
    clone.style.width = this.source!.offsetWidth + "px";
    clone.style.height = this.source!.offsetHeight + "px";
    this.ghost.append(clone);
    doc.body.append(this.ghost);
    this.source!.classList.add("cw-card-dragging");
    this.line = doc.createElement("div");
    this.line.className = "cw-drop-line";
    this.frame = this.win.requestAnimationFrame(this.scroll);
  }
  private target() {
    for (const el of this.board.querySelectorAll(".cw-column-target"))
      el.classList.remove("cw-column-target");
    const hit = this.board.ownerDocument.elementFromPoint(
      this.point.x,
      this.point.y,
    );
    const column = hit?.closest<HTMLElement>("[data-stage]");
    if (!column || !this.board.contains(column)) {
      this.destination = null;
      this.line?.remove();
      return;
    }
    if (!this.manual() && column.contains(this.source)) {
      this.destination = null;
      this.line?.remove();
      return;
    }
    column.classList.add("cw-column-target");
    const list = column.querySelector<HTMLElement>(".cw-cards")!;
    const cards = [
      ...list.querySelectorAll<HTMLElement>("[data-card-id]"),
    ].filter((el) => el !== this.source);
    let index = cards.length;
    if (this.manual()) {
      const i = cards.findIndex(
        (el) =>
          this.point.y < el.getBoundingClientRect().top + el.offsetHeight / 2,
      );
      if (i >= 0) index = i;
    }
    this.destination = { stage: column.dataset.stage as Stage, index };
    if (!this.line) return;
    list.append(this.line);
    const rect = list.getBoundingClientRect();
    this.line.style.top =
      (cards[index]
        ? cards[index].getBoundingClientRect().top - rect.top + list.scrollTop
        : cards.length
          ? cards.at(-1)!.getBoundingClientRect().bottom -
            rect.top +
            list.scrollTop +
            6
          : 8) + "px";
  }
  private scroll = () => {
    if (!this.dragging) return;
    const r = this.board.getBoundingClientRect();
    if (this.point.x < r.left + 40) this.board.scrollLeft -= 10;
    if (this.point.x > r.right - 40) this.board.scrollLeft += 10;
    const col = this.board.ownerDocument
      .elementFromPoint(this.point.x, this.point.y)
      ?.closest(".cw-column");
    const list = col?.querySelector<HTMLElement>(".cw-cards");
    if (list) {
      const lr = list.getBoundingClientRect();
      if (this.point.y < lr.top + 36) list.scrollTop -= 10;
      if (this.point.y > lr.bottom - 36) list.scrollTop += 10;
    }
    this.target();
    this.frame = this.win.requestAnimationFrame(this.scroll);
  };
  private up = () => {
    const id = this.source?.dataset.cardId,
      target = this.destination,
      dragged = this.dragging;
    if (dragged) this.board.dataset.suppressClick = "true";
    this.cleanup();
    if (dragged && id && target)
      void this.commit(id, target.stage, target.index).catch(this.fail);
    this.win.setTimeout(() => delete this.board.dataset.suppressClick, 80);
  };
  private key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.cancel();
    }
  };
  private cancel = () => this.cleanup();
  cancelDrag() {
    this.cancel();
  }
  private cleanup() {
    this.win.cancelAnimationFrame(this.frame);
    this.source?.classList.remove("cw-card-dragging");
    this.ghost?.remove();
    this.line?.remove();
    this.board.classList.remove("cw-dragging");
    for (const el of this.board.querySelectorAll(".cw-column-target"))
      el.classList.remove("cw-column-target");
    this.win.removeEventListener("pointermove", this.move);
    this.win.removeEventListener("pointerup", this.up);
    this.win.removeEventListener("pointercancel", this.cancel);
    this.win.removeEventListener("keydown", this.key);
    this.source = null;
    this.ghost = null;
    this.line = null;
    this.destination = null;
    this.dragging = false;
  }
  destroy() {
    this.cleanup();
    this.board.removeEventListener("pointerdown", this.down);
  }
}

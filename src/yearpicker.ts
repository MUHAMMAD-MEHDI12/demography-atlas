// Year picker under the chart: a strip of years you slide sideways, tap, or
// step through with the arrow keys. The selected year sits in the box.

const SPACING = 58; // px between years

export class YearPicker {
  private track: HTMLElement;
  private items: HTMLElement[] = [];
  private shown = NaN;
  private active = -1;
  private drag: { x: number; year: number; moved: boolean } | null = null;

  constructor(
    readonly el: HTMLElement,
    private start: number,
    private end: number,
    private lastEstimate: number,
    /** fractional years while sliding; `done` when the year is settled */
    private onChange: (year: number, done: boolean) => void,
    private onPlay: () => void,
  ) {
    this.track = el.querySelector(".yp-track")!;
    for (let y = start; y <= end; y++) {
      const b = document.createElement("span");
      b.className = `yp-year${y > lastEstimate ? " is-proj" : ""}`;
      b.textContent = String(y);
      b.dataset.year = String(y);
      this.track.append(b);
      this.items.push(b);
    }
    el.setAttribute("aria-valuemin", String(start));
    el.setAttribute("aria-valuemax", String(end));
    el.querySelector(".yp-play")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onPlay();
    });

    const strip = el.querySelector<HTMLElement>(".yp-strip")!;
    strip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      strip.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, year: this.shown, moved: false };
      el.classList.add("is-dragging");
    });
    strip.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      if (Math.abs(dx) > 3) this.drag.moved = true;
      if (this.drag.moved) this.onChange(this.clamp(this.drag.year - dx / SPACING), false);
    });
    const release = (e: PointerEvent) => {
      if (!this.drag) return;
      const { moved } = this.drag;
      this.drag = null;
      el.classList.remove("is-dragging");
      if (moved) this.onChange(Math.round(this.shown), true);
      else {
        const year = (e.target as HTMLElement).closest<HTMLElement>(".yp-year")?.dataset.year;
        if (year) this.onChange(Number(year), true);
      }
    };
    strip.addEventListener("pointerup", release);
    strip.addEventListener("pointercancel", release);
    strip.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.onChange(this.clamp(Math.round(this.shown) + Math.sign(d)), true);
      },
      { passive: false },
    );
    el.addEventListener("keydown", (e) => {
      const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
      let y: number | null = null;
      if (e.key in step) y = Math.round(this.shown) + step[e.key];
      if (e.key === "Home") y = this.start;
      if (e.key === "End") y = this.end;
      if (y === null) return;
      e.preventDefault();
      this.onChange(this.clamp(y), true);
    });
    for (const ev of ["pointerdown", "wheel", "dblclick"]) el.addEventListener(ev, (e) => e.stopPropagation());
  }

  get isDragging() {
    return !!this.drag;
  }

  private clamp(y: number) {
    return Math.min(Math.max(y, this.start), this.end);
  }

  /** Draw the strip for a (possibly fractional) year. */
  render(year: number, playing: boolean) {
    if (year === this.shown) return;
    this.shown = year;
    const offset = (year - this.start) * SPACING;
    this.track.style.transform = `translateX(${(-offset - SPACING / 2).toFixed(1)}px)`;
    const idx = Math.round(year) - this.start;
    if (idx !== this.active) {
      this.items[this.active]?.classList.remove("is-active");
      this.items[idx]?.classList.add("is-active");
      this.active = idx;
      const y = idx + this.start;
      this.el.setAttribute("aria-valuenow", String(y));
      this.el.setAttribute("aria-valuetext", `${y}, ${y > this.lastEstimate ? "UN projection" : "UN estimate"}`);
      this.el.querySelector(".yp-phase")!.textContent = y > this.lastEstimate ? "UN projection" : "UN estimate";
    }
    this.el.querySelector(".yp-play")!.setAttribute("aria-label", playing ? "Pause" : "Play from this year");
    this.el.querySelector(".yp-play path")!.setAttribute("d", playing ? "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" : "M7 4.5v15l12.5-7.5z");
  }

  /** Keep the picker centred under the chart. */
  place(x: number, y: number) {
    this.el.style.transform = `translate(${(x - this.el.offsetWidth / 2).toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

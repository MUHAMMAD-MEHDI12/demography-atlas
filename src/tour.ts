// Guided tour: visits a list of places one after another with a caption and a
// progress bar, waiting for each map flight to finish before holding on the place.

export interface TourStop {
  title: string;
  detail: string;
  /** select the place; returns how long the map flight takes in ms */
  go: () => number;
}

const STEP_MS = 2500; // time on each place, flight included

export class Tour {
  running = false;
  private timer = 0;
  private i = -1;
  private stops: TourStop[] = [];

  constructor(
    private button: HTMLButtonElement,
    private caption: HTMLElement,
    private build: () => TourStop[],
    private label: string,
  ) {
    button.addEventListener("click", () => (this.running ? this.stop() : this.start()));
    caption.querySelector(".tc-close")?.addEventListener("click", () => this.stop());
  }

  start() {
    this.stops = this.build();
    if (!this.stops.length) return;
    this.running = true;
    this.i = -1;
    this.button.classList.add("is-on");
    this.button.querySelector(".tb-label")!.textContent = "Stop tour";
    this.caption.hidden = false;
    this.next();
  }

  /** Stop, e.g. when the user takes over the map. */
  stop(finished = false) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.running = false;
    this.button.classList.remove("is-on");
    this.button.querySelector(".tb-label")!.textContent = this.label;
    if (finished) {
      this.caption.querySelector(".tc-rank")!.textContent = "Tour finished";
      this.bar(0, 0);
      this.timer = window.setTimeout(() => (this.caption.hidden = true), 2500);
    } else this.caption.hidden = true;
  }

  private next() {
    this.i++;
    if (this.i >= this.stops.length) return this.stop(true);
    const stop = this.stops[this.i];
    this.caption.querySelector(".tc-rank")!.textContent = `${this.i + 1} of ${this.stops.length}`;
    this.caption.querySelector(".tc-title")!.textContent = stop.title;
    this.caption.querySelector(".tc-detail")!.textContent = stop.detail;
    const flight = stop.go();
    const total = Math.max(STEP_MS, flight);
    this.bar(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => this.bar(100, total)));
    this.timer = window.setTimeout(() => this.next(), total);
  }

  private bar(pct: number, ms: number) {
    const el = this.caption.querySelector<HTMLElement>(".tc-progress i")!;
    el.style.transition = ms ? `width ${ms}ms linear` : "none";
    el.style.width = `${pct}%`;
  }
}

export const tourMarkup = (label: string) => ({
  button: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 18l5-6 4 3 7-9" /><circle cx="20" cy="6" r="1.6" /></svg><span class="tb-label">${label}</span>`,
  caption: `<div class="tc-head"><span class="tc-rank"></span><button type="button" class="tc-close" aria-label="Stop tour">×</button></div>
    <strong class="tc-title"></strong><span class="tc-detail"></span><div class="tc-progress"><i></i></div>`,
});

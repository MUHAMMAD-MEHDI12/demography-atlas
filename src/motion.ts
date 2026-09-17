// Spring motion for the chart: it trails the pointer a little while dragged,
// tilts with its speed, lifts slightly, and settles onto a place with a soft bounce.

export class ChartMotion {
  x = 0;
  y = 0;
  tilt = 0;
  lift = 1;
  active = false;
  dragging = false;
  private vx = 0;
  private vy = 0;
  private tx = 0;
  private ty = 0;

  constructor(private reduced: () => boolean) {}

  /** Jump straight to a position and stop. */
  snap(x: number, y: number) {
    this.x = this.tx = x;
    this.y = this.ty = y;
    this.vx = this.vy = 0;
    this.active = false;
  }

  /** Spring towards a position. */
  follow(x: number, y: number) {
    this.tx = x;
    this.ty = y;
    this.active = true;
    if (this.reduced()) this.snap(x, y);
  }

  /** Advance by dt milliseconds; returns true while still moving. */
  step(dtMs: number): boolean {
    if (!this.active) return false;
    // stiffer while held so it keeps up with the hand, softer when settling
    const k = this.dragging ? 900 : 150;
    const c = 2 * Math.sqrt(k) * (this.dragging ? 0.78 : 0.62);
    let left = Math.min(dtMs, 64) / 1000;
    while (left > 0) {
      const h = Math.min(left, 1 / 120);
      this.vx += (k * (this.tx - this.x) - c * this.vx) * h;
      this.vy += (k * (this.ty - this.y) - c * this.vy) * h;
      this.x += this.vx * h;
      this.y += this.vy * h;
      left -= h;
    }
    const e = 1 - Math.exp(-dtMs / 90);
    const tiltTarget = Math.max(-8, Math.min(8, this.vx * 0.0065));
    this.tilt += (tiltTarget - this.tilt) * e;
    this.lift += ((this.dragging ? 1.05 : 1) - this.lift) * e;
    const settled = !this.dragging && Math.hypot(this.tx - this.x, this.ty - this.y) < 0.3 && Math.hypot(this.vx, this.vy) < 4 && Math.abs(this.tilt) < 0.05 && Math.abs(this.lift - 1) < 0.001;
    if (settled) {
      this.snap(this.tx, this.ty);
      this.tilt = 0;
      this.lift = 1;
    }
    return !settled;
  }
}

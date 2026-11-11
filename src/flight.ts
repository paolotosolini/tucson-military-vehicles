import { Vec3 } from 'playcanvas';
import type { Pose } from './viewer';

/** Straight-line distance above which a flight arcs upward to clear rooftops. */
export const ARC_THRESHOLD = 15;
const MIN_DURATION = 1.5;
const MAX_DURATION = 2.5;

export function flightDuration(distance: number): number {
  // 1.5 s for short hops, growing to 2.5 s for a cross-town move (~50 units).
  return Math.min(MAX_DURATION, MIN_DURATION + (distance / 50) * (MAX_DURATION - MIN_DURATION));
}

/** Peak height added at the middle of a long flight. */
export function arcHeight(distance: number): number {
  if (distance <= ARC_THRESHOLD) return 0;
  return Math.min(20, (distance - ARC_THRESHOLD) * 0.35 + 2);
}

/**
 * Cubic Hermite from `p0` (moving at `v0` units/s) to `p1` (at rest), over `duration` seconds.
 * With v0 = 0 this is exactly smoothstep: ease-in-out. With v0 ≠ 0 — a flight interrupted by a
 * new selection — the camera carries its current velocity into the new path instead of stalling.
 */
function hermite(out: Vec3, p0: Vec3, v0: Vec3, p1: Vec3, s: number, duration: number): Vec3 {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  return out.set(
    h00 * p0.x + h10 * v0.x * duration + h01 * p1.x,
    h00 * p0.y + h10 * v0.y * duration + h01 * p1.y,
    h00 * p0.z + h10 * v0.z * duration + h01 * p1.z,
  );
}

function smoothstep(s: number): number {
  return s * s * (3 - 2 * s);
}

export interface FlightState {
  position: Vec3;
  target: Vec3;
  fov: number;
}

/**
 * One camera flight. Position and target are interpolated separately so the view turns smoothly
 * while it travels; long flights rise along a sin² arc (zero vertical speed at both ends).
 */
export class Flight {
  readonly duration: number;
  private elapsed = 0;
  private readonly p0: Vec3;
  private readonly t0: Vec3;
  private readonly p1: Vec3;
  private readonly t1: Vec3;
  private readonly vp0: Vec3;
  private readonly vt0: Vec3;
  private readonly fov0: number;
  private readonly fov1: number;
  private readonly arc: number;

  constructor(from: FlightState, fromVelocity: { position: Vec3; target: Vec3 }, to: Pose) {
    this.p0 = from.position.clone();
    this.t0 = from.target.clone();
    this.vp0 = fromVelocity.position.clone();
    this.vt0 = fromVelocity.target.clone();
    this.fov0 = from.fov;
    this.p1 = new Vec3(...to.position);
    this.t1 = new Vec3(...to.target);
    this.fov1 = to.fov;

    const distance = this.p0.distance(this.p1);
    this.duration = flightDuration(distance);
    this.arc = arcHeight(distance);
  }

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  /** Advances by dt seconds and writes the camera state into `out`. */
  step(dt: number, out: FlightState): FlightState {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const s = this.elapsed / this.duration;
    hermite(out.position, this.p0, this.vp0, this.p1, s, this.duration);
    hermite(out.target, this.t0, this.vt0, this.t1, s, this.duration);
    if (this.arc > 0) {
      const lift = this.arc * Math.sin(Math.PI * s) ** 2;
      out.position.y += lift;
      out.target.y += lift * 0.5; // keep the town in view while climbing
    }
    out.fov = this.fov0 + (this.fov1 - this.fov0) * smoothstep(s);
    return out;
  }
}

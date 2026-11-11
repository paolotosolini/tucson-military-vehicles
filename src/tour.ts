import type { Pose } from './viewer';

export type Drift = 'orbit' | 'sway' | 'none';

export interface Stop {
  id: string;
  title: string;
  description: string;
  camera: Pose;
  thumbnail: string;
  drift?: Drift;
}

export interface TourData {
  title: string;
  subtitle: string;
  model: string;
  stops: Stop[];
}

export async function loadTour(url: string): Promise<TourData> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const data = (await res.json()) as TourData;
  if (!Array.isArray(data.stops) || data.stops.length === 0) throw new Error('stops.json has no stops');
  return data;
}

export interface StopChange {
  index: number;
  previous: number;
  stop: Stop;
  /** True on the initial stop (from the deep link or default): no flight. */
  initial: boolean;
}

type Listener = (change: StopChange) => void;

/** Thumbnail file for a stop id, relative to public/. */
export const thumbPath = (id: string) => `thumbs/${id}.webp`;

/**
 * Tour state: the active stop, prev/next, and the `#stop-N` deep link.
 * The tour decides *which* stop is active; listeners (viewer, UI) react to changes.
 */
export class Tour {
  readonly data: TourData;
  private current = -1;
  private listeners: Listener[] = [];
  private listListeners: (() => void)[] = [];

  constructor(data: TourData) {
    this.data = data;
    window.addEventListener('hashchange', () => {
      const i = this.indexFromHash();
      if (i >= 0 && i !== this.current) this.goTo(i);
    });
  }

  get stops(): Stop[] {
    return this.data.stops;
  }
  get index(): number {
    return this.current;
  }
  get count(): number {
    return this.stops.length;
  }
  get stop(): Stop {
    return this.stops[this.current];
  }
  get isHome(): boolean {
    return this.current === 0;
  }

  /** Index named by the URL hash, or -1. */
  indexFromHash(): number {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''));
    return id ? this.stops.findIndex((s) => s.id === id) : -1;
  }

  /** Index the tour should open at: the deep-linked stop, else the overview. */
  startIndex(): number {
    return Math.max(0, this.indexFromHash());
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  /** Called when stops are added, removed, reordered or their text/pose edited (dev mode). */
  onStopsChanged(fn: () => void): void {
    this.listListeners.push(fn);
  }

  /**
   * Tells listeners the stop list or a stop's content changed. Ids are renumbered to match the
   * order (`stop-1` … `stop-N`), so deep links and thumbnail names always match the counter.
   */
  stopsChanged(): void {
    this.stops.forEach((s, i) => {
      s.id = `stop-${i + 1}`;
      s.thumbnail = thumbPath(s.id);
    });
    if (this.current >= 0) {
      const hash = `#${this.stop.id}`;
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }
    for (const fn of this.listListeners) fn();
  }

  /** Makes `index` active without a flight (used after structural edits). */
  select(index: number): void {
    this.set(Math.max(0, Math.min(index, this.count - 1)), true);
  }

  /** Activates the start stop without a flight. Call once, after listeners are attached. */
  start(): void {
    this.set(this.startIndex(), true);
  }

  goTo(index: number): void {
    if (index < 0 || index >= this.count || index === this.current) return;
    this.set(index, false);
  }

  /** Next stop; after the last stop the tour loops back to the overview. */
  next(): void {
    this.goTo((this.current + 1) % this.count);
  }

  /** Previous stop; before the overview the tour loops round to the last stop. */
  prev(): void {
    this.goTo((this.current - 1 + this.count) % this.count);
  }

  /** Back to the overview (stop 1). */
  home(): void {
    this.goTo(0);
  }

  private set(index: number, initial: boolean): void {
    const previous = this.current;
    this.current = index;
    const stop = this.stop;
    // replaceState: keep the hash shareable without stacking a history entry per stop.
    const hash = `#${encodeURIComponent(stop.id)}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    for (const fn of this.listeners) fn({ index, previous, stop, initial });
  }
}

import type { Stop, TourData } from './tour';

/**
 * Where each stop's thumbnail comes from: a freshly captured image (dev mode) or the file it was
 * loaded with. Tracking the original file per stop (not per id) means reordering or deleting stops
 * in dev mode can rename thumbnails on export without losing any.
 */
type Source = { kind: 'blob'; blob: Blob; url: string } | { kind: 'file'; url: string };

export class ThumbStore {
  private sources = new Map<Stop, Source>();
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  /** URL to display for a stop. */
  url(stop: Stop): string {
    return this.source(stop).url;
  }

  /** Records a newly captured thumbnail for a stop. */
  set(stop: Stop, blob: Blob): void {
    const old = this.sources.get(stop);
    if (old?.kind === 'blob' && old.blob === blob) return; // unchanged: keep the URL cards use
    if (old?.kind === 'blob') URL.revokeObjectURL(old.url);
    this.sources.set(stop, { kind: 'blob', blob, url: URL.createObjectURL(blob) });
  }

  /** True if the stop has a thumbnail captured in this session or restored from local edits. */
  isCaptured(stop: Stop): boolean {
    return this.sources.get(stop)?.kind === 'blob';
  }

  /** The image bytes for a stop, or null if it has no thumbnail yet. */
  async blob(stop: Stop): Promise<Blob | null> {
    const src = this.source(stop);
    if (src.kind === 'blob') return src.blob;
    try {
      const res = await fetch(src.url, { cache: 'no-cache' });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? '';
      return type.startsWith('image/') ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  private source(stop: Stop): Source {
    let src = this.sources.get(stop);
    if (!src) {
      // First sight of this stop: its thumbnail is whatever file stops.json points at right now.
      src = { kind: 'file', url: `${this.base}${stop.thumbnail}` };
      this.sources.set(stop, src);
    }
    return src;
  }

  // --- Autosave -------------------------------------------------------------------------

  /** Serialisable form, aligned with `stops`: data URLs for captures, file URLs otherwise. */
  async snapshot(stops: Stop[]): Promise<SavedThumb[]> {
    return Promise.all(
      stops.map(async (stop): Promise<SavedThumb> => {
        const src = this.source(stop);
        return src.kind === 'blob' ? { data: await blobToDataUrl(src.blob) } : { url: src.url };
      }),
    );
  }

  async restore(stops: Stop[], saved: SavedThumb[]): Promise<void> {
    await Promise.all(
      stops.map(async (stop, i) => {
        const t = saved[i];
        if (t && 'data' in t) this.set(stop, await (await fetch(t.data)).blob());
        else if (t && 'url' in t) this.sources.set(stop, { kind: 'file', url: t.url });
      }),
    );
  }
}

export type SavedThumb = { data: string } | { url: string };

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// --- Local edits (dev mode autosave) ---------------------------------------------------

const STORAGE_KEY = 'tmvm-tour-dev-edits';

export interface LocalEdits {
  savedAt: number;
  data: TourData;
  thumbs: SavedThumb[];
}

export function loadLocalEdits(): LocalEdits | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const edits = JSON.parse(raw) as LocalEdits;
    return Array.isArray(edits?.data?.stops) && edits.data.stops.length > 0 ? edits : null;
  } catch {
    return null;
  }
}

/** Saves edits; returns false if the browser refused (e.g. storage quota). */
export function saveLocalEdits(edits: LocalEdits): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalEdits(): void {
  localStorage.removeItem(STORAGE_KEY);
}

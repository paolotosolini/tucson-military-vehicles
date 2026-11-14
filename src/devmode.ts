import { isTyping, type Carousel, type Nav } from './carousel';
import { type Drift, type Stop, type Tour, serializeTour, thumbPath } from './tour';
import { type ThumbStore, clearLocalEdits, saveLocalEdits } from './thumbs';
import type { Pose, Viewer } from './viewer';
import { createZip } from './zip';

/**
 * Dev mode: author the tour in the browser. Fly to a view, snap it, type the text, export.
 * On with `?dev=1` (or the ` key on localhost, which reloads with the flag).
 */

export const DEV_TOGGLE_KEY = '`';

export function isLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
}

/** Reloads the page with dev mode switched on or off. */
export function toggleDevMode(on: boolean): void {
  const url = new URL(location.href);
  if (on) url.searchParams.set('dev', '1');
  else url.searchParams.delete('dev');
  location.href = url.href;
}

interface DevContext {
  tour: Tour;
  viewer: Viewer;
  carousel: Carousel;
  nav: Nav;
  thumbs: ThumbStore;
  ui: HTMLElement;
  /** Shown once in the status line, e.g. "Restored unsaved edits from …". */
  initialStatus?: string;
  /** True when the stops came from this browser's backup of unsaved edits, not the project. */
  restored?: boolean;
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const roundPose = (p: Pose): Pose => ({
  position: p.position.map((v) => round(v)) as Pose['position'],
  target: p.target.map((v) => round(v)) as Pose['target'],
  fov: round(p.fov, 1),
});

export function initDevMode(ctx: DevContext): void {
  const { tour, viewer, carousel, nav, thumbs, ui } = ctx;
  document.body.classList.add('is-dev');

  // ---------------------------------------------------------------- HUD
  const hud = document.createElement('section');
  hud.className = 'dev-hud';
  hud.setAttribute('aria-label', 'Dev mode');
  hud.innerHTML = `
    <header class="dev-hud__head">
      <strong>Dev mode</strong>
      <button class="dev-btn dev-btn--ghost" data-act="exit" title="Leave dev mode">Exit</button>
    </header>
    <dl class="dev-hud__pose">
      <dt>Position</dt><dd data-f="pos"></dd>
      <dt>Target</dt><dd data-f="target"></dd>
      <dt>FOV</dt><dd><input type="range" min="20" max="100" step="1" data-f="fov" aria-label="Field of view" /><span data-f="fovval"></span></dd>
    </dl>
    <div class="dev-hud__actions">
      <button class="dev-btn" data-act="snap" title="Save the current camera to this stop (Space)">Snap pose <kbd>Space</kbd></button>
      <button class="dev-btn" data-act="add" title="Insert a stop after this one at the current view (N)">Add stop <kbd>N</kbd></button>
      <button class="dev-btn" data-act="preview" title="Fly in from the previous stop (P)">Preview <kbd>P</kbd></button>
      <button class="dev-btn dev-btn--primary" data-act="export" title="Save stops.json and thumbnails into the project's public/ folder (Ctrl/⌘+S). Changes also save automatically.">Save <kbd>⌘S</kbd></button>
    </div>
    <details class="dev-hud__more">
      <summary>More</summary>
      <div class="dev-hud__actions">
        <button class="dev-btn" data-act="rethumb" title="Re-render every stop's thumbnail from its saved pose">Re-render all thumbnails</button>
        <button class="dev-btn dev-btn--danger" data-act="discard" title="Throw away local edits and reload stops.json">Discard local edits</button>
      </div>
      <p class="dev-hud__keys">
        Fly: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · <kbd>Q</kbd>/<kbd>E</kbd> down/up · <kbd>Shift</kbd> faster ·
        left-drag orbit · right-drag move · middle-drag look<br />
        Stops: <kbd>[</kbd>/<kbd>]</kbd> reorder · <kbd>Del</kbd> delete · arrows to move between stops
      </p>
    </details>
    <p class="dev-hud__saved" data-state="saved" aria-live="polite">✓ Saved to project</p>
    <p class="dev-hud__status" role="status" aria-live="polite"></p>`;
  ui.appendChild(hud);

  const $ = <T extends HTMLElement>(sel: string) => hud.querySelector<T>(sel)!;
  const posEl = $('[data-f="pos"]');
  const targetEl = $('[data-f="target"]');
  const fovInput = $<HTMLInputElement>('[data-f="fov"]');
  const fovVal = $('[data-f="fovval"]');
  const statusEl = $('.dev-hud__status');

  let statusTimer = 0;
  const status = (msg: string, kind: 'ok' | 'warn' | 'busy' = 'ok') => {
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    statusEl.dataset.kind = kind;
    if (kind === 'ok') statusTimer = window.setTimeout(() => (statusEl.textContent = ''), 6000);
  };
  if (ctx.initialStatus) status(ctx.initialStatus);

  const fmt = (v: number[]) => v.map((n) => n.toFixed(2)).join(', ');
  let lastHud = 0;
  viewer.app.on('update', () => {
    const now = performance.now();
    if (now - lastHud < 100) return;
    lastHud = now;
    const p = viewer.getPose();
    posEl.textContent = fmt(p.position);
    targetEl.textContent = fmt(p.target);
    if (document.activeElement !== fovInput) fovInput.value = String(Math.round(p.fov));
    fovVal.textContent = `${p.fov.toFixed(0)}°`;
  });
  fovInput.addEventListener('input', () => {
    viewer.camera.camera!.fov = Number(fovInput.value);
  });

  // ---------------------------------------------------------------- saving
  // Every change is saved twice, automatically: to this browser (instant backup that survives a
  // reload) and, about a second later, into the project's public/ folder through the dev
  // server, which is what visitors see and what you commit. The ⌘S / Save button does the
  // project save immediately; if the dev server isn't there, it falls back to a folder or zip.
  const savedEl = $('.dev-hud__saved');
  let dirty = false; // changes not yet written into the project
  const showSaved = (state: 'saved' | 'saving' | 'unsaved', text?: string) => {
    savedEl.dataset.state = state;
    savedEl.textContent =
      text ?? (state === 'saved' ? '✓ Saved to project' : state === 'saving' ? 'Saving…' : '● Unsaved changes');
  };

  // Which thumbnails need writing. Saves write stops.json plus only the thumbnails that were
  // re-captured or renumbered since the last save, so a save can never overwrite good images on
  // disk with older ones it happens to hold in memory.
  const onDisk = new Map<Stop, string>(); // the id under which a stop's image is on disk
  const changedThumbs = new Set<Stop>(); // captured since the last save
  if (!ctx.restored) tour.stops.forEach((st) => onDisk.set(st, st.id));
  const needsWrite = (st: Stop) => changedThumbs.has(st) || onDisk.get(st) !== st.id;

  let localTimer = 0;
  let projectTimer = 0;
  const autosave = () => {
    dirty = true;
    showSaved('unsaved');
    clearTimeout(localTimer);
    localTimer = window.setTimeout(async () => {
      const ok = saveLocalEdits({ savedAt: Date.now(), data: tour.data, thumbs: await thumbs.snapshot(tour.stops) });
      if (!ok) status('Browser backup failed (storage full). Changes still save to the project.', 'warn');
    }, 300);
    clearTimeout(projectTimer);
    projectTimer = window.setTimeout(() => saveToProject(), 1000);
  };

  /** Writes stops.json + thumbnails into public/ via the dev server. Returns false if unavailable. */
  const saveToProject = async (): Promise<boolean> => {
    if (busy) {
      // a snap/thumbnail render is running; try again shortly
      clearTimeout(projectTimer);
      projectTimer = window.setTimeout(() => saveToProject(), 500);
      return false;
    }
    busy = true;
    try {
      showSaved('saving');
      const { files, written } = await collectFiles(needsWrite);
      if (await saveViaDevServer(files, tour.stops.map((st) => `${st.id}.webp`))) {
        // Each written stop's thumbnail is now exactly the image just written (so later saves
        // never re-read a file this save renamed), and it's on disk under its current id.
        for (const [st, blob] of written) {
          thumbs.set(st, blob);
          onDisk.set(st, st.id);
          changedThumbs.delete(st);
        }
        // Everything is in the project now; the browser backup only ever holds unsaved changes.
        clearTimeout(localTimer);
        clearLocalEdits();
        dirty = false;
        showSaved('saved');
        return true;
      }
      showSaved('unsaved', '● Not saved to project: press Save');
      return false;
    } finally {
      busy = false;
    }
  };

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  // ---------------------------------------------------------------- editor in the active card
  const editor = document.createElement('div');
  editor.className = 'dev-editor';
  editor.innerHTML = `
    <div class="dev-editor__head" data-e="head"></div>
    <label>Title <input type="text" maxlength="30" data-e="title" placeholder="e.g. M113 APC" /></label>
    <div class="dev-editor__row">
      <label>Drift
        <select data-e="drift">
          <option value="sway">Sway</option>
          <option value="orbit">Orbit</option>
          <option value="none">None</option>
        </select>
      </label>
      <button class="dev-btn dev-btn--danger" data-e="delete" type="button">Delete stop</button>
    </div>
    <div class="dev-editor__confirm" hidden>
      <span>Delete this stop?</span>
      <button class="dev-btn dev-btn--danger" data-e="confirm" type="button">Delete</button>
      <button class="dev-btn" data-e="cancel" type="button">Cancel</button>
    </div>`;
  const titleIn = editor.querySelector<HTMLInputElement>('[data-e="title"]')!;
  const headEl = editor.querySelector<HTMLElement>('[data-e="head"]')!;
  const driftIn = editor.querySelector<HTMLSelectElement>('[data-e="drift"]')!;
  const confirmRow = editor.querySelector<HTMLElement>('.dev-editor__confirm')!;
  const deleteBtn = editor.querySelector<HTMLButtonElement>('[data-e="delete"]')!;

  // The stop editor lives in the HUD, under the camera readout.
  hud.querySelector('.dev-hud__pose')!.after(editor);
  const mountEditor = () => {
    if (tour.index < 0) return;
    const stop = tour.stop;
    headEl.textContent = `Stop ${tour.index + 1} of ${tour.count}`;
    if (titleIn.value !== stop.title) titleIn.value = stop.title;
    driftIn.value = stop.drift ?? 'sway';
    confirmRow.hidden = true;
    deleteBtn.disabled = tour.count <= 1;
  };
  tour.onChange(mountEditor);
  tour.onStopsChanged(mountEditor);

  titleIn.addEventListener('input', () => {
    tour.stop.title = titleIn.value;
    carousel.setTitle(tour.index, titleIn.value);
    nav.refresh();
    autosave();
  });
  driftIn.addEventListener('change', () => {
    tour.stop.drift = driftIn.value as Drift;
    autosave();
  });
  // Esc leaves a text field so the keyboard shortcuts work again.
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
  });

  deleteBtn.addEventListener('click', () => askDelete());
  editor.querySelector('[data-e="cancel"]')!.addEventListener('click', () => (confirmRow.hidden = true));
  editor.querySelector('[data-e="confirm"]')!.addEventListener('click', () => deleteActive());

  // ---------------------------------------------------------------- actions
  let busy = false;
  const capture = async (stop: Stop) => {
    await viewer.waitForDetail();
    thumbs.set(stop, await viewer.captureImage());
    changedThumbs.add(stop);
  };

  const snap = async () => {
    if (busy) return;
    busy = true;
    try {
      const stop = tour.stop;
      stop.camera = roundPose(viewer.getPose());
      status(`Snapped ${stop.id}. Rendering thumbnail…`, 'busy');
      await capture(stop);
      tour.stopsChanged();
      autosave();
      status(`Snapped ${stop.id}.`);
    } finally {
      busy = false;
    }
  };

  const addStop = async () => {
    if (busy) return;
    busy = true;
    try {
      const at = tour.index + 1;
      const stop: Stop = {
        id: '',
        title: 'New stop',
        camera: roundPose(viewer.getPose()),
        thumbnail: '',
        drift: 'sway',
      };
      tour.stops.splice(at, 0, stop);
      tour.stopsChanged();
      tour.select(at);
      status(`Added ${stop.id}. Rendering thumbnail…`, 'busy');
      await capture(stop);
      tour.stopsChanged();
      autosave();
      status(`Added ${stop.id} after stop ${at}.`);
      titleIn.focus();
      titleIn.select();
    } finally {
      busy = false;
    }
  };

  const askDelete = () => {
    if (tour.count <= 1) return status('A tour needs at least one stop.', 'warn');
    confirmRow.hidden = false;
    editor.querySelector<HTMLButtonElement>('[data-e="confirm"]')!.focus();
  };

  const deleteActive = () => {
    const i = tour.index;
    const [removed] = tour.stops.splice(i, 1);
    tour.stopsChanged();
    tour.select(Math.min(i, tour.count - 1));
    autosave();
    status(`Deleted “${removed.title}”.`);
  };

  const move = (dir: -1 | 1) => {
    const i = tour.index;
    const j = i + dir;
    if (j < 0 || j >= tour.count) return;
    const stops = tour.stops;
    [stops[i], stops[j]] = [stops[j], stops[i]];
    tour.stopsChanged();
    tour.select(j);
    autosave();
    status(`Moved to position ${j + 1}.`);
  };

  const preview = async () => {
    const prev = tour.stops[(tour.index - 1 + tour.count) % tour.count];
    viewer.setPose(prev.camera);
    await viewer.flyTo(tour.stop.camera);
  };

  const rethumbAll = async () => {
    if (busy) return;
    busy = true;
    const start = tour.index;
    try {
      for (let i = 0; i < tour.count; i++) {
        status(`Rendering thumbnail ${i + 1} of ${tour.count}…`, 'busy');
        tour.select(i);
        await capture(tour.stop);
      }
      tour.stopsChanged();
      tour.select(start);
      autosave();
      status(`Re-rendered ${tour.count} thumbnails.`);
    } finally {
      busy = false;
    }
  };

  let discardArmed = 0;
  const discard = (btn: HTMLElement) => {
    if (performance.now() > discardArmed) {
      discardArmed = performance.now() + 4000;
      btn.textContent = 'Click again to discard';
      setTimeout(() => (btn.textContent = 'Discard local edits'), 4000);
      return;
    }
    clearLocalEdits();
    location.reload();
  };

  let exitArmed = 0;
  const exit = (btn: HTMLElement) => {
    if (dirty && performance.now() > exitArmed) {
      exitArmed = performance.now() + 4000;
      btn.textContent = 'Unsaved! Exit anyway?';
      setTimeout(() => (btn.textContent = 'Exit'), 4000);
      return;
    }
    dirty = false; // don't trigger the browser's own leave-page prompt as well
    toggleDevMode(false);
  };

  // ---------------------------------------------------------------- export
  /** stops.json plus the thumbnails `include` selects (default: all, for folder/zip export). */
  const collectFiles = async (include: (s: Stop) => boolean = () => true) => {
    const inOrder = tour.stops.every((s, i) => s.id === `stop-${i + 1}` && s.thumbnail === thumbPath(s.id));
    if (!inOrder) tour.stopsChanged();
    const chosen = tour.stops.filter(include);
    // Read every thumbnail before writing anything: renumbered stops may overwrite each other.
    const blobs = await Promise.all(chosen.map((s) => thumbs.blob(s)));
    const files = [{ path: 'stops.json', blob: new Blob([serializeTour(tour.data)], { type: 'application/json' }) }];
    const written: [Stop, Blob][] = [];
    chosen.forEach((s, i) => {
      const b = blobs[i];
      if (!b) return;
      files.push({ path: thumbPath(s.id), blob: b });
      written.push([s, b]);
    });
    return { files, written };
  };

  const exportAll = async () => {
    clearTimeout(projectTimer);
    // 1. Local dev server: write straight into public/ (no folder picker needed).
    if (await saveToProject()) {
      status('Saved into the project (public/). Review the diff and commit.');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      status('Saving…', 'busy');
      const { files } = await collectFiles();
      // 2. Chrome/Edge: write into a folder the user picks. 3. Anything else: a zip download.
      if ('showDirectoryPicker' in window) {
        try {
          const dir = await publicDir();
          await writeFiles(dir, files);
          dirty = false;
          showSaved('saved');
          const n = files.length - 1;
          status(`Saved stops.json and ${n} thumbnail${n === 1 ? '' : 's'} to public/. Review the diff and commit.`);
          return;
        } catch (err) {
          if ((err as DOMException).name === 'AbortError') return status('Export cancelled.', 'warn');
          if (err instanceof WrongFolderError) return status(err.message, 'warn');
          console.warn('Folder export failed, falling back to zip', err);
        }
      }
      await downloadZip(files);
      status('Downloaded tmvm-tour.zip. Unzip it into public/, then commit.');
    } catch (err) {
      console.error(err);
      status(`Export failed: ${(err as Error).message}`, 'warn');
    } finally {
      busy = false;
    }
  };

  // ---------------------------------------------------------------- wiring
  hud.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  hud.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'snap') snap();
    else if (act === 'add') addStop();
    else if (act === 'preview') preview();
    else if (act === 'export') exportAll();
    else if (act === 'rethumb') rethumbAll();
    else if (act === 'discard') discard(btn);
    else if (act === 'exit') exit(btn);
  });

  // ⌘S / Ctrl+S: capture phase, so it also works while typing in the title field.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopImmediatePropagation();
        exportAll();
      }
    },
    true,
  );

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) snap();
        break;
      case 'n':
      case 'N':
        if (!e.repeat) addStop();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        askDelete();
        break;
      case '[':
        move(-1);
        break;
      case ']':
        move(1);
        break;
      case 'p':
      case 'P':
        if (!e.repeat) preview();
        break;
    }
  });

  mountEditor();
}

// -------------------------------------------------------------------- File System Access

/** Writes via the Vite dev server's /__dev endpoints; false if they aren't there. */
async function saveViaDevServer(files: { path: string; blob: Blob }[], keepThumbs: string[]): Promise<boolean> {
  const endpoint = (p: string) => `/__dev/${p}`;
  try {
    for (const f of files) {
      const res = await fetch(`${endpoint('save')}?path=${encodeURIComponent(f.path)}`, { method: 'POST', body: f.blob });
      if (!res.ok) return false;
    }
    await fetch(endpoint('prune-thumbs'), { method: 'POST', body: JSON.stringify(keepThumbs) });
    return true;
  } catch {
    return false;
  }
}

class WrongFolderError extends Error {}

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};

let cachedDir: DirHandle | null = null;

/** The repo's public/ folder: remembered across reloads, picked by the user the first time. */
async function publicDir(): Promise<DirHandle> {
  let dir = cachedDir ?? (await idbGet<DirHandle>('publicDir'));
  if (dir && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
  }
  if (!dir) {
    const picker = (window as unknown as {
      showDirectoryPicker(o: object): Promise<DirHandle>;
    }).showDirectoryPicker;
    dir = await picker({ id: 'tmvm-public', mode: 'readwrite', startIn: 'documents' });
    try {
      await dir.getDirectoryHandle('model');
    } catch {
      throw new WrongFolderError(
        `“${dir.name}” has no model/ folder. Pick the repo’s public/ folder and export again.`,
      );
    }
    await idbSet('publicDir', dir);
  }
  cachedDir = dir;
  return dir;
}

async function writeFiles(dir: DirHandle, files: { path: string; blob: Blob }[]): Promise<void> {
  const thumbsDir = (await dir.getDirectoryHandle('thumbs', { create: true })) as DirHandle;
  const keep = new Set<string>();
  for (const f of files) {
    const [folder, name] = f.path.includes('/') ? f.path.split('/') : [null, f.path];
    const target = folder ? thumbsDir : dir;
    if (folder) keep.add(name);
    const handle = await target.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(f.blob);
    await w.close();
  }
  // Remove thumbnails of stops that no longer exist (after deletes).
  for await (const [name, handle] of thumbsDir.entries()) {
    if (handle.kind === 'file' && /^stop-\d+\.webp$/.test(name) && !keep.has(name)) {
      await thumbsDir.removeEntry(name);
    }
  }
}

async function downloadZip(files: { path: string; blob: Blob }[]): Promise<void> {
  const entries = await Promise.all(
    files.map(async (f) => ({ path: f.path, data: new Uint8Array(await f.blob.arrayBuffer()) })),
  );
  const url = URL.createObjectURL(createZip(entries));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tmvm-tour.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// -------------------------------------------------------------------- tiny IndexedDB kv

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tmvm-dev', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    }).finally(() => db.close()) as T | null;
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* remembering the folder is a nicety */
  }
}

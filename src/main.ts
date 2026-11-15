import './styles.css';
import { type Carousel, createCarousel, createNav, isTyping } from './carousel';
import { DEV_TOGGLE_KEY, initDevMode, isLocalhost, toggleDevMode } from './devmode';
import { ThumbStore, loadLocalEdits } from './thumbs';
import { type Stop, Tour, loadTour } from './tour';
import { Vec3 } from 'playcanvas';
import { Viewer, type Pose } from './viewer';
import { WalkMode } from './walk';

const base = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);
/** Dev mode (tour authoring) is only ever on with ?dev=1. */
const dev = params.get('dev') === '1';

const loader = document.getElementById('loader')!;
const fill = loader.querySelector<HTMLElement>('.loader__fill')!;
const bar = loader.querySelector<HTMLElement>('.loader__bar')!;
const label = loader.querySelector<HTMLElement>('.loader__label')!;
const enterBtn = loader.querySelector<HTMLButtonElement>('.loader__enter')!;
const ui = document.getElementById('ui')!;

const setProgress = (f: number) => {
  const pct = Math.round(Math.min(1, Math.max(0, f)) * 100);
  fill.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
};

function showSplashImage(url: string) {
  const bg = loader.querySelector<HTMLElement>('.loader__bg')!;
  const img = new Image();
  img.onload = () => {
    bg.style.backgroundImage = `url("${url}")`;
    bg.classList.add('is-loaded');
  };
  img.src = url;
}

const ENTER_FALLBACK_MS = 10_000;

// ---- Intro: the "assembly" reveal ---------------------------------------------------------
const FLOOR_Y = -1.4; // the hangar floor, world y (see the spec, Step 0)
const HALL_RADIUS = 75; // m: the reveal wave covers the whole hall from anywhere in it
const INTRO_GLIDE_S = 4.5;
const INTRO_UI_DELAY_MS = 2600;

/**
 * After ENTER: the scan starts empty; gold sparks ripple out across the floor from where the
 * start view looks, a warm wave follows and grows them into the scan, while the camera cranes in
 * from higher and further back to the stop's view, where its idle drift then starts.
 */
function playIntro(viewer: Viewer, stop: Stop) {
  const pose = stop.camera;
  const p = new Vec3(...pose.position);
  const t = new Vec3(...pose.target);
  const dir = t.clone().sub(p).normalize();

  // Where the view's centre meets the floor: the wave's origin.
  const center =
    dir.y < -0.05
      ? p.clone().add(dir.clone().mulScalar((FLOOR_Y - p.y) / dir.y))
      : new Vec3(t.x, FLOOR_Y, t.z);

  // Crane in: start further back along the view and higher, slightly wider.
  const back = Math.min(8, Math.max(3, p.distance(t) * 0.3));
  const start = p.clone().sub(dir.clone().mulScalar(back)).add(new Vec3(0, 2.5, 0));
  viewer.setPose({ position: [start.x, start.y, start.z], target: pose.target, fov: pose.fov + 8 });
  viewer.flyTo(pose, INTRO_GLIDE_S).then((result) => {
    if (result === 'arrived') viewer.startDrift(stop.drift ?? 'sway', pose);
  });
  viewer.reveal(center, HALL_RADIUS);
}

/**
 * Resolves when the visitor presses ENTER. The button appears once the first view is fully sharp,
 * or after ENTER_FALLBACK_MS so nobody waits on a slow connection (detail keeps streaming).
 */
function waitForEnter(viewer: Viewer): Promise<void> {
  label.textContent = 'Sharpening the first view…';
  let shown = false;
  const show = (sharp: boolean) => {
    if (shown) {
      if (sharp) label.textContent = '';
      return;
    }
    shown = true;
    loader.classList.add('is-ready');
    enterBtn.hidden = false;
    enterBtn.focus({ preventScroll: true });
    label.textContent = sharp ? '' : 'Detail is still loading. You can enter now.';
  };
  const fallback = window.setTimeout(() => show(false), ENTER_FALLBACK_MS);
  viewer
    .waitForDetail(120_000, (f) => setProgress(0.35 + 0.65 * f))
    .then(() => {
      clearTimeout(fallback);
      setProgress(1);
      show(true);
    });
  return new Promise((resolve) => enterBtn.addEventListener('click', () => resolve(), { once: true }));
}

const TIP_KEY = 'tmvm-carousel-tip-seen';

/** A one-time hint pointing at the carousel; gone on first use, never shown again. */
function showCarouselTip(tour: Tour, carousel: Carousel) {
  try {
    if (localStorage.getItem(TIP_KEY)) return;
  } catch {
    /* storage blocked: show it anyway */
  }
  const tip = document.createElement('div');
  tip.className = 'carousel-tip';
  tip.setAttribute('role', 'note');
  tip.innerHTML = `Scroll or click a card to visit a vehicle
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;
  ui.appendChild(tip);
  requestAnimationFrame(() => tip.classList.add('is-on'));

  const dismiss = () => {
    tip.classList.remove('is-on');
    setTimeout(() => tip.remove(), 400);
    try {
      localStorage.setItem(TIP_KEY, '1');
    } catch {
      /* fine */
    }
  };
  tour.onChange(dismiss);
  carousel.el.addEventListener('wheel', dismiss, { once: true, passive: true });
  carousel.el.addEventListener('pointerdown', dismiss, { once: true });
  setTimeout(dismiss, 12_000);
}

async function start() {
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  try {
    let data = await loadTour(`${base}stops.json`);
    const thumbs = new ThumbStore(base);

    // Dev mode resumes unexported edits saved in this browser.
    const edits = dev ? loadLocalEdits() : null;
    if (edits) data = edits.data;
    const tour = new Tour(data);
    if (edits) await thumbs.restore(tour.stops, edits.thumbs);
    loader.querySelector('.loader__title')!.textContent = data.title;
    loader.querySelector('.loader__subtitle')!.textContent = data.subtitle;
    ui.querySelector('.brand__title')!.textContent = data.title;
    ui.querySelector('.brand__subtitle')!.textContent = data.subtitle;

    // The splash shows the start stop's thumbnail, blurred, while the scan loads.
    const startStop = tour.stops[tour.startIndex()];
    showSplashImage(thumbs.url(startStop));

    // The UI is built now (so thumbnails load while the model streams) but stays hidden under the
    // splash until the visitor presses ENTER.
    const nav = createNav(tour, ui);
    // The drum; visitors who prefer reduced motion get a plain list instead.
    const carousel = createCarousel(tour, ui, {
      thumbUrl: (stop) => thumbs.url(stop),
      mode: reducedMotion.matches ? 'flat' : 'drum',
    });

    const viewer = await Viewer.create({
      canvas,
      // ?model= and ?budget= are for testing streaming settings; visitors never use them.
      modelUrl: new URL(params.get('model') ?? data.model, new URL(base, location.href)).href,
      splatBudget: Number(params.get('budget')) || undefined,
      minCameraY: FLOOR_Y + 0.3,
      initialPose: startStop.camera,
      showStats: params.has('stats'),
      // First, the coarse scan: the first 35% of the bar.
      onProgress: (f) => setProgress(0.35 * f),
    });

    wireTransitions(tour, viewer, canvas, carousel);
    const walk = new WalkMode(viewer, canvas, `${base}collision/hangar`);
    wireWalk(walk, nav.el, tour, carousel);
    Object.assign(window, { walk });
    tour.start();
    if (dev) {
      const when = edits ? new Date(edits.savedAt).toLocaleString() : '';
      initDevMode({
        tour,
        viewer,
        carousel,
        nav,
        thumbs,
        ui,
        initialStatus: edits ? `Restored unsaved edits from ${when}.` : undefined,
        restored: !!edits,
      });
    }

    // Then the first view sharpens; ENTER appears once it's sharp (or after 10 s, while detail
    // keeps streaming). Dev mode skips the splash.
    if (!dev) await waitForEnter(viewer);
    const cinematic = !dev && !reducedMotion.matches;
    if (cinematic) playIntro(viewer, tour.stop);
    loader.classList.add('is-done');
    // Let the reveal play unobstructed, then bring in the title, bar and carousel.
    if (cinematic) await new Promise((r) => setTimeout(r, INTRO_UI_DELAY_MS));
    ui.classList.add('is-live');
    canvas.focus();
    if (!dev) showCarouselTip(tour, carousel);
    // Handy for debugging in the console.
    Object.assign(window, { viewer, tour, thumbs });
  } catch (err) {
    console.error(err);
    loader.classList.add('is-error');
    label.textContent = 'Could not load the scan. Try a recent Chrome, Edge or Safari.';
  }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const FADE_MS = 150; // each half of the 300 ms reduced-motion cross-fade


/**
 * Stop changes fly the camera (or fade, with reduced motion), then start the stop's idle drift.
 * Any input on the canvas stops the motion and hands control to the user; the active card then
 * offers "Back to view".
 */
function wireTransitions(tour: Tour, viewer: Viewer, canvas: HTMLCanvasElement, carousel: Carousel) {
  const fade = document.getElementById('fade')!;
  let fadeToken = 0;

  /** Resolves true once the new view is showing, or false if a newer selection took over. */
  const fadeTo = async (pose: Pose): Promise<boolean> => {
    const token = ++fadeToken;
    fade.classList.add('is-on');
    await new Promise((r) => setTimeout(r, FADE_MS));
    if (token !== fadeToken) return false;
    viewer.setPose(pose);
    // Give the new view a frame to render before revealing it.
    requestAnimationFrame(() => requestAnimationFrame(() => fade.classList.remove('is-on')));
    return true;
  };

  const arrive = (stop: Stop) => {
    if (tour.stop !== stop) return; // the user has moved on
    // No idle drift while authoring: it would move the camera you're composing.
    if (!reducedMotion.matches && !dev) viewer.startDrift(stop.drift ?? 'sway', stop.camera);
  };

  const showStop = async (stop: Stop, instant: boolean) => {
    carousel.setTakenOver(false);
    if (instant) {
      viewer.setPose(stop.camera);
      arrive(stop);
    } else if (reducedMotion.matches) {
      if (await fadeTo(stop.camera)) arrive(stop);
    } else if ((await viewer.flyTo(stop.camera)) === 'arrived') {
      arrive(stop);
    }
  };

  tour.onChange(({ stop, initial }) => showStop(stop, initial));
  carousel.onBackToView(() => showStop(tour.stop, false));

  // Any direct camera input hands control to the user at the current view.
  const takeOver = () => {
    viewer.takeOver();
    carousel.setTakenOver(true);
  };
  canvas.addEventListener('pointerdown', takeOver, true);
  canvas.addEventListener('wheel', takeOver, { capture: true, passive: true });
  const flyKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
  window.addEventListener('keydown', (e) => {
    if (flyKeys.has(e.code) && !e.metaKey && !e.ctrlKey && !isTyping(e.target)) takeOver();
  });
}

/** The Walk button in the nav bar, the on-screen hint, and leaving walk mode on stop changes. */
function wireWalk(walk: WalkMode, nav: HTMLElement, tour: Tour, carousel: Carousel) {
  const btn = document.createElement('button');
  btn.className = 'nav__walk';
  btn.type = 'button';
  btn.setAttribute('aria-pressed', 'false');
  btn.title = 'Walk through the museum: click the floor to walk there, drag to look, WASD, Esc to stop';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 2 3M10 8l1 7"/></svg>
    <span>Walk</span>`;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    btn.disabled = true;
    walk.toggle().finally(() => (btn.disabled = false));
  });
  nav.appendChild(btn);

  const hint = document.createElement('div');
  hint.className = 'walk-hint';
  hint.innerHTML = 'Click the floor to walk there · drag to look · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk · <kbd>Esc</kbd> stop';
  nav.parentElement!.appendChild(hint);

  walk.onChange((on) => {
    btn.setAttribute('aria-pressed', String(on));
    hint.classList.toggle('is-on', on);
  });
  tour.onChange(() => walk.exit());
  carousel.onBackToView(() => walk.exit());
}

// Typing in a text field must never drive the camera. PlayCanvas's CameraControls listens for
// keys on window (bubble phase), so stop key presses from inputs at the document. Only keydown:
// a keyup that gets through just releases a key the controls never saw pressed (harmless), whereas
// blocking keyup could leave a key "held" if it was pressed before focusing the field.
document.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) e.stopPropagation();
});

// On localhost, the ` key switches dev mode on/off (reloads with or without ?dev=1).
// (The spec suggested D, but D is also "strafe right" when flying with WASD.)
if (isLocalhost()) {
  window.addEventListener('keydown', (e) => {
    if (e.key === DEV_TOGGLE_KEY && !isTyping(e.target) && !e.metaKey && !e.ctrlKey) toggleDevMode(!dev);
  });
}

start();

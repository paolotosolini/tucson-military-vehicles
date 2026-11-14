import './styles.css';
import { type Carousel, createCarousel, createNav, isTyping } from './carousel';
import { DEV_TOGGLE_KEY, initDevMode, isLocalhost, toggleDevMode } from './devmode';
import { ThumbStore, loadLocalEdits } from './thumbs';
import { type Stop, Tour, loadTour } from './tour';
import { Viewer, type Pose } from './viewer';

const base = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);
/** Dev mode (tour authoring) is only ever on with ?dev=1. */
const dev = params.get('dev') === '1';

const loader = document.getElementById('loader')!;
const fill = loader.querySelector<HTMLElement>('.loader__fill')!;
const label = loader.querySelector<HTMLElement>('.loader__label')!;
const ui = document.getElementById('ui')!;

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

    // UI is built straight away (the carousel's thumbnails can load while the model streams).
    const nav = createNav(tour, ui);
    // The drum; visitors who prefer reduced motion get a plain list instead.
    const carousel = createCarousel(tour, ui, {
      thumbUrl: (stop) => thumbs.url(stop),
      mode: reducedMotion.matches ? 'flat' : 'drum',
    });
    ui.classList.add('is-ready');

    const startStop = tour.stops[tour.startIndex()];
    const viewer = await Viewer.create({
      canvas,
      modelUrl: new URL(data.model, new URL(base, location.href)).href,
      initialPose: startStop.camera,
      showStats: params.has('stats'),
      onProgress: (f) => {
        fill.style.width = `${Math.round(f * 100)}%`;
      },
    });

    wireTransitions(tour, viewer, canvas, carousel);
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
        initialStatus: edits ? `Restored local edits from ${when}.` : undefined,
      });
    }

    loader.classList.add('is-done');
    ui.classList.add('is-live');
    canvas.focus();
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

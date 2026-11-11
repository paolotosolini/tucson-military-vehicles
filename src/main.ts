import './styles.css';
import { createNav } from './carousel';
import { Tour, loadTour } from './tour';
import { Viewer, type Pose } from './viewer';

const base = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);

const loader = document.getElementById('loader')!;
const fill = loader.querySelector<HTMLElement>('.loader__fill')!;
const label = loader.querySelector<HTMLElement>('.loader__label')!;
const ui = document.getElementById('ui')!;

async function start() {
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  try {
    const data = await loadTour(`${base}stops.json`);
    const tour = new Tour(data);
    loader.querySelector('.loader__title')!.textContent = data.title;
    loader.querySelector('.loader__subtitle')!.textContent = data.subtitle;

    // UI is built straight away (the carousel's thumbnails can load while the model streams).
    createNav(tour, ui);

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

    wireTransitions(tour, viewer, canvas);
    tour.start();

    loader.classList.add('is-done');
    ui.classList.add('is-ready');
    canvas.focus();
    // Handy for debugging in the console.
    Object.assign(window, { viewer, tour });
  } catch (err) {
    console.error(err);
    loader.classList.add('is-error');
    label.textContent = 'Could not load the scan. Try a recent Chrome, Edge or Safari.';
  }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const FADE_MS = 150; // each half of the 300 ms reduced-motion cross-fade

/** Stop changes fly the camera (or fade, with reduced motion); user input cancels a flight. */
function wireTransitions(tour: Tour, viewer: Viewer, canvas: HTMLCanvasElement) {
  const fade = document.getElementById('fade')!;
  let fadeToken = 0;

  const fadeTo = async (pose: Pose) => {
    const token = ++fadeToken;
    fade.classList.add('is-on');
    await new Promise((r) => setTimeout(r, FADE_MS));
    if (token !== fadeToken) return; // a newer selection took over
    viewer.setPose(pose);
    // Give the new view a frame to render before revealing it.
    requestAnimationFrame(() => requestAnimationFrame(() => fade.classList.remove('is-on')));
  };

  tour.onChange(({ stop, initial }) => {
    if (initial) viewer.setPose(stop.camera);
    else if (reducedMotion.matches) fadeTo(stop.camera);
    else viewer.flyTo(stop.camera);
  });

  // Any direct camera input during a flight hands control to the user at the current view.
  const interrupt = () => viewer.interruptFlight();
  canvas.addEventListener('pointerdown', interrupt, true);
  canvas.addEventListener('wheel', interrupt, { capture: true, passive: true });
  const flyKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
  window.addEventListener('keydown', (e) => {
    if (flyKeys.has(e.code) && !e.metaKey && !e.ctrlKey) interrupt();
  });
}

start();

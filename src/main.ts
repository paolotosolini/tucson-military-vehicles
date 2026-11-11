import './styles.css';
import { createNav } from './carousel';
import { Tour, loadTour } from './tour';
import { Viewer } from './viewer';

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

    // Step 3: every stop change jumps instantly. Flights arrive in Step 4.
    tour.onChange(({ stop }) => viewer.setPose(stop.camera));
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

start();

import './styles.css';
import { Viewer, type Pose } from './viewer';

// Temporary start pose until stops.json arrives in Step 3: street level, looking across the yard.
const START_POSE: Pose = { position: [-15, 4, -5], target: [0, 1, -20], fov: 60 };

const base = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);

const loader = document.getElementById('loader')!;
const fill = loader.querySelector<HTMLElement>('.loader__fill')!;
const label = loader.querySelector<HTMLElement>('.loader__label')!;

async function start() {
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  try {
    const viewer = await Viewer.create({
      canvas,
      modelUrl: `${base}model/lod-meta.json`,
      initialPose: START_POSE,
      showStats: params.has('stats'),
      onProgress: (f) => {
        fill.style.width = `${Math.round(f * 100)}%`;
      },
    });
    loader.classList.add('is-done');
    canvas.focus();
    // Handy for debugging in the console.
    (window as unknown as { viewer: Viewer }).viewer = viewer;
  } catch (err) {
    console.error(err);
    loader.classList.add('is-error');
    label.textContent = 'Could not load the scan. Try a recent Chrome, Edge or Safari.';
  }
}

start();

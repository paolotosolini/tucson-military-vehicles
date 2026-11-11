import type { Tour } from './tour';

const KEYS: Record<string, 'prev' | 'next' | 'home'> = {
  ArrowLeft: 'prev',
  ArrowUp: 'prev',
  ArrowRight: 'next',
  ArrowDown: 'next',
  Home: 'home',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Bottom-left navigation: Home, tour title, Previous / Next and the "2 / 10" counter, plus keys.
 * Previous / Next loop round at the ends.
 * (The side rail of cards joins this module in Step 5.)
 */
export function createNav(tour: Tour, root: HTMLElement): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.setAttribute('aria-label', 'Tour navigation');
  nav.innerHTML = `
    <button class="nav__btn nav__home" data-dir="home" aria-label="Back to overview" title="Back to overview (Home)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7"/><path d="M6 10v9h4v-5h4v5h4v-9"/></svg>
    </button>
    <span class="nav__title"></span>
    <div class="nav__controls">
      <button class="nav__btn" data-dir="prev" aria-label="Previous stop">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <span class="nav__counter" aria-live="polite"></span>
      <button class="nav__btn" data-dir="next" aria-label="Next stop">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>`;
  root.appendChild(nav);

  nav.querySelector<HTMLElement>('.nav__title')!.textContent = tour.data.title;
  const counter = nav.querySelector<HTMLElement>('.nav__counter')!;
  const prevBtn = nav.querySelector<HTMLButtonElement>('[data-dir="prev"]')!;
  const nextBtn = nav.querySelector<HTMLButtonElement>('[data-dir="next"]')!;
  const homeBtn = nav.querySelector<HTMLButtonElement>('[data-dir="home"]')!;

  prevBtn.addEventListener('click', () => tour.prev());
  nextBtn.addEventListener('click', () => tour.next());
  homeBtn.addEventListener('click', () => tour.home());

  const render = () => {
    counter.textContent = `${tour.index + 1} / ${tour.count}`;
    homeBtn.disabled = tour.isHome;
  };
  tour.onChange(render);

  // Arrow keys navigate stops; Home returns to the overview. PlayCanvas's CameraControls also
  // binds arrows to flying and listens on window (bubble), so claim them in the capture phase —
  // keydown *and* keyup, or its key state would see an unmatched release.
  const onKey = (e: KeyboardEvent) => {
    const dir = KEYS[e.key];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown') tour[dir]();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  return nav;
}

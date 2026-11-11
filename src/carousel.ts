import type { Stop, Tour } from './tour';

const KEYS: Record<string, 'prev' | 'next' | 'home'> = {
  ArrowLeft: 'prev',
  ArrowUp: 'prev',
  ArrowRight: 'next',
  ArrowDown: 'next',
  Home: 'home',
};

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Bottom-left navigation: Home, tour title, Previous / Next and the "2 / 10" counter, plus keys.
 * Previous / Next loop round at the ends.
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

  // Mouse clicks shouldn't leave focus (and a focus ring) on the buttons, or later key presses
  // would show it. Keyboard users can still Tab to them.
  for (const btn of [prevBtn, nextBtn, homeBtn]) btn.addEventListener('mousedown', (e) => e.preventDefault());

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

/** Delay after the rail stops scrolling before the centred card is selected. */
const SCROLL_SELECT_MS = 250;

export interface CarouselOptions {
  /** URL for a stop's thumbnail (dev mode swaps in freshly captured ones). */
  thumbUrl: (stop: Stop) => string;
}

export interface Carousel {
  el: HTMLElement;
  /** Re-renders all cards (after stops are edited). */
  render(): void;
  /** The card element for a stop index. */
  card(index: number): HTMLElement | undefined;
}

/**
 * The right-hand rail: one card per stop. The active card is expanded (thumbnail, title,
 * description) and highlighted; the rest show thumbnail and title. Clicking a card selects it;
 * scrolling the rail snaps to the nearest card and selects it once scrolling settles.
 */
export function createCarousel(tour: Tour, root: HTMLElement, opts: CarouselOptions): Carousel {
  const rail = document.createElement('aside');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Tour stops');
  const list = document.createElement('ol');
  list.className = 'rail__list';
  rail.appendChild(list);
  root.appendChild(rail);

  let cards: HTMLElement[] = [];

  const render = () => {
    list.replaceChildren();
    cards = tour.stops.map((stop, i) => {
      const li = document.createElement('li');
      li.className = 'card';
      li.dataset.index = String(i);
      li.innerHTML = `
        <div class="card__select" role="button" tabindex="0">
          <div class="card__thumb">
            <img alt="" decoding="async" draggable="false" />
            <span class="card__num">${i + 1}</span>
          </div>
          <h3 class="card__title"></h3>
        </div>
        <div class="card__more"><div class="card__more-inner">
          <p class="card__desc"></p>
          <div class="card__actions"></div>
        </div></div>`;
      li.querySelector('.card__title')!.textContent = stop.title;
      li.querySelector('.card__desc')!.textContent = stop.description;
      const img = li.querySelector('img')!;
      img.addEventListener('error', () => li.classList.add('no-thumb'));
      img.addEventListener('load', () => li.classList.remove('no-thumb'));
      img.src = opts.thumbUrl(stop);

      const select = li.querySelector<HTMLElement>('.card__select')!;
      select.addEventListener('mousedown', (e) => e.preventDefault()); // no focus ring on click
      select.addEventListener('click', () => tour.goTo(i));
      select.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          tour.goTo(i);
        }
      });
      list.appendChild(li);
      return li;
    });
    mark(false);
  };

  // --- Active state and scroll-into-view -------------------------------------------------
  let programmatic = 0; // timestamp until which scroll events are ours, not the user's

  const mark = (scroll: boolean) => {
    cards.forEach((c, i) => {
      const active = i === tour.index;
      c.classList.toggle('is-active', active);
      c.querySelector('.card__select')!.setAttribute('aria-current', active ? 'step' : 'false');
    });
    if (scroll) scrollToActive('smooth');
  };

  let recentre = 0;
  const scrollToActive = (behavior: ScrollBehavior) => {
    const index = tour.index;
    const c = cards[index];
    if (!c) return;
    programmatic = performance.now() + 900;
    requestAnimationFrame(() => c.scrollIntoView({ block: 'center', behavior }));
    // Cards expand/collapse over 300 ms, which shifts the layout under the scroll; re-centre
    // once that settles.
    clearTimeout(recentre);
    recentre = window.setTimeout(() => {
      if (tour.index !== index) return;
      programmatic = performance.now() + 600;
      c.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 340);
  };

  tour.onChange(({ initial }) => {
    mark(false);
    scrollToActive(initial ? 'instant' : 'smooth');
  });

  // --- Wheel / trackpad scrolling selects the centred card after a pause ------------------
  let settleTimer = 0;
  rail.addEventListener(
    'scroll',
    () => {
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (performance.now() < programmatic) return;
        const i = centredCard();
        if (i >= 0 && i !== tour.index) tour.goTo(i);
      }, SCROLL_SELECT_MS);
    },
    { passive: true },
  );
  // A user wheel gesture always wins over our own pending smooth scroll.
  rail.addEventListener('wheel', () => (programmatic = 0), { passive: true });
  rail.addEventListener('touchstart', () => (programmatic = 0), { passive: true });

  const centredCard = (): number => {
    const r = rail.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    let best = -1;
    let bestDist = Infinity;
    cards.forEach((c, i) => {
      const cr = c.getBoundingClientRect();
      const d = Math.abs(cr.top + cr.height / 2 - mid);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  tour.onStopsChanged(() => {
    render();
    scrollToActive('instant');
  });

  render();
  return { el: rail, render, card: (i) => cards[i] };
}

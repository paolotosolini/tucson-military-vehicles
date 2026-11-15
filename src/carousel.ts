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

export interface Nav {
  el: HTMLElement;
  /** Re-reads the active stop's title (after a dev-mode edit). */
  refresh(): void;
}

/**
 * Bottom-left navigation: Home, the active stop's title, Previous / Next and the "2 / 10"
 * counter, plus keys. Previous / Next loop round at the ends.
 */
export function createNav(tour: Tour, root: HTMLElement): Nav {
  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.setAttribute('aria-label', 'Tour navigation');
  nav.innerHTML = `
    <button class="nav__btn nav__home" data-dir="home" aria-label="Back to overview" title="Back to overview (Home)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7"/><path d="M6 10v9h4v-5h4v5h4v-9"/></svg>
    </button>
    <span class="nav__title" aria-live="polite"></span>
    <div class="nav__controls">
      <button class="nav__btn" data-dir="prev" aria-label="Previous stop">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <span class="nav__counter"></span>
      <button class="nav__btn" data-dir="next" aria-label="Next stop">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>`;
  root.appendChild(nav);

  const title = nav.querySelector<HTMLElement>('.nav__title')!;
  const counter = nav.querySelector<HTMLElement>('.nav__counter')!;
  const prevBtn = nav.querySelector<HTMLButtonElement>('[data-dir="prev"]')!;
  const nextBtn = nav.querySelector<HTMLButtonElement>('[data-dir="next"]')!;
  const homeBtn = nav.querySelector<HTMLButtonElement>('[data-dir="home"]')!;
  title.textContent = tour.data.title;

  prevBtn.addEventListener('click', () => tour.prev());
  nextBtn.addEventListener('click', () => tour.next());
  homeBtn.addEventListener('click', () => tour.home());

  // Mouse clicks shouldn't leave focus (and a focus ring) on the buttons, or later key presses
  // would show it. Keyboard users can still Tab to them.
  for (const btn of [prevBtn, nextBtn, homeBtn]) btn.addEventListener('mousedown', (e) => e.preventDefault());

  const refresh = () => {
    if (tour.index < 0) return;
    title.textContent = tour.stop.title || tour.data.title;
    counter.textContent = `${tour.index + 1} / ${tour.count}`;
    homeBtn.disabled = tour.isHome;
  };
  tour.onChange(refresh);
  tour.onStopsChanged(refresh);

  // Arrow keys navigate stops; Home returns to the overview. PlayCanvas's CameraControls also
  // binds arrows to flying and listens on window (bubble), so claim them in the capture phase —
  // keydown *and* keyup, or its key state would see an unmatched release.
  const onKey = (e: KeyboardEvent) => {
    const dir = KEYS[e.key];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
    if (!root.classList.contains('is-live')) return; // still on the splash screen
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown') tour[dir]();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  return { el: nav, refresh };
}

// =============================================================================================
// The rail: stop cards in 3D
// =============================================================================================

/**
 * How cards are laid out:
 * - `drum`: on a cylinder rolling around a horizontal axis; looping rolls straight on (10 → 1).
 * - `flat`: a plain vertical stack, for visitors who prefer reduced motion.
 * - `strip`: a horizontal row along the bottom of a portrait phone screen, with a gentle Cover
 *   Flow tilt; swiped sideways.
 */
export type RailMode = 'drum' | 'flat' | 'strip';

const CARD_H = 169; // 300 × 169 ≈ 16:9 (width set in CSS)
const GAP = 18;
const PITCH = CARD_H + GAP;
const STRIP_W = 196; // strip cards are narrower (width set in CSS)
const STRIP_PITCH = STRIP_W + 14;
/** Pixels of drag that move the rail by one card, along its axis. */
const pitchFor = (mode: RailMode) => (mode === 'strip' ? STRIP_PITCH : PITCH);

interface Placement {
  x: number;
  y: number;
  z: number;
  rx: number; // degrees; positive tips the top edge away from the viewer
  ry: number; // degrees; strip cards turn slightly towards the centre
  opacity: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where a card `d` positions away from the centre sits (d may be fractional mid-animation). */
function place(mode: RailMode, d: number, count: number): Placement {
  const a = Math.abs(d);
  if (mode === 'drum') {
    // A wider drum than "count cards around the circle" would give: 24° apart keeps 3 cards
    // readable either side of the centre. The back of the drum is never visible, so looping
    // still reads as rolling on.
    const step = (Math.min(24, 360 / count) * Math.PI) / 180;
    const radius = PITCH / (2 * Math.tan(step / 2));
    const angle = -d * step; // cards above the centre (d < 0) rotate up and back
    const facing = Math.cos(angle);
    return {
      x: 0,
      y: -radius * Math.sin(angle),
      z: radius * facing - radius,
      rx: (angle * 180) / Math.PI,
      ry: 0,
      opacity: clamp((facing - 0.25) / 0.35, 0, 1),
    };
  }
  if (mode === 'strip') {
    const t = clamp(d, -1, 1);
    return {
      x: d * STRIP_PITCH - Math.sign(d) * Math.min(a, 1) * 18, // neighbours tuck in a little
      y: 0,
      z: -Math.min(a, 1) * 70 - Math.max(0, a - 1) * 20,
      rx: 0,
      ry: -t * 28,
      opacity: clamp(3.4 - a, 0, 1),
    };
  }
  return { x: 0, y: d * PITCH, z: 0, rx: 0, ry: 0, opacity: clamp(4.2 - a, 0, 1) };
}

export interface CarouselOptions {
  /** URL for a stop's thumbnail (dev mode swaps in freshly captured ones). */
  thumbUrl: (stop: Stop) => string;
  mode: RailMode;
}

export interface Carousel {
  el: HTMLElement;
  /** Re-renders all cards (after stops are edited). */
  render(): void;
  /** Updates one card's title in place (live dev-mode editing). */
  setTitle(index: number, title: string): void;
  /** Shows "Back to view" on the active card once the user has moved the camera themselves. */
  setTakenOver(takenOver: boolean): void;
  /** Switches layout (e.g. drum ↔ strip when a phone rotates). */
  setMode(mode: RailMode): void;
  onBackToView(fn: () => void): void;
}

/**
 * The right-hand rail. Cards float over the scene in 3D around a continuous position `pos`
 * (0 = first stop centred). Next/Prev/keys/clicks animate `pos` to the selected stop; wheel and
 * vertical drag spin it freely, then it settles on the nearest card and selects it after a pause.
 */
export function createCarousel(tour: Tour, root: HTMLElement, opts: CarouselOptions): Carousel {
  const rail = document.createElement('aside');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Tour stops');
  const stage = document.createElement('div');
  stage.className = 'rail__stage';
  rail.appendChild(stage);
  root.appendChild(rail);

  let mode = opts.mode;
  let cards: HTMLElement[] = [];
  const backListeners: (() => void)[] = [];

  // ---- rendering ------------------------------------------------------------------------
  const render = () => {
    stage.replaceChildren();
    cards = tour.stops.map((stop, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.index = String(i);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.innerHTML = `
        <img alt="" decoding="async" draggable="false" />
        <span class="card__num">${i + 1}</span>
        <span class="card__title"></span>
        <button class="card__back" type="button" tabindex="-1">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14l-4-4 4-4"/><path d="M5 10h9a5 5 0 0 1 0 10h-3"/></svg>
          Back to view
        </button>`;
      card.querySelector('.card__title')!.textContent = stop.title;
      card.setAttribute('aria-label', `Stop ${i + 1}: ${stop.title}`);
      const img = card.querySelector('img')!;
      img.addEventListener('error', () => card.classList.add('no-thumb'));
      img.addEventListener('load', () => card.classList.remove('no-thumb'));
      img.src = opts.thumbUrl(stop);

      card.addEventListener('mousedown', (e) => e.preventDefault()); // no focus ring on click
      // (Clicks are handled once, on the rail: see cardAt().)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          tour.goTo(i);
        }
      });
      stage.appendChild(card);
      return card;
    });
    markActive();
    layout();
  };

  const markActive = () => {
    cards.forEach((c, i) => {
      const active = i === tour.index;
      c.classList.toggle('is-active', active);
      c.setAttribute('aria-current', active ? 'step' : 'false');
      c.querySelector<HTMLButtonElement>('.card__back')!.tabIndex = active ? 0 : -1;
    });
  };

  // ---- motion: one damped spring drives the rail --------------------------------------------
  // `pos` (fractional stop index at the centre) follows `target` like a mass on a spring.
  // - Wheel moves the target, so notchy mouse wheels glide instead of jumping.
  // - Drag moves `pos` directly; on release it keeps its velocity, coasts towards a projected
  //   card and settles there.
  // - Next / Prev / clicks just set the target.
  // After wheel or drag input the target snaps to a whole card; once the rail has nearly come to
  // rest on it, that card is selected (so fast spins never fly the camera to every card).
  const STIFFNESS = 160; // ω² — ω ≈ 12.6 rad/s
  const DAMPING = 2 * 0.82 * Math.sqrt(STIFFNESS); // ζ = 0.82: settles with a hint of overshoot
  const COAST_S = 0.12; // how far a released drag coasts: velocity × this (a short glide)
  const WHEEL_SNAP_MS = 120; // wheel quiet time before snapping to a card
  const WHEEL_PX_PER_CARD = 110; // one mouse-wheel notch (~100 px) ≈ one card

  let pos = Math.max(0, tour.startIndex());
  let target = pos;
  let vel = 0; // cards per second
  let raf = 0;
  let running = false;
  let pendingSelect = false; // a wheel/drag spin is waiting to settle, then select
  const n = () => tour.count;
  const wrap = (d: number) => {
    const m = n();
    return ((((d + m / 2) % m) + m) % m) - m / 2; // into [-m/2, m/2)
  };
  const offset = (i: number) => (mode === 'drum' ? wrap(i - pos) : i - pos);
  /** Keeps a free-spinning position in range on the non-looping layouts. */
  const bound = (v: number) => (mode === 'drum' ? v : clamp(v, -0.4, n() - 0.6));

  const layout = () => {
    const count = n();
    cards.forEach((c, i) => {
      const d = offset(i);
      const p = place(mode, d, count);
      c.style.transform = `translate(-50%, -50%) translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, ${p.z.toFixed(1)}px) rotateX(${p.rx.toFixed(2)}deg) rotateY(${p.ry.toFixed(2)}deg)`;
      c.style.opacity = p.opacity.toFixed(3);
      c.style.zIndex = String(1000 - Math.round(Math.abs(d) * 10));
      c.style.visibility = p.opacity < 0.01 ? 'hidden' : 'visible';
      c.style.pointerEvents = p.opacity < 0.3 ? 'none' : '';
    });
  };

  const integrate = (dt: number) => {
    // semi-implicit Euler in small fixed substeps: stable at any frame rate
    for (let t = dt; t > 0; t -= 1 / 240) {
      const h = Math.min(1 / 240, t);
      vel += (-STIFFNESS * (pos - target) - DAMPING * vel) * h;
      pos += vel * h;
    }
  };

  const selectSettled = () => {
    pendingSelect = false;
    const index = ((Math.round(target) % n()) + n()) % n();
    if (index !== tour.index) tour.goTo(index);
  };

  const run = () => {
    if (running) return;
    running = true;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!dragging) {
        if (reducedMotion()) {
          pos = target;
          vel = 0;
        } else integrate(dt);
      }
      const near = Math.abs(target - pos) < 0.06 && Math.abs(vel) < 0.4;
      if (pendingSelect && !dragging && near) selectSettled();
      const settled = !dragging && Math.abs(target - pos) < 0.001 && Math.abs(vel) < 0.01;
      if (settled) {
        pos = target;
        vel = 0;
      }
      layout();
      if (settled) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  /** Spin to stop `i`, the short way round on the drum. */
  const spinTo = (i: number, instant = false) => {
    pendingSelect = false;
    target = mode === 'drum' ? pos + wrap(i - pos) : i;
    if (instant) {
      cancelAnimationFrame(raf);
      running = false;
      pos = target;
      vel = 0;
      layout();
    } else run();
  };

  /** The whole card a spin should come to rest on, leaning in the direction of travel. */
  const snapIndex = (v: number, dir: number) => {
    const i = Math.round(v + 0.25 * Math.sign(dir));
    return mode === 'drum' ? i : clamp(i, 0, n() - 1);
  };

  tour.onChange(({ index, initial }) => {
    markActive();
    // A spin that just selected this card is already heading there; don't restart it.
    if (Math.abs(wrap(index - target)) < 0.01 && !initial) return run();
    spinTo(index, initial);
  });
  tour.onStopsChanged(() => {
    render();
    spinTo(tour.index, true);
  });

  // ---- wheel ------------------------------------------------------------------------------
  let wheelTimer = 0;
  let wheelDir = 0;
  rail.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const px = e.deltaMode === 1 ? delta * 40 : e.deltaMode === 2 ? delta * 400 : delta;
      if (px === 0) return;
      wheelDir = Math.sign(px);
      pendingSelect = false;
      target = bound(target + px / WHEEL_PX_PER_CARD);
      run();
      clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        target = snapIndex(target, wheelDir);
        pendingSelect = true;
        run();
      }, WHEEL_SNAP_MS);
    },
    { passive: false },
  );

  // ---- drag -------------------------------------------------------------------------------
  /** Pointer position along the rail: x for the horizontal strip, y otherwise. */
  const axisCoord = (e: PointerEvent) => (mode === 'strip' ? e.clientX : e.clientY);
  let dragging = false;
  let dragMoved = false;
  let lastY = 0;
  let samples: { t: number; pos: number }[] = [];
  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    lastY = axisCoord(e);
    clearTimeout(wheelTimer);
    pendingSelect = false;
    vel = 0; // catch the rail
    target = pos;
    samples = [{ t: performance.now(), pos }];
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = axisCoord(e) - lastY;
    if (!dragMoved && Math.abs(dy) < 6) return;
    if (!dragMoved) {
      dragMoved = true;
      rail.setPointerCapture?.(e.pointerId);
      rail.classList.add('is-dragging');
    }
    lastY = axisCoord(e);
    pos = target = bound(pos - dy / pitchFor(mode));
    const now = performance.now();
    samples.push({ t: now, pos });
    while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
    run();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove('is-dragging');
    if (!dragMoved) return;
    // Release velocity from movement in the last 100 ms. Holding still before letting go
    // means no coasting.
    const now = performance.now();
    samples.push({ t: now, pos });
    const recent = samples.filter((p) => now - p.t <= 100);
    const first = recent[0];
    const span = (now - first.t) / 1000;
    vel = recent.length > 1 && span > 0.02 ? clamp((pos - first.pos) / span, -25, 25) : 0;
    target = snapIndex(bound(pos + vel * COAST_S), 0); // the coast already carries direction
    pendingSelect = true;
    run();
    setTimeout(() => (dragMoved = false), 0); // swallow the click that ends the drag
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---- clicks / taps ----------------------------------------------------------------------
  // Chrome's event targeting can miss cards tilted inside nested 3D transforms (the click lands
  // on the stage behind them), while elementsFromPoint() gets them right. So clicks are handled
  // here, once, by looking up what's actually under the pointer.
  const cardAt = (x: number, y: number) => {
    for (const el of document.elementsFromPoint(x, y)) {
      const card = (el as HTMLElement).closest?.<HTMLElement>('.card');
      if (card && rail.contains(card)) return { card, back: !!(el as HTMLElement).closest('.card__back') };
    }
    return null;
  };
  let hovered: HTMLElement | null = null;
  rail.addEventListener('pointermove', (e) => {
    const card = dragging ? null : (cardAt(e.clientX, e.clientY)?.card ?? null);
    if (card === hovered) return;
    hovered?.classList.remove('is-hover');
    card?.classList.add('is-hover');
    hovered = card;
  });
  rail.addEventListener('pointerleave', () => {
    hovered?.classList.remove('is-hover');
    hovered = null;
  });
  rail.addEventListener('click', (e) => {
    if (dragMoved) return; // the end of a drag, not a tap
    const hit = cardAt(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.back && hit.card.classList.contains('is-active')) backListeners.forEach((fn) => fn());
    else tour.goTo(Number(hit.card.dataset.index));
  });

  const applyMode = (m: RailMode) => {
    mode = m;
    rail.dataset.mode = m;
    pos = target = tour.index >= 0 ? tour.index : pos;
    vel = 0;
    layout();
  };
  applyMode(mode);
  render();

  return {
    el: rail,
    render,
    setTitle: (i, title) => {
      const c = cards[i];
      if (!c) return;
      c.querySelector('.card__title')!.textContent = title;
      c.setAttribute('aria-label', `Stop ${i + 1}: ${title}`);
    },
    setTakenOver: (on) => rail.classList.toggle('is-taken-over', on),
    setMode: applyMode,
    onBackToView: (fn) => backListeners.push(fn),
  };
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

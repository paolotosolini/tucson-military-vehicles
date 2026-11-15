import {
  AppBase,
  AppOptions,
  Asset,
  CameraComponentSystem,
  Color,
  Entity,
  FILLMODE_FILL_WINDOW,
  GSplatComponentSystem,
  GSplatHandler,
  GSPLAT_BUDGET_TARGET,
  Keyboard,
  MiniStats,
  Mouse,
  RenderComponentSystem,
  RESOLUTION_AUTO,
  ScriptComponentSystem,
  TONEMAP_LINEAR,
  TextureHandler,
  TouchDevice,
  Vec2,
  Vec3,
  createGraphicsDevice,
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { GSplatRevealRadial } from 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs';
import { Flight, type FlightState } from './flight';

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

interface PoseLike {
  copy(other: PoseLike): unknown;
}

/** The parts of CameraControls' private state the viewer needs to sync with. */
interface ControlsInternals {
  _controller: { _rootPose: PoseLike; _targetRootPose: PoseLike; _childPose: PoseLike; _targetChildPose: PoseLike };
  _pose: { look(from: Vec3, to: Vec3): unknown; getFocus(out: Vec3): Vec3 };
}

/** How a flight ended. */
export type FlightResult = 'arrived' | 'replaced' | 'interrupted';

export type DriftKind = 'orbit' | 'sway' | 'none';

const SWAY_DEGREES = 1.5; // peak yaw either side of the saved view
const SWAY_PERIOD = 14; // seconds for one full side-to-side cycle
const ORBIT_DEG_PER_SEC = 2; // one revolution every three minutes
const DRIFT_RAMP = 2.5; // seconds to ease into the motion
const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

interface DriftState {
  kind: 'orbit' | 'sway';
  offset: Vec3; // camera position relative to the target at the saved pose
  target: Vec3;
  fov: number;
  t: number;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  modelUrl: string;
  initialPose: Pose;
  showStats?: boolean;
  /** Splats to aim for on screen (detail rises until this many are drawn). */
  splatBudget?: number;
  /** The camera never goes below this height (world y): keeps it above the floor. */
  minCameraY?: number;
  /** Highest device pixel ratio to render at (lower = faster). Default 1.5. */
  maxPixelRatio?: number;
  /** Finest LOD level to stream (0 = full detail; 1 skips the finest level, about half the data). */
  lodMin?: number;
  /** Called with 0..1 while the first (coarse) view streams in. */
  onProgress?: (fraction: number) => void;
}

/** Owns the PlayCanvas app, the camera and its controls, and the streamed splat. */
export class Viewer {
  readonly app: AppBase;
  readonly camera: Entity;
  readonly controls: CameraControls;
  private splat: Entity | null = null;

  // Flight state
  private flight: Flight | null = null;
  private settleFlight: ((r: FlightResult) => void) | null = null;
  private readonly state: FlightState = { position: new Vec3(), target: new Vec3(), fov: 60 };
  private readonly velocity = { position: new Vec3(), target: new Vec3() };
  private readonly prev = { position: new Vec3(), target: new Vec3() };
  private drift: DriftState | null = null;
  private driver: ((dt: number) => void) | null = null;
  private logicalFov = 60;
  minCameraY = -Infinity;

  private constructor(app: AppBase, camera: Entity, controls: CameraControls) {
    this.app = app;
    this.camera = camera;
    this.controls = controls;
    app.on('update', (dt: number) => {
      this.applyFov(); // follows rotation / resizes
      if (this.driver) return this.driver(dt); // e.g. walk mode owns the camera
      this.updateFlight(dt);
      this.updateDrift(dt);
      // Orbit and pan can still dip low; hold the camera at the floor height.
      const p = this.camera.getPosition();
      if (p.y < this.minCameraY) this.camera.setPosition(p.x, this.minCameraY, p.z);
    });
  }

  static async create(opts: ViewerOptions): Promise<Viewer> {
    const { canvas } = opts;
    const device = await createGraphicsDevice(canvas, {
      deviceTypes: ['webgpu', 'webgl2'],
      antialias: false, // splats don't benefit from MSAA, and it's expensive
    });

    const appOptions = new AppOptions();
    appOptions.graphicsDevice = device;
    appOptions.mouse = new Mouse(canvas);
    appOptions.touch = new TouchDevice(canvas);
    appOptions.keyboard = new Keyboard(window);
    appOptions.componentSystems = [CameraComponentSystem, ScriptComponentSystem, GSplatComponentSystem, RenderComponentSystem];
    appOptions.resourceHandlers = [TextureHandler, GSplatHandler]; // SOG chunks are WebP textures

    const app = new AppBase(canvas);
    app.init(appOptions);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    // Cap pixel ratio: retina at full DPR is ~4x the fragment work for little visible gain on splats.
    const applyResolution = () => {
      const dpr = window.devicePixelRatio || 1;
      device.maxPixelRatio = Math.min(dpr, opts.maxPixelRatio ?? 1.5);
      app.resizeCanvas();
    };
    applyResolution();
    window.addEventListener('resize', applyResolution);

    // Camera with orbit + fly controls
    const { position, fov } = opts.initialPose;
    const camera = new Entity('camera');
    camera.addComponent('camera', {
      clearColor: new Color(0.035, 0.035, 0.04), // near-black: the roofless hall floats in darkness
      fov,
      nearClip: 0.05,
      farClip: 10000, // the scan's sky/environment shell reaches ~1,500 units out
      toneMapping: TONEMAP_LINEAR,
    });
    camera.setPosition(position[0], position[1], position[2]);
    app.root.addChild(camera);

    camera.addComponent('script');
    const controls = camera.script!.create(CameraControls) as CameraControls;
    Object.assign(controls, {
      sceneSize: 100,
      moveSpeed: 4,
      moveFastSpeed: 12,
      moveSlowSpeed: 1,
      enableOrbit: true,
      enableFly: true,
      enablePan: true,
      // Left-drag orbits, right-drag moves (pans) the model, middle-drag looks around.
      leftButton: 'orbit',
      rightButton: 'pan',
      middleButton: 'look',
    });
    // Orbiting can't swing round underneath the scene: at most a slight upward look.
    controls.pitchRange = new Vec2(-89, 15);
    if (opts.minCameraY !== undefined) {
      // Flying (WASD/QE) stops at the floor height natively.
      const fly = (controls as unknown as { _flyController: { _targetPose: { yRange: Vec2 } } })._flyController;
      fly._targetPose.yRange.set(opts.minCameraY, Infinity);
    }

    // Streaming / LOD settings
    const gs = app.scene.gsplat;
    gs.splatBudgetMode = GSPLAT_BUDGET_TARGET;
    // 2.5M splats on screen: same close-up look as 4M in tests, a third less drawing per frame.
    gs.splatBudget = opts.splatBudget ?? 2_500_000;
    gs.lodBehindPenalty = 3;
    (gs as unknown as { lodUpdateAngle: number }).lodUpdateAngle = 90;

    app.start();
    if (opts.showStats) new MiniStats(app);

    const viewer = new Viewer(app, camera, controls);
    viewer.minCameraY = opts.minCameraY ?? -Infinity;
    viewer.setPose(opts.initialPose);
    await viewer.loadSplat(opts.modelUrl, opts.onProgress, opts.lodMin ?? 0);
    return viewer;
  }

  /**
   * Loads the streamed model. Resolves once the coarsest LOD around the start view is on screen,
   * then lifts the LOD cap so finer detail streams in behind it.
   */
  private async loadSplat(url: string, onProgress?: (f: number) => void, lodMin = 0): Promise<void> {
    const app = this.app;
    const asset = new Asset('scan', 'gsplat', { url });
    app.assets.add(asset);
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve());
      asset.once('error', (err: string) => reject(new Error(`Failed to load model: ${err}`)));
      app.assets.load(asset);
    });
    onProgress?.(0.1);

    const splat = new Entity('splat');
    splat.addComponent('gsplat', { asset });
    // No rotation here: tools/prepare-model.sh bakes the scan upright (Y-up), so stop poses in
    // stops.json are plain world coordinates.
    app.root.addChild(splat);
    this.splat = splat;

    const gsplat = splat.gsplat!;
    gsplat.lodBaseDistance = 8;
    gsplat.lodMultiplier = 3;

    // Start at the coarsest level for a fast first image.
    const resource = gsplat.resource as unknown as { octree?: { lodLevels: number } } | null;
    const levels = resource?.octree?.lodLevels ?? 1;
    gsplat.lodRangeMin = levels - 1;
    gsplat.lodRangeMax = levels - 1;

    const system = app.systems.gsplat as unknown as {
      on(name: string, cb: (...a: unknown[]) => void): void;
      off(name: string, cb: (...a: unknown[]) => void): void;
    };

    await new Promise<void>((resolve) => {
      let peak = 0;
      const onFrameReady = (...args: unknown[]) => {
        const ready = args[2] as boolean;
        const loading = args[3] as number;
        peak = Math.max(peak, loading);
        if (peak > 0) onProgress?.(0.1 + 0.9 * (1 - loading / peak));
        if (ready && loading === 0) {
          system.off('frame:ready', onFrameReady);
          onProgress?.(1);
          gsplat.lodRangeMin = Math.min(lodMin, levels - 1);
          gsplat.lodRangeMax = levels - 1;
          resolve();
        }
      };
      system.on('frame:ready', onFrameReady);
    });
  }

  /** Jumps the camera to a pose instantly and leaves the user in orbit mode around its target. */
  setPose(pose: Pose): void {
    this.driver = null;
    this.drift = null;
    this.endFlight('replaced');
    this.handOver(new Vec3(...pose.position), new Vec3(...pose.target), pose.fov);
  }

  /** The camera's current position, look-at target (orbit pivot) and FOV. */
  getPose(): Pose {
    const p = this.camera.getPosition();
    const t = this.flight
      ? this.state.target
      : (this.controls as unknown as ControlsInternals)._pose.getFocus(new Vec3());
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: this.fov };
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  /**
   * Flies from wherever the camera is now to `pose`. A flight already under way is replaced, and
   * the new one starts from the camera's current position and velocity, so rapid selections
   * never snap or stall.
   *
   * CameraControls keeps running during a flight; this viewer's app 'update' handler fires after
   * script updates, so the flight simply overrides the camera each frame. (Disabling the script
   * instead is a trap: re-enabling discards pending key events but not its running key state, so a
   * key released mid-flight leaves the camera drifting forever.)
   */
  flyTo(pose: Pose, duration?: number): Promise<FlightResult> {
    this.driver = null;
    const from: FlightState = {
      position: this.camera.getPosition().clone(),
      target: new Vec3(...this.getPose().target),
      fov: this.fov,
    };
    const velocity = this.flight ? this.velocity : { position: Vec3.ZERO, target: Vec3.ZERO };
    const flight = new Flight(from, velocity, pose, duration);
    this.endFlight('replaced');
    this.drift = null;

    this.flight = flight;
    this.prev.position.copy(from.position);
    this.prev.target.copy(from.target);
    return new Promise((resolve) => {
      this.settleFlight = resolve;
    });
  }

  /**
   * Hands the camera to an external per-frame driver (walk mode). Like flights it runs after
   * CameraControls each frame, so the controls are never paused. Stops any flight or drift.
   */
  drive(fn: (dt: number) => void): void {
    this.endFlight('replaced');
    this.drift = null;
    this.driver = fn;
  }

  /** Ends external driving and gives the camera back to the orbit controls, looking `ahead` m. */
  release(ahead = 4): void {
    if (!this.driver) return;
    this.driver = null;
    const p = this.camera.getPosition().clone();
    const t = p.clone().add(this.camera.forward.clone().mulScalar(ahead));
    this.handOver(p, t, this.fov);
  }

  get isDriven(): boolean {
    return this.driver !== null;
  }

  /**
   * The view's field of view, in degrees, as authored: the vertical FOV of a 16:9 view. On a
   * portrait screen the camera instead keeps the horizontal FOV that 16:9 view would have, so a
   * stop shows the same width of the scene (more above and below) instead of a narrow zoomed slice.
   */
  get fov(): number {
    return this.logicalFov;
  }
  set fov(value: number) {
    this.logicalFov = value;
    this.applyFov();
  }

  private applyFov(): void {
    const cam = this.camera.camera!;
    const canvas = this.app.graphicsDevice.canvas;
    const portrait = canvas.height > canvas.width;
    if (portrait) {
      const half = (this.logicalFov * Math.PI) / 360;
      const hfov = (Math.atan(Math.tan(half) * (16 / 9)) * 360) / Math.PI;
      if (!cam.horizontalFov) cam.horizontalFov = true;
      if (cam.fov !== hfov) cam.fov = hfov;
    } else {
      if (cam.horizontalFov) cam.horizontalFov = false;
      if (cam.fov !== this.logicalFov) cam.fov = this.logicalFov;
    }
  }

  /** True while the camera is moving on its own (flight or idle drift). */
  get isAutomatic(): boolean {
    return this.flight !== null || this.drift !== null;
  }

  /**
   * The user touched the camera: stop any flight or drift exactly where it is and hand control
   * over. Returns true if something automatic was stopped.
   */
  takeOver(): boolean {
    if (this.flight) {
      const { position, target, fov } = this.state;
      this.endFlight('interrupted');
      this.handOver(position.clone(), target.clone(), fov);
      return true;
    }
    if (this.drift) {
      const target = this.drift.target.clone();
      const fov = this.drift.fov;
      this.drift = null;
      this.handOver(this.camera.getPosition().clone(), target, fov);
      return true;
    }
    return false;
  }

  /**
   * Starts idle motion around `pose` (normally right after arriving there): `sway` rocks the view
   * a few degrees side to side, `orbit` circles slowly around the target. Both ease in from rest.
   */
  startDrift(kind: DriftKind, pose: Pose): void {
    this.drift = null;
    if (kind === 'none' || this.flight) return;
    const target = new Vec3(...pose.target);
    this.drift = {
      kind,
      target,
      offset: new Vec3(...pose.position).sub(target),
      fov: pose.fov,
      t: 0,
    };
  }

  private readonly driftPos = new Vec3();
  private updateDrift(dt: number): void {
    const d = this.drift;
    if (!d || this.flight) return;
    d.t += dt;
    let yawDeg: number;
    if (d.kind === 'sway') {
      yawDeg = SWAY_DEGREES * Math.sin((2 * Math.PI * d.t) / SWAY_PERIOD) * smoothstep(d.t / DRIFT_RAMP);
    } else {
      // Speed ramps linearly to full over DRIFT_RAMP; this is its integral.
      const r = DRIFT_RAMP;
      yawDeg = ORBIT_DEG_PER_SEC * (d.t < r ? (d.t * d.t) / (2 * r) : d.t - r / 2);
    }
    const a = (yawDeg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const { x, y, z } = d.offset;
    this.driftPos.set(d.target.x + x * cos + z * sin, d.target.y + y, d.target.z - x * sin + z * cos);
    this.camera.setPosition(this.driftPos);
    this.camera.lookAt(d.target);
  }

  private updateFlight(dt: number): void {
    const flight = this.flight;
    if (!flight) return;
    const st = flight.step(dt, this.state);

    if (dt > 0) {
      this.velocity.position.sub2(st.position, this.prev.position).mulScalar(1 / dt);
      this.velocity.target.sub2(st.target, this.prev.target).mulScalar(1 / dt);
    }
    this.prev.position.copy(st.position);
    this.prev.target.copy(st.target);

    this.camera.setPosition(st.position);
    this.camera.lookAt(st.target);
    this.fov = st.fov;

    if (flight.done) {
      this.endFlight('arrived');
      this.handOver(st.position.clone(), st.target.clone(), st.fov);
    }
  }

  private endFlight(result: FlightResult): void {
    if (!this.flight) return;
    this.flight = null;
    this.velocity.position.set(0, 0, 0);
    this.velocity.target.set(0, 0, 0);
    const settle = this.settleFlight;
    this.settleFlight = null;
    settle?.(result);
  }

  /** Places the camera and syncs CameraControls so the user continues from exactly this view. */
  private handOver(position: Vec3, target: Vec3, fov: number): void {
    this.fov = fov;
    this.camera.setPosition(position);
    this.camera.lookAt(target);

    // CameraControls.reset() eases towards the pose; skip the easing by snapping its focus
    // controller, and update the cached pose it hands to the orbit controller afterwards.
    const controls = this.controls;
    controls.reset(target, position);
    const internal = controls as unknown as ControlsInternals;
    const c = internal._controller;
    c._rootPose.copy(c._targetRootPose);
    c._childPose.copy(c._targetChildPose);
    internal._pose.look(position, target);
  }

  /**
   * Resolves once the streamed LOD chunks the current view needs are loaded (or after
   * `timeoutMs`, so a capture never hangs). Waits a few frames first so LOD selection catches up
   * with a camera that just moved.
   */
  async waitForDetail(timeoutMs = 10000, onProgress?: (fraction: number) => void): Promise<void> {
    const frames = (n: number) =>
      new Promise<void>((r) => {
        const tick = () => (--n <= 0 ? r() : this.app.once('frameend', tick));
        this.app.once('frameend', tick);
      });
    await frames(3);
    const system = this.app.systems.gsplat as unknown as {
      on(name: string, cb: (...a: unknown[]) => void): void;
      off(name: string, cb: (...a: unknown[]) => void): void;
    };
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        system.off('frame:ready', onReady);
        resolve();
      };
      let peak = 0;
      const onReady = (...args: unknown[]) => {
        const loading = args[3] as number;
        peak = Math.max(peak, loading);
        if (peak > 0) onProgress?.(1 - loading / peak);
        if (args[2] === true && loading === 0) done();
      };
      const timer = setTimeout(done, timeoutMs);
      system.on('frame:ready', onReady);
    });
    await frames(2);
  }

  /**
   * Captures the current view as a 16:9 image (e.g. 640×360 WebP) with the camera's vertical
   * FOV, whatever the window's shape: on a window taller than 16:9 the FOV is widened for the
   * capture frame so the centre crop still spans the full FOV. Only the WebGL/WebGPU canvas is
   * read, so DOM UI is never in the picture.
   */
  async captureImage(width = 640, height = 360, type = 'image/webp', quality = 0.8): Promise<Blob> {
    const src = this.app.graphicsDevice.canvas as HTMLCanvasElement;
    const aspect = width / height;
    const nextFrame = () => new Promise<void>((r) => this.app.once('frameend', () => r()));

    const fov = this.fov;
    const cropH = Math.min(src.height, src.width / aspect);
    const widen = src.height / cropH; // > 1 when the window is taller than 16:9
    if (widen > 1.001) {
      const half = (fov * Math.PI) / 360;
      this.fov = (Math.atan(Math.tan(half) * widen) * 360) / Math.PI;
      await nextFrame();
    }
    try {
      // Read inside 'frameend': a WebGPU canvas is blank outside the frame that drew it.
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      await new Promise<void>((r) =>
        this.app.once('frameend', () => {
          const sw = cropH * aspect;
          const g = out.getContext('2d')!;
          g.imageSmoothingQuality = 'high';
          g.drawImage(src, (src.width - sw) / 2, (src.height - cropH) / 2, sw, cropH, 0, 0, width, height);
          r();
        }),
      );
      return await new Promise<Blob>((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
      );
    } finally {
      this.fov = fov;
    }
  }

  /**
   * Plays the "assembly" reveal: the scene starts empty, gold sparks ripple out from `center`,
   * and a warm wave follows that grows them into the full scan. Resolves when it has finished
   * (the effect then removes itself).
   */
  reveal(center: Vec3, radius: number): Promise<void> {
    const splat = this.splat;
    if (!splat) return Promise.resolve();
    if (!splat.script) splat.addComponent('script');
    const fx = splat.script!.create(GSplatRevealRadial) as GSplatRevealRadial;
    Object.assign(fx, {
      center: center.clone(),
      speed: 5, // m/s at the start …
      acceleration: 8, // … speeding up, so the far end of the hall isn't a long wait
      delay: 1.0, // the warm wave trails the sparks by a second
      dotTint: new Color(1.0, 0.62, 0.22),
      waveTint: new Color(1.4, 0.85, 0.35),
      oscillationIntensity: 0.06,
      endRadius: radius,
      bandWidth: 1.6,
    });
    const ms = fx.getCompletionTime() * 1000;
    return new Promise((resolve) => setTimeout(resolve, ms + 100));
  }

  get splatEntity(): Entity | null {
    return this.splat;
  }
}

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
  RESOLUTION_AUTO,
  ScriptComponentSystem,
  TONEMAP_LINEAR,
  TextureHandler,
  TouchDevice,
  Vec3,
  createGraphicsDevice,
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
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

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  modelUrl: string;
  initialPose: Pose;
  showStats?: boolean;
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

  private constructor(app: AppBase, camera: Entity, controls: CameraControls) {
    this.app = app;
    this.camera = camera;
    this.controls = controls;
    app.on('update', (dt: number) => this.updateFlight(dt));
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
    appOptions.componentSystems = [CameraComponentSystem, ScriptComponentSystem, GSplatComponentSystem];
    appOptions.resourceHandlers = [TextureHandler, GSplatHandler]; // SOG chunks are WebP textures

    const app = new AppBase(canvas);
    app.init(appOptions);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    // Cap pixel ratio: retina at full DPR is ~4x the fragment work for little visible gain on splats.
    const applyResolution = () => {
      const dpr = window.devicePixelRatio || 1;
      device.maxPixelRatio = Math.min(dpr, 1.5);
      app.resizeCanvas();
    };
    applyResolution();
    window.addEventListener('resize', applyResolution);

    // Camera with orbit + fly controls
    const { position, fov } = opts.initialPose;
    const camera = new Entity('camera');
    camera.addComponent('camera', {
      clearColor: new Color(0.73, 0.78, 0.82),
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
    });

    // Streaming / LOD settings
    const gs = app.scene.gsplat;
    gs.splatBudgetMode = GSPLAT_BUDGET_TARGET;
    gs.splatBudget = 4_000_000;
    gs.lodBehindPenalty = 3;
    (gs as unknown as { lodUpdateAngle: number }).lodUpdateAngle = 90;

    app.start();
    if (opts.showStats) new MiniStats(app);

    const viewer = new Viewer(app, camera, controls);
    viewer.setPose(opts.initialPose);
    await viewer.loadSplat(opts.modelUrl, opts.onProgress);
    return viewer;
  }

  /**
   * Loads the streamed model. Resolves once the coarsest LOD around the start view is on screen,
   * then lifts the LOD cap so finer detail streams in behind it.
   */
  private async loadSplat(url: string, onProgress?: (f: number) => void): Promise<void> {
    const app = this.app;
    const asset = new Asset('goldfield', 'gsplat', { url });
    app.assets.add(asset);
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve());
      asset.once('error', (err: string) => reject(new Error(`Failed to load model: ${err}`)));
      app.assets.load(asset);
    });
    onProgress?.(0.1);

    const splat = new Entity('splat');
    splat.addComponent('gsplat', { asset });
    // The scan uses the common 3DGS y-down convention; turn it upright. All stop poses
    // (stops.json) are in this upright world space.
    splat.setLocalEulerAngles(0, 0, 180);
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
          gsplat.lodRangeMin = 0;
          gsplat.lodRangeMax = levels - 1;
          resolve();
        }
      };
      system.on('frame:ready', onFrameReady);
    });
  }

  /** Jumps the camera to a pose instantly and leaves the user in orbit mode around its target. */
  setPose(pose: Pose): void {
    this.endFlight('replaced');
    this.handOver(new Vec3(...pose.position), new Vec3(...pose.target), pose.fov);
  }

  /** The camera's current position, look-at target (orbit pivot) and FOV. */
  getPose(): Pose {
    const p = this.camera.getPosition();
    const t = this.flight
      ? this.state.target
      : (this.controls as unknown as ControlsInternals)._pose.getFocus(new Vec3());
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: this.camera.camera!.fov };
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
  flyTo(pose: Pose): Promise<FlightResult> {
    const from: FlightState = {
      position: this.camera.getPosition().clone(),
      target: new Vec3(...this.getPose().target),
      fov: this.camera.camera!.fov,
    };
    const velocity = this.flight ? this.velocity : { position: Vec3.ZERO, target: Vec3.ZERO };
    const flight = new Flight(from, velocity, pose);
    this.endFlight('replaced');

    this.flight = flight;
    this.prev.position.copy(from.position);
    this.prev.target.copy(from.target);
    return new Promise((resolve) => {
      this.settleFlight = resolve;
    });
  }

  /** Stops a flight where it is and gives the camera back to the user (e.g. on mouse input). */
  interruptFlight(): void {
    if (!this.flight) return;
    const { position, target, fov } = this.state;
    this.endFlight('interrupted');
    this.handOver(position.clone(), target.clone(), fov);
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
    this.camera.camera!.fov = st.fov;

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
    this.camera.camera!.fov = fov;
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

  get splatEntity(): Entity | null {
    return this.splat;
  }
}

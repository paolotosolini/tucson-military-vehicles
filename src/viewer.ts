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

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

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

  private constructor(app: AppBase, camera: Entity, controls: CameraControls) {
    this.app = app;
    this.camera = camera;
    this.controls = controls;
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
    const { position, target, fov } = opts.initialPose;
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
    controls.reset(new Vec3(...target), new Vec3(...position));

    // Streaming / LOD settings
    const gs = app.scene.gsplat;
    gs.splatBudgetMode = GSPLAT_BUDGET_TARGET;
    gs.splatBudget = 4_000_000;
    gs.lodBehindPenalty = 3;
    (gs as unknown as { lodUpdateAngle: number }).lodUpdateAngle = 90;

    app.start();
    if (opts.showStats) new MiniStats(app);

    const viewer = new Viewer(app, camera, controls);
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

  get splatEntity(): Entity | null {
    return this.splat;
  }
}

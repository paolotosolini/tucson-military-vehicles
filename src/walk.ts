import {
  BLEND_NORMAL,
  Color,
  Entity,
  Mesh,
  MeshInstance,
  StandardMaterial,
  TorusGeometry,
  Vec3,
  VoxelOccupancy,
} from 'playcanvas';
import { isTyping } from './carousel';
import type { Viewer } from './viewer';

/**
 * Walk mode: move through the hangar at eye height, on the floor, without walking through
 * vehicles or walls. Two ways to move, like SuperSplat:
 * - point at the floor: a ring (the "puck") shows where you'd go; click to walk there;
 * - WASD (Shift to run). Dragging looks around.
 *
 * Collision uses the voxel occupancy grid splat-transform builds from the scan (10 cm voxels,
 * ~1 MB) instead of a physics engine:
 * - the floor under you is the first solid voxel below your feet (with gravity if you step off),
 * - you can step up small rises (STEP), and
 * - a body-sized ring of samples at knee, waist and head height blocks movement, sliding along
 *   walls when only one direction is blocked.
 */
const EYE = 1.6; // m above the floor
const RADIUS = 0.3; // body radius
const STEP = 0.45; // highest rise you can step onto
const WALK_SPEED = 1.6; // m/s
const RUN_SPEED = 3.6;
const CLICK_WALK_SPEED = 2.4; // walking to a clicked spot
const GRAVITY = 9.8;
const LOOK_DEG_PER_PX = 0.18;
const DRAG_THRESHOLD_PX = 6; // less movement than this between press and release is a click
const PICK_RANGE = 40; // m
const ROOF_CUT = 2.9; // the model is cropped above this height (see tools/crop-scan.mjs)

export class WalkMode {
  private occ: VoxelOccupancy | null = null;
  private loading: Promise<VoxelOccupancy> | null = null;
  private min = new Vec3();
  private res = 0.1;
  private active = false;
  private readonly feet = new Vec3();
  private eyeY = 0;
  private vy = 0;
  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();
  private listeners: ((on: boolean) => void)[] = [];

  // pointer: press → (drag to look | click to walk)
  private pressed = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private hover: Vec3 | null = null; // walkable floor point under the mouse
  private goal: Vec3 | null = null; // where a click is walking us
  private stuckFrames = 0;
  private puck: Entity | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly canvas: HTMLCanvasElement,
    private readonly url: string,
  ) {
    window.addEventListener('keydown', (e) => {
      if (!this.active || isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      if (e.code === 'Escape') return this.exit();
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) this.goal = null; // keys take over
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active || e.button !== 0) return;
      this.pressed = true;
      this.dragging = false;
      this.downX = e.clientX;
      this.downY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      if (this.pressed && !this.dragging) {
        this.dragging = Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > DRAG_THRESHOLD_PX;
      }
      if (this.dragging) {
        this.yaw -= e.movementX * LOOK_DEG_PER_PX;
        this.pitch = Math.max(-80, Math.min(80, this.pitch - e.movementY * LOOK_DEG_PER_PX));
        this.hover = null;
      } else {
        this.hover = this.pickFloor(e.clientX, e.clientY);
      }
    });
    const release = () => {
      if (this.active && this.pressed && !this.dragging && this.hover) {
        this.goal = this.hover.clone();
        this.stuckFrames = 0;
      }
      this.pressed = false;
      this.dragging = false;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => {
      this.pressed = false;
      this.dragging = false;
    });
    canvas.addEventListener('pointerleave', () => {
      if (!this.pressed) this.hover = null;
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  onChange(fn: (on: boolean) => void): void {
    this.listeners.push(fn);
  }

  async toggle(): Promise<void> {
    if (this.active) this.exit();
    else await this.enter();
  }

  private load(): Promise<VoxelOccupancy> {
    this.loading ??= (async () => {
      const [meta, bin] = await Promise.all([
        fetch(`${this.url}.voxel.json`).then((r) => r.json()),
        fetch(`${this.url}.voxel.bin`).then((r) => r.arrayBuffer()),
      ]);
      const occ = new VoxelOccupancy(meta, bin);
      this.min.copy(occ.bounds.getMin());
      this.res = occ.voxelSize;
      this.occ = occ;
      this.puck = this.createPuck();
      return occ;
    })();
    return this.loading;
  }

  /** The floor marker: a thin white ring drawn over the scan (no depth test, after the splats). */
  private createPuck(): Entity {
    const app = this.viewer.app;
    const material = new StandardMaterial();
    material.diffuse = new Color(0, 0, 0);
    material.emissive = new Color(1, 1, 1);
    material.useLighting = false;
    material.blendType = BLEND_NORMAL;
    material.opacity = 0.9;
    material.depthTest = false;
    material.depthWrite = false;
    material.update();
    const mesh = Mesh.fromGeometry(
      app.graphicsDevice,
      new TorusGeometry({ ringRadius: 0.28, tubeRadius: 0.022, segments: 64, sides: 8 }),
    );
    const puck = new Entity('walk-puck');
    puck.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
    const immediate = app.scene.layers.getLayerByName('Immediate');
    if (immediate) puck.render!.layers = [immediate.id]; // drawn after the splats
    puck.setLocalScale(1, 0.3, 1); // flatten the tube into a ribbon
    puck.enabled = false;
    app.root.addChild(puck);
    return puck;
  }

  /**
   * Starts walking from where the camera is, keeping its direction, tilt and field of view: only
   * the height eases to standing eye height. Only when the camera is high above the floor (e.g. the
   * aerial overview) or inside something does it fly down to the nearest free spot first.
   */
  async enter(): Promise<void> {
    await this.load();
    const cam = this.viewer.camera;
    const pos = cam.getPosition().clone();
    const fwd = cam.forward;
    this.yaw = (Math.atan2(-fwd.x, -fwd.z) * 180) / Math.PI;
    this.pitch = Math.max(-80, Math.min(80, (Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180) / Math.PI));
    this.vy = 0;
    this.goal = null;

    const floor = this.groundBelow(pos.x, pos.y, pos.z);
    const standingHere =
      floor !== null && pos.y - floor < EYE + 1.2 && floor < -0.8 && !this.blocked(pos.x, floor, pos.z);

    this.active = true;
    this.listeners.forEach((fn) => fn(true));

    if (standingHere) {
      // Walk from right here; update() eases the eye from its current height to standing height.
      this.feet.set(pos.x, floor!, pos.z);
      this.eyeY = pos.y;
      this.viewer.drive((dt) => this.update(dt));
      return;
    }

    // Too high up or inside something: fly down to a free spot under where we're looking.
    const pose = this.viewer.getPose();
    const start =
      this.findStandingSpot(pose.target[0], pose.target[2]) ?? this.findStandingSpot(pos.x, pos.z);
    if (!start) {
      this.active = false;
      this.listeners.forEach((fn) => fn(false));
      return;
    }
    this.feet.copy(start);
    this.eyeY = start.y + EYE;
    this.pitch = -5;
    const eye = new Vec3(start.x, this.eyeY, start.z);
    const look = eye.clone().add(this.forward().mulScalar(4)).add(new Vec3(0, -0.35, 0));
    const result = await this.viewer.flyTo({
      position: [eye.x, eye.y, eye.z],
      target: [look.x, look.y, look.z],
      fov: cam.camera!.fov,
    });
    if (result !== 'arrived' || !this.active) {
      this.active = false;
      this.listeners.forEach((fn) => fn(false));
      return;
    }
    this.viewer.drive((dt) => this.update(dt));
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    this.pressed = this.dragging = false;
    this.hover = this.goal = null;
    if (this.puck) this.puck.enabled = false;
    if (this.viewer.isDriven) this.viewer.release();
    this.listeners.forEach((fn) => fn(false));
  }

  // ---- per frame ---------------------------------------------------------------------------
  private update(dt: number): void {
    dt = Math.min(dt, 0.05);
    const k = this.keys;
    const fwdIn = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const sideIn = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const running = k.has('ShiftLeft') || k.has('ShiftRight');

    if (fwdIn || sideIn) {
      const f = this.forward();
      const r = new Vec3(-f.z, 0, f.x);
      const move = f.mulScalar(fwdIn).add(r.mulScalar(sideIn)).normalize();
      this.tryMove(move.mulScalar((running ? RUN_SPEED : WALK_SPEED) * dt));
    } else if (this.goal) {
      // Walk towards the clicked spot, easing in over the last half metre.
      const to = new Vec3(this.goal.x - this.feet.x, 0, this.goal.z - this.feet.z);
      const dist = to.length();
      if (dist < 0.05) {
        this.goal = null;
      } else {
        const speed = (running ? RUN_SPEED : CLICK_WALK_SPEED) * Math.min(1, 0.25 + dist / 0.6);
        const moved = this.tryMove(to.normalize().mulScalar(Math.min(dist, speed * dt)));
        // Give up if something blocks the way for a moment.
        this.stuckFrames = moved ? 0 : this.stuckFrames + 1;
        if (this.stuckFrames > 8) this.goal = null;
      }
    }

    // Gravity onto the floor below (no falling into the void if there's none).
    const ground = this.groundBelow(this.feet.x, this.feet.y + 0.05, this.feet.z);
    if (ground !== null && ground < this.feet.y - 0.01) {
      this.vy -= GRAVITY * dt;
      this.feet.y = Math.max(ground, this.feet.y + this.vy * dt);
      if (this.feet.y === ground) this.vy = 0;
    } else {
      this.vy = 0;
    }

    // Ease the eye towards standing height so steps don't jolt the view.
    this.eyeY += (this.feet.y + EYE - this.eyeY) * (1 - Math.exp(-dt * 14));
    const cam = this.viewer.camera;
    cam.setPosition(this.feet.x, this.eyeY, this.feet.z);
    cam.setEulerAngles(this.pitch, this.yaw, 0);

    // The puck: on the walk target while walking to it, else under the mouse.
    const at = this.goal ?? (this.dragging ? null : this.hover);
    if (this.puck) {
      this.puck.enabled = !!at;
      if (at) this.puck.setPosition(at.x, at.y + 0.02, at.z);
    }
  }

  /** Moves the feet by (move.x, move.z) if the body fits, sliding along walls. Returns success. */
  private tryMove(move: Vec3): boolean {
    for (const [dx, dz] of [
      [move.x, move.z],
      [move.x, 0],
      [0, move.z],
    ]) {
      if (Math.abs(dx) + Math.abs(dz) < 1e-6) continue;
      const nx = this.feet.x + dx;
      const nz = this.feet.z + dz;
      const ground = this.groundBelow(nx, this.feet.y + STEP, nz);
      const feetY = ground !== null && ground > this.feet.y ? ground : this.feet.y; // step up
      if (!this.blocked(nx, feetY, nz)) {
        this.feet.x = nx;
        this.feet.z = nz;
        if (feetY > this.feet.y) {
          this.feet.y = feetY;
          this.vy = 0;
        }
        return true;
      }
    }
    return false;
  }

  private forward(): Vec3 {
    const a = (this.yaw * Math.PI) / 180;
    return new Vec3(-Math.sin(a), 0, -Math.cos(a));
  }

  // ---- picking -------------------------------------------------------------------------------
  /**
   * The walkable floor point under the mouse, or null. Marches the view ray through the voxels
   * to the first solid one, and accepts it only if it's floor you could stand on: roughly at your
   * level, with room for your body above it.
   */
  private pickFloor(clientX: number, clientY: number): Vec3 | null {
    const cam = this.viewer.camera.camera!;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const from = cam.screenToWorld(x, y, cam.nearClip);
    const to = cam.screenToWorld(x, y, PICK_RANGE);
    const dir = to.clone().sub(from).normalize();
    const step = this.res * 0.5;
    const p = from.clone();
    for (let d = 0; d < PICK_RANGE; d += step) {
      p.copy(from).add(dir.clone().mulScalar(d));
      if (!this.solid(p.x, p.y, p.z)) continue;
      if (p.y > this.feet.y + STEP + 0.2 || p.y < this.feet.y - 1.5) return null; // not your floor
      const ground = this.groundBelow(p.x, p.y + 0.2, p.z);
      if (ground === null || Math.abs(ground - p.y) > 0.3) return null; // a wall or a vehicle side
      if (this.blocked(p.x, ground, p.z)) return null; // no room to stand there
      return new Vec3(p.x, ground, p.z);
    }
    return null;
  }

  // ---- voxel queries -------------------------------------------------------------------------
  /**
   * Whether the world point (x, y, z) is inside a solid voxel. splat-transform writes the grid in
   * its own frame, which is the viewer's world turned 180° about Z: (x, y, z) → (-x, -y, z).
   */
  private solid(x: number, y: number, z: number): boolean {
    const { min, res } = this;
    return this.occ!.isVoxelSolid(
      Math.floor((-x - min.x) / res),
      Math.floor((-y - min.y) / res),
      Math.floor((z - min.z) / res),
    );
  }

  /** Height of the floor surface below (x, fromY, z), searching up to 4 m down; null if none. */
  private groundBelow(x: number, fromY: number, z: number): number | null {
    let best: number | null = null;
    // Sample a small footprint: splat floors can have pin-holes.
    for (const [ox, oz] of [
      [0, 0],
      [0.12, 0],
      [-0.12, 0],
      [0, 0.12],
      [0, -0.12],
    ]) {
      for (let y = fromY; y > fromY - 4; y -= this.res) {
        if (this.solid(x + ox, y, z + oz)) {
          // world top of this voxel: grid y is flipped, so its world top is -(its grid bottom)
          const top = -(this.min.y + Math.floor((-y - this.min.y) / this.res) * this.res);
          if (best === null || top > best) best = top;
          break;
        }
      }
    }
    return best;
  }

  /** True if a body standing at (x, feetY, z) would overlap solid voxels. */
  private blocked(x: number, feetY: number, z: number): boolean {
    const heights = [STEP + 0.05, 0.9, 1.35, EYE - 0.05];
    for (const h of heights) {
      const y = feetY + h;
      if (y > ROOF_CUT) continue;
      if (this.solid(x, y, z)) return true;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        if (this.solid(x + Math.cos(a) * RADIUS, y, z + Math.sin(a) * RADIUS)) return true;
      }
    }
    return false;
  }

  /** A free spot to stand near (x, z): the floor there, or the nearest clear one within ~6 m. */
  private findStandingSpot(x: number, z: number): Vec3 | null {
    for (let ring = 0; ring <= 12; ring++) {
      const r = ring * 0.5;
      const n = ring === 0 ? 1 : 8 + ring * 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const g = this.groundBelow(px, ROOF_CUT - 0.2, pz);
        if (g !== null && g < -0.8 && !this.blocked(px, g, pz)) return new Vec3(px, g, pz);
      }
    }
    return null;
  }
}

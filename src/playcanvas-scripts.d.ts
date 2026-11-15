// The engine ships its ESM scripts without type declarations.
declare module 'playcanvas/scripts/esm/camera-controls.mjs' {
  import type { Script, Vec3 } from 'playcanvas';
  export class CameraControls extends Script {
    enableOrbit: boolean;
    enableFly: boolean;
    enablePan: boolean;
    focusPoint: Vec3;
    moveSpeed: number;
    moveFastSpeed: number;
    moveSlowSpeed: number;
    rotateSpeed: number;
    zoomSpeed: number;
    sceneSize: number;
    pitchRange: import('playcanvas').Vec2;
    leftButton: 'orbit' | 'pan' | 'look';
    middleButton: 'orbit' | 'pan' | 'look';
    rightButton: 'orbit' | 'pan' | 'look';
    focus(focus: Vec3, resetZoom?: boolean): void;
    look(focus: Vec3, resetZoom?: boolean): void;
    reset(focus: Vec3, position: Vec3): void;
  }
}

declare module 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs' {
  import type { Color, Script, Vec3 } from 'playcanvas';
  export class GSplatRevealRadial extends Script {
    center: Vec3;
    speed: number;
    acceleration: number;
    delay: number;
    dotTint: Color;
    waveTint: Color;
    oscillationIntensity: number;
    endRadius: number;
    bandWidth: number;
    getCompletionTime(): number;
    isEffectComplete(): boolean;
  }
}

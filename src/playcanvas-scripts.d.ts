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
    leftButton: 'orbit' | 'pan' | 'look';
    middleButton: 'orbit' | 'pan' | 'look';
    rightButton: 'orbit' | 'pan' | 'look';
    focus(focus: Vec3, resetZoom?: boolean): void;
    look(focus: Vec3, resetZoom?: boolean): void;
    reset(focus: Vec3, position: Vec3): void;
  }
}

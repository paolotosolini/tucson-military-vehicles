#!/usr/bin/env node
// Crops a binary little-endian Gaussian-splat PLY to the inside of the hangar: an oriented box in
// world space (Y-up, after the +90° X rotation that prepare-model.sh applies), which removes the
// roof and every splat outside the walls.
//
//   node tools/crop-scan.mjs <in.ply> <out.ply>
//
// The raw scan is Z-up: world (x, y, z) = (raw x, raw z, -raw y).
import fs from 'node:fs';

// ---- The hangar, measured from the scan (see the spec, Step 0) ------------------------------
const BOX = {
  centre: [-5.6, 32.19], // world x, z of the hall's centre
  angleDeg: -76.11, // direction of the hall's long axis, from world +X towards +Z
  along: [-31.8, 35.3], // walls at -31.0 / +34.5, plus a 0.8 m margin
  across: [-19.3, 18.6], // walls at -18.5 / +17.8, plus a 0.8 m margin
  height: [-2.2, 2.9], // floor is at -1.4; above 2.9 is ceiling clutter and roof
};

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/crop-scan.mjs <in.ply> <out.ply>');
  process.exit(1);
}

const fd = fs.openSync(inPath, 'r');
const head = Buffer.alloc(64 * 1024);
fs.readSync(fd, head, 0, head.length, 0);
const endTag = 'end_header\n';
const headerEnd = head.indexOf(endTag) + endTag.length;
const headerText = head.subarray(0, headerEnd).toString('latin1');
const lines = headerText.split('\n');
if (!lines.includes('format binary_little_endian 1.0')) throw new Error('expected binary_little_endian PLY');
const count = Number(lines.find((l) => l.startsWith('element vertex ')).split(' ')[2]);
const props = lines.filter((l) => l.startsWith('property ')).map((l) => l.split(' '));
if (props.some(([, type]) => type !== 'float')) throw new Error('expected float properties only');
const names = props.map((p) => p[2]);
const stride = names.length;
const [ix, iy, iz] = ['x', 'y', 'z'].map((n) => names.indexOf(n));

const a = (BOX.angleDeg * Math.PI) / 180;
const ca = Math.cos(a);
const sa = Math.sin(a);
const inside = (rx, ry, rz) => {
  const wx = rx;
  const wy = rz;
  const wz = -ry;
  if (wy < BOX.height[0] || wy > BOX.height[1]) return false;
  const dx = wx - BOX.centre[0];
  const dz = wz - BOX.centre[1];
  const u = dx * ca + dz * sa;
  const v = -dx * sa + dz * ca;
  return u >= BOX.along[0] && u <= BOX.along[1] && v >= BOX.across[0] && v <= BOX.across[1];
};

// Pass 1: filter into a temp body file; pass 2: write header with the new count + body.
const tmp = `${outPath}.body`;
const body = fs.openSync(tmp, 'w');
const CHUNK = 1 << 20;
const buf = Buffer.alloc(CHUNK * stride * 4);
const out = Buffer.alloc(CHUNK * stride * 4);
let pos = headerEnd;
let done = 0;
let kept = 0;
while (done < count) {
  const n = Math.min(CHUNK, count - done);
  fs.readSync(fd, buf, 0, n * stride * 4, pos);
  const f = new Float32Array(buf.buffer, buf.byteOffset, n * stride);
  let o = 0;
  for (let v = 0; v < n; v++) {
    const b = v * stride;
    if (inside(f[b + ix], f[b + iy], f[b + iz])) {
      buf.copy(out, o * stride * 4, b * 4, (b + stride) * 4);
      o++;
    }
  }
  fs.writeSync(body, out, 0, o * stride * 4);
  kept += o;
  pos += n * stride * 4;
  done += n;
}
fs.closeSync(fd);
fs.closeSync(body);

const header = headerText.replace(/element vertex \d+/, `element vertex ${kept}`);
fs.writeFileSync(outPath, header);
fs.appendFileSync(outPath, fs.readFileSync(tmp));
fs.unlinkSync(tmp);
console.log(`${inPath.split('/').pop()}: kept ${kept} of ${count} (${((100 * kept) / count).toFixed(1)}%)`);

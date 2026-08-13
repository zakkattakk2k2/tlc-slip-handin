/**
 * Draw the detected quad (red), the true quad (green) and the top runner-up
 * candidates (blue) over each test photo, so detection failures can be looked
 * at instead of inferred from numbers.
 *
 * Run:  node tools/overlay.mjs <photodir> <outdir>
 */
import fs from 'node:fs';
import path from 'node:path';

import { detectSlip, __debug } from '../js/detect.js';
import { readPNG, writePNG } from './png.mjs';

const photoDir = process.argv[2] || '/tmp/testphotos';
const outDir = process.argv[3] || '/tmp/overlayout';
fs.mkdirSync(outDir, { recursive: true });

function line(img, a, b, colour, thickness = 3) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    for (let dy = -thickness; dy <= thickness; dy++) {
      for (let dx = -thickness; dx <= thickness; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
        const o = (ny * img.width + nx) * 4;
        img.data[o] = colour[0]; img.data[o + 1] = colour[1]; img.data[o + 2] = colour[2];
      }
    }
  }
}

const drawQuad = (img, q, colour, th) => {
  for (let i = 0; i < 4; i++) line(img, q[i], q[(i + 1) % 4], colour, th);
};

const cases = JSON.parse(fs.readFileSync(path.join(photoDir, 'index.json'), 'utf8'));

for (const name of cases) {
  const meta = JSON.parse(fs.readFileSync(path.join(photoDir, name + '.json'), 'utf8'));
  const img = readPNG(path.join(photoDir, name + '.png'));

  const res = detectSlip(img);
  const { work, candidates } = __debug(img);
  const up = (q) => q.map((p) => ({ x: p.x / work.scale, y: p.y / work.scale }));

  for (const c of candidates.slice(1, 5)) drawQuad(img, up(c.quad), [70, 130, 255], 2);
  drawQuad(img, meta.quad.map(([x, y]) => ({ x, y })), [40, 200, 90], 4);
  drawQuad(img, res.quad, [235, 40, 40], 3);
  for (const e of res.extras) drawQuad(img, e.quad, [250, 170, 30], 3);

  writePNG(path.join(outDir, name + '-overlay.png'), img);
}
console.log('green = truth, red = chosen, blue = runners-up, orange = flagged extras');
console.log('written to', outDir);

/**
 * Diagnostic dump for one test photo: writes every candidate mask as a PNG and
 * prints the scored candidate list, so a detection failure can be traced to the
 * mask that produced it rather than guessed at.
 *
 * Run:  node tools/debug-detect.mjs <photo.png> <outdir>
 */
import fs from 'node:fs';
import path from 'node:path';

import * as D from '../js/detect.js';
import { readPNG, writePNG } from './png.mjs';

const file = process.argv[2];
const outDir = process.argv[3] || '/tmp/debugout';
fs.mkdirSync(outDir, { recursive: true });

const img = readPNG(file);
const base = path.basename(file, '.png');

const dbg = D.__debug(img);

console.log(`image ${img.width}x${img.height}  work ${dbg.work.width}x${dbg.work.height}`);

for (const [name, mask] of dbg.masks) {
  const { width: w, height: h } = dbg.work;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 255 : 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  writePNG(path.join(outDir, `${base}--${name.replace('@', '-')}.png`), { data: out, width: w, height: h });
}

const rows = dbg.candidates.slice(0, 14).map((c) => ({
  mask: c.mask,
  total: c.total.toFixed(3),
  aspect: c.aspect.toFixed(2),
  fill: c.fill.toFixed(2),
  size: c.size.toFixed(2),
  edges: c.edges,
  ar: (D.quadSize(c.quad).w / D.quadSize(c.quad).h).toFixed(3),
  wh: `${Math.round(D.quadSize(c.quad).w)}x${Math.round(D.quadSize(c.quad).h)}`,
  at: `${Math.round(c.quad[0].x)},${Math.round(c.quad[0].y)}`,
}));
console.table(rows);

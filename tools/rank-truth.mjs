/**
 * For each test photo, find where the TRUE slip rectangle sits in the scored
 * candidate list. This separates the two failure modes that look identical
 * from the outside:
 *
 *   "rank -1"  the correct rectangle was never generated  -> fix the generators
 *   "rank 5"   it was generated but out-scored            -> fix the scoring
 *
 * Run:  node tools/rank-truth.mjs <photodir>
 */
import fs from 'node:fs';
import path from 'node:path';

import { __debug, orderCorners, downscale, TUNING } from '../js/detect.js';
import { readPNG } from './png.mjs';

const photoDir = process.argv[2] || '/tmp/testphotos';
const cases = JSON.parse(fs.readFileSync(path.join(photoDir, 'index.json'), 'utf8'));

const err = (a, b) => {
  const A = orderCorners(a), B = orderCorners(b);
  const diag = Math.hypot(B[0].x - B[2].x, B[0].y - B[2].y);
  let best = Infinity;
  for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let i = 0; i < 4; i++) s += Math.hypot(A[(i + r) % 4].x - B[i].x, A[(i + r) % 4].y - B[i].y);
    best = Math.min(best, (s / 4) / diag * 100);
  }
  return best;
};

const rows = [];
for (const name of cases) {
  const meta = JSON.parse(fs.readFileSync(path.join(photoDir, name + '.json'), 'utf8'));
  const img = readPNG(path.join(photoDir, name + '.png'));
  const { work, candidates } = __debug(img);

  const truth = meta.quad.map(([x, y]) => ({ x: x * work.scale, y: y * work.scale }));

  let rank = -1, bestErr = Infinity, bestIdx = -1;
  candidates.forEach((c, i) => {
    const e = err(c.quad, truth);
    if (e < bestErr) { bestErr = e; bestIdx = i; }
    if (e < 6 && rank < 0) rank = i;
  });

  const c = candidates[bestIdx];
  rows.push({
    name,
    cands: candidates.length,
    'rank of truth': rank,
    'closest err': bestErr.toFixed(1) + '%',
    'its mask': c ? c.mask : '-',
    'its score': c ? c.total.toFixed(2) : '-',
    'winner score': candidates[0] ? candidates[0].total.toFixed(2) : '-',
    'winner mask': candidates[0] ? candidates[0].mask : '-',
  });
}
console.table(rows);

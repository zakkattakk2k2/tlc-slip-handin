/**
 * Headless test rig for js/detect.js.
 *
 * Loads each synthetic photo from tools/make-test-photos.py, runs the detector,
 * and compares the corners it found against the true ones. Also writes the
 * flattened crop out as a PNG so the result can be eyeballed, not just scored.
 *
 * Run:  node tools/test-detect.mjs <photodir> <outdir>
 */
import fs from 'node:fs';
import path from 'node:path';

import { detectSlip, warp, autoLevels, orderCorners, isUpsideDown, rotate180, SLIP_ASPECT } from '../js/detect.js';
import { readPNG, writePNG } from './png.mjs';

/* ── Scoring ─────────────────────────────────────────────────────────────── */

/**
 * Mean corner error as a percentage of the slip's diagonal. Compared against
 * every rotation of the truth, because a 90-degree spin is a presentation
 * question for the Rotate button, not a detection failure.
 */
function cornerError(found, truth) {
  const t = orderCorners(truth.map(([x, y]) => ({ x, y })));
  const f = orderCorners(found);
  const diag = Math.hypot(t[0].x - t[2].x, t[0].y - t[2].y);

  let best = Infinity, bestRot = 0;
  for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const a = f[(i + r) % 4], b = t[i];
      sum += Math.hypot(a.x - b.x, a.y - b.y);
    }
    const err = (sum / 4) / diag * 100;
    if (err < best) { best = err; bestRot = r; }
  }
  return { error: best, rotation: bestRot };
}

/* ── Runner ──────────────────────────────────────────────────────────────── */

const photoDir = process.argv[2] || '/tmp/testphotos';
const outDir = process.argv[3] || '/tmp/detectout';
fs.mkdirSync(outDir, { recursive: true });

const cases = JSON.parse(fs.readFileSync(path.join(photoDir, 'index.json'), 'utf8'));
const OUT_W = 1000, OUT_H = Math.round(OUT_W / SLIP_ASPECT);

let passed = 0, accurateCount = 0;
const rows = [];

for (const name of cases) {
  const meta = JSON.parse(fs.readFileSync(path.join(photoDir, name + '.json'), 'utf8'));
  const img = readPNG(path.join(photoDir, name + '.png'));

  const t0 = Date.now();
  const res = detectSlip(img);
  const detectMs = Date.now() - t0;

  const { error, rotation } = cornerError(res.quad, meta.quad);

  const t1 = Date.now();
  let flat = warp(img, res.quad, OUT_W, OUT_H);
  const flipped = isUpsideDown(flat);
  if (flipped) flat = rotate180(flat);
  autoLevels(flat);
  const warpMs = Date.now() - t1;
  writePNG(path.join(outDir, name + '-crop.png'), flat);

  const wantsExtra = /two-slips/.test(name);
  const extraOK = wantsExtra ? res.extras.length >= 1 : res.extras.length === 0;

  // The product-level bar: either the crop is right, or the app knows it is
  // unsure and hands the tutor the adjust-corners view. A confidently WRONG
  // crop is the only truly bad outcome, because that is the one that gets
  // saved and compiled without anybody looking at it.
  const accurate = error < 6;
  const ok = (accurate || !res.confident) && extraOK;
  if (ok) passed++;
  if (accurate) accurateCount++;

  rows.push({
    name,
    err: error.toFixed(2) + '%',
    score: res.score.toFixed(2),
    mask: res.mask,
    conf: res.confident ? 'yes' : 'NO',
    flip: flipped ? 'yes' : '-',
    extras: res.extras.length,
    ms: detectMs + '+' + warpMs,
    ok: ok ? (accurate ? 'PASS' : 'asks') : 'FAIL',
    note: meta.note,
  });
}

console.table(rows);
console.log(`\n${accurateCount}/${cases.length} cropped accurately`);
console.log(`${passed}/${cases.length} acceptable (accurate, or correctly asked for confirmation)`);
console.log(`crops written to ${outDir}`);
process.exit(passed === cases.length ? 0 : 1);

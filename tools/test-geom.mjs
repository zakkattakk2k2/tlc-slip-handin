/**
 * Unit checks for the geometry helpers that fail SILENTLY when they are wrong.
 *
 * The IoU clipper is the motivating case: with the winding convention
 * inverted it returns 0 for every pair of rectangles, which looks exactly like
 * "these candidates genuinely disagree" and quietly turned off the detector's
 * whole confidence signal.
 *
 * Run:  node tools/test-geom.mjs
 */
import { __iou, orderCorners, quadSize, rotateQuad, SLIP_ASPECT } from '../js/detect.js';

let failures = 0;
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

function check(label, got, want, tol) {
  const ok = near(got, want, tol);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: got ${(+got).toFixed(4)}, want ${(+want).toFixed(4)}`);
}

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

const A = rect(0, 0, 10, 10);

check('IoU with itself', __iou(A, A), 1);
check('IoU, half overlap', __iou(A, rect(5, 0, 10, 10)), 1 / 3);
check('IoU, quarter overlap', __iou(A, rect(5, 5, 10, 10)), 25 / 175);
check('IoU, disjoint', __iou(A, rect(100, 100, 10, 10)), 0);
check('IoU, fully contained', __iou(A, rect(2, 2, 5, 5)), 25 / 100);
check('IoU is symmetric', __iou(rect(5, 0, 10, 10), A), 1 / 3);

// orderCorners must return TL, TR, BR, BL no matter how the input is shuffled.
const shuffled = [{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }];
const ord = orderCorners(shuffled);
check('orderCorners TL.x', ord[0].x, 0);
check('orderCorners TL.y', ord[0].y, 0);
check('orderCorners TR.x', ord[1].x, 10);
check('orderCorners BR.y', ord[2].y, 10);
check('orderCorners BL.x', ord[3].x, 0);

// quadSize on a slip-shaped rectangle must recover the slip's aspect ratio.
const slip = rect(0, 0, 243.84, 423.36);
const qs = quadSize(orderCorners(slip));
check('quadSize aspect', qs.w / qs.h, SLIP_ASPECT);

// Rotating four times is the identity.
const r4 = rotateQuad(rotateQuad(rotateQuad(rotateQuad(ord))));
check('rotateQuad x4 is identity', r4[0].x + r4[0].y, ord[0].x + ord[0].y);
check('rotateQuad once moves TL', rotateQuad(ord)[0].x, 10);

console.log(failures ? `\n${failures} FAILED` : '\nall geometry checks passed');
process.exit(failures ? 1 : 0);

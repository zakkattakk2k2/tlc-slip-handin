/* ============================================================================
   Genius Premium Tuition — TLC Slip Hand-in
   detect.js — finding a lesson slip in a photo, and flattening it.

   WHY THIS EXISTS
   ---------------
   Tutors photograph a slip on a desk, often with a student's workbook, a pen
   and a mug in the frame. We keep the slip and throw the rest away, without
   asking anyone to crop by hand.

   THE THING THAT SHAPES THE WHOLE DESIGN
   --------------------------------------
   A Genius lesson slip is NOT a white rectangle. It has a dark grey band at
   the top, a dark grey band at the bottom, and white in between. So the
   obvious "find the bright paper" trick finds only the white middle — which
   is roughly square, nothing like the slip's real 0.576 aspect ratio — and
   crops the branding off. Everything below is built around that:

     * We generate SEVERAL candidate masks (edges, difference-from-desk,
       bright-vs-dark) rather than trusting one.
     * Every mask is closed and hole-filled, so a slip that only shows up as
       an outline or as two grey bars becomes one solid region.
     * Candidates from all masks compete on a single score, and aspect ratio
       carries the most weight, because 0.576 is the one thing we know for
       certain about the target.

   No OpenCV: this is ~20KB of plain JS instead of an 8MB WASM download on a
   tutor's phone data.

   Everything here is a pure function over {data, width, height} — the same
   shape as ImageData — so it runs identically in the browser and in the Node
   test harness (tools/test-detect.mjs).
   ========================================================================== */

'use strict';

/* Measured off GENIUS LESSON SLIP SHEET PRINT FILE V3.2: 243.84 × 423.36 pt.
   Everything downstream keys off this number. */
export const SLIP_W_PT = 243.84;
export const SLIP_H_PT = 423.36;
export const SLIP_ASPECT = SLIP_W_PT / SLIP_H_PT;   // 0.5760

/* Tunables, named and in one place so behaviour can be adjusted without
   hunting through the algorithm. */
export const TUNING = {
  workEdge:        640,   // analysis resolution (long edge, px)
  minAreaFrac:     0.025, // ignore blobs smaller than 2.5% of the frame
  maxAreaFrac:     0.97,  // a blob filling the frame IS the frame
  /* Closing radius, run at BOTH values on every mask.
     A slip resting against a workbook, a phone or a second slip is one
     connected lump of "not-desk", and a generous close welds them together
     for good. The small radius keeps neighbours apart; the large one closes
     broken outlines and soft, out-of-focus borders. Scoring picks the winner,
     and aspect ratio is what tells a lone slip from a slip-plus-workbook. */
  closeRadii:      [1, 3],
  simplifyFrac:    0.018, // Douglas-Peucker epsilon as a fraction of the diagonal
  extraAreaFrac:   0.30,  // a second slip must be >=30% the area of the first
  extraMinScore:   0.50,  // ...and must still look like a slip
  aspectTolerance: 1.55,  // how far the aspect may drift before it scores zero
  minFillRatio:    0.58,  // blob area / quad area - below this it is not a rectangle
  landscapePenalty: 0.72, // how much a sideways aspect match is discounted
  /* Aspect says "is this slip-shaped", fill says "is there really a rectangle
     here", size says "is this the whole slip rather than a piece of it".
     Size carries real weight because most false positives are small pieces. */
  weights: { aspect: 0.46, fill: 0.24, size: 0.30 },
  nestedAreaRatio: 1.6,   // a container must be this much bigger to absorb a candidate
  nestedScoreFloor: 0.55, // ...and score at least this fraction of it
  confidentScore:  0.60,
  confidentAspect: 0.58,
  /* Consensus thresholds. When two analyses have both locked onto the real
     slip they agree almost exactly and score almost the same; when one has
     merged the slip with a phone or a workbook next to it, the other lands
     somewhere close but not identical and scores visibly worse. Measured
     across the test set: correct crops agree at IoU 0.99-1.00 with near-equal
     scores, the merged-blob failure agrees at 0.88 with scores 0.92 vs 0.71.
     Both conditions have to hold, which is what separates the two. */
  agreeIoU:         0.95,
  agreeScoreRatio:  0.85,
};

/* ────────────────────────────────────────────────────────────────────────
   Geometry
   ──────────────────────────────────────────────────────────────────────── */

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Shoelace area of a polygon. Always positive. */
function polyArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Andrew's monotone chain. Returns the hull in order, no repeated endpoint. */
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));

  const build = (src) => {
    const out = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  const lower = build(pts);
  const upper = build(pts.slice().reverse());
  return lower.concat(upper);
}

/**
 * Douglas-Peucker on a CLOSED polygon. Split at the two most distant vertices
 * first so the result does not depend on where the vertex list starts.
 */
function simplifyClosed(poly, epsilon) {
  if (poly.length <= 4) return poly.slice();

  let ai = 0, bi = 0, best = -1;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const d = dist(poly[i], poly[j]);
      if (d > best) { best = d; ai = i; bi = j; }
    }
  }

  const arc = (from, to) => {
    const out = [];
    for (let i = from; ; i = (i + 1) % poly.length) {
      out.push(poly[i]);
      if (i === to) break;
    }
    return out;
  };

  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const L = dist(a, b);
    let idx = -1, dmax = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = L < 1e-9 ? dist(pts[i], a) : Math.abs(cross(a, b, pts[i])) / L;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax <= epsilon || idx < 0) return [a, b];
    return dp(pts.slice(0, idx + 1)).slice(0, -1).concat(dp(pts.slice(idx)));
  };

  const first = dp(arc(ai, bi));
  const second = dp(arc(bi, ai));
  return first.slice(0, -1).concat(second.slice(0, -1));
}

/**
 * The four vertices of `hull` enclosing the most area, kept in hull order.
 * On a rectangle seen in perspective this lands exactly on the corners.
 * O(n^4), but the hull is simplified to a handful of points first and capped.
 */
function maxAreaQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  if (n === 4) return hull.slice();

  // Guard the quartic: keep the vertices furthest from the centroid.
  let pts = hull;
  if (n > 16) {
    const c = hull.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
    const keep = hull.map((p, i) => ({ i, d: dist(p, c) }))
      .sort((a, b) => b.d - a.d).slice(0, 16).map((o) => o.i).sort((a, b) => a - b);
    pts = keep.map((i) => hull[i]);
  }

  const m = pts.length;
  let best = null, bestArea = -1;
  for (let i = 0; i < m - 3; i++) {
    for (let j = i + 1; j < m - 2; j++) {
      for (let k = j + 1; k < m - 1; k++) {
        for (let l = k + 1; l < m; l++) {
          const quad = [pts[i], pts[j], pts[k], pts[l]];
          const a = polyArea(quad);
          if (a > bestArea) { bestArea = a; best = quad; }
        }
      }
    }
  }
  return best;
}

/**
 * Order four corners top-left, top-right, bottom-right, bottom-left, walking
 * clockwise in screen coordinates (y down).
 */
export function orderCorners(quad) {
  const c = quad.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  const sorted = quad.slice().sort((a, b) =>
    Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));

  let start = 0, bestSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < bestSum) { bestSum = s; start = i; }
  }
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

/** Average width and height of a quad, from its opposite sides. */
export function quadSize(q) {
  return {
    w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2,
    h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2,
  };
}

/** Rotate corner order one step clockwise. Drives the UI's Rotate button. */
export function rotateQuad(q, steps = 1) {
  const s = ((steps % 4) + 4) % 4;
  return [0, 1, 2, 3].map((i) => q[(i + s) % 4]);
}

/* ────────────────────────────────────────────────────────────────────────
   Image basics
   ──────────────────────────────────────────────────────────────────────── */

/** Box-filter downscale so the long edge is at most `maxEdge`. */
export function downscale(img, maxEdge) {
  const { width: w, height: h } = img;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  if (scale >= 1) return { data: img.data, width: w, height: h, scale: 1 };

  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const src = img.data;

  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * h / nh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * w / nw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / nw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) { r += src[p]; g += src[p + 1]; b += src[p + 2]; n++; }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh, scale: nw / w };
}

/** Rec. 709 luminance, one byte per pixel. */
function luminance(img) {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) | 0;
  }
  return out;
}

/** Otsu's threshold over a 0–255 byte array. */
function otsu(vals) {
  const hist = new Float64Array(256);
  for (let i = 0; i < vals.length; i++) hist[vals[i]]++;

  const total = vals.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

/* ────────────────────────────────────────────────────────────────────────
   Morphology — separable min/max, so the radius is nearly free
   ──────────────────────────────────────────────────────────────────────── */

function morph(mask, w, h, r, want) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {                      // horizontal pass
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = want ? 0 : 1;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) {
        const m = mask[row + k];
        if (want ? m : !m) { v = want ? 1 : 0; break; }
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {                      // vertical pass
    for (let y = 0; y < h; y++) {
      let v = want ? 0 : 1;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) {
        const m = tmp[k * w + x];
        if (want ? m : !m) { v = want ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

const dilate = (m, w, h, r) => morph(m, w, h, r, 1);
const erode  = (m, w, h, r) => morph(m, w, h, r, 0);
const close  = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);

/**
 * Fill enclosed holes. This is the step that turns "we only found the slip's
 * outline" or "we only found its two grey bands" into one solid slip.
 * Anything background-coloured that cannot reach the image border is interior.
 */
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;

  const push = (p) => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

  while (sp > 0) {
    const p = stack[--sp];
    const y = (p / w) | 0, x = p - y * w;
    if (x > 0)     push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0)     push(p - w);
    if (y < h - 1) push(p + w);
  }

  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (mask[i] || !outside[i]) ? 1 : 0;
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
   Candidate masks — three different ideas about what "the slip" means
   ──────────────────────────────────────────────────────────────────────── */

/**
 * MASK 1 — edges. Sobel magnitude, thresholded and closed. Works no matter
 * what colour the slip is, because it only cares that its border differs from
 * whatever it sits on. Usually the best performer on a two-tone slip.
 */
function edgeMask(g, w, h, r) {
  // A low fraction of the strongest edge keeps soft, out-of-focus borders and
  // the slip's low-contrast grey-on-desk outline.
  const t = Math.max(12, g.peak * 0.08);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = g.mag[i] >= t ? 1 : 0;

  return fillHoles(close(mask, w, h, r), w, h);
}

/**
 * MASK 2 — difference from the desk. Estimate the background from a ring
 * around the frame edge, then keep everything that does not look like it.
 * Catches the whole slip, grey bands included.
 */
function backgroundMask(img, w, h, r) {
  const d = img.data;
  const band = Math.max(3, Math.round(Math.min(w, h) * 0.06));

  // Modal colour of the border ring, in coarse 16-level bins: robust even when
  // the slip runs off the edge of the frame and contaminates part of the ring.
  const bins = new Map();
  const consider = (x, y) => {
    const p = (y * w + x) * 4;
    const key = ((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4);
    const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += d[p]; e.g += d[p + 1]; e.b += d[p + 2];
    bins.set(key, e);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < band || y < band || x >= w - band || y >= h - band) consider(x, y);
    }
  }
  let top = null;
  for (const e of bins.values()) if (!top || e.n > top.n) top = e;
  if (!top) return null;
  const bg = [top.r / top.n, top.g / top.n, top.b / top.n];

  const diff = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < diff.length; i++, p += 4) {
    diff[i] = Math.min(255,
      (Math.abs(d[p] - bg[0]) + Math.abs(d[p + 1] - bg[1]) + Math.abs(d[p + 2] - bg[2])) / 2) | 0;
  }

  const t = Math.max(18, otsu(diff));
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = diff[i] >= t ? 1 : 0;

  return fillHoles(close(mask, w, h, r), w, h);
}

/** MASK 3 — plain Otsu on luminance, both polarities. The simple case. */
function toneMask(gray, w, h, r, bright) {
  const t = otsu(gray);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (bright ? gray[i] > t : gray[i] <= t) ? 1 : 0;
  }
  return fillHoles(close(mask, w, h, r), w, h);
}

/* ────────────────────────────────────────────────────────────────────────
   Blob finding
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Label 4-connected regions and return the ones worth looking at. Iterative,
 * because a recursive flood fill blows the call stack on a full-frame blob.
 */
function findBlobs(mask, w, h, minArea, maxArea) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const blobs = [];
  let next = 0;

  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed] !== -1) continue;

    const id = next++;
    let sp = 0, area = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    // Per-row horizontal extremes: a faithful outline for a convex-ish shape,
    // and far fewer points to hull than every boundary pixel.
    const rowMin = new Int32Array(h).fill(-1);
    const rowMax = new Int32Array(h).fill(-1);

    stack[sp++] = seed;
    labels[seed] = id;

    while (sp > 0) {
      const p = stack[--sp];
      const y = (p / w) | 0, x = p - y * w;

      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (rowMin[y] < 0 || x < rowMin[y]) rowMin[y] = x;
      if (rowMax[y] < 0 || x > rowMax[y]) rowMax[y] = x;

      if (x > 0     && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0     && mask[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack[sp++] = p + w; }
    }

    if (area < minArea || area > maxArea) continue;

    const outline = [];
    for (let y = minY; y <= maxY; y++) {
      if (rowMin[y] < 0) continue;
      outline.push({ x: rowMin[y], y });
      if (rowMax[y] !== rowMin[y]) outline.push({ x: rowMax[y], y });
    }
    blobs.push({ area, minX, maxX, minY, maxY, outline });
  }

  return blobs;
}

/* ────────────────────────────────────────────────────────────────────────
   Candidate generator 2 — straight lines

   WHY A SECOND GENERATOR AT ALL
   -----------------------------
   Blobs handle a slip alone on a desk beautifully. They fall apart the moment
   the slip overlaps something else made of paper: a slip lying on a student's
   open workbook is ONE connected region of "not-desk" at every threshold, so
   no amount of re-thresholding will ever hand back the slip on its own.

   Lines do not have that problem. The slip's four borders are four straight,
   high-contrast edges whether or not it overlaps anything, so we find the
   lines first and assemble rectangles from them afterwards.

   This is a gradient-guided Hough transform: each edge pixel only votes for
   the handful of angles near its own gradient direction, which is both much
   faster than a full sweep and much cleaner, because a pixel on a horizontal
   edge cannot smear votes across vertical lines.
   ──────────────────────────────────────────────────────────────────────── */

const NTHETA = 180;                       // 1-degree resolution
const THETA_STEP = Math.PI / NTHETA;

/**
 * Sobel gradients plus a thinned edge map (non-maximum suppression).
 *
 * Run per COLOUR CHANNEL, keeping whichever channel responds strongest at each
 * pixel, rather than on luminance alone. The slip's grey card (about 90,90,98)
 * against a warm wooden desk (about 104,96,84) is nearly invisible in
 * brightness — the two differ by a handful of levels — but they are far apart
 * in blue. A luminance-only Sobel loses the slip's top and left borders in
 * exactly that situation, which is how a crop ends up anchored to whatever
 * strong internal ruling it can find instead.
 */
function gradients(img, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  const d = img.data;
  let peak = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = (i - w - 1) * 4, tc = (i - w) * 4, tr = (i - w + 1) * 4;
      const ml = (i - 1) * 4,                       mr = (i + 1) * 4;
      const bl = (i + w - 1) * 4, bc = (i + w) * 4, br = (i + w + 1) * 4;

      let bestA = 0, bestB = 0, bestM = -1;
      for (let c = 0; c < 3; c++) {
        const a = -d[tl + c] - 2 * d[ml + c] - d[bl + c]
                  + d[tr + c] + 2 * d[mr + c] + d[br + c];
        const b = -d[tl + c] - 2 * d[tc + c] - d[tr + c]
                  + d[bl + c] + 2 * d[bc + c] + d[br + c];
        const m = a * a + b * b;
        if (m > bestM) { bestM = m; bestA = a; bestB = b; }
      }

      gx[i] = bestA; gy[i] = bestB;
      const m = Math.sqrt(bestM);
      mag[i] = m;
      if (m > peak) peak = m;
    }
  }

  // Thin the ridges: keep a pixel only if it is a local maximum along its own
  // gradient. Fat edges turn one true line into a smear of Hough peaks.
  //
  // The threshold is deliberately low. The slip's outer border is grey card
  // against a desk, which can be a far weaker edge than the crisp black-on-
  // white ruling inside the form — set this by the strongest edge in the frame
  // and the slip's own outline drops out while its contents survive.
  const thin = new Uint8Array(w * h);
  const t = Math.max(20, peak * 0.08);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < t) continue;
      const nx = gx[i] / m, ny = gy[i] / m;
      const sx = Math.abs(nx) > 0.383 ? Math.sign(nx) : 0;
      const sy = Math.abs(ny) > 0.383 ? Math.sign(ny) : 0;
      const f = mag[i + sy * w + sx], bk = mag[i - sy * w - sx];
      if (m >= f && m >= bk) thin[i] = 1;
    }
  }
  return { gx, gy, mag, thin, peak };
}

/**
 * Dominant straight lines, as {theta, rho, votes}.
 * A line is stored in normal form: x*cos(theta) + y*sin(theta) = rho.
 */
function findLines(g, w, h, maxLines = 90) {
  const { gx, gy, thin } = g;
  const diag = Math.ceil(Math.hypot(w, h));
  const nrho = 2 * diag + 1;
  const acc = new Float32Array(NTHETA * nrho);
  const SPREAD = 3;                        // vote +/- 3 degrees around the normal

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!thin[i]) continue;

      // The gradient points across the edge, which is exactly the line normal.
      let ang = Math.atan2(gy[i], gx[i]);
      if (ang < 0) ang += Math.PI;
      const centre = Math.round(ang / THETA_STEP);

      for (let d = -SPREAD; d <= SPREAD; d++) {
        let ti = centre + d;
        let sign = 1;
        if (ti < 0) { ti += NTHETA; sign = -1; }        // theta wraps at PI, rho flips
        else if (ti >= NTHETA) { ti -= NTHETA; sign = -1; }
        const th = ti * THETA_STEP;
        const rho = sign * (x * Math.cos(th) + y * Math.sin(th));
        const ri = Math.round(rho) + diag;
        if (ri < 0 || ri >= nrho) continue;
        acc[ti * nrho + ri] += 1;
      }
    }
  }

  // Peak picking with non-maximum suppression in a (theta, rho) window.
  let maxV = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxV) maxV = acc[i];
  if (maxV < 12) return [];

  const floor = Math.max(10, maxV * 0.22);
  const peaks = [];
  for (let ti = 0; ti < NTHETA; ti++) {
    for (let ri = 1; ri < nrho - 1; ri++) {
      const v = acc[ti * nrho + ri];
      if (v < floor) continue;
      if (v < acc[ti * nrho + ri - 1] || v < acc[ti * nrho + ri + 1]) continue;
      peaks.push({ ti, ri, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);

  // Suppression has to stay TIGHT. A slip's outer border and the inner edge of
  // its grey header band are only a few pixels apart; a generous window merges
  // them into one peak that lands between the two, which is how a crop ends up
  // consistently shaved by a few percent on every side.
  const kept = [];
  const RHO_NMS = Math.max(4, diag * 0.008), THETA_NMS = 4;
  for (const p of peaks) {
    let clash = false;
    for (const k of kept) {
      let dt = Math.abs(p.ti - k.ti);
      dt = Math.min(dt, NTHETA - dt);
      // Near theta wrap the rho sign flips, so compare both readings.
      const drho = Math.min(Math.abs(p.ri - k.ri), Math.abs(p.ri + k.ri - 2 * diag));
      if (dt <= THETA_NMS && drho <= RHO_NMS) { clash = true; break; }
    }
    if (clash) continue;
    kept.push(p);
    if (kept.length >= maxLines) break;
  }

  const lines = kept.map((p) => ({
    theta: p.ti * THETA_STEP,
    rho: p.ri - diag,
    votes: p.v,
  }));

  return refineLines(lines, g, w, h);
}

/**
 * Re-fit each line to the edge pixels that actually support it.
 *
 * The accumulator is quantised to 1 degree and 1 pixel, and on a 640px frame a
 * one-degree error moves the ends of a line by ~11px. That is the difference
 * between a crop on the slip's border and a crop a few millimetres inside it.
 * Total-least-squares through the supporting pixels removes the quantisation
 * entirely and costs one pass over the edge list per line.
 */
function refineLines(lines, g, w, h) {
  const { gx, gy, thin } = g;

  // Flatten the edge map once; every line then scans this short list.
  const pts = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (thin[i]) pts.push(x, y, gx[i], gy[i]);
    }
  }

  return lines.map((L) => {
    const ct = Math.cos(L.theta), st = Math.sin(L.theta);
    let n = 0, sx = 0, sy = 0;
    const near = [];

    for (let k = 0; k < pts.length; k += 4) {
      const x = pts[k], y = pts[k + 1];
      if (Math.abs(x * ct + y * st - L.rho) > 2.5) continue;
      // The pixel's gradient must agree with the line's normal, or a crossing
      // line's pixels get pulled into the fit and tilt it.
      const gxv = pts[k + 2], gyv = pts[k + 3];
      const m = Math.hypot(gxv, gyv) || 1;
      if (Math.abs((gxv / m) * ct + (gyv / m) * st) < 0.86) continue;   // ~30 degrees
      near.push(x, y);
      sx += x; sy += y; n++;
    }
    if (n < 12) return L;

    const mx = sx / n, my = sy / n;
    let vxx = 0, vyy = 0, vxy = 0;
    for (let k = 0; k < near.length; k += 2) {
      const dx = near[k] - mx, dy = near[k + 1] - my;
      vxx += dx * dx; vyy += dy * dy; vxy += dx * dy;
    }

    // Principal axis of the covariance = the line's direction; the normal is
    // perpendicular to it.
    const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
    let nt = theta + Math.PI / 2;
    nt = ((nt % Math.PI) + Math.PI) % Math.PI;
    const rho = mx * Math.cos(nt) + my * Math.sin(nt);

    return { theta: nt, rho, votes: L.votes };
  });
}

/** Where two lines in normal form meet. Null when they are near-parallel. */
function intersect(a, b) {
  const ca = Math.cos(a.theta), sa = Math.sin(a.theta);
  const cb = Math.cos(b.theta), sb = Math.sin(b.theta);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * sb - b.rho * sa) / det,
    y: (ca * b.rho - cb * a.rho) / det,
  };
}

/** Smallest angle between two undirected line directions, in radians. */
function angleGap(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

/**
 * Chamfer distance transform: for every pixel, roughly how far to the nearest
 * edge pixel. Two passes, 3-4 weighting. Computed once per image so that
 * checking a candidate rectangle costs one array lookup per sample instead of
 * a neighbourhood scan — which is what makes it affordable to test thousands
 * of candidate rectangles rather than dozens.
 */
function distanceToEdge(thin, w, h) {
  const BIG = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = thin[i] ? 0 : BIG;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (y > 0) {
        if (x > 0)     v = Math.min(v, d[i - w - 1] + 4);
        v = Math.min(v, d[i - w] + 3);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      if (x > 0)       v = Math.min(v, d[i - 1] + 3);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (y < h - 1) {
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        v = Math.min(v, d[i + w] + 3);
        if (x > 0)     v = Math.min(v, d[i + w - 1] + 4);
      }
      if (x < w - 1)   v = Math.min(v, d[i + 1] + 3);
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;      // back into pixel units
  return d;
}

/**
 * How much of the quad's perimeter actually sits on a detected edge?
 *
 * Returns the WEAKEST of the four sides, not the average. In a cluttered photo
 * there are enough strong lines around that some four of them will always
 * cross at roughly slip proportions; what those coincidental rectangles almost
 * never have is real edge underneath all four sides at once. Averaging lets a
 * quad with three excellent sides and one invented one through, which is
 * exactly the failure this is here to prevent.
 */
function edgeSupport(quad, dmap, w, h, samples = 40) {
  let worst = 1;
  for (let s = 0; s < 4; s++) {
    const a = quad[s], b = quad[(s + 1) % 4];
    let hits = 0, total = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      total++;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;   // off-frame counts as a miss
      if (dmap[y * w + x] <= 2.2) hits++;
    }
    const side = total ? hits / total : 0;
    if (side < worst) worst = side;
  }
  return worst;
}

/**
 * Assemble rectangles from pairs of near-parallel lines crossed with another
 * near-perpendicular pair, and keep the ones that look like a slip.
 */
function lineCandidates(g, dmap, w, h) {
  const lines = findLines(g, w, h);
  if (lines.length < 4) return [];

  const diag = Math.hypot(w, h);
  const minSep = diag * 0.09;

  // Group lines into parallel pairs, remembering their shared direction.
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i], B = lines[j];
      if (angleGap(A.theta, B.theta) > 0.20) continue;          // ~11.5 degrees
      // theta lives in [0, PI), so two parallel lines can be recorded with
      // opposite normals — one at ~0 and one at ~PI. When that happens their
      // rho signs are flipped relative to each other and the gap is the SUM,
      // not the difference. Getting this backwards silently rejects real
      // opposite sides and lets unrelated lines pair up instead.
      const flipped = Math.abs(A.theta - B.theta) > Math.PI / 2;
      const sep = flipped ? Math.abs(A.rho + B.rho) : Math.abs(A.rho - B.rho);
      if (sep < minSep) continue;
      pairs.push({ A, B, theta: A.theta, votes: A.votes + B.votes });
    }
  }
  if (pairs.length < 2) return [];

  pairs.sort((a, b) => b.votes - a.votes);
  const top = pairs.slice(0, 150);

  /* Build every rectangle the pairs can make, but score them on SHAPE first
     and only then pay for an edge-support check.

     Ranking pairs by vote count instead does not work: a student's ruled
     exercise book contributes two dozen long, high-scoring parallel lines that
     crowd out the slip's own four borders long before the expensive stage.
     Shape is both cheaper to test and far more selective, since we know
     exactly what proportions we are looking for. */
  const rough = [];
  const pad = diag * 0.12;

  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const P = top[i], Q = top[j];
      if (Math.abs(angleGap(P.theta, Q.theta) - Math.PI / 2) > 0.52) continue;  // ~30 deg

      const c1 = intersect(P.A, Q.A), c2 = intersect(P.A, Q.B);
      const c3 = intersect(P.B, Q.B), c4 = intersect(P.B, Q.A);
      if (!c1 || !c2 || !c3 || !c4) continue;

      const quad = [c1, c2, c3, c4];
      // Reject corners far outside the frame: a real slip is in the picture.
      if (quad.some((p) => p.x < -pad || p.y < -pad || p.x > w + pad || p.y > h + pad)) continue;

      const ordered = orderCorners(quad);
      const { w: qw, h: qh } = quadSize(ordered);
      if (qw < 8 || qh < 8) continue;

      const ar = qw / qh;
      const tol = Math.log(TUNING.aspectTolerance);
      const shape = Math.max(
        1 - Math.abs(Math.log(ar / SLIP_ASPECT)) / tol,
        (1 - Math.abs(Math.log(ar * SLIP_ASPECT)) / tol) * TUNING.landscapePenalty
      );
      if (shape <= 0) continue;

      rough.push({ quad: ordered, shape, area: qw * qh });
    }
  }

  // Favour the right shape, then the bigger of two equally plausible ones.
  rough.sort((a, b) => (b.shape - a.shape) || (b.area - a.area));

  const out = [];
  for (const c of rough.slice(0, 500)) {
    const support = edgeSupport(c.quad, dmap, w, h);
    if (support < 0.62) continue;
    out.push({ quad: c.quad, support });
    if (out.length >= 60) break;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
   Candidate generator 3 — aspect completion

   The most common near-miss is a crop that gets three borders right and
   substitutes an internal line for the fourth. On this slip that happens in a
   very specific way: the boundary where the grey header band meets the white
   body is a hard black-on-white edge, while the slip's true top border is grey
   card against a desk and can be far softer. The detector takes the strong
   line and quietly shaves the branding off the top.

   We know the slip is exactly 243.84 x 423.36. So when a candidate is the
   right shape apart from being short in one dimension, push the deficient edge
   out until the proportions are exactly right and see whether there is any
   edge there at all. Cheap, and it only ever proposes — scoring still decides.
   ──────────────────────────────────────────────────────────────────────── */

const norm = (v) => {
  const m = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / m, y: v.y / m };
};
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const shift = (p, d, k) => ({ x: p.x + d.x * k, y: p.y + d.y * k });

function completeAspect(quad, dmap, w, h) {
  const q = orderCorners(quad);
  const [TL, TR, BR, BL] = q;
  const { w: qw, h: qh } = quadSize(q);
  if (qw < 4 || qh < 4) return [];

  const out = [];
  const down = norm({ x: mid(BL, BR).x - mid(TL, TR).x, y: mid(BL, BR).y - mid(TL, TR).y });
  const right = norm({ x: mid(TR, BR).x - mid(TL, BL).x, y: mid(TR, BR).y - mid(TL, BL).y });

  // Too short: extend vertically. Too narrow: extend horizontally.
  const wantH = qw / SLIP_ASPECT;
  const wantW = qh * SLIP_ASPECT;

  const push = (variants) => {
    for (const v of variants) {
      if (v.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
      const ordered = orderCorners(v);
      const support = edgeSupport(ordered, dmap, w, h);
      if (support < 0.35) continue;
      out.push({ quad: ordered, support });
    }
  };

  if (wantH > qh * 1.04 && wantH < qh * 2.6) {
    const d = wantH - qh;
    push([
      [shift(TL, down, -d), shift(TR, down, -d), BR, BL],            // grow upwards
      [TL, TR, shift(BR, down, d), shift(BL, down, d)],              // grow downwards
      [shift(TL, down, -d / 2), shift(TR, down, -d / 2),
       shift(BR, down, d / 2), shift(BL, down, d / 2)],              // grow both ways
    ]);
  }

  if (wantW > qw * 1.04 && wantW < qw * 2.6) {
    const d = wantW - qw;
    push([
      [shift(TL, right, -d), TR, BR, shift(BL, right, -d)],
      [TL, shift(TR, right, d), shift(BR, right, d), BL],
      [shift(TL, right, -d / 2), shift(TR, right, d / 2),
       shift(BR, right, d / 2), shift(BL, right, -d / 2)],
    ]);
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────
   Scoring
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How much does this quad look like a lesson slip?
 *
 * Aspect ratio is weighted hardest: 0.576 is the one thing we know for certain
 * about the target, and it is what separates a slip from a workbook page.
 *
 * `evidence.fill` means slightly different things per generator — for a blob it
 * is how completely the region fills its own quad, for a line quad it is how
 * much of the perimeter sits on a real edge — but both answer the same
 * question: is there actually a rectangle here, or did we just draw one?
 */
function scoreQuad(quad, evidence, w, h) {
  const qArea = polyArea(quad);
  if (qArea < 1) return { total: 0 };

  const ordered = orderCorners(quad);
  const { w: qw, h: qh } = quadSize(ordered);
  if (qw < 4 || qh < 4) return { total: 0 };

  // Either orientation, because the tutor may have shot it sideways — but
  // portrait is strongly preferred. A slip is full of wide internal boxes, and
  // a band of them has almost exactly the aspect of a slip lying on its side
  // (1/0.576 = 1.74), so an unweighted landscape match makes the detector crop
  // to the middle of the form. Sideways captures are rarer than that failure,
  // and the UI's Rotate button makes them cheap to fix.
  const ar = qw / qh;
  const tol = Math.log(TUNING.aspectTolerance);
  const portrait = Math.max(0, 1 - Math.abs(Math.log(ar / SLIP_ASPECT)) / tol);
  const sideways = Math.max(0, 1 - Math.abs(Math.log(ar * SLIP_ASPECT)) / tol)
                 * TUNING.landscapePenalty;
  const aspect = Math.max(portrait, sideways);

  const fill = Math.min(1, evidence.fill);
  const fillScore = fill < TUNING.minFillRatio ? 0
    : (fill - TUNING.minFillRatio) / (1 - TUNING.minFillRatio);

  // Prefer a slip that dominates the frame, with diminishing returns.
  const size = Math.min(1, Math.sqrt((qArea / (w * h)) / 0.40));

  // A region hugging every edge is the desk, the wall, or the frame itself.
  const bb = evidence.bbox || {
    minX: Math.min(...ordered.map((p) => p.x)), maxX: Math.max(...ordered.map((p) => p.x)),
    minY: Math.min(...ordered.map((p) => p.y)), maxY: Math.max(...ordered.map((p) => p.y)),
  };
  const m = 2;
  let edges = 0;
  if (bb.minX <= m) edges++;
  if (bb.minY <= m) edges++;
  if (bb.maxX >= w - 1 - m) edges++;
  if (bb.maxY >= h - 1 - m) edges++;
  const edgePenalty = edges >= 4 ? 0.10 : edges === 3 ? 0.50 : edges === 2 ? 0.85 : 1;

  const W = TUNING.weights;
  const total = (aspect * W.aspect + fillScore * W.fill + size * W.size) * edgePenalty;
  return { total, aspect, fillScore, size, edges, fill, area: qArea, quad: ordered };
}

/* ────────────────────────────────────────────────────────────────────────
   The main entry point
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Find the lesson slip in `img` ({data,width,height}, ImageData-compatible).
 *
 * Returns:
 *   quad       [TL,TR,BR,BL] in FULL-RESOLUTION source coordinates
 *   score      0–1 confidence
 *   confident  true when the crop is safe to show pre-accepted
 *   extras     [{quad,score}] — other slip-shaped things in the frame
 *   landscape  true if the slip was shot sideways and we turned it upright
 *
 * A quad is ALWAYS returned. When nothing convincing is found it falls back to
 * a centred, slip-shaped rectangle with score 0, so the UI drops the tutor
 * into manual adjustment rather than into an error message.
 */
function gatherCandidates(img, tune) {
  const work = downscale(img, tune.workEdge);
  const { width: w, height: h } = work;
  const gray = luminance(work);

  const minArea = w * h * tune.minAreaFrac;
  const maxArea = w * h * tune.maxAreaFrac;
  const epsilon = Math.hypot(w, h) * tune.simplifyFrac;

  // One Sobel pass and one distance transform, shared by every generator.
  const g = gradients(work, w, h);
  const dmap = distanceToEdge(g.thin, w, h);

  const masks = [];
  for (const r of tune.closeRadii) {
    masks.push([`edge@${r}`, edgeMask(g, w, h, r)]);
    masks.push([`background@${r}`, backgroundMask(work, w, h, r)]);
    masks.push([`bright@${r}`, toneMask(gray, w, h, r, true)]);
    masks.push([`dark@${r}`, toneMask(gray, w, h, r, false)]);
  }

  const candidates = [];

  // Generator 1 — regions.
  for (const [name, mask] of masks.filter(([, m]) => m)) {
    for (const blob of findBlobs(mask, w, h, minArea, maxArea)) {
      const hull = convexHull(blob.outline);
      if (hull.length < 4) continue;
      const simple = simplifyClosed(hull, epsilon);
      const quad = maxAreaQuad(simple.length >= 4 ? simple : hull);
      if (!quad) continue;

      const s = scoreQuad(quad, { fill: blob.area / Math.max(1, polyArea(quad)), bbox: blob }, w, h);
      if (s.total > 0) candidates.push({ ...s, mask: name });
    }
  }

  // Generator 2 — lines. The one that copes with overlapping paper.
  for (const c of lineCandidates(g, dmap, w, h)) {
    const s = scoreQuad(c.quad, { fill: c.support }, w, h);
    if (s.total > 0) candidates.push({ ...s, mask: 'lines' });
  }

  // Generator 3 — aspect completion, seeded from the best of the above.
  candidates.sort((a, b) => b.total - a.total);
  for (const seed of candidates.slice(0, 14)) {
    if (seed.aspect > 0.97) continue;                 // already the right shape
    for (const c of completeAspect(seed.quad, dmap, w, h)) {
      const s = scoreQuad(c.quad, { fill: c.support }, w, h);
      if (s.total > seed.total) candidates.push({ ...s, mask: seed.mask + '+fit' });
    }
  }

  candidates.sort((a, b) => b.total - a.total);
  return { work, masks, candidates: suppressNested(candidates, tune) };
}

/** Is point p inside polygon poly? Standard ray crossing count. */
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Drop candidates that sit INSIDE a bigger, comparably-plausible candidate.
 *
 * This is what stops the detector cropping to a block of boxes in the middle
 * of the form. Those inner rectangles are genuinely rectangular and genuinely
 * slip-shaped, so no amount of aspect or fill tuning rules them out — but they
 * are always contained by the slip itself, and that is a fact about the world
 * we can use directly.
 *
 * Deliberately NOT symmetric with overlap: a slip lying on a workbook overlaps
 * it heavily but is not contained by it, so this leaves that case alone.
 */
function suppressNested(candidates, tune) {
  return candidates.filter((c) => {
    // Test the corners pulled slightly towards the candidate's own centre.
    // Inner rectangles very often SHARE a corner or an edge with the slip that
    // contains them (a band of boxes starting at the slip's top-left), and a
    // point sitting exactly on the container's boundary does not count as
    // inside. Shrinking first makes containment robust to that.
    const c0 = c.quad.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    const probes = c.quad.map((p) => ({
      x: p.x + (c0.x - p.x) * 0.08,
      y: p.y + (c0.y - p.y) * 0.08,
    }));

    for (const other of candidates) {
      if (other === c) continue;
      if (other.area < c.area * tune.nestedAreaRatio) continue;
      if (other.total < c.total * tune.nestedScoreFloor) continue;
      if (probes.every((p) => pointInPoly(p, other.quad))) return false;
    }
    return true;
  });
}

export function detectSlip(img, opts = {}) {
  const tune = { ...TUNING, ...opts };
  const { work, candidates } = gatherCandidates(img, tune);
  const upscale = (q) => q.map((p) => ({ x: p.x / work.scale, y: p.y / work.scale }));

  if (!candidates.length) {
    return {
      quad: centredFallback(img.width, img.height),
      score: 0, confident: false, extras: [], landscape: false, mask: 'none',
    };
  }

  const best = candidates[0];
  const bestArea = polyArea(best.quad);

  // Anything else slip-shaped and comparably sized is a second slip. Compare
  // against the winner's area so a slightly more distant slip still registers.
  const extras = [];
  for (const c of candidates.slice(1)) {
    if (c.total < tune.extraMinScore) continue;
    if (polyArea(c.quad) < bestArea * tune.extraAreaFrac) continue;
    if (overlaps(c.quad, best.quad)) continue;               // the same slip, found twice
    if (extras.some((e) => overlaps(c.quad, e.rawQuad))) continue;
    extras.push({ quad: upscale(c.quad), rawQuad: c.quad, score: c.total });
  }

  // Turn a sideways slip upright. Which way it should spin is genuinely
  // ambiguous without reading the text, so the UI offers a Rotate button.
  let quad = best.quad;
  const { w: qw, h: qh } = quadSize(quad);
  const landscape = qw > qh;
  if (landscape) quad = rotateQuad(quad, 1);

  /* Confidence is CONSENSUS, not score.
     A high score only says the winner looked good to whichever generator
     produced it, and a generator that has latched onto the wrong rectangle is
     usually very pleased with it. Independent agreement is a much better
     signal: if the region masks and the line assembler, which share no
     machinery beyond the Sobel pass, land on the same rectangle, it is almost
     certainly the slip. When they disagree the crop may still be right, but we
     drop the tutor into the adjust-corners view rather than saving something
     wrong behind their back. Getting this wrong silently is far more expensive
     than asking. */
  const agreement = candidates.some((c) =>
    c !== best
    && family(c.mask) !== family(best.mask)
    && quadIoU(c.quad, best.quad) >= tune.agreeIoU
    && c.total >= best.total * tune.agreeScoreRatio);

  return {
    quad: upscale(quad),
    score: best.total,
    confident: best.total >= tune.confidentScore
            && best.aspect >= tune.confidentAspect
            && agreement,
    agreement,
    extras: extras.map(({ quad: q, score }) => ({ quad: q, score })),
    landscape,
    mask: best.mask,
    detail: { aspect: best.aspect, fill: best.fill, size: best.size, edges: best.edges },
  };
}

/**
 * Same pipeline as detectSlip, but hands back the intermediate masks and the
 * full scored candidate list. Used only by tools/debug-detect.mjs — when a crop
 * comes out wrong, this says which mask produced the winner and what the runners
 * up looked like, instead of leaving it to guesswork.
 */
export function __debug(img, opts = {}) {
  return gatherCandidates(img, { ...TUNING, ...opts });
}

/** Clip polygon `subject` against convex polygon `clip` (Sutherland-Hodgman). */
function clipPoly(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const input = out;
    out = [];
    if (!input.length) break;
    /* `clip` is wound clockwise on a y-down screen (orderCorners guarantees
       it), and for that winding the INSIDE of an edge is where this cross
       product is positive. Take the sign the other way round and every
       intersection clips to nothing — which reads exactly like two rectangles
       that never overlap, rather than like a bug. */
    const side = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length];
      const sc = side(cur), sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) {
          const t = sp / (sp - sc);
          out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
        }
        out.push(cur);
      } else if (sp >= 0) {
        const t = sp / (sp - sc);
        out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
      }
    }
  }
  return out;
}

/** Exact intersection-over-union of two convex quads. */
function quadIoU(a, b) {
  const inter = polyArea(clipPoly(a, b));
  if (inter <= 0) return 0;
  const union = polyArea(a) + polyArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/* Exposed for the unit check in tools/test-geom.mjs. The clipper's winding
   convention is easy to get backwards and fails silently when you do. */
export const __iou = quadIoU;

/**
 * Identity of the analysis that produced a candidate, for the consensus check.
 *
 * The "+fit" suffix is stripped because an aspect-completed quad is DERIVED
 * from its seed — letting it vouch for that seed would be a candidate
 * agreeing with itself. Different masks and different closing radii do count
 * as separate evidence: they are separate segmentations of the image, and a
 * rectangle that survives all of them is a real one.
 */
const family = (mask) => String(mask).split('+')[0];

/** Do two quads cover much the same ground? Bounding-box overlap is enough. */
function overlaps(a, b) {
  const box = (q) => ({
    x0: Math.min(...q.map((p) => p.x)), x1: Math.max(...q.map((p) => p.x)),
    y0: Math.min(...q.map((p) => p.y)), y1: Math.max(...q.map((p) => p.y)),
  });
  const A = box(a), B = box(b);
  const iw = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
  const ih = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  if (iw <= 0 || ih <= 0) return false;
  const smaller = Math.min((A.x1 - A.x0) * (A.y1 - A.y0), (B.x1 - B.x0) * (B.y1 - B.y0));
  return (iw * ih) / smaller > 0.45;
}

/** A centred, slip-shaped rectangle: the "we found nothing, you drive" crop. */
export function centredFallback(w, h) {
  let cw = w * 0.8, ch = cw / SLIP_ASPECT;
  if (ch > h * 0.9) { ch = h * 0.9; cw = ch * SLIP_ASPECT; }
  const x = (w - cw) / 2, y = (h - ch) / 2;
  return [{ x, y }, { x: x + cw, y }, { x: x + cw, y: y + ch }, { x, y: y + ch }];
}

/* ────────────────────────────────────────────────────────────────────────
   Perspective correction
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Homography taking the destination rectangle (0,0)-(w,h) onto `quad` in the
 * source. Eight unknowns, eight equations, Gaussian elimination with partial
 * pivoting.
 */
function homography(quad, w, h) {
  const dst = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const A = [], B = [];

  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i];
    const { x, y } = quad[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }

  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [B[col], B[pivot]] = [B[pivot], B[col]];

    const p = A[col][col];
    for (let c = col; c < 8; c++) A[col][c] /= p;
    B[col] /= p;

    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      B[r] -= f * B[col];
    }
  }

  return [B[0], B[1], B[2], B[3], B[4], B[5], B[6], B[7]];
}

/**
 * Flatten `quad` out of `img` into a straight outW x outH image.
 * Bilinear sampling — nearest-neighbour makes handwriting look chewed.
 */
export function warp(img, quad, outW, outH) {
  const H = homography(quad, outW, outH);
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (!H) return { data: out, width: outW, height: outH };

  const src = img.data, sw = img.width, sh = img.height;
  const [a, b, c, d, e, f, g, i] = H;

  for (let y = 0; y < outH; y++) {
    // Row-constant parts of the projection, hoisted out of the inner loop.
    const nx0 = b * y + c, ny0 = e * y + f, nw0 = i * y + 1;
    let o = y * outW * 4;

    for (let x = 0; x < outW; x++, o += 4) {
      const wgt = g * x + nw0;
      if (Math.abs(wgt) < 1e-9) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255; continue; }
      const sx = (a * x + nx0) / wgt;
      const sy = (d * x + ny0) / wgt;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255;
        continue;
      }

      const x0 = sx | 0, y0 = sy | 0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy,       w11 = fx * fy;

      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;

      out[o]     = src[p00]     * w00 + src[p10]     * w10 + src[p01]     * w01 + src[p11]     * w11;
      out[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      out[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      out[o + 3] = 255;
    }
  }

  return { data: out, width: outW, height: outH };
}

/* ────────────────────────────────────────────────────────────────────────
   Which way up?
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Is this flattened slip upside down?
 *
 * A slip is very nearly symmetric end to end — a dark band top and bottom with
 * white between — so nothing about its outline says which way up it goes, and
 * a slip photographed sideways lands at 180 degrees as often as not.
 *
 * Its CONTENTS are not symmetric though. The upper part of the white body
 * holds the boxes (date, times, subject, names), while the lower part holds
 * the run of evenly spaced full-width ruled lines for the lesson notes. So we
 * find the white body, count full-width dark rows in each half, and the half
 * with more of them is the bottom.
 *
 * Returns true when the image should be turned through 180 degrees.
 */
export function isUpsideDown(img) {
  const { width: w, height: h, data } = img;
  const x0 = Math.round(w * 0.10), x1 = Math.round(w * 0.90);
  const span = Math.max(1, x1 - x0);

  // Mean luminance per row, across the middle of the slip so the margins and
  // any residual background at the edges do not skew it.
  const rowLum = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      s += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    rowLum[y] = s / span;
  }

  /* Find the white body as the gap BETWEEN the two dark bands, using a
     smoothed profile. Looking for the longest unbroken run of bright rows does
     not work: every ruled line and every box edge is a dark full-width row
     that chops the body into dozens of short fragments, and the longest of
     those is just the gap between two rulings. */
  const R = Math.max(2, Math.round(h * 0.008));
  const smooth = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R); k++) { s += rowLum[k]; n++; }
    smooth[y] = s / n;
  }

  let bodyStart = -1, bodyEnd = -1;
  for (let y = 0; y < h; y++) if (smooth[y] > 165) { bodyStart = y; break; }
  for (let y = h - 1; y >= 0; y--) if (smooth[y] > 165) { bodyEnd = y + 1; break; }
  if (bodyStart < 0 || bodyEnd - bodyStart < h * 0.25) return false;

  const bestStart = bodyStart, bestLen = bodyEnd - bodyStart;

  /* The answer is in the two GREY BANDS, not in the form between them.

     The obvious signal — the seven evenly spaced note rulings live in the
     lower half — works beautifully on a blank slip and falls apart the moment
     anyone writes on it, because handwriting adds dark rows everywhere and
     destroys the spacing regularity it depends on. Tutors always write on
     these, so that heuristic was measuring the one thing guaranteed not to be
     there.

     Nobody writes on the bands. The header band carries the large white GENIUS
     wordmark; the footer band carries three lines of small contact text. On
     the print file that is 6,365 white pixels against 3,437 — a 1.85x
     difference that handwriting cannot touch.

     Note that this has to be a COUNT, not a position. Anything positional is
     useless here: a 180-degree turn flips both bands, so "the top band is
     right-heavy" stays true either way up. The amount of white does not
     survive the swap, which is exactly why it works. */
  const bandWhite = (y0, y1) => {
    if (y1 - y0 < 4) return 0;
    const lums = [];
    for (let y = y0; y < y1; y++) lums.push(rowLum[y]);
    lums.sort((a, b) => a - b);
    const median = lums[Math.floor(lums.length / 2)];
    const mark = median + 45;              // "lighter than this band's own grey"

    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 4;
        const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
        if (lum > mark) count++;
      }
    }
    return count / ((y1 - y0) * span);
  };

  const topBand = bandWhite(0, bestStart);
  const bottomBand = bandWhite(bodyEnd, h);

  // Only act on a clear margin. A near-tie means we cannot tell, and guessing
  // would turn correctly-oriented slips upside down half the time.
  return bottomBand > topBand * 1.4 && bottomBand > 0.004;
}

/* ────────────────────────────────────────────────────────────────────────
   Document clean-up
   ──────────────────────────────────────────────────────────────────────── */

/** Turn an image through 180 degrees, returning a new buffer. */
export function rotate180(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const s = i * 4, d = (n - 1 - i) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1];
    out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return { data: out, width: w, height: h };
}

/**
 * Per-channel auto-levels, in place. Phone photos of paper under classroom
 * lighting come out grey and yellow; this pulls the page back towards white
 * without the blown-out look of a hard threshold.
 *
 * Stretching each channel separately is what removes a colour cast: under
 * tungsten light the blue channel needs several times the gain of the red one,
 * so the cap has to be generous or warm photos stay orange. It only ever
 * brightens, so a correctly exposed slip is left alone.
 */
export function autoLevels(img, { lowPct = 0.02, highPct = 0.97, maxGain = 3.6 } = {}) {
  const d = img.data, n = img.width * img.height;

  for (let ch = 0; ch < 3; ch++) {
    const hist = new Uint32Array(256);
    for (let i = 0, p = ch; i < n; i++, p += 4) hist[d[p]]++;

    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * lowPct) { lo = v; break; } }
    acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * highPct) { hi = v; break; } }

    if (hi - lo < 12) continue;                     // flat channel: leave it alone
    let gain = 245 / (hi - lo);
    if (gain > maxGain) gain = maxGain;
    if (gain < 1) gain = 1;                         // only ever brighten

    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) * gain;
    for (let i = 0, p = ch; i < n; i++, p += 4) d[p] = lut[d[p]];
  }

  return img;
}

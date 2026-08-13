/* ============================================================================
   digital.js — the slip to use when there is no paper slip.

   This redraws GENIUS LESSON SLIP SHEET PRINT FILE V3.2 onto a canvas at the
   exact proportions of the printed one, fills in the tutor's answers, and drops
   both signatures in. The result is an ordinary slip image, so it goes down the
   same road as a photographed slip: same store, same WhatsApp share, same
   month-end compile. Nothing downstream needs to know which kind it is.

   EVERY NUMBER BELOW WAS MEASURED OFF THE PRINT FILE, in PostScript points on
   a 243.84 x 423.36 page, by reading its vector geometry rather than eyeballing
   a screenshot. That is why a digital slip and a photo of a paper slip line up
   when they land on the same page of the compiled PDF.

   The layout has no printed labels — the boxes are blank on the real slip, and
   tutors know what goes where. FIELDS below is that knowledge written down.
   ========================================================================== */

/* The page, and the two grey bands that make it recognisably a Genius slip. */
export const PAGE = { w: 243.84, h: 423.36 };
export const HEADER_H = 100.8;          // grey band, top of page down to here
export const FOOTER_Y = 334.1;          // grey band, here down to the bottom

export const BRAND = {
  band:    '#6D6C71',                   // measured (109,108,113)
  pattern: 'rgba(0,0,0,0.05)',          // the faint node motif in the bands
  gold:    '#F5B51A',                   // measured (245,181,26)
  white:   '#FFFFFF',
  rule:    '#6C6C6C',                   // box borders and note rulings
  ink:     '#1A1816',                   // what the tutor writes
};

/* Column geometry, shared by rows 2-4. */
const X0 = 17.3, X_WIDE_END = 146.0, X_NARROW = 157.4, X1 = 216.2;

export const FIELDS = {
  // Row 1 — date in three cells, then the two times. The printed "h" is the
  // separator, South African style: 14h30. Hours go left of it, minutes right.
  dateCells: [
    { x0: 17.3, x1: 36.5 },             // DD
    { x0: 36.5, x1: 56.3 },             // MM
    { x0: 56.3, x1: 75.7 },             // YY
  ],
  row1: { y0: 111.7, y1: 124.2 },
  timeFrom: { x0: 87.4, x1: 146.2 },
  timeTo:   { x0: 157.4, x1: 216.2 },
  dash:     { x: 151.8 },               // the little rule between the two times

  // Rows 2-4 — a wide box and a narrow one.
  subject:    { x0: X0, x1: X_WIDE_END, y0: 136.2, y1: 161.2 },
  hours:      { x0: X_NARROW, x1: X1,   y0: 136.2, y1: 161.2 },
  student:    { x0: X0, x1: X_WIDE_END, y0: 173.9, y1: 199.1 },
  studentSig: { x0: X_NARROW, x1: X1,   y0: 173.9, y1: 199.1 },
  tutor:      { x0: X0, x1: X_WIDE_END, y0: 211.3, y1: 236.5 },
  tutorSig:   { x0: X_NARROW, x1: X1,   y0: 211.3, y1: 236.5 },

  // The seven ruled lines for lesson notes.
  noteLines: [249.0, 261.2, 273.7, 286.0, 298.4, 310.9, 323.2],
  noteX: { x0: X0, x1: X1 },
};

/* ────────────────────────────────────────────────────────────────────────
   Drawing helpers. All of these take points and convert internally, so the
   code below reads in the same units as the measurements above.
   ──────────────────────────────────────────────────────────────────────── */

function makePainter(ctx, s) {
  const P = (v) => v * s;

  return {
    rect(x0, y0, x1, y1, { fill, stroke, lw = 0.7 } = {}) {
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(P(x0), P(y0), P(x1 - x0), P(y1 - y0));
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(1, P(lw));
        ctx.strokeRect(P(x0), P(y0), P(x1 - x0), P(y1 - y0));
      }
    },

    line(x0, y0, x1, y1, { stroke = BRAND.rule, lw = 0.7 } = {}) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, P(lw));
      ctx.beginPath();
      ctx.moveTo(P(x0), P(y0));
      ctx.lineTo(P(x1), P(y1));
      ctx.stroke();
    },

    /** Text positioned by its BASELINE, as the print file specifies it. */
    text(str, x, baseline, {
      size = 9, weight = 400, colour = BRAND.ink, align = 'left',
      family = 'Montserrat, Arial, Helvetica, sans-serif', tracking = 0,
    } = {}) {
      if (str == null || str === '') return;
      ctx.font = `${weight} ${P(size)}px ${family}`;
      ctx.fillStyle = colour;
      ctx.textBaseline = 'alphabetic';

      if (!tracking) {
        ctx.textAlign = align;
        ctx.fillText(String(str), P(x), P(baseline));
        return;
      }

      // Canvas has no letter-spacing everywhere yet, so step the glyphs.
      const chars = [...String(str)];
      const gap = P(tracking);
      const total = chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + gap * (chars.length - 1);
      let cx = align === 'right' ? P(x) - total : align === 'center' ? P(x) - total / 2 : P(x);
      ctx.textAlign = 'left';
      for (const c of chars) {
        ctx.fillText(c, cx, P(baseline));
        cx += ctx.measureText(c).width + gap;
      }
    },

    /** Fit an image inside a box without stretching it. */
    image(img, box, { pad = 1.5 } = {}) {
      if (!img) return;
      const bw = (box.x1 - box.x0) - pad * 2;
      const bh = (box.y1 - box.y0) - pad * 2;
      const scale = Math.min(bw / img.width, bh / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(
        img,
        P(box.x0 + pad + (bw - w) / 2),
        P(box.y0 + pad + (bh - h) / 2),
        P(w), P(h)
      );
    },
  };
}

/** The faint node-network motif printed into the two grey bands. */
function drawPattern(ctx, s, y0, y1) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y0 * s, PAGE.w * s, (y1 - y0) * s);
  ctx.clip();
  ctx.strokeStyle = BRAND.pattern;
  ctx.fillStyle = BRAND.pattern;
  ctx.lineWidth = Math.max(1, 1.6 * s);

  const step = 26;
  for (let y = y0 - step; y < y1 + step; y += step) {
    for (let x = -step; x < PAGE.w + step; x += step) {
      const off = (Math.round(y / step) % 2) * (step / 2);
      ctx.beginPath();
      ctx.arc((x + off) * s, y * s, 7.5 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc((x + off + step / 2) * s, (y + step / 2) * s, 3.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** The GENIUS wordmark, top right of the header band. */
function drawLogo(p, ctx, s) {
  p.text('GENIUS', 216.5, 36.0, {
    size: 20, weight: 800, colour: BRAND.white, align: 'right', tracking: -0.3,
  });
  p.text('PREMIUM TUITION', 216.5, 44.5, {
    size: 5.6, weight: 600, colour: BRAND.white, align: 'right', tracking: 1.15,
  });
  // The gold stroke through the E of GENIUS.
  ctx.fillStyle = BRAND.gold;
  ctx.beginPath();
  ctx.moveTo(150.5 * s, 30.5 * s);
  ctx.lineTo(164.0 * s, 27.2 * s);
  ctx.lineTo(164.0 * s, 30.8 * s);
  ctx.lineTo(150.5 * s, 33.6 * s);
  ctx.closePath();
  ctx.fill();
}

/* ────────────────────────────────────────────────────────────────────────
   Text fitting
   ──────────────────────────────────────────────────────────────────────── */

/** Shrink text until it fits a box. Long subject names should not overflow. */
function fitText(ctx, str, maxWidthPt, s, startSize, weight) {
  let size = startSize;
  const family = 'Montserrat, Arial, Helvetica, sans-serif';
  while (size > 4.5) {
    ctx.font = `${weight} ${size * s}px ${family}`;
    if (ctx.measureText(str).width <= maxWidthPt * s) break;
    size -= 0.4;
  }
  return size;
}

/** Greedy word wrap into at most `maxLines` lines of `maxWidthPt`. */
function wrapNotes(ctx, text, maxWidthPt, s, size, maxLines) {
  ctx.font = `400 ${size * s}px Montserrat, Arial, Helvetica, sans-serif`;
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';

  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(trial).width <= maxWidthPt * s || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** "14:30" -> {h:"14", m:"30"}; tolerates "1430", "14h30" and "14". */
export function splitTime(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (!digits) return { h: '', m: '' };
  if (digits.length <= 2) return { h: digits, m: '' };
  return { h: digits.slice(0, digits.length - 2), m: digits.slice(-2) };
}

/** "2026-08-13" -> ["13","08","26"] for the three date cells. */
export function splitDate(iso) {
  const [y, m, d] = String(iso || '').split('-');
  if (!y || !m || !d) return ['', '', ''];
  return [d, m, y.slice(2)];
}

/* ────────────────────────────────────────────────────────────────────────
   The renderer
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Draw a complete lesson slip.
 *
 * `values`  { date, timeFrom, timeTo, subject, hours, student, tutor, notes,
 *             studentSig, tutorSig }   signatures are HTMLImageElements or null
 * `width`   output width in pixels; height follows the slip's aspect ratio
 *
 * Returns the canvas, ready for encodeSlip().
 */
export function renderSlip(values = {}, { width = 900 } = {}) {
  const s = width / PAGE.w;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(PAGE.h * s);

  const ctx = canvas.getContext('2d');
  const p = makePainter(ctx, s);

  // Paper
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Bands
  p.rect(0, 0, PAGE.w, HEADER_H, { fill: BRAND.band });
  p.rect(0, FOOTER_Y, PAGE.w, PAGE.h, { fill: BRAND.band });
  drawPattern(ctx, s, 0, HEADER_H);
  drawPattern(ctx, s, FOOTER_Y, PAGE.h);

  // Header
  p.text('LESSON SLIP', 18.8, 35.0, {
    size: 9.2, weight: 700, colour: BRAND.gold, tracking: 0.5,
  });
  drawLogo(p, ctx, s);
  p.text('Premium Private Tuition', 20.7, 78.0, {
    size: 11.5, weight: 400, colour: BRAND.gold,
  });

  // Footer
  p.text('We follow a philosophy, not a', 13.4, 358.5, { size: 9.6, colour: BRAND.gold });
  p.text('methodology.', 13.9, 371.5, { size: 9.6, colour: BRAND.gold });
  p.text('Reception@GeniusPremium.com  |  011 467 9884', 13.2, 396.5,
    { size: 6.2, colour: BRAND.white });
  p.text('www.GeniusPremiumTuition.com', 12.9, 409.0, { size: 6.2, colour: BRAND.white });

  /* ── The form itself ─────────────────────────────────────────────────── */
  const F = FIELDS;
  const box = (b) => p.rect(b.x0, b.y0, b.x1, b.y1, { stroke: BRAND.rule });

  // Row 1: date cells
  for (const cell of F.dateCells) {
    p.rect(cell.x0, F.row1.y0, cell.x1, F.row1.y1, { stroke: BRAND.rule });
  }
  const dateParts = splitDate(values.date);
  F.dateCells.forEach((cell, i) => {
    p.text(dateParts[i], (cell.x0 + cell.x1) / 2, F.row1.y1 - 3.6,
      { size: 8.4, weight: 600, align: 'center' });
  });

  // Row 1: the two times, written around the printed "h".
  for (const t of [F.timeFrom, F.timeTo]) {
    p.rect(t.x0, F.row1.y0, t.x1, F.row1.y1, { stroke: BRAND.rule });
  }
  p.line(F.dash.x - 3, (F.row1.y0 + F.row1.y1) / 2, F.dash.x + 3, (F.row1.y0 + F.row1.y1) / 2,
    { stroke: BRAND.ink, lw: 1.1 });

  const baseline1 = F.row1.y1 - 3.6;
  [[F.timeFrom, values.timeFrom], [F.timeTo, values.timeTo]].forEach(([b, v]) => {
    const mid = (b.x0 + b.x1) / 2;
    p.text('h', mid, baseline1, { size: 8, weight: 400, align: 'center', colour: BRAND.ink });
    const { h, m } = splitTime(v);
    p.text(h, mid - 3.2, baseline1, { size: 8.4, weight: 600, align: 'right' });
    p.text(m, mid + 3.2, baseline1, { size: 8.4, weight: 600, align: 'left' });
  });

  // Rows 2-4
  [F.subject, F.hours, F.student, F.studentSig, F.tutor, F.tutorSig].forEach(box);

  const writeIn = (b, value, { pad = 3.5, size = 9.5, weight = 600 } = {}) => {
    if (!value) return;
    const maxW = (b.x1 - b.x0) - pad * 2;
    const fitted = fitText(ctx, String(value), maxW, s, size, weight);
    p.text(value, b.x0 + pad, b.y1 - 8.0, { size: fitted, weight });
  };

  writeIn(F.subject, values.subject);
  writeIn(F.hours, values.hours ? String(values.hours) : '', { size: 9.5 });
  writeIn(F.student, values.student);
  writeIn(F.tutor, values.tutor);

  if (values.studentSig) p.image(values.studentSig, F.studentSig);
  if (values.tutorSig) p.image(values.tutorSig, F.tutorSig);

  // Notes, one per printed ruling.
  F.noteLines.forEach((y) => p.line(F.noteX.x0, y, F.noteX.x1, y, { stroke: BRAND.rule, lw: 0.6 }));

  if (values.notes) {
    const maxW = F.noteX.x1 - F.noteX.x0 - 2;
    const lines = wrapNotes(ctx, values.notes, maxW, s, 7.6, F.noteLines.length);
    lines.forEach((text, i) => {
      p.text(text, F.noteX.x0 + 1, F.noteLines[i] - 2.4, { size: 7.6, weight: 400 });
    });
  }

  return canvas;
}

/** Load a data URL into an Image, for signatures. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the signature image.'));
    img.src = src;
  });
}

/**
 * Wait for Montserrat before drawing. Canvas silently substitutes a fallback
 * font if the webfont has not arrived, and a slip rendered in Times looks
 * nothing like the printed one.
 */
export async function fontsReady() {
  if (!document.fonts) return;
  try {
    await document.fonts.load('700 20px Montserrat');
    await document.fonts.load('400 12px Montserrat');
    await document.fonts.ready;
  } catch { /* fall back to the system sans */ }
}

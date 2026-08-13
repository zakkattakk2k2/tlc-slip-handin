/* ============================================================================
   compile.js — turning a month of slips into the one document that gets handed in.

   Order of the finished PDF, which is the order the office expects:

     1. the branded cover page, filled in and signed
     2. every slip for the month, in lesson-date order
     3. any appended documents (mission docs, misc), in the tutor's order

   The cover overlay is the original app's code, unchanged in behaviour: the
   coordinate map below was calibrated against the real template with pdf.js and
   still matches it, so hand-ins keep looking exactly as they always have.
   ========================================================================== */

import { readAppendix } from './store.js';
import { SLIP_W_PT, SLIP_H_PT } from './detect.js';
import { longDate } from './share.js';

/* ────────────────────────────────────────────────────────────────────────
   COVER OVERLAY COORDINATE MAP  ⭐ NON-DEVELOPERS: EDIT HERE ⭐
   ------------------------------------------------------------------------
   pdf-lib origin = BOTTOM-LEFT. The cover page is US Letter: 612 × 792 pt.
   x grows rightward, y grows upward. After a first render, nudge any value
   by a few points until the text sits neatly on its line.
   If you replace assets/cover-template.pdf, re-check these against the new
   template.
   ──────────────────────────────────────────────────────────────────────── */
export const COVER = {
  page: { width: 612, height: 792 },
  font: { size: 10.5, color: { r: 0.14, g: 0.12, b: 0.13 } },   // near-black
  fields: {
    // y is ~3 pt ABOVE each printed underline so text rests cleanly above the
    // line (not touching it). Underlines sit at y≈641 / 615 / 589 / 228.
    name:           { x: 128, y: 643.5 },
    payMonth:       { x: 128, y: 617.5 },
    dateIssued:     { x: 128, y: 591.5 },
    syndicateCount: { x: 206, y: 427.5 },
    declarationName:{ x: 58,  y: 230.0 },
  },
  syndicateDates: [
    { x: 60,  y: 394.5 }, { x: 118, y: 394.5 }, { x: 179, y: 394.5 },
    { x: 238, y: 394.5 }, { x: 293, y: 394.5 },
  ],
  signature: { x: 92, y: 158, maxWidth: 180, maxHeight: 40 },
};

export const COVER_TEMPLATE_URL = 'assets/cover-template.pdf';
export const MAX_SYNDICATES = 5;

/* Page layout for the slip pages. */
const MARGIN = 36;
const GUTTER = 22;
const CAPTION_H = 13;

/** How the slips are tiled. Two per page is the default: it halves the page
    count while keeping every slip comfortably larger than the printed one. */
export const LAYOUTS = {
  1: { cols: 1, rows: 1, label: 'One per page (largest)' },
  2: { cols: 2, rows: 1, label: 'Two per page (recommended)' },
  4: { cols: 2, rows: 2, label: 'Four per page (fewest pages)' },
};

/* ────────────────────────────────────────────────────────────────────────
   Cover page
   ──────────────────────────────────────────────────────────────────────── */

async function fetchCoverTemplate() {
  let res;
  try {
    res = await fetch(COVER_TEMPLATE_URL);
  } catch {
    throw new Error('Could not load the branded cover template. Check that assets/cover-template.pdf exists.');
  }
  if (!res.ok) {
    throw new Error('The branded cover template (assets/cover-template.pdf) is missing. Add it to the assets folder and try again.');
  }
  return res.arrayBuffer();
}

async function drawCover(pdfDoc, data, StandardFonts, rgb) {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.getPage(0);
  const { size, color } = COVER.font;
  const ink = rgb(color.r, color.g, color.b);

  const draw = (text, pos) => {
    if (!text && text !== 0) return;
    page.drawText(String(text), { x: pos.x, y: pos.y, size, font, color: ink });
  };

  draw(data.name, COVER.fields.name);
  draw(data.payMonth, COVER.fields.payMonth);
  draw(data.dateIssued, COVER.fields.dateIssued);
  draw(String(data.syndicateCount), COVER.fields.syndicateCount);
  draw(data.name, COVER.fields.declarationName);   // repeats in "I, ____"

  (data.syndicateDates || []).forEach((day, i) => {
    if (COVER.syndicateDates[i]) draw(day, COVER.syndicateDates[i]);
  });

  if (data.signaturePng) {
    const png = await pdfDoc.embedPng(data.signaturePng);
    const box = COVER.signature;
    // Scale to fit, never stretch and never enlarge past the box.
    const scale = Math.min(box.maxWidth / png.width, box.maxHeight / png.height, 1);
    page.drawImage(png, {
      x: box.x, y: box.y, width: png.width * scale, height: png.height * scale,
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Slip pages
   ──────────────────────────────────────────────────────────────────────── */

async function drawSlipPages(pdfDoc, slips, perPage, { StandardFonts, rgb }) {
  if (!slips.length) return;

  const layout = LAYOUTS[perPage] || LAYOUTS[2];
  const { width: PW, height: PH } = COVER.page;
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const cellW = (PW - MARGIN * 2 - GUTTER * (layout.cols - 1)) / layout.cols;
  const cellH = (PH - MARGIN * 2 - GUTTER * (layout.rows - 1)) / layout.rows;

  /* Every slip is the same shape, so work out one tile size for the whole
     document and centre the block on the page. Filling from the top-left
     instead leaves a band of empty paper under a two-up page, which looks like
     the document was cut short. */
  const aspect = SLIP_W_PT / SLIP_H_PT;
  let tileW = cellW;
  let tileH = tileW / aspect;
  if (tileH > cellH - CAPTION_H) {
    tileH = cellH - CAPTION_H;
    tileW = tileH * aspect;
  }

  const blockW = layout.cols * tileW + (layout.cols - 1) * GUTTER;
  const startX = (PW - blockW) / 2;

  for (let i = 0; i < slips.length; i += perPage) {
    const page = pdfDoc.addPage([PW, PH]);
    const batch = slips.slice(i, i + perPage);
    const rowsUsed = Math.ceil(batch.length / layout.cols);

    const blockH = rowsUsed * (tileH + CAPTION_H) + (rowsUsed - 1) * GUTTER;
    const startTop = PH - Math.max(MARGIN, (PH - blockH) / 2);

    for (let k = 0; k < batch.length; k++) {
      const slip = batch[k];
      const col = k % layout.cols;
      const row = Math.floor(k / layout.cols);

      let img;
      try {
        img = await embedSlipImage(pdfDoc, slip.image);
      } catch (e) {
        console.error('Could not embed slip', slip.id, e);
        continue;
      }

      // Respect the individual image's own proportions inside the tile, so a
      // hand-adjusted crop that is not exactly 0.576 is never stretched.
      const scale = Math.min(tileW / img.width, tileH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;

      // pdf-lib measures from the bottom, so row 0 is the TOP row.
      const x = startX + col * (tileW + GUTTER) + (tileW - w) / 2;
      const y = startTop - row * (tileH + CAPTION_H + GUTTER) - h;

      page.drawImage(img, { x, y, width: w, height: h });

      // A small date line under each slip, so the office can find one fast.
      const meta = slip.meta || {};
      const caption = [longDate(slip.date), meta.student, meta.subject]
        .filter(Boolean).join('  ·  ');
      if (caption) {
        page.drawText(caption, {
          x, y: y - 9.5, size: 7.5, font, color: rgb(0.42, 0.42, 0.45),
        });
      }
    }
  }
}

async function embedSlipImage(pdfDoc, dataUrl) {
  const isPng = /^data:image\/png/i.test(dataUrl);
  const bytes = dataUrlToBytes(dataUrl);
  return isPng ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
   Appended documents
   ──────────────────────────────────────────────────────────────────────── */

async function appendDocuments(pdfDoc, appendices, PDFDocument, onProgress) {
  const { width: PW, height: PH } = COVER.page;

  for (let i = 0; i < appendices.length; i++) {
    const record = appendices[i];
    if (onProgress) onProgress(`Adding "${record.name}"…`);

    let dataUrl;
    try {
      dataUrl = await readAppendix(record);
    } catch (e) {
      throw new Error(`Could not read the appended document "${record.name}". ${e.message}`);
    }
    const bytes = dataUrlToBytes(dataUrl);

    if (/pdf/i.test(record.mime) || /\.pdf$/i.test(record.name)) {
      let src;
      try {
        src = await PDFDocument.load(bytes);
      } catch (e) {
        if (/encrypt/i.test(e && e.message)) {
          throw new Error(`"${record.name}" is password-protected. Remove the protection and add it again.`);
        }
        throw new Error(`"${record.name}" could not be read as a PDF.`);
      }
      const pages = await pdfDoc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => pdfDoc.addPage(p));
      continue;
    }

    // An image: give it a page of its own, scaled to fit with a margin.
    const img = /png/i.test(record.mime)
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);
    const scale = Math.min((PW - MARGIN * 2) / img.width, (PH - MARGIN * 2) / img.height, 1);
    const w = img.width * scale, h = img.height * scale;
    const page = pdfDoc.addPage([PW, PH]);
    page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
  }
}

/**
 * The original app's behaviour, kept for tutors who still scan a whole month
 * on an office copier: append that file's pages straight after the cover.
 */
export async function appendScannedFile(pdfDoc, file, PDFDocument) {
  const bytes = await file.arrayBuffer();
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  const isImage = /^image\/(jpeg|png)$/.test(type) || /\.(jpe?g|png)$/.test(name);

  if (isImage) {
    const img = /png/.test(type) || /\.png$/.test(name)
      ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const { width: PW, height: PH } = COVER.page;
    const scale = Math.min((PW - MARGIN * 2) / img.width, (PH - MARGIN * 2) / img.height, 1);
    const w = img.width * scale, h = img.height * scale;
    const page = pdfDoc.addPage([PW, PH]);
    page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
    return;
  }

  let src;
  try {
    src = await PDFDocument.load(bytes);
  } catch (e) {
    if (/encrypt/i.test(e && e.message)) {
      throw new Error('Your PDF is password-protected/encrypted. Please remove the protection and upload again.');
    }
    throw new Error('Your PDF could not be read. It may be corrupted or not a valid PDF.');
  }
  const pages = await pdfDoc.copyPages(src, src.getPageIndices());
  pages.forEach((p) => pdfDoc.addPage(p));
}

/* ────────────────────────────────────────────────────────────────────────
   The whole document
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the month's hand-in PDF.
 *
 * cover        { name, payMonth, dateIssued, syndicateCount, syndicateDates[],
 *                signaturePng }
 * slips        records from the store, already in date order
 * appendices   records from the store, in the tutor's order
 * perPage      1 | 2 | 4
 * scannedFile  optional File, used instead of stored slips
 */
export async function buildHandInPdf({
  cover, slips = [], appendices = [], perPage = 2, scannedFile = null, onProgress = null,
}) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

  if (onProgress) onProgress('Loading the cover template…');
  const pdfDoc = await PDFDocument.load(await fetchCoverTemplate());

  if (onProgress) onProgress('Filling in the cover page…');
  await drawCover(pdfDoc, cover, StandardFonts, rgb);

  if (scannedFile) {
    if (onProgress) onProgress('Adding your scanned slips…');
    await appendScannedFile(pdfDoc, scannedFile, PDFDocument);
  } else if (slips.length) {
    if (onProgress) onProgress(`Adding ${slips.length} slip${slips.length === 1 ? '' : 's'}…`);
    await drawSlipPages(pdfDoc, slips, perPage, { StandardFonts, rgb });
  }

  if (appendices.length) {
    await appendDocuments(pdfDoc, appendices, PDFDocument, onProgress);
  }

  if (onProgress) onProgress('Finishing the PDF…');
  return pdfDoc.save();
}

/** Make a string safe for a filename across operating systems. */
export function sanitizeFilename(s) {
  return (s || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown';
}

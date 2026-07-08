/* ============================================================================
   Genius Premium Tuition — TLC Slip Hand-in
   Client-side PDF builder. No backend: the uploaded PDF and the entered
   details never leave the browser.

   Flow:
     1. User uploads a scanned slips PDF (or JPG/PNG scans).
     2. User fills details + draws a signature.
     3. On Generate we overlay the details + signature onto the branded
        cover template (assets/cover-template.pdf) and append the slip pages.
     4. The combined PDF auto-downloads; a "Download again" button re-serves it.

   Libraries (loaded via CDN in index.html):
     - pdf-lib      → window.PDFLib
     - signature_pad→ window.SignaturePad
   ========================================================================== */

'use strict';

/* ────────────────────────────────────────────────────────────────────────
   COVER OVERLAY COORDINATE MAP  ⭐ NON-DEVELOPERS: EDIT HERE ⭐
   ------------------------------------------------------------------------
   pdf-lib origin = BOTTOM-LEFT. The cover page is US Letter: 612 × 792 pt.
   x grows rightward, y grows upward. After a first render, nudge any value
   by a few points until the text sits neatly on its line.
   If you replace assets/cover-template.pdf, re-check these against the new
   template.
   ──────────────────────────────────────────────────────────────────────── */
const COVER = {
  page:      { width: 612, height: 792 },
  font:      { size: 10.5, color: { r: 0.14, g: 0.12, b: 0.13 } }, // near-black
  // Calibrated to "GLE Payslip Hand in form v2.3" (measured from the actual
  // template with pdf.js). Each y is the label's text baseline; values are
  // drawn on that same baseline just to the right of the label.
  fields: {
    // y is ~3 pt ABOVE each printed underline so text rests cleanly above the
    // line (not touching it). Underlines sit at y≈641 / 615 / 589 / 228.
    name:            { x: 128, y: 643.5 }, // Name line        (line: x≈126, y≈641)
    payMonth:        { x: 128, y: 617.5 }, // Pay Month line   (line: x≈126, y≈615)
    dateIssued:      { x: 128, y: 591.5 }, // Date Issued line (line: x≈126, y≈589)
    syndicateCount:  { x: 206, y: 427.5 }, // "attended: ____" blank (underscore y≈425)
    declarationName: { x: 58,  y: 230.0 }, // "I, ____ hereby…" (line: x≈54, y≈228)
  },
  // Blank after each numbered "1." … "5." on the "Dates (day only)" line.
  // y is ~2.5 pt above the underscores (which sit at y≈392) for a clean gap.
  syndicateDates: [
    { x: 60,  y: 394.5 },
    { x: 118, y: 394.5 },
    { x: 179, y: 394.5 },
    { x: 238, y: 394.5 },
    { x: 293, y: 394.5 },
  ],
  // Signature PNG: bottom-left anchor next to "Signed:" (baseline y≈178),
  // scaled to fit this box (aspect ratio preserved, never stretched/enlarged).
  signature: { x: 92, y: 158, maxWidth: 180, maxHeight: 40 },
};

const COVER_TEMPLATE_URL = 'assets/cover-template.pdf';
const MAX_SYNDICATES = 5;

/* ────────────────────────────────────────────────────────────────────────
   Small helpers
   ──────────────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-06" → "June 2026". Parsed by parts to avoid timezone drift. */
function formatPayMonth(value) {
  if (!value) return '';
  const [y, m] = value.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return '';
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-07-01" → "1 July 2026" (no leading zero on the day). */
function formatLongDate(value) {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-07-14" → "14" (day only, no leading zero). */
function formatDayOnly(value) {
  if (!value) return '';
  const parts = value.split('-');
  const d = Number(parts[2]);
  return d ? String(d) : '';
}

/** Local "today" as yyyy-mm-dd for the date input default. */
function todayISO() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Make a string safe for a filename across OSes. */
function sanitizeFilename(s) {
  return (s || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')  // illegal filename chars
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown';
}

/* ────────────────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────────────────── */
let uploadedFile = null;         // the raw File the user chose
let lastBlobUrl = null;          // object URL of the last generated PDF
let lastFilename = 'TLC Slip Handin.pdf';
let signaturePad = null;

/* ────────────────────────────────────────────────────────────────────────
   Signature pad (high-DPI aware)
   ──────────────────────────────────────────────────────────────────────── */
function initSignaturePad() {
  const canvas = $('signature-pad');
  signaturePad = new window.SignaturePad(canvas, {
    penColor: '#1A1816',
    minWidth: 0.7,
    maxWidth: 2.2,
    backgroundColor: 'rgba(0,0,0,0)', // transparent → clean PNG for overlay
  });

  // Scale the backing store by devicePixelRatio so strokes stay crisp and
  // the exported PNG is high resolution. Preserve any existing drawing.
  function resizeCanvas() {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = signaturePad.toData();
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    signaturePad.clear();
    if (data && data.length) signaturePad.fromData(data);
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  $('sig-clear').addEventListener('click', () => {
    signaturePad.clear();
    clearError('signature-err');
  });

  $('sig-undo').addEventListener('click', () => {
    const data = signaturePad.toData();
    if (data && data.length) {
      data.pop();
      signaturePad.fromData(data);
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────
   File upload (click, keyboard, drag & drop)
   ──────────────────────────────────────────────────────────────────────── */
function initUpload() {
  const dropzone = $('dropzone');
  const input = $('file-input');

  const openPicker = () => input.click();
  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });

  input.addEventListener('change', () => {
    if (input.files && input.files[0]) acceptFile(input.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }));
  ['dragleave', 'dragend', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }));
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) acceptFile(f);
  });
}

const PDF_TYPES = ['application/pdf'];
const IMG_TYPES = ['image/jpeg', 'image/png'];

function acceptFile(file) {
  clearError('file-error');
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const looksPdf = type === 'application/pdf' || name.endsWith('.pdf');
  const looksImg = IMG_TYPES.includes(type) ||
    /\.(jpe?g|png)$/.test(name);

  if (!looksPdf && !looksImg) {
    uploadedFile = null;
    $('file-status').textContent = '';
    $('dropzone').classList.remove('has-file');
    showError('file-error', 'That file type isn’t supported. Please upload a PDF (or a JPG/PNG scan).');
    return;
  }

  uploadedFile = file;
  const kb = file.size / 1024;
  const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  $('file-status').textContent = `✓ ${file.name} (${size})`;
  $('dropzone').classList.add('has-file');
}

/* ────────────────────────────────────────────────────────────────────────
   Syndicate date inputs — count drives how many appear (cap 5)
   ──────────────────────────────────────────────────────────────────────── */
function initSyndicates() {
  const countInput = $('syndicate-count');
  countInput.addEventListener('input', renderSyndicateDates);
  countInput.addEventListener('change', renderSyndicateDates);
  renderSyndicateDates();
}

function renderSyndicateDates() {
  const wrap = $('syndicate-dates');
  const list = $('syndicate-date-list');
  const capNote = $('syndicate-cap-note');

  let n = parseInt($('syndicate-count').value, 10);
  if (Number.isNaN(n) || n < 0) n = 0;

  capNote.hidden = n <= MAX_SYNDICATES;
  if (n > MAX_SYNDICATES) n = MAX_SYNDICATES;

  wrap.hidden = n === 0;

  // Preserve any dates the user already typed.
  const existing = Array.from(list.querySelectorAll('input')).map((i) => i.value);

  list.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const field = document.createElement('div');
    field.className = 'field';

    const label = document.createElement('label');
    label.setAttribute('for', `syndicate-date-${i}`);
    label.textContent = `Syndicate ${i + 1}`;

    const input = document.createElement('input');
    input.type = 'date';
    input.id = `syndicate-date-${i}`;
    input.name = `syndicate-date-${i}`;
    input.className = 'syndicate-date';
    if (existing[i]) input.value = existing[i];
    input.addEventListener('input', updatePreview);
    input.addEventListener('change', updatePreview);

    field.append(label, input);
    list.append(field);
  }
  updatePreview();
}

function getSyndicateDates() {
  return Array.from(document.querySelectorAll('#syndicate-date-list input'))
    .map((i) => i.value);
}

/* ────────────────────────────────────────────────────────────────────────
   Live preview ("as it will appear on the form")
   ──────────────────────────────────────────────────────────────────────── */
function initPreview() {
  ['pay-month', 'date-issued'].forEach((id) => {
    $(id).addEventListener('input', updatePreview);
    $(id).addEventListener('change', updatePreview);
  });
  updatePreview();
}

function updatePreview() {
  $('pv-pay-month').textContent = formatPayMonth($('pay-month').value) || '—';
  $('pv-date-issued').textContent = formatLongDate($('date-issued').value) || '—';

  const days = getSyndicateDates().map(formatDayOnly).filter(Boolean);
  $('pv-syndicate-dates').textContent = days.length ? days.join(', ') : '—';
}

/* ────────────────────────────────────────────────────────────────────────
   Error display helpers
   ──────────────────────────────────────────────────────────────────────── */
function showError(id, msg) { $(id).textContent = msg; }
function clearError(id) { $(id).textContent = ''; }

function markInvalid(inputId, on) {
  const el = $(inputId);
  if (el) el.classList.toggle('invalid', !!on);
}

function clearAllErrors() {
  ['full-name-err', 'pay-month-err', 'date-issued-err', 'syndicate-count-err',
    'signature-err', 'file-error'].forEach(clearError);
  ['full-name', 'pay-month', 'date-issued', 'syndicate-count'].forEach((i) => markInvalid(i, false));
  const box = $('form-error');
  box.hidden = true;
  box.innerHTML = '';
}

/* ────────────────────────────────────────────────────────────────────────
   Validation
   ──────────────────────────────────────────────────────────────────────── */
function validate() {
  clearAllErrors();
  const problems = [];

  if (!uploadedFile) {
    showError('file-error', 'Please upload your scanned slips first.');
    problems.push('Upload your scanned slips (PDF or JPG/PNG).');
  }

  const name = $('full-name').value.trim();
  if (!name) {
    showError('full-name-err', 'Your full name is required.');
    markInvalid('full-name', true);
    problems.push('Enter your full name.');
  }

  if (!$('pay-month').value) {
    showError('pay-month-err', 'Choose the pay month.');
    markInvalid('pay-month', true);
    problems.push('Choose the pay month.');
  }

  if (!$('date-issued').value) {
    showError('date-issued-err', 'Choose the date issued.');
    markInvalid('date-issued', true);
    problems.push('Choose the date issued.');
  }

  let count = parseInt($('syndicate-count').value, 10);
  if ($('syndicate-count').value === '' || Number.isNaN(count) || count < 0 || count > MAX_SYNDICATES) {
    showError('syndicate-count-err', 'Enter a number from 0 to 5.');
    markInvalid('syndicate-count', true);
    problems.push('Enter how many syndicates you attended (0–5).');
    count = null;
  }

  // Require a date for each declared syndicate.
  if (count && count > 0) {
    const dates = getSyndicateDates();
    const missing = [];
    for (let i = 0; i < count; i++) if (!dates[i]) missing.push(i + 1);
    if (missing.length) {
      problems.push(`Fill in the date${missing.length > 1 ? 's' : ''} for syndicate ${missing.join(', ')}.`);
    }
  }

  // Robust emptiness check: isEmpty() only flips once a stroke forms, so also
  // consult the captured stroke data.
  const hasSignature = signaturePad &&
    (!signaturePad.isEmpty() || signaturePad.toData().length > 0);
  if (!hasSignature) {
    showError('signature-err', 'Please draw your signature.');
    problems.push('Draw your signature.');
  }

  if (problems.length) {
    const box = $('form-error');
    box.hidden = false;
    box.innerHTML =
      '<strong>Please fix the following before generating:</strong>' +
      '<ul>' + problems.map((p) => `<li>${p}</li>`).join('') + '</ul>';
    // Focus the error summary for keyboard/screen-reader users.
    box.setAttribute('tabindex', '-1');
    box.focus();
    return null;
  }

  return {
    name,
    payMonth: formatPayMonth($('pay-month').value),
    dateIssued: formatLongDate($('date-issued').value),
    syndicateCount: count,
    syndicateDates: getSyndicateDates().slice(0, count).map(formatDayOnly),
  };
}

/* ────────────────────────────────────────────────────────────────────────
   Status helpers
   ──────────────────────────────────────────────────────────────────────── */
function setStatus(msg, kind) {
  const el = $('status');
  el.hidden = false;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  el.textContent = msg;
}
function hideStatus() { $('status').hidden = true; }

/* ────────────────────────────────────────────────────────────────────────
   PDF assembly
   ──────────────────────────────────────────────────────────────────────── */
async function fetchCoverTemplate() {
  let res;
  try {
    res = await fetch(COVER_TEMPLATE_URL);
  } catch (e) {
    throw new Error('Could not load the branded cover template. Check that assets/cover-template.pdf exists.');
  }
  if (!res.ok) {
    throw new Error('The branded cover template (assets/cover-template.pdf) is missing. Add it to the assets folder and try again.');
  }
  return res.arrayBuffer();
}

async function buildCombinedPdf(data) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

  // 1 ─ Load the branded cover template as the output document.
  const templateBytes = await fetchCoverTemplate();
  const pdfDoc = await PDFDocument.load(templateBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.getPage(0);

  const { size, color } = COVER.font;
  const ink = rgb(color.r, color.g, color.b);
  const draw = (text, pos) => {
    if (!text) return;
    page.drawText(String(text), { x: pos.x, y: pos.y, size, font, color: ink });
  };

  // 2 ─ Draw field values on the cover.
  draw(data.name, COVER.fields.name);
  draw(data.payMonth, COVER.fields.payMonth);
  draw(data.dateIssued, COVER.fields.dateIssued);
  draw(String(data.syndicateCount), COVER.fields.syndicateCount);
  draw(data.name, COVER.fields.declarationName); // repeat name in "I, ____"

  data.syndicateDates.forEach((day, i) => {
    if (COVER.syndicateDates[i]) draw(day, COVER.syndicateDates[i]);
  });

  // 3 ─ Embed the signature PNG and place it, scaled to fit (never stretched).
  const sigPng = await pdfDoc.embedPng(signaturePad.toDataURL('image/png'));
  const box = COVER.signature;
  const scale = Math.min(box.maxWidth / sigPng.width, box.maxHeight / sigPng.height, 1);
  const w = sigPng.width * scale;
  const h = sigPng.height * scale;
  page.drawImage(sigPng, { x: box.x, y: box.y, width: w, height: h });

  // 4 ─ Append the uploaded slips after the cover.
  await appendUpload(pdfDoc, PDFDocument);

  // 5 ─ Serialize.
  return pdfDoc.save();
}

/** Append the user's upload (PDF pages, or an image on its own page). */
async function appendUpload(pdfDoc, PDFDocument) {
  const bytes = await uploadedFile.arrayBuffer();
  const type = (uploadedFile.type || '').toLowerCase();
  const name = (uploadedFile.name || '').toLowerCase();
  const isImage = IMG_TYPES.includes(type) || /\.(jpe?g|png)$/.test(name);

  if (isImage) {
    const img = /png$/.test(name) || type === 'image/png'
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);
    // Place the scan on its own US-Letter page, scaled to fit with a margin.
    const { width: PW, height: PH } = COVER.page;
    const margin = 36;
    const scale = Math.min((PW - margin * 2) / img.width, (PH - margin * 2) / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    const page = pdfDoc.addPage([PW, PH]);
    page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
    return;
  }

  // PDF: copy every page in order and append.
  let slipsDoc;
  try {
    slipsDoc = await PDFDocument.load(bytes);
  } catch (e) {
    if (/encrypt/i.test(e && e.message)) {
      throw new Error('Your PDF is password-protected/encrypted. Please remove the protection and upload again.');
    }
    throw new Error('Your PDF could not be read. It may be corrupted or not a valid PDF. Please try a different file.');
  }
  const pages = await pdfDoc.copyPages(slipsDoc, slipsDoc.getPageIndices());
  pages.forEach((p) => pdfDoc.addPage(p));
}

/* ────────────────────────────────────────────────────────────────────────
   Download
   ──────────────────────────────────────────────────────────────────────── */
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ────────────────────────────────────────────────────────────────────────
   Generate handler
   ──────────────────────────────────────────────────────────────────────── */
async function onGenerate(e) {
  e.preventDefault();
  const data = validate();
  if (!data) return;

  const btn = $('generate');
  btn.disabled = true;
  $('download-again').hidden = true;
  setStatus('Generating your combined PDF…', 'busy');

  // Let the browser paint the busy state before the heavy work.
  await new Promise((r) => setTimeout(r, 30));

  try {
    const pdfBytes = await buildCombinedPdf(data);
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });

    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = URL.createObjectURL(blob);
    lastFilename = `TLC Slip Handin - ${sanitizeFilename(data.name)} - ${sanitizeFilename(data.payMonth)}.pdf`;

    triggerDownload(lastBlobUrl, lastFilename);

    setStatus(`✓ Done — "${lastFilename}" downloaded. If it didn't start, use “Download again”.`, 'done');
    const again = $('download-again');
    again.hidden = false;
  } catch (err) {
    console.error(err);
    hideStatus();
    const box = $('form-error');
    box.hidden = false;
    box.innerHTML = `<strong>Couldn't generate the PDF.</strong><p>${(err && err.message) || 'Unexpected error.'}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Boot
   ──────────────────────────────────────────────────────────────────────── */
function init() {
  // Guard: make sure the CDN libraries actually loaded.
  if (!window.PDFLib || !window.SignaturePad) {
    const box = $('form-error');
    box.hidden = false;
    box.innerHTML = '<strong>Could not load required libraries.</strong>' +
      '<p>Check your internet connection and reload the page.</p>';
    return;
  }

  $('date-issued').value = todayISO(); // default to today, still editable

  initSignaturePad();
  initUpload();
  initSyndicates();
  initPreview();

  $('handin-form').addEventListener('submit', onGenerate);
  $('download-again').addEventListener('click', () => {
    if (lastBlobUrl) triggerDownload(lastBlobUrl, lastFilename);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

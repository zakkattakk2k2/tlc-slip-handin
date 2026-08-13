/* ============================================================================
   capture.js — photographing a slip, checking the crop, saving it.

   The flow, and why it is shaped this way:

     choose  →  crop  →  details  →  saved (share)

   The crop step is never skipped, even when the detector is confident. A slip
   is a payroll document: a crop that quietly clipped the date off gets found
   at the end of the month, by which time the paper may be gone. Confirming
   takes one tap, and when detection IS confident the corners are already
   right, so that tap is all it costs.

   When detection is NOT confident the same screen appears with the corners
   ready to drag, rather than an error. There is always something to adjust and
   never a dead end.
   ========================================================================== */

import {
  detectSlip, warp, autoLevels, isUpsideDown, rotate180,
  centredFallback, rotateQuad, orderCorners, SLIP_ASPECT,
} from './detect.js';
import { encodeSlip, saveSlip, todayISO } from './store.js';

/* Detection and warping run on a copy no larger than this. A modern phone
   photo is 12 megapixels; analysing it at full size costs seconds and buys
   nothing, because the slip's borders are the same borders at 1600px. */
const MAX_SOURCE_EDGE = 1600;

/* The saved slip. 1000px across a 243.84pt slip is about 295 dpi, which keeps
   handwriting crisp when the compiled PDF is printed. */
const OUT_W = 1000;
const OUT_H = Math.round(OUT_W / SLIP_ASPECT);

const $ = (id) => document.getElementById(id);

let state = null;      // { source, quad, extras, confident, landscape }
let stream = null;     // live camera stream, when open
let onSavedCallback = null;
let getTutorName = () => '';

/* ────────────────────────────────────────────────────────────────────────
   Panels
   ──────────────────────────────────────────────────────────────────────── */

const PANELS = ['cap-choose-panel', 'cap-camera-panel', 'cap-crop-panel',
  'cap-details-panel', 'cap-done-panel'];

function showPanel(id) {
  PANELS.forEach((p) => { const el = $(p); if (el) el.hidden = p !== id; });
}

function setStatus(msg, kind = '') {
  const el = $('cap-status');
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ` ${kind}` : '');
}

/* ────────────────────────────────────────────────────────────────────────
   Loading an image
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Decode a File into an ImageData-shaped object, downscaled for analysis.
 * createImageBitmap honours EXIF orientation; a bare <img> does not, and these
 * are phone photos, so sideways portraits are guaranteed.
 */
async function fileToSource(file) {
  let bitmap;
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall through to the <img> path */ }
  }
  if (!bitmap) {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')); };
      img.src = url;
    });
  }
  return bitmapToSource(bitmap);
}

function bitmapToSource(bitmap) {
  const bw = bitmap.width || bitmap.videoWidth;
  const bh = bitmap.height || bitmap.videoHeight;
  const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(bw, bh));
  const w = Math.max(1, Math.round(bw * scale));
  const h = Math.max(1, Math.round(bh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const data = ctx.getImageData(0, 0, w, h);
  return { data: data.data, width: w, height: h, canvas };
}

/* ────────────────────────────────────────────────────────────────────────
   Camera
   ──────────────────────────────────────────────────────────────────────── */

async function openCamera() {
  const err = $('cap-camera-error');
  err.hidden = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.hidden = false;
    err.textContent = 'This browser cannot open the camera. Use “Choose a photo” instead.';
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },       // the back camera on a phone
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
      audio: false,
    });
  } catch (e) {
    err.hidden = false;
    err.textContent = e && e.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, or use “Choose a photo”.'
      : 'Could not start the camera. Use “Choose a photo” instead.';
    showPanel('cap-camera-panel');
    return;
  }

  const video = $('cap-video');
  video.srcObject = stream;
  video.setAttribute('playsinline', '');            // iOS refuses to inline otherwise
  await video.play().catch(() => {});
  showPanel('cap-camera-panel');
}

function closeCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  const video = $('cap-video');
  if (video) video.srcObject = null;
}

async function shoot() {
  const video = $('cap-video');
  if (!video || !video.videoWidth) return;

  const full = document.createElement('canvas');
  full.width = video.videoWidth;
  full.height = video.videoHeight;
  full.getContext('2d').drawImage(video, 0, 0);
  closeCamera();

  await beginCrop(bitmapToSource(full));
}

/* ────────────────────────────────────────────────────────────────────────
   Crop editor
   ──────────────────────────────────────────────────────────────────────── */

let dragging = -1;
let previewTimer = null;

async function beginCrop(source) {
  showPanel('cap-crop-panel');
  setStatus('Looking for the slip…', 'busy');

  // Let the browser paint the busy state before the heavy synchronous work.
  await new Promise((r) => setTimeout(r, 30));

  let result;
  try {
    result = detectSlip(source);
  } catch (e) {
    console.error(e);
    result = { quad: centredFallback(source.width, source.height), score: 0, confident: false, extras: [] };
  }

  state = {
    source,
    quad: orderCorners(result.quad),
    extras: result.extras || [],
    confident: !!result.confident,
    landscape: !!result.landscape,
  };

  const warn = $('cap-warning');
  if (state.extras.length) {
    warn.hidden = false;
    warn.className = 'callout callout-warn';
    warn.innerHTML = '<strong>More than one slip in this photo.</strong>'
      + '<p>Please photograph one slip at a time, so each is stored and counted separately. '
      + 'The highlighted one will be saved — retake if that is not the one you meant.</p>';
  } else if (!state.confident) {
    warn.hidden = false;
    warn.className = 'callout';
    warn.innerHTML = '<strong>Check the corners.</strong>'
      + '<p>The slip was hard to make out here. Drag the four dots onto its corners.</p>';
  } else {
    warn.hidden = true;
  }

  setStatus('');
  // Size the canvas BEFORE the first draw. The panel was hidden until a moment
  // ago, so the ResizeObserver has nothing new to report and will not fire —
  // without this the editor draws into the default 300x150 backing store and
  // the photo appears as a small blurry strip.
  sizeCropCanvas();
  drawCrop();
  schedulePreview();
}

/** Map source pixels to display pixels and back. */
function fitInfo() {
  const canvas = $('cap-crop-canvas');
  const { width: sw, height: sh } = state.source;
  const scale = Math.min(canvas.width / sw, canvas.height / sh);
  return {
    scale,
    ox: (canvas.width - sw * scale) / 2,
    oy: (canvas.height - sh * scale) / 2,
  };
}

const toDisplay = (p, f) => ({ x: p.x * f.scale + f.ox, y: p.y * f.scale + f.oy });
const toSource = (p, f) => ({ x: (p.x - f.ox) / f.scale, y: (p.y - f.oy) / f.scale });

function sizeCropCanvas() {
  const canvas = $('cap-crop-canvas');
  if (!canvas || !state) return;
  const box = canvas.parentElement.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(200, box.width);
  const cssH = Math.max(240, Math.min(window.innerHeight * 0.52, cssW * 1.25));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * ratio);
  canvas.height = Math.round(cssH * ratio);
}

function drawCrop() {
  const canvas = $('cap-crop-canvas');
  if (!canvas || !state) return;
  const ctx = canvas.getContext('2d');
  const f = fitInfo();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#15161A';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.source.canvas, f.ox, f.oy,
    state.source.width * f.scale, state.source.height * f.scale);

  const pts = state.quad.map((p) => toDisplay(p, f));

  // Dim everything outside the crop, so the tutor sees what will be kept.
  ctx.save();
  ctx.fillStyle = 'rgba(12,13,16,0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill('evenodd');
  ctx.restore();

  // Any other slip we spotted, so "there is a second slip" is visible, not
  // just asserted in a warning.
  const dpr = canvas.width / parseFloat(canvas.style.width);
  for (const extra of state.extras) {
    const q = extra.quad.map((p) => toDisplay(p, f));
    ctx.strokeStyle = 'rgba(245,184,42,0.9)';
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([7 * dpr, 5 * dpr]);
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The crop outline.
  ctx.strokeStyle = '#3FC4F0';
  ctx.lineWidth = 2.2 * dpr;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();

  // Corner handles, drawn large: these are dragged with a fingertip.
  pts.forEach((p, i) => {
    const r = (i === dragging ? 15 : 12) * dpr;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === dragging ? '#3FC4F0' : 'rgba(255,255,255,0.94)';
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#1B7FA8';
    ctx.stroke();
  });
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(drawPreview, 90);
}

/** Small live preview of the flattened slip, so the crop can be judged. */
function drawPreview() {
  if (!state) return;
  const canvas = $('cap-preview-canvas');
  if (!canvas) return;

  const w = 210, h = Math.round(w / SLIP_ASPECT);
  canvas.width = w; canvas.height = h;

  const flat = warp(state.source, state.quad, w, h);
  autoLevels(flat);
  const out = new ImageData(new Uint8ClampedArray(flat.data), w, h);
  canvas.getContext('2d').putImageData(out, 0, 0);
}

function pointerPos(evt) {
  const canvas = $('cap-crop-canvas');
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  return { x: (evt.clientX - rect.left) * dpr, y: (evt.clientY - rect.top) * dpr };
}

function onPointerDown(evt) {
  if (!state) return;
  const canvas = $('cap-crop-canvas');
  const pos = pointerPos(evt);
  const f = fitInfo();
  const dpr = canvas.width / canvas.getBoundingClientRect().width;

  let best = -1, bestDist = 34 * dpr;      // a forgiving hit area for fingers
  state.quad.forEach((p, i) => {
    const d = Math.hypot(pos.x - toDisplay(p, f).x, pos.y - toDisplay(p, f).y);
    if (d < bestDist) { bestDist = d; best = i; }
  });

  if (best < 0) return;
  dragging = best;
  canvas.setPointerCapture(evt.pointerId);
  evt.preventDefault();
  drawCrop();
}

function onPointerMove(evt) {
  if (dragging < 0 || !state) return;
  const f = fitInfo();
  const p = toSource(pointerPos(evt), f);
  state.quad[dragging] = {
    x: Math.max(0, Math.min(state.source.width, p.x)),
    y: Math.max(0, Math.min(state.source.height, p.y)),
  };
  evt.preventDefault();
  drawCrop();
  schedulePreview();
}

function onPointerUp(evt) {
  if (dragging < 0) return;
  dragging = -1;
  // Re-order so the corners keep their TL/TR/BR/BL meaning after a drag that
  // crossed another corner; without this the crop can come out mirrored.
  state.quad = orderCorners(state.quad);
  const canvas = $('cap-crop-canvas');
  try { canvas.releasePointerCapture(evt.pointerId); } catch { /* already gone */ }
  drawCrop();
  schedulePreview();
}

/* ────────────────────────────────────────────────────────────────────────
   Details and saving
   ──────────────────────────────────────────────────────────────────────── */

let pendingCanvas = null;

function acceptCrop() {
  if (!state) return;

  let flat = warp(state.source, state.quad, OUT_W, OUT_H);
  if (isUpsideDown(flat)) flat = rotate180(flat);
  autoLevels(flat);

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W; canvas.height = OUT_H;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(flat.data), OUT_W, OUT_H), 0, 0);
  pendingCanvas = canvas;

  const thumb = $('cap-details-thumb');
  if (thumb) thumb.src = canvas.toDataURL('image/jpeg', 0.7);

  if (!$('cap-date').value) $('cap-date').value = todayISO();
  showPanel('cap-details-panel');
}

async function save() {
  if (!pendingCanvas) return;
  const btn = $('cap-save');
  btn.disabled = true;
  setStatus('Saving…', 'busy');

  try {
    const { dataUrl } = encodeSlip(pendingCanvas);
    const record = await saveSlip({
      image: dataUrl,
      date: $('cap-date').value || todayISO(),
      source: 'photo',
      width: pendingCanvas.width,
      height: pendingCanvas.height,
      meta: {
        student: $('cap-student').value.trim(),
        subject: $('cap-subject').value.trim(),
        hours: $('cap-hours').value.trim(),
        notes: $('cap-notes').value.trim(),
        tutor: getTutorName(),
      },
    });

    setStatus('');
    showPanel('cap-done-panel');
    const img = $('cap-done-thumb');
    if (img) img.src = record.image;
    if (onSavedCallback) onSavedCallback(record);
    return record;
  } catch (e) {
    console.error(e);
    setStatus(`Could not save the slip. ${e.message || ''}`.trim(), 'error');
    return null;
  } finally {
    btn.disabled = false;
  }
}

function reset() {
  state = null;
  pendingCanvas = null;
  dragging = -1;
  ['cap-student', 'cap-subject', 'cap-hours', 'cap-notes'].forEach((id) => {
    const el = $(id); if (el) el.value = '';
  });
  setStatus('');
  showPanel('cap-choose-panel');
}

/* ────────────────────────────────────────────────────────────────────────
   Wiring
   ──────────────────────────────────────────────────────────────────────── */

export function initCapture({ onSaved, tutorName } = {}) {
  onSavedCallback = onSaved || null;
  if (typeof tutorName === 'function') getTutorName = tutorName;

  $('cap-take').addEventListener('click', openCamera);
  $('cap-choose').addEventListener('click', () => $('cap-file').click());

  $('cap-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                       // so the same file can be re-picked
    if (!file) return;
    try {
      await beginCrop(await fileToSource(file));
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'That file could not be opened.', 'error');
      showPanel('cap-choose-panel');
    }
  });

  $('cap-shutter').addEventListener('click', shoot);
  $('cap-cancel-camera').addEventListener('click', () => { closeCamera(); showPanel('cap-choose-panel'); });

  const canvas = $('cap-crop-canvas');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  $('cap-rotate').addEventListener('click', () => {
    if (!state) return;
    state.quad = rotateQuad(state.quad, 1);
    drawCrop();
    schedulePreview();
  });

  $('cap-full').addEventListener('click', () => {
    if (!state) return;
    state.quad = [
      { x: 0, y: 0 },
      { x: state.source.width, y: 0 },
      { x: state.source.width, y: state.source.height },
      { x: 0, y: state.source.height },
    ];
    drawCrop();
    schedulePreview();
  });

  $('cap-retake').addEventListener('click', reset);
  $('cap-accept').addEventListener('click', acceptCrop);
  $('cap-back-to-crop').addEventListener('click', () => showPanel('cap-crop-panel'));
  $('cap-save').addEventListener('click', save);
  $('cap-another').addEventListener('click', reset);

  window.addEventListener('resize', () => {
    if (!state || $('cap-crop-panel').hidden) return;
    sizeCropCanvas();
    drawCrop();
  });

  // Keep the crop canvas correctly sized when its panel first becomes visible.
  const observer = new ResizeObserver(() => {
    if (state && !$('cap-crop-panel').hidden) { sizeCropCanvas(); drawCrop(); }
  });
  observer.observe($('cap-crop-canvas').parentElement);

  showPanel('cap-choose-panel');
}

/** Stop the camera when the tutor navigates away from this tab. */
export function suspendCapture() {
  closeCamera();
  if (!$('cap-camera-panel').hidden) showPanel('cap-choose-panel');
}

/** The slip currently on screen, for the share buttons on the done panel. */
export function lastSavedRecord() {
  return null;
}

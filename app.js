/* ============================================================================
   Genius Premium Tuition — TLC Slip Hand-in
   app.js — sign-in, the four tabs, and everything that is not detection.

   WHAT CHANGED FROM THE ORIGINAL
   The first version of this app was a single form: upload a scan of the whole
   month, fill in the cover, download a combined PDF. It stored nothing, which
   meant every tutor still had to collect a month of paper slips and scan them
   in one go.

   Now a slip is captured the day it happens — photographed in the app or
   uploaded — cropped to the slip alone, saved, and shared to WhatsApp. At the
   end of the month the hand-in builds itself from what is already stored.

   The old path is still here. "Compile" accepts a scanned PDF instead of the
   stored slips, so a tutor who prefers the office copier is not forced to
   change how they work.
   ========================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';

import {
  initStore, listSlips, listMonths, deleteSlip, saveSlip, todayISO,
  saveAppendix, listAppendices, deleteAppendix, reorderAppendices,
  loadProfile, saveProfile, encodeSlip, dataUrlBytes,
} from './js/store.js';
import { initCapture, suspendCapture } from './js/capture.js';
import { shareSlip, copyCaption, longDate } from './js/share.js';
import { renderSlip, loadImage, fontsReady } from './js/digital.js';
import { buildHandInPdf, MAX_SYNDICATES, sanitizeFilename } from './js/compile.js';

const $ = (id) => document.getElementById(id);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* ────────────────────────────────────────────────────────────────────────
   Small formatting helpers (unchanged from the original app)
   ──────────────────────────────────────────────────────────────────────── */

/** "2026-06" → "June 2026". Parsed by parts to avoid timezone drift. */
function formatPayMonth(value) {
  if (!value) return '';
  const [y, m] = value.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return '';
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-07-14" → "14" (day only, no leading zero). */
function formatDayOnly(value) {
  if (!value) return '';
  const d = Number((value.split('-'))[2]);
  return d ? String(d) : '';
}

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function showError(id, msg) { const el = $(id); if (el) el.textContent = msg; }
function clearError(id) { showError(id, ''); }

function toast(msg) {
  if (!msg) return;
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('is-shown');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('is-shown');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 3200);
}

/* ────────────────────────────────────────────────────────────────────────
   Application state
   ──────────────────────────────────────────────────────────────────────── */

const app = {
  user: null,
  tutorName: '',
  month: (todayISO()).slice(0, 7),
  slips: [],
  appendices: [],
  pads: {},                 // SignaturePad instances, by canvas id
  lastSaved: null,
};

/* ────────────────────────────────────────────────────────────────────────
   Signature pads
   ──────────────────────────────────────────────────────────────────────── */

function makePad(canvasId, clearBtnId) {
  const canvas = $(canvasId);
  if (!canvas || !window.SignaturePad) return null;

  const pad = new window.SignaturePad(canvas, {
    penColor: '#1A1816',
    minWidth: 0.7,
    maxWidth: 2.2,
    backgroundColor: 'rgba(0,0,0,0)',      // transparent → a clean PNG to overlay
  });

  /* Scale the backing store by devicePixelRatio so strokes stay crisp and the
     exported PNG is high resolution. Also re-run whenever the pad becomes
     visible: a canvas inside a hidden tab measures 0x0, and a pad sized 0x0
     exports an empty image no matter how carefully it was signed. */
  const resize = () => {
    if (!canvas.offsetWidth) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = pad.toData();
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    pad.clear();
    if (data && data.length) pad.fromData(data);
  };

  resize();
  pad._resize = resize;

  const clearBtn = $(clearBtnId);
  if (clearBtn) clearBtn.addEventListener('click', () => pad.clear());

  app.pads[canvasId] = pad;
  return pad;
}

/** isEmpty() only flips once a stroke forms, so consult the stroke data too. */
const padHasInk = (pad) => !!pad && (!pad.isEmpty() || pad.toData().length > 0);

const resizeAllPads = () => Object.values(app.pads).forEach((p) => p._resize && p._resize());

/* ────────────────────────────────────────────────────────────────────────
   Tabs
   ──────────────────────────────────────────────────────────────────────── */

const TABS = ['capture', 'month', 'digital', 'compile'];

function selectTab(which) {
  TABS.forEach((key) => {
    const on = key === which;
    const tab = $(`tab-${key}`);
    const panel = $(`panel-${key}`);
    if (tab) {
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.classList.toggle('is-active', on);
    }
    if (panel) panel.hidden = !on;
  });

  if (which !== 'capture') suspendCapture();
  if (which === 'month') refreshMonth();
  if (which === 'compile') refreshCompile();
  // Pads in a freshly revealed tab were 0x0 a moment ago.
  setTimeout(resizeAllPads, 40);
  if (which === 'digital') setTimeout(renderDigitalPreview, 60);
}

/* ────────────────────────────────────────────────────────────────────────
   This month
   ──────────────────────────────────────────────────────────────────────── */

async function refreshMonth() {
  const list = $('month-list');
  const summary = $('month-summary');
  if (!app.user) { list.innerHTML = ''; return; }

  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await refreshMonthPicker();
    app.slips = await listSlips(app.month);
  } catch (e) {
    console.error(e);
    list.innerHTML = `<p class="field-error">Could not load your slips. ${escapeHtml(e.message || '')}</p>`;
    return;
  }

  if (!app.slips.length) {
    summary.textContent = '';
    list.innerHTML = '<div class="empty"><p><strong>No slips saved for this month yet.</strong></p>'
      + '<p class="muted">Capture one on the “Add a slip” tab, or fill in a digital slip.</p></div>';
    return;
  }

  const hours = app.slips.reduce((a, s) => a + (parseFloat((s.meta || {}).hours) || 0), 0);
  const bytes = app.slips.reduce((a, s) => a + dataUrlBytes(s.image), 0);
  summary.textContent =
    `${app.slips.length} slip${app.slips.length === 1 ? '' : 's'}`
    + (hours ? ` · ${+hours.toFixed(2)} hours` : '')
    + ` · ${(bytes / 1024 / 1024).toFixed(1)} MB stored`;

  list.innerHTML = app.slips.map((s) => {
    const m = s.meta || {};
    const detail = [m.student, m.subject, m.hours ? `${m.hours}h` : ''].filter(Boolean).join(' · ');
    return `
      <article class="slip-card" data-id="${escapeHtml(s.id)}">
        <img class="slip-thumb" src="${s.image}" alt="Slip for ${escapeHtml(longDate(s.date))}" loading="lazy" />
        <div class="slip-body">
          <p class="slip-date">${escapeHtml(longDate(s.date))}</p>
          <p class="slip-detail">${escapeHtml(detail || 'No details entered')}</p>
          ${s.source === 'digital' ? '<span class="pill">Digital slip</span>' : ''}
        </div>
        <div class="slip-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="share">Send</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="copy">Copy caption</button>
          <button type="button" class="btn btn-ghost btn-sm btn-danger" data-act="delete">Delete</button>
        </div>
      </article>`;
  }).join('');
}

async function refreshMonthPicker() {
  const picker = $('month-picker');
  const months = await listMonths();
  const known = new Set(months.map((m) => m.month));
  known.add(app.month);

  const options = [...known].sort().reverse();
  picker.innerHTML = options.map((m) => {
    const found = months.find((x) => x.month === m);
    const count = found ? ` (${found.count})` : '';
    return `<option value="${m}"${m === app.month ? ' selected' : ''}>${formatPayMonth(m)}${count}</option>`;
  }).join('');
}

async function onMonthListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = e.target.closest('.slip-card');
  const slip = app.slips.find((s) => s.id === card.dataset.id);
  if (!slip) return;

  if (btn.dataset.act === 'share') {
    toast(await shareSlip(slip, app.tutorName));
  } else if (btn.dataset.act === 'copy') {
    toast(await copyCaption(slip, app.tutorName));
  } else if (btn.dataset.act === 'delete') {
    // A slip is a payroll record; deleting one by accident is expensive.
    if (!window.confirm(`Delete the slip for ${longDate(slip.date)}? This cannot be undone.`)) return;
    try {
      await deleteSlip(slip.id);
      toast('Slip deleted');
      refreshMonth();
    } catch (err) {
      console.error(err);
      toast('Could not delete that slip.');
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Digital slip
   ──────────────────────────────────────────────────────────────────────── */

function digitalValues() {
  return {
    date: $('dig-date').value || todayISO(),
    timeFrom: $('dig-from').value,
    timeTo: $('dig-to').value,
    subject: $('dig-subject').value.trim(),
    hours: $('dig-hours').value.trim(),
    student: $('dig-student').value.trim(),
    tutor: $('dig-tutor').value.trim() || app.tutorName,
    notes: $('dig-notes').value.trim(),
  };
}

async function renderDigitalPreview() {
  await fontsReady();
  const values = digitalValues();

  const studentPad = app.pads['dig-sig-student'];
  const tutorPad = app.pads['dig-sig-tutor'];
  values.studentSig = padHasInk(studentPad) ? await loadImage(studentPad.toDataURL('image/png')) : null;
  values.tutorSig = padHasInk(tutorPad) ? await loadImage(tutorPad.toDataURL('image/png')) : null;

  const canvas = renderSlip(values, { width: 900 });
  canvas.className = 'dig-preview-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Preview of the completed lesson slip');

  const holder = $('dig-preview');
  holder.innerHTML = '';
  holder.appendChild(canvas);
  return canvas;
}

function validateDigital() {
  const problems = [];
  const v = digitalValues();
  if (!v.date) problems.push('Choose the lesson date.');
  if (!v.subject) problems.push('Enter the subject.');
  if (!v.student) problems.push('Enter the student’s name.');
  if (!v.tutor) problems.push('Enter the tutor’s name.');
  if (!padHasInk(app.pads['dig-sig-student'])) problems.push('The student still needs to sign.');
  if (!padHasInk(app.pads['dig-sig-tutor'])) problems.push('The tutor still needs to sign.');

  const box = $('dig-error');
  if (problems.length) {
    box.hidden = false;
    box.innerHTML = '<strong>Before this slip can be saved:</strong><ul>'
      + problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('') + '</ul>';
    box.setAttribute('tabindex', '-1');
    box.focus();
    return null;
  }
  box.hidden = true;
  return v;
}

async function saveDigital() {
  const values = validateDigital();
  if (!values) return;

  const btn = $('dig-save');
  btn.disabled = true;
  try {
    const canvas = await renderDigitalPreview();
    const { dataUrl } = encodeSlip(canvas);
    const record = await saveSlip({
      image: dataUrl,
      date: values.date,
      source: 'digital',
      width: canvas.width,
      height: canvas.height,
      meta: {
        student: values.student,
        subject: values.subject,
        hours: values.hours,
        timeFrom: values.timeFrom,
        timeTo: values.timeTo,
        notes: values.notes,
        tutor: values.tutor,
      },
    });

    app.lastSaved = record;
    $('dig-done').hidden = false;
    toast('Digital slip saved ✓');
  } catch (e) {
    console.error(e);
    toast(`Could not save: ${e.message || 'unexpected error'}`);
  } finally {
    btn.disabled = false;
  }
}

function resetDigital() {
  ['dig-subject', 'dig-hours', 'dig-student', 'dig-notes', 'dig-from', 'dig-to']
    .forEach((id) => { $(id).value = ''; });
  $('dig-date').value = todayISO();
  Object.entries(app.pads).forEach(([id, pad]) => { if (id.startsWith('dig-')) pad.clear(); });
  $('dig-done').hidden = true;
  $('dig-error').hidden = true;
  app.lastSaved = null;
  renderDigitalPreview();
}

/* ────────────────────────────────────────────────────────────────────────
   Compile
   ──────────────────────────────────────────────────────────────────────── */

async function refreshCompile() {
  if (!app.user) return;
  $('cmp-month').value = app.month;
  if (!$('cmp-pay-month').value) $('cmp-pay-month').value = app.month;

  try {
    app.slips = await listSlips(app.month);
    app.appendices = await listAppendices(app.month);
  } catch (e) {
    console.error(e);
  }

  const n = app.slips.length;
  $('cmp-slip-count').textContent = n
    ? `${n} saved slip${n === 1 ? '' : 's'} will be added after the cover page, in date order.`
    : 'No saved slips for this month — either capture some, or attach a scanned PDF below.';

  renderAppendixList();
  updateCoverPreview();
}

function renderAppendixList() {
  const list = $('cmp-appendix-list');
  if (!app.appendices.length) {
    list.innerHTML = '<li class="muted apx-empty">Nothing appended yet.</li>';
    return;
  }
  list.innerHTML = app.appendices.map((a, i) => `
    <li class="apx-row" data-id="${escapeHtml(a.id)}">
      <span class="apx-name">${escapeHtml(a.name)}</span>
      <span class="apx-size muted">${(a.bytes / 1024).toFixed(0)} KB</span>
      <span class="apx-tools">
        <button type="button" class="btn btn-ghost btn-sm" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="down" ${i === app.appendices.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button type="button" class="btn btn-ghost btn-sm btn-danger" data-act="remove">Remove</button>
      </span>
    </li>`).join('');
}

async function onAppendixClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = e.target.closest('.apx-row');
  const idx = app.appendices.findIndex((a) => a.id === row.dataset.id);
  if (idx < 0) return;

  if (btn.dataset.act === 'remove') {
    if (!window.confirm(`Remove “${app.appendices[idx].name}” from this month?`)) return;
    try {
      await deleteAppendix(app.appendices[idx]);
      app.appendices.splice(idx, 1);
      renderAppendixList();
      toast('Removed');
    } catch (err) {
      console.error(err);
      toast('Could not remove that document.');
    }
    return;
  }

  const to = btn.dataset.act === 'up' ? idx - 1 : idx + 1;
  if (to < 0 || to >= app.appendices.length) return;
  const [moved] = app.appendices.splice(idx, 1);
  app.appendices.splice(to, 0, moved);
  renderAppendixList();
  try {
    await reorderAppendices(app.appendices);
  } catch (err) {
    console.error(err);
    toast('New order could not be saved.');
  }
}

function renderSyndicateDates() {
  const wrap = $('cmp-syndicate-dates');
  const list = $('cmp-syndicate-list');
  const capNote = $('cmp-syndicate-cap');

  let n = parseInt($('cmp-syndicate-count').value, 10);
  if (Number.isNaN(n) || n < 0) n = 0;

  capNote.hidden = n <= MAX_SYNDICATES;
  if (n > MAX_SYNDICATES) n = MAX_SYNDICATES;
  wrap.hidden = n === 0;

  const existing = Array.from(list.querySelectorAll('input')).map((i) => i.value);
  list.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.setAttribute('for', `cmp-syn-${i}`);
    label.textContent = `Syndicate ${i + 1}`;
    const input = document.createElement('input');
    input.type = 'date';
    input.id = `cmp-syn-${i}`;
    input.className = 'syndicate-date';
    if (existing[i]) input.value = existing[i];
    input.addEventListener('change', updateCoverPreview);
    field.append(label, input);
    list.append(field);
  }
  updateCoverPreview();
}

const syndicateDates = () =>
  Array.from(document.querySelectorAll('#cmp-syndicate-list input')).map((i) => i.value);

function updateCoverPreview() {
  $('pv-pay-month').textContent = formatPayMonth($('cmp-pay-month').value) || '—';
  $('pv-date-issued').textContent = $('cmp-date-issued').value
    ? longDate($('cmp-date-issued').value) : '—';
  const days = syndicateDates().map(formatDayOnly).filter(Boolean);
  $('pv-syndicate-dates').textContent = days.length ? days.join(', ') : '—';
}

function validateCompile() {
  const problems = [];
  ['cmp-name-err', 'cmp-pay-month-err', 'cmp-date-issued-err', 'cmp-syndicate-err']
    .forEach(clearError);

  const name = $('cmp-name').value.trim();
  if (!name) { showError('cmp-name-err', 'Your full name is required.'); problems.push('Enter your full name.'); }
  if (!$('cmp-pay-month').value) { showError('cmp-pay-month-err', 'Choose the pay month.'); problems.push('Choose the pay month.'); }
  if (!$('cmp-date-issued').value) { showError('cmp-date-issued-err', 'Choose the date issued.'); problems.push('Choose the date issued.'); }

  let count = parseInt($('cmp-syndicate-count').value, 10);
  if ($('cmp-syndicate-count').value === '' || Number.isNaN(count) || count < 0 || count > MAX_SYNDICATES) {
    showError('cmp-syndicate-err', 'Enter a number from 0 to 5.');
    problems.push('Enter how many syndicates you attended (0–5).');
    count = null;
  }

  if (count) {
    const dates = syndicateDates();
    const missing = [];
    for (let i = 0; i < count; i++) if (!dates[i]) missing.push(i + 1);
    if (missing.length) {
      problems.push(`Fill in the date${missing.length > 1 ? 's' : ''} for syndicate ${missing.join(', ')}.`);
    }
  }

  if (!padHasInk(app.pads['cmp-signature'])) problems.push('Draw your signature.');

  const scanned = $('cmp-scan-file').files[0] || null;
  if (!scanned && !app.slips.length && !app.appendices.length) {
    problems.push('There is nothing to hand in yet — capture some slips, or attach a scanned PDF.');
  }

  const box = $('cmp-error');
  if (problems.length) {
    box.hidden = false;
    box.innerHTML = '<strong>Please fix the following before generating:</strong><ul>'
      + problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('') + '</ul>';
    box.setAttribute('tabindex', '-1');
    box.focus();
    return null;
  }
  box.hidden = true;

  return {
    name,
    payMonth: formatPayMonth($('cmp-pay-month').value),
    dateIssued: longDate($('cmp-date-issued').value),
    syndicateCount: count,
    syndicateDates: syndicateDates().slice(0, count).map(formatDayOnly),
    signaturePng: app.pads['cmp-signature'].toDataURL('image/png'),
    scanned,
  };
}

let lastPdfUrl = null;
let lastPdfName = 'TLC Slip Handin.pdf';

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);      // Safari ignores detached anchors
  a.click();
  a.remove();
}

function setCompileStatus(msg, kind) {
  const el = $('cmp-status');
  el.hidden = !msg;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  el.textContent = msg || '';
}

async function generate(e) {
  e.preventDefault();
  const cover = validateCompile();
  if (!cover) return;

  const btn = $('cmp-generate');
  btn.disabled = true;
  $('cmp-download-again').hidden = true;
  setCompileStatus('Building your hand-in…', 'busy');
  await new Promise((r) => setTimeout(r, 30));   // let the busy state paint

  try {
    try { await saveProfile({ name: cover.name }); } catch { /* not fatal */ }

    const bytes = await buildHandInPdf({
      cover,
      slips: cover.scanned ? [] : app.slips,
      appendices: app.appendices,
      perPage: parseInt($('cmp-per-page').value, 10) || 2,
      scannedFile: cover.scanned,
      onProgress: (m) => setCompileStatus(m, 'busy'),
    });

    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
    lastPdfUrl = URL.createObjectURL(blob);
    lastPdfName = `TLC Slip Handin - ${sanitizeFilename(cover.name)} - ${sanitizeFilename(cover.payMonth)}.pdf`;

    triggerDownload(lastPdfUrl, lastPdfName);
    setCompileStatus(`✓ Done — “${lastPdfName}” downloaded. If it didn’t start, use “Download again”.`, 'done');
    $('cmp-download-again').hidden = false;
  } catch (err) {
    console.error(err);
    setCompileStatus('');
    const box = $('cmp-error');
    box.hidden = false;
    box.innerHTML = `<strong>Couldn’t build the PDF.</strong><p>${escapeHtml((err && err.message) || 'Unexpected error.')}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Auth
   ──────────────────────────────────────────────────────────────────────── */

function deriveFirstName(user) {
  if (!user) return null;
  if (user.displayName) {
    const first = user.displayName.trim().split(/\s+/)[0];
    if (first) return first;
  }
  if (user.email) {
    const cleaned = user.email.split('@')[0].replace(/[._\-]+/g, ' ').replace(/\d+$/, '').trim();
    const first = cleaned.split(/\s+/)[0];
    if (first) return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return null;
}

async function onSignedIn(firebaseApp, user) {
  app.user = user;
  app.tutorName = user.displayName || '';
  initStore(firebaseApp, user);

  $('user-area').hidden = false;
  $('user-email').textContent = user.email || '';

  // Remembered from last month, so the cover page is not retyped every time.
  try {
    const profile = await loadProfile();
    if (profile.name) app.tutorName = profile.name;
  } catch (err) {
    console.warn('Could not load profile', err);
  }

  if (!$('cmp-name').value) $('cmp-name').value = app.tutorName;
  if (!$('dig-tutor').value) $('dig-tutor').value = app.tutorName;

  refreshMonth();
}

/* ────────────────────────────────────────────────────────────────────────
   Boot
   ──────────────────────────────────────────────────────────────────────── */

function fatal(html) {
  const box = $('boot-error');
  box.hidden = false;
  box.innerHTML = html;
  if (window.__onAuth) window.__onAuth({ signedIn: false });
}

function init() {
  const settings = window.TLC_SETTINGS || {};

  const missing = [];
  if (!window.PDFLib) missing.push('pdf-lib');
  if (!window.SignaturePad) missing.push('signature_pad');
  if (missing.length) {
    fatal('<strong>Could not load required libraries.</strong>'
      + `<p>Missing: ${escapeHtml(missing.join(', '))}. Check your internet connection and reload the page.</p>`);
    return;
  }

  if (!settings.firebase || String(settings.firebase.apiKey || '').startsWith('PASTE_')) {
    fatal('<strong>Setup isn’t finished.</strong>'
      + '<p>The Firebase settings at the top of <code>index.html</code> are still placeholders. '
      + 'Follow <code>FIREBASE-SETUP.md</code> to create the project and paste its config in.</p>');
    return;
  }

  const firebaseApp = initializeApp(settings.firebase);
  const auth = getAuth(firebaseApp);
  const allowedDomain = settings.ALLOWED_DOMAIN || '';

  window.__signIn = function () {
    const err = $('auth-error');
    if (err) err.hidden = true;
    signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
      console.error(e);
      if (!err) return;
      err.hidden = false;
      err.textContent = e && e.code === 'auth/unauthorized-domain'
        ? 'This site isn’t authorised for sign-in yet. (Add its domain in Firebase → Authentication → Settings → Authorized domains.)'
        : 'Sign-in was cancelled or failed. Please try again.';
    });
  };
  window.__signOut = function () { signOut(auth).then(() => window.location.reload()); };

  onAuthStateChanged(auth, (user) => {
    if (user && allowedDomain
        && !(user.email || '').toLowerCase().endsWith('@' + allowedDomain)) {
      const err = $('auth-error');
      if (err) { err.hidden = false; err.textContent = `Please sign in with your @${allowedDomain} account.`; }
      signOut(auth);                               // re-fires this handler with null
      if (window.__onAuth) window.__onAuth({ signedIn: false });
      return;
    }

    const firstName = deriveFirstName(user);
    if (firstName && window.__setWelcomeName) window.__setWelcomeName(firstName);

    if (user) {
      onSignedIn(firebaseApp, user);
    } else {
      app.user = null;
      $('user-area').hidden = true;
    }

    if (window.__onAuth) window.__onAuth({ signedIn: !!user });
  });

  /* ── Wiring ─────────────────────────────────────────────────────────── */

  TABS.forEach((key) => $(`tab-${key}`).addEventListener('click', () => selectTab(key)));

  initCapture({
    tutorName: () => app.tutorName,
    onSaved: (record) => {
      app.lastSaved = record;
      refreshMonthPicker().catch(() => {});
    },
  });

  $('cap-share').addEventListener('click', async () => {
    if (app.lastSaved) toast(await shareSlip(app.lastSaved, app.tutorName));
  });
  $('cap-copy').addEventListener('click', async () => {
    if (app.lastSaved) toast(await copyCaption(app.lastSaved, app.tutorName));
  });

  $('month-picker').addEventListener('change', (e) => {
    app.month = e.target.value;
    refreshMonth();
  });
  $('month-list').addEventListener('click', onMonthListClick);
  $('month-refresh').addEventListener('click', refreshMonth);

  // Digital slip
  $('dig-date').value = todayISO();
  makePad('dig-sig-student', 'dig-sig-student-clear');
  makePad('dig-sig-tutor', 'dig-sig-tutor-clear');
  ['dig-date', 'dig-from', 'dig-to', 'dig-subject', 'dig-hours', 'dig-student', 'dig-tutor', 'dig-notes']
    .forEach((id) => $(id).addEventListener('input', () => {
      clearTimeout(init._digTimer);
      init._digTimer = setTimeout(renderDigitalPreview, 260);
    }));
  $('dig-refresh').addEventListener('click', renderDigitalPreview);
  $('dig-save').addEventListener('click', saveDigital);
  $('dig-another').addEventListener('click', resetDigital);
  $('dig-share').addEventListener('click', async () => {
    if (app.lastSaved) toast(await shareSlip(app.lastSaved, app.tutorName));
  });

  // Compile
  $('cmp-date-issued').value = todayISO();
  makePad('cmp-signature', 'cmp-signature-clear');
  $('cmp-month').addEventListener('change', (e) => {
    app.month = e.target.value;
    refreshCompile();
  });
  $('cmp-syndicate-count').addEventListener('input', renderSyndicateDates);
  ['cmp-pay-month', 'cmp-date-issued'].forEach((id) =>
    $(id).addEventListener('change', updateCoverPreview));
  $('cmp-appendix-list').addEventListener('click', onAppendixClick);
  $('cmp-appendix-add').addEventListener('click', () => $('cmp-appendix-file').click());
  $('cmp-appendix-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setCompileStatus('Uploading…', 'busy');
    try {
      for (const file of files) {
        const rec = await saveAppendix({ file, month: app.month, order: app.appendices.length });
        app.appendices.push(rec);
      }
      renderAppendixList();
      setCompileStatus('');
      toast(`Added ${files.length} document${files.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(err);
      setCompileStatus(`Could not add that document. ${err.message || ''}`.trim(), 'error');
    }
  });
  $('cmp-scan-file').addEventListener('change', () => {
    const f = $('cmp-scan-file').files[0];
    $('cmp-scan-status').textContent = f
      ? `✓ ${f.name} — this will be used instead of your saved slips.` : '';
  });
  $('cmp-form').addEventListener('submit', generate);
  $('cmp-download-again').addEventListener('click', () => {
    if (lastPdfUrl) triggerDownload(lastPdfUrl, lastPdfName);
  });

  renderSyndicateDates();
  selectTab('capture');
  renderDigitalPreview();

  window.addEventListener('resize', resizeAllPads);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

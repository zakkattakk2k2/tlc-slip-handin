/* ============================================================================
   store.js — where slips live between the lesson and the end of the month.

   The old app kept nothing: you uploaded a scan, it built a PDF, and that was
   that. Now a slip captured on a Tuesday has to still be there on the 30th, on
   whatever device the tutor happens to compile from. That means a server, and
   the smallest one that fits how the rest of the Genius apps already work is
   Firestore.

   SHAPE OF THE DATA
     users/{uid}/slips/{slipId}            one document per slip, image inline
     users/{uid}/appendices/{apxId}        mission docs and misc, metadata
     users/{uid}/appendixChunks/{apxId#n}  their bytes, split to fit
     users/{uid}/profile/main              remembered name, for the cover page

   Everything is scoped under the tutor's own uid: no tutor can read another
   tutor's slips, and the security rules in firestore.rules enforce that
   server-side rather than trusting this file.

   WHY IMAGES LIVE INSIDE THE DOCUMENTS
   Firebase Storage needs a billing-enabled project; Firestore does not, and a
   cropped slip is only a couple of hundred KB. A Firestore document caps at
   1 MiB, so `encodeSlip` below treats that as a hard budget and steps the JPEG
   quality down until the encoded slip fits, rather than letting a save fail on
   the 30th when it matters. Appendices can be genuinely large, so those are
   split across chunk documents and stitched back together on read.
   ========================================================================== */

import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, orderBy, writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const APP_NS = 'genius-tlcslips';

/* A Firestore document may not exceed 1 MiB. Leave room for the field names,
   the metadata and base64's 33% overhead, and never plan to land near it. */
export const MAX_DOC_BYTES = 1_000_000;
export const SLIP_BUDGET_BYTES = 700_000;
export const CHUNK_BYTES = 600_000;

let db = null;
let uid = null;

export function initStore(app, user) {
  if (!db) {
    try {
      // Persistent cache means a tutor can look at the month's slips on a bad
      // connection, and repeat visits cost no reads.
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch (e) {
      // Already initialised elsewhere, or the browser refuses IndexedDB
      // (private mode on some browsers). Plain Firestore still works online.
      console.warn('Falling back to non-persistent Firestore:', e && e.message);
      db = getFirestore(app);
    }
  }
  uid = user ? user.uid : null;
  return db;
}

const requireUser = () => {
  if (!db || !uid) throw new Error('Not signed in yet.');
};

const userPath = (...rest) => ['artifacts', APP_NS, 'users', uid, ...rest];
const slipsCol = () => collection(db, ...userPath('slips'));
const slipDoc = (id) => doc(db, ...userPath('slips', id));
const apxCol = () => collection(db, ...userPath('appendices'));
const apxDoc = (id) => doc(db, ...userPath('appendices', id));
const chunkDoc = (id) => doc(db, ...userPath('appendixChunks', id));
const profileDoc = () => doc(db, ...userPath('profile', 'main'));

/* ────────────────────────────────────────────────────────────────────────
   Ids and dates
   ──────────────────────────────────────────────────────────────────────── */

/** "2026-08-13" -> "2026-08". */
export const monthOf = (isoDate) => (isoDate || '').slice(0, 7);

/** Local today as yyyy-mm-dd. Deliberately not toISOString, which is UTC and
    quietly reports yesterday for anyone east of Greenwich after midnight. */
export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Sortable, collision-resistant id: time first so natural order is capture order. */
function newId() {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}

/* ────────────────────────────────────────────────────────────────────────
   Encoding
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Encode a canvas as a JPEG data URL that will fit in one Firestore document.
 *
 * JPEG, not WebP, and not by accident: WhatsApp has been known to treat a WebP
 * image as a sticker, and these get shared to WhatsApp constantly.
 *
 * Quality steps down only as far as it must. A slip that still will not fit is
 * scaled down too, because a slightly softer slip that saves beats a perfect
 * one that throws on the last day of the month.
 */
export function encodeSlip(canvas, budget = SLIP_BUDGET_BYTES) {
  let work = canvas;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const q of [0.86, 0.78, 0.68, 0.58]) {
      const url = work.toDataURL('image/jpeg', q);
      if (url.length <= budget) return { dataUrl: url, quality: q, width: work.width };
    }
    // Still too big: halve the pixel count and try the ladder again.
    const next = document.createElement('canvas');
    next.width = Math.max(320, Math.round(work.width * 0.75));
    next.height = Math.max(320, Math.round(work.height * 0.75));
    const ctx = next.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(work, 0, 0, next.width, next.height);
    work = next;
  }
  return { dataUrl: work.toDataURL('image/jpeg', 0.5), quality: 0.5, width: work.width };
}

/* ────────────────────────────────────────────────────────────────────────
   Slips
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Save one slip. `image` is a JPEG data URL from encodeSlip.
 * Returns the stored record, including its new id.
 */
export async function saveSlip({ image, date, source = 'photo', meta = {}, width, height }) {
  requireUser();
  const id = newId();
  const record = {
    id,
    date: date || todayISO(),
    month: monthOf(date || todayISO()),
    source,                                   // 'photo' | 'upload' | 'digital'
    image,
    width: width || null,
    height: height || null,
    meta,
    createdAt: Date.now(),
  };
  await setDoc(slipDoc(id), record);
  return record;
}

/** Every slip for one month ("2026-08"), oldest lesson first. */
export async function listSlips(month) {
  requireUser();
  const snap = await getDocs(query(slipsCol(), where('month', '==', month)));
  const rows = snap.docs.map((d) => d.data());
  // Sorted here rather than in the query: ordering by a second field would
  // demand a composite index, and a month is at most a few dozen slips.
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt - b.createdAt));
  return rows;
}

/** Which months have slips? Used to fill the month picker. */
export async function listMonths() {
  requireUser();
  const snap = await getDocs(slipsCol());
  const counts = new Map();
  snap.docs.forEach((d) => {
    const m = d.data().month;
    if (m) counts.set(m, (counts.get(m) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

export async function deleteSlip(id) {
  requireUser();
  await deleteDoc(slipDoc(id));
}

export async function updateSlip(id, patch) {
  requireUser();
  const ref = slipDoc(id);
  const cur = await getDoc(ref);
  if (!cur.exists()) throw new Error('That slip no longer exists.');
  const next = { ...cur.data(), ...patch };
  if (patch.date) next.month = monthOf(patch.date);
  await setDoc(ref, next);
  return next;
}

/* ────────────────────────────────────────────────────────────────────────
   Appendices — mission docs and misc, added after the slips
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Store a file to be appended after the slips.
 *
 * A mission document can be several megabytes, well past a single Firestore
 * document, so the bytes are split across chunk documents. They are written in
 * one batch so a half-uploaded appendix never appears in the list.
 */
export async function saveAppendix({ file, month, order = 0 }) {
  requireUser();
  const dataUrl = await fileToDataURL(file);
  const id = newId();

  const chunks = [];
  for (let i = 0; i < dataUrl.length; i += CHUNK_BYTES) {
    chunks.push(dataUrl.slice(i, i + CHUNK_BYTES));
  }

  const batch = writeBatch(db);
  const record = {
    id, month, order,
    name: file.name || 'document',
    mime: file.type || 'application/octet-stream',
    bytes: file.size || 0,
    chunkCount: chunks.length,
    createdAt: Date.now(),
  };
  batch.set(apxDoc(id), record);
  chunks.forEach((text, i) => batch.set(chunkDoc(`${id}__${i}`), { data: text, i, apx: id }));
  await batch.commit();

  return record;
}

export async function listAppendices(month) {
  requireUser();
  const snap = await getDocs(query(apxCol(), where('month', '==', month)));
  const rows = snap.docs.map((d) => d.data());
  rows.sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
  return rows;
}

/** Reassemble one appendix into its original data URL. */
export async function readAppendix(record) {
  requireUser();
  const parts = [];
  for (let i = 0; i < record.chunkCount; i++) {
    const snap = await getDoc(chunkDoc(`${record.id}__${i}`));
    if (!snap.exists()) throw new Error(`"${record.name}" is missing part ${i + 1} of ${record.chunkCount}.`);
    parts.push(snap.data().data);
  }
  return parts.join('');
}

export async function deleteAppendix(record) {
  requireUser();
  const batch = writeBatch(db);
  batch.delete(apxDoc(record.id));
  for (let i = 0; i < record.chunkCount; i++) batch.delete(chunkDoc(`${record.id}__${i}`));
  await batch.commit();
}

export async function reorderAppendices(records) {
  requireUser();
  const batch = writeBatch(db);
  records.forEach((r, i) => batch.set(apxDoc(r.id), { ...r, order: i }));
  await batch.commit();
}

/* ────────────────────────────────────────────────────────────────────────
   Profile — so the cover page does not have to be retyped every month
   ──────────────────────────────────────────────────────────────────────── */

export async function loadProfile() {
  requireUser();
  const snap = await getDoc(profileDoc());
  return snap.exists() ? snap.data() : {};
}

export async function saveProfile(patch) {
  requireUser();
  const cur = await loadProfile();
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await setDoc(profileDoc(), next);
  return next;
}

/* ────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────── */

export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    r.readAsDataURL(file);
  });
}

/** Rough decoded size of a data URL, for showing storage used. */
export function dataUrlBytes(url) {
  const i = (url || '').indexOf(',');
  if (i < 0) return 0;
  return Math.round((url.length - i - 1) * 0.75);
}

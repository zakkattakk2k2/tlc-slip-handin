/**
 * An in-memory stand-in for the three Firebase modules the app imports.
 *
 * Playwright serves these in place of the real gstatic bundles so the whole
 * app — sign-in, saving slips, listing a month, building the PDF — can be
 * driven end to end without a Firebase project, a network, or test data
 * leaking into a real database.
 *
 * Only the surface the app actually uses is implemented. If the app starts
 * using another Firestore feature, this file has to grow with it; a missing
 * export shows up immediately as a module load error in the test run, which is
 * the behaviour we want.
 */

export const APP_STUB = `
  export function initializeApp(config) { return { name: '[DEFAULT]', options: config }; }
`;

export const AUTH_STUB = `
  const USER = {
    uid: 'test-tutor-uid',
    email: 'zak.k@geniuspremium.com',
    displayName: 'Zak Kayat',
    emailVerified: true,
  };
  export function getAuth() { return { currentUser: USER }; }
  export function onAuthStateChanged(auth, cb) {
    // Asynchronous, like the real SDK, so the app's ordering assumptions
    // are exercised rather than accidentally satisfied.
    setTimeout(() => cb(USER), 10);
    return () => {};
  }
  export function signInWithPopup() { return Promise.resolve({ user: USER }); }
  export function signOut() { return Promise.resolve(); }
  export class GoogleAuthProvider {}
`;

export const FIRESTORE_STUB = `
  const DB = new Map();                       // path -> data
  window.__FIRESTORE = DB;

  const key = (parts) => parts.join('/');

  export function getFirestore() { return { kind: 'stub' }; }
  export function initializeFirestore() { return { kind: 'stub' }; }
  export function persistentLocalCache() { return {}; }
  export function persistentMultipleTabManager() { return {}; }

  export function doc(db, ...path) { return { type: 'doc', path: key(path) }; }
  export function collection(db, ...path) { return { type: 'col', path: key(path) }; }

  export function query(col, ...constraints) {
    return { type: 'query', path: col.path, constraints };
  }
  export function where(field, op, value) { return { field, op, value }; }
  export function orderBy(field, dir) { return { orderBy: field, dir }; }

  export async function setDoc(ref, data) {
    DB.set(ref.path, JSON.parse(JSON.stringify(data)));
  }
  export async function getDoc(ref) {
    const data = DB.get(ref.path);
    return { exists: () => data !== undefined, data: () => data, id: ref.path.split('/').pop() };
  }
  export async function deleteDoc(ref) { DB.delete(ref.path); }

  export async function getDocs(target) {
    const path = target.path;
    const constraints = target.constraints || [];
    const out = [];
    for (const [k, v] of DB.entries()) {
      if (!k.startsWith(path + '/')) continue;
      // Direct children only, matching a real collection query.
      if (k.slice(path.length + 1).includes('/')) continue;
      const ok = constraints.every((c) => {
        if (!c.field) return true;
        if (c.op === '==') return v[c.field] === c.value;
        return true;
      });
      if (ok) out.push({ id: k.split('/').pop(), data: () => v });
    }
    return { docs: out, empty: out.length === 0, size: out.length };
  }

  export function writeBatch() {
    const ops = [];
    return {
      set(ref, data) { ops.push(['set', ref, data]); return this; },
      delete(ref) { ops.push(['del', ref]); return this; },
      async commit() {
        for (const [kind, ref, data] of ops) {
          if (kind === 'set') DB.set(ref.path, JSON.parse(JSON.stringify(data)));
          else DB.delete(ref.path);
        }
      },
    };
  }
`;

/** Wire the stubs (and locally vendored CDN libraries) into a Playwright page. */
export async function installStubs(page, vendorDir) {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const serve = (body, type = 'application/javascript') => ({
    status: 200,
    contentType: type,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body,
  });

  await page.route('**/firebasejs/**/firebase-app.js', (r) => r.fulfill(serve(APP_STUB)));
  await page.route('**/firebasejs/**/firebase-auth.js', (r) => r.fulfill(serve(AUTH_STUB)));
  await page.route('**/firebasejs/**/firebase-firestore.js', (r) => r.fulfill(serve(FIRESTORE_STUB)));

  await page.route('**/pdf-lib*', (r) => r.fulfill(serve(
    fs.readFileSync(path.join(vendorDir, 'node_modules/pdf-lib/dist/pdf-lib.min.js'), 'utf8'))));
  await page.route('**/signature_pad*', (r) => r.fulfill(serve(
    fs.readFileSync(path.join(vendorDir, 'node_modules/signature_pad/dist/signature_pad.umd.min.js'), 'utf8'))));

  // Google Fonts is unreachable in the test container; the app falls back to a
  // system sans, which is fine for behaviour and irrelevant to these checks.
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill(serve('', 'text/css')));
  await page.route('**/fonts.gstatic.com/**', (r) => r.abort());
}

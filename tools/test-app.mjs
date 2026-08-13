/**
 * End-to-end check of the real app in a real browser.
 *
 * Drives index.html through the whole journey a tutor takes — sign in, upload a
 * photo, adjust nothing, save, look at the month, fill in a digital slip,
 * build the hand-in PDF — with Firebase stubbed at the network layer so no
 * project or connection is needed.
 *
 * Run:  node tools/test-app.mjs [photo.png]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { installStubs } from './firebase-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = '/tmp/vendor';
const PHOTO = process.argv[2] || '/tmp/testphotos/01-flat-dark-desk.png';
const SHOTS = '/tmp/appshots';
fs.mkdirSync(SHOTS, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.pdf': 'application/pdf', '.png': 'image/png', '.json': 'application/json',
};

function serveRoot(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      let body = fs.readFileSync(file);
      if (rel === 'index.html') {
        // Stand in for a real deployment: fill the SETTINGS placeholders as
        // Zak will when the Firebase project exists. Patching them after load
        // does not work — the inline settings block runs during parse.
        body = Buffer.from(String(body)
          .replace(/PASTE_API_KEY/g, 'test-api-key')
          .replace(/PASTE_PROJECT_ID/g, 'tlc-slips-test')
          .replace(/PASTE_SENDER_ID/g, '000000000000')
          .replace(/PASTE_APP_ID/g, '1:000000000000:web:testtesttest'));
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
    server.listen(port, () => resolve(server));
  });
}

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const PORT = 8137;
  const server = await serveRoot(PORT);

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
    permissions: [],
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await installStubs(page, VENDOR);

  /* ── 1. It boots and signs in ─────────────────────────────────────── */
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#main:not([hidden])', { timeout: 15000 }).catch(() => {});
  const bootErrorVisible = await page.locator('#boot-error').isVisible();
  const mainVisible = await page.locator('#main').isVisible();
  check('app boots and reveals the main UI', mainVisible && !bootErrorVisible,
    bootErrorVisible ? await page.locator('#boot-error').innerText() : '');

  await page.screenshot({ path: `${SHOTS}/01-capture-tab.png` });

  /* ── 2. Upload a photo, detect, crop ──────────────────────────────── */
  await page.setInputFiles('#cap-file', PHOTO);
  await page.waitForSelector('#cap-crop-panel:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1200);           // let detection and the preview settle
  await page.screenshot({ path: `${SHOTS}/02-crop.png` });

  const cropPreviewInk = await page.evaluate(() => {
    const c = document.getElementById('cap-preview-canvas');
    if (!c || !c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 140) dark++;
    return dark / (d.length / 4);
  });
  // A real slip is roughly 40% dark (the two grey bands); a blank crop is 0.
  check('crop preview shows a slip', cropPreviewInk > 0.12 && cropPreviewInk < 0.75,
    `${(cropPreviewInk * 100).toFixed(1)}% dark pixels`);

  /* ── 3. Details and save ──────────────────────────────────────────── */
  await page.click('#cap-accept');
  await page.waitForSelector('#cap-details-panel:not([hidden])');
  await page.fill('#cap-date', '2026-08-03');
  await page.fill('#cap-student', 'Miguel');
  await page.fill('#cap-subject', 'Physical Sciences');
  await page.fill('#cap-hours', '1.5');
  await page.click('#cap-save');
  await page.waitForSelector('#cap-done-panel:not([hidden])', { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/03-saved.png` });

  const stored = await page.evaluate(() => {
    const out = [];
    for (const [k, v] of window.__FIRESTORE.entries()) if (k.includes('/slips/')) out.push({ k, v });
    return out.map((o) => ({ date: o.v.date, month: o.v.month, len: (o.v.image || '').length, meta: o.v.meta }));
  });
  check('slip written to the store', stored.length === 1 && stored[0].month === '2026-08',
    JSON.stringify(stored[0] && { date: stored[0].date, month: stored[0].month }));
  check('stored image fits a Firestore document',
    stored[0] && stored[0].len > 5000 && stored[0].len < 1000000,
    stored[0] ? `${(stored[0].len / 1024).toFixed(0)} KB encoded` : '');
  check('capture metadata saved',
    stored[0] && stored[0].meta.student === 'Miguel' && stored[0].meta.hours === '1.5');

  /* ── 4. Month view lists it ───────────────────────────────────────── */
  await page.click('#tab-month');
  await page.waitForTimeout(700);
  const cards = await page.locator('.slip-card').count();
  check('month view lists the saved slip', cards === 1, `${cards} card(s)`);
  await page.screenshot({ path: `${SHOTS}/04-month.png` });

  /* ── 5. Digital slip ──────────────────────────────────────────────── */
  await page.click('#tab-digital');
  await page.waitForTimeout(400);
  await page.fill('#dig-date', '2026-08-05');
  await page.fill('#dig-subject', 'Mathematics');
  await page.fill('#dig-student', 'Brook Adams');
  await page.fill('#dig-tutor', 'Zak Kayat');
  await page.fill('#dig-hours', '2');
  await page.fill('#dig-from', '14:30');
  await page.fill('#dig-to', '16:30');
  await page.fill('#dig-notes',
    'Covered trigonometric identities and the compound angle formulae. Brook is now confident with proving identities; next lesson we start on 3D trig problems.');

  // Sign both pads by dragging across them, the way a person would.
  // Scroll each into view first: mouse coordinates are viewport-relative, so a
  // pad below the fold gets "signed" somewhere else entirely.
  for (const id of ['#dig-sig-student', '#dig-sig-tutor']) {
    await page.locator(id).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const box = await page.locator(id).boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.25, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.8, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.3, { steps: 8 });
    await page.mouse.up();
  }

  await page.click('#dig-refresh');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/05-digital.png` });

  const digCanvas = await page.locator('#dig-preview canvas');
  check('digital slip preview rendered', await digCanvas.count() === 1);

  const sigInk = await page.evaluate(() => {
    const c = document.getElementById('dig-sig-student');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) ink++;
    return ink;
  });
  check('signature pad captured strokes', sigInk > 200, `${sigInk} inked pixels`);
  await digCanvas.screenshot({ path: `${SHOTS}/06-digital-slip.png` }).catch(() => {});

  await page.click('#dig-save');
  await page.waitForSelector('#dig-done:not([hidden])', { timeout: 15000 });
  const slipCount = await page.evaluate(() =>
    [...window.__FIRESTORE.keys()].filter((k) => k.includes('/slips/')).length);
  check('digital slip saved alongside the photo', slipCount === 2, `${slipCount} slips`);

  /* ── 6. Build the hand-in PDF ─────────────────────────────────────── */
  await page.click('#tab-compile');
  await page.waitForTimeout(700);
  await page.fill('#cmp-month', '2026-08');
  await page.dispatchEvent('#cmp-month', 'change');
  await page.waitForTimeout(500);
  await page.fill('#cmp-name', 'Zak Kayat');
  await page.fill('#cmp-pay-month', '2026-08');
  await page.dispatchEvent('#cmp-pay-month', 'change');
  await page.fill('#cmp-date-issued', '2026-09-01');
  await page.fill('#cmp-syndicate-count', '2');
  await page.dispatchEvent('#cmp-syndicate-count', 'input');
  await page.waitForTimeout(200);
  await page.fill('#cmp-syn-0', '2026-08-07');
  await page.fill('#cmp-syn-1', '2026-08-21');

  await page.locator('#cmp-signature').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const sigBox = await page.locator('#cmp-signature').boundingBox();
  await page.mouse.move(sigBox.x + 30, sigBox.y + sigBox.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(sigBox.x + sigBox.width * 0.4, sigBox.y + sigBox.height * 0.3, { steps: 10 });
  await page.mouse.move(sigBox.x + sigBox.width * 0.75, sigBox.y + sigBox.height * 0.75, { steps: 10 });
  await page.mouse.up();

  await page.screenshot({ path: `${SHOTS}/07-compile.png`, fullPage: true });

  const download = page.waitForEvent('download', { timeout: 40000 });
  await page.click('#cmp-generate');
  let pdfPath = null;
  try {
    const dl = await download;
    pdfPath = '/tmp/appshots/handin.pdf';
    await dl.saveAs(pdfPath);
  } catch (e) {
    const msg = await page.locator('#cmp-error').innerText().catch(() => '');
    check('hand-in PDF generated', false, msg || String(e).slice(0, 160));
  }

  if (pdfPath) {
    const size = fs.statSync(pdfPath).size;
    check('hand-in PDF generated', size > 40000, `${(size / 1024).toFixed(0)} KB`);
  }

  /* ── 7. Append a document and rebuild ─────────────────────────────── */
  // Appendices are split across chunk documents to get past Firestore's 1 MiB
  // per-document cap, so stitching them back together is worth proving.
  await page.setInputFiles('#cmp-appendix-file', path.join(ROOT, 'assets/cover-template.pdf'));
  await page.waitForTimeout(1200);
  const apxRows = await page.locator('.apx-row').count();
  check('appended document listed', apxRows === 1, `${apxRows} row(s)`);

  const chunkCount = await page.evaluate(() =>
    [...window.__FIRESTORE.keys()].filter((k) => k.includes('/appendixChunks/')).length);
  check('appendix stored in chunks', chunkCount >= 1, `${chunkCount} chunk(s)`);

  const dl2p = page.waitForEvent('download', { timeout: 40000 });
  await page.click('#cmp-generate');
  let pdf2 = null;
  try {
    const dl2 = await dl2p;
    pdf2 = '/tmp/appshots/handin-with-appendix.pdf';
    await dl2.saveAs(pdf2);
    check('rebuild with appendix succeeded', fs.statSync(pdf2).size > 40000,
      `${(fs.statSync(pdf2).size / 1024).toFixed(0)} KB`);
  } catch (e) {
    const msg = await page.locator('#cmp-error').innerText().catch(() => '');
    check('rebuild with appendix succeeded', false, msg || String(e).slice(0, 160));
  }

  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/08-done.png`, fullPage: true });

  /* ── 7. No JavaScript errors anywhere in that journey ─────────────── */
  const realErrors = errors.filter((e) =>
    !/favicon|fonts\.gstatic|net::ERR_FAILED.*fonts/i.test(e));
  check('no JavaScript errors during the whole flow', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})();

# Genius Premium Tuition — TLC Slip Hand-in

A small, production-quality **static web app** that lets a GPT tutor submit their
monthly TLC slips. The tutor uploads their scanned slips PDF, fills in a few
details, draws a signature, and clicks **Generate** — the app builds **one
combined PDF**:

- **Page 1** — the branded GPT hand-in form, with their details filled in and
  their signature on the "Signed:" line.
- **Pages 2+** — their uploaded slips, appended unchanged and in order.

The combined PDF **auto-downloads**, with a **"Download again"** fallback button.

> **Everything runs in the browser.** Nothing the user enters or uploads is ever
> sent to a server. No backend, no build step, no framework.

## Screenshot

![Screenshot of the TLC Slip Hand-in app](assets/screenshot.png)

*(Add `assets/screenshot.png` — a capture of the running app — for the README preview.)*

## How it works

| Library | Used for |
|---|---|
| [pdf-lib](https://unpkg.com/pdf-lib) | Overlay the details + signature onto the cover template and append the slip pages |
| [signature_pad](https://cdn.jsdelivr.net/npm/signature_pad) | Smooth, high-DPI signature drawing, exported as a PNG |

Both are loaded via CDN — there is nothing to install.

## Files

```
/ (repo root)
  index.html      # markup + CDN script tags
  app.js          # all logic; the COVER coordinate map is at the top
  styles.css      # GPT booklet-brand styling (UI only)
  assets/
    cover-template.pdf   # branded GLE hand-in form v2.3 (included, calibrated)
  README.md
```

## Cover template

The app overlays onto `assets/cover-template.pdf` — the branded **"GLE Payslip
Hand in form v2.3"** (US Letter, 612 × 792 pt). This file is **already included**
and the coordinate map in `app.js` is calibrated to it, so the app works out of
the box.

If the template PDF is ever missing, clicking **Generate** shows a clear message
telling you to restore it.

## Run locally

Because it uses `fetch()` to load the cover template, open it via a local server
(not `file://`):

```bash
# Python 3
python -m http.server 8000
# then open http://localhost:8000
```

Any static server works (VS Code "Live Server", `npx serve`, etc.).

## Adjusting the cover layout

All overlay positions live in one clearly-commented constant, `COVER`, at the
top of [`app.js`](app.js). pdf-lib's origin is the **bottom-left** of the page,
so **+y moves text up** and **+x moves it right**; values are in points on a
612 × 792 pt page. Generate a test PDF, then nudge any value by a few points
until each value sits neatly on its line.

**To update the cover:** replace `assets/cover-template.pdf` and re-check the
coordinate map in `app.js`.

## Deploy to GitHub Pages

1. Create a **public** GitHub repo and commit these files to the `main` branch
   (including `assets/cover-template.pdf`).
2. Repo → **Settings → Pages** → Source = *Deploy from a branch* →
   Branch = `main`, folder = `/ (root)` → **Save**.
3. Wait ~1 minute; the app is live at
   `https://<username>.github.io/<repo>/`.
4. Because everything runs in-browser, there are no secrets, servers, or costs.

> Netlify, Cloudflare Pages, and Vercel static hosting work identically — just
> drag-and-drop the folder.

## Accessibility & UX notes

- Every input is labelled; the form is fully keyboard-navigable.
- The signature canvas is high-DPI aware (scaled by `devicePixelRatio`).
- A live preview shows the resolved **Pay month**, **Date issued**, and
  **syndicate days** exactly as they'll print, so the tutor can sanity-check.
- Missing fields / no signature block **Generate** with a helpful summary.
- Large slip PDFs keep the UI responsive with a "Generating…" state.
- Encrypted or non-PDF uploads produce a clear inline error instead of crashing.

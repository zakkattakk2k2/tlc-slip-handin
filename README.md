# Genius Premium Tuition — TLC Slip Hand-in

A static web app that takes a tutor from **"the lesson just ended"** to
**"the month is handed in"** without any paper admin at the end of the month.

## What it does

**Capture a slip the day it happens.** Photograph the paper slip in the app.
It finds the slip in the photo, straightens it, crops everything else away —
the desk, the student's workbook, the pen lying next to it — and saves it.

**Send it to WhatsApp.** One tap prepares the cropped image and a caption and
opens the share sheet, so the tutor just picks the group.

**Or fill in a digital slip.** When there is no paper slip to hand, the app
reproduces the printed V3.2 lesson slip on screen. Both parties sign on the
tutor's device and it is saved exactly like a photographed one.

**Hand in without compiling anything.** At the end of the month the branded
cover page is filled in and signed, every saved slip is added in lesson-date
order, and any mission documents go on the end. One PDF, one download.

Tutors who prefer to scan a whole month on the office copier can still do
that — the **Hand in** tab accepts a scanned PDF in place of the saved slips.

## The four tabs

| Tab | What happens there |
|---|---|
| **Add a slip** | Photograph or upload → check the crop → a few details → saved |
| **This month** | Everything saved this month; re-send any slip, or delete one |
| **Digital slip** | The on-screen lesson slip, with both signatures |
| **Hand in** | Cover details, signature, appended documents → the finished PDF |

## Setup

Slips are **stored**, so the app needs a Firebase project of its own.
**[FIREBASE-SETUP.md](FIREBASE-SETUP.md)** walks through it — about ten minutes,
once, and it cannot affect the Schedule Maker or Sell Bios.

Until that is done the app shows a "Setup isn't finished" message rather than
failing in a confusing way.

To publish the site itself, see **[GITHUB-SETUP.md](GITHUB-SETUP.md)**.

## Files

```
/ (repo root)
  index.html          markup, the intro overlay, and the SETTINGS block
  app.js              sign-in, tabs, month view, digital slip, hand-in
  styles.css          house styling
  firestore.rules     database security — must be published to Firebase
  js/
    detect.js         finds the slip in a photo and flattens it
    capture.js        camera, the crop editor, saving
    digital.js        draws the V3.2 lesson slip on a canvas
    store.js          Firestore read/write, image encoding
    share.js          WhatsApp share and captions
    compile.js        builds the month's hand-in PDF
  assets/
    cover-template.pdf   branded GLE hand-in form v2.3 (calibrated)
  tools/              test harnesses — not part of the app
```

## How the auto-crop works

There is no OpenCV here — it would be an 8 MB download on a tutor's phone data
for one feature. `js/detect.js` is about 20 KB of plain JavaScript.

The thing that shapes the whole design: **a Genius lesson slip is not a white
rectangle.** It has a dark grey band at the top, a dark grey band at the bottom
and white in between, so the obvious "find the bright paper" approach finds only
the white middle — which is roughly square, nothing like the slip's real
0.576 aspect ratio — and crops the branding off. So the detector:

1. Builds several different candidate masks (edges, difference-from-desk,
   bright, dark) at two smoothing levels, filling enclosed holes so a slip that
   shows up only as an outline becomes one solid region.
2. Separately finds straight lines with a gradient-guided Hough transform and
   assembles rectangles from them, which is the only approach that survives a
   slip lying on top of a student's workbook.
3. Completes near-misses using the one thing known for certain — the slip is
   exactly 243.84 × 423.36 pt — so a crop that snapped to the header band's
   inner edge gets extended to the real border.
4. Scores every candidate on shape, evidence and size, then corrects the
   perspective with a homography.

**Confidence is agreement, not score.** A crop is only treated as certain when
two independent analyses land on the same rectangle. When they disagree the
tutor is shown the crop with draggable corners instead of it being saved
silently — a slip is a payroll document, and a wrong crop is discovered at the
end of the month when the paper may be gone.

If a second slip is spotted in the frame it is outlined and flagged, since one
slip per photo is what keeps the month's count right.

## Testing

```bash
node tools/test-geom.mjs                    # geometry unit checks
python3 tools/make-test-photos.py <slip.png> /tmp/testphotos
node tools/test-detect.mjs /tmp/testphotos  # detection accuracy, writes crops
node tools/test-app.mjs                     # the whole app in a real browser
```

`tools/test-app.mjs` drives the real `index.html` in Chromium with Firebase
stubbed at the network layer, so the full journey — upload, crop, save, month
view, digital slip, PDF — is exercised without a Firebase project.
`tools/overlay.mjs` and `tools/debug-detect.mjs` are for looking at detection
failures rather than guessing at them.

## Run locally

`fetch()` is used to load the cover template, so open it through a local server
rather than `file://`:

```bash
python -m http.server 8000    # then open http://localhost:8000
```

**Start TLC App.bat** does this for you on Windows.

## Adjusting the cover layout

All overlay positions live in one commented constant, `COVER`, at the top of
[`js/compile.js`](js/compile.js). pdf-lib's origin is the **bottom-left**, so
**+y moves text up**; values are points on a 612 × 792 pt page. Generate a test
PDF and nudge by a few points until each value sits on its line.

**To change the cover:** replace `assets/cover-template.pdf` and re-check that
map.

## Notes

- Every input is labelled and the app is keyboard-navigable.
- Signature canvases are high-DPI aware and re-measure when their tab becomes
  visible — a pad sized 0×0 exports an empty signature.
- Slips are stored as JPEG. WhatsApp has been known to treat WebP as a sticker.
- Each slip is encoded to fit inside a single Firestore document, stepping
  quality down if it must, so a save never fails on the last day of the month.
- Appended documents are split across chunk documents, so a large mission PDF
  is not limited by Firestore's 1 MiB document cap.

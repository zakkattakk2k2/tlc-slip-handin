# "Choose a file" opens the camera instead of the file picker

A one-attribute bug that is easy to ship, because **it is invisible on a
desktop browser.** This is what it is, how to fix it, and the related traps
that produce a similar-looking symptom.

---

## The symptom

On a phone, tapping your "Choose a photo" / "Upload file" button goes straight
to the camera. There is no chance to pick an existing photo from the gallery or
from Files. On a laptop the same button works perfectly.

## The cause

The `capture` attribute on the file input.

```html
<!-- BROKEN: always launches the camera on a phone -->
<input type="file" accept="image/*" capture="environment" />
```

`capture` does not mean "allow the camera". It means **"skip the picker and go
straight to the camera"**. Once it is present the user can no longer choose an
existing file at all.

## The fix

Delete the attribute.

```html
<!-- CORRECT: the OS offers gallery, files, AND camera -->
<input type="file" accept="image/*" />
```

You lose nothing by removing it. Without `capture`, iOS shows an action sheet
offering *Photo Library / Take Photo / Choose File*, and Android opens its photo
picker with a camera option. **The camera is still reachable** — it is just no
longer forced.

---

## Why it survives testing

`capture` is **ignored on desktop browsers.** Chrome and Safari on a laptop show
a normal file dialog whether or not the attribute is there. So the bug cannot be
reproduced on the machine where the code is written, and only appears on a real
phone.

Anything involving `capture` has to be tested on an actual device.

---

## What to write, depending on what you want

| You want | Write this |
|---|---|
| Pick an existing photo (and camera as an option) | `accept="image/*"` |
| Pick any file | `accept` omitted, or a specific list |
| **Force** the rear camera, no picker | `accept="image/*" capture="environment"` |
| **Force** the front camera (selfie), no picker | `accept="image/*" capture="user"` |
| Live camera preview inside your own page | Not a file input — use `getUserMedia` |

Only reach for `capture` when skipping the chooser is genuinely what you want —
a "scan a receipt now" flow, for example. If your UI has a separate "Take a
photo" button, that button should almost never be a `capture` input either: a
real in-page camera via `getUserMedia` gives you a live preview, framing guides
and control over resolution.

Note also that **`capture` overrides `multiple`** — you get exactly one photo,
no matter what.

### The attribute is presence-based

All of these are broken in the same way. There is no "off" value:

```html
<input type="file" capture />
<input type="file" capture="" />
<input type="file" capture="camera" />   <!-- not even a real value -->
```

Any presence of `capture` requests capture, and browsers treat an unrecognised
value as the rear camera. To disable it, the attribute must be **absent**.
Removing it in JavaScript means `removeAttribute`, not setting it to `false`:

```js
input.removeAttribute('capture');        // correct
input.capture = false;                   // does NOT work
```

---

## Look-alikes: other reasons a picker misbehaves

Worth checking these before assuming `capture` is your problem.

### 1. The input is hidden with `display:none`

A common pattern is a styled button that forwards its click to a hidden input.
If the input is hidden with `display: none` or `visibility: hidden`, some
browsers refuse to open the picker and **nothing happens at all**.

Use the clip-rect technique instead — off-screen but still rendered:

```css
.visually-hidden {
  position: absolute !important;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0);
  white-space: nowrap; border: 0;
}
```

### 2. Picking the same file twice does nothing

`change` only fires when the value *changes*. Re-selecting the same photo is not
a change, so your handler never runs and the app looks frozen. Clear the value
as soon as you have the file:

```js
input.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                   // so the same file can be re-picked
  if (!file) return;
  // …
});
```

### 3. `accept` is too narrow

`accept="image/jpeg"` will grey out or hide PNGs, screenshots and HEIC photos,
which reads to the user as "my photos are missing". Prefer `image/*` unless you
have a real reason to restrict, and remember iOS photos are often **HEIC** —
list it explicitly if you are naming types:

```html
<input type="file" accept="image/*,.heic,.heif" />
```

Also note that an `accept` list of extensions only (`.pdf,.jpg`) is less
reliable on Android than including MIME types (`application/pdf,image/jpeg`).

### 4. The page is inside an in-app browser

Links opened inside WhatsApp, Instagram or Facebook run in a restricted webview
where file pickers and camera access are sometimes blocked outright. Symptom:
the button does nothing, with no error. Nothing in your code fixes this — detect
it and tell the user to open the page in Safari or Chrome.

### 5. `getUserMedia` needs HTTPS

If you are using a live in-page camera rather than a file input, it silently
fails outside a secure context. `localhost` counts as secure; a plain
`http://192.168.x.x` address on your phone does not. Test over HTTPS.

---

## Quick diagnosis

Paste this in the console on the affected page. It lists every file input and
flags the ones that will bypass the picker:

```js
[...document.querySelectorAll('input[type=file]')].forEach((i) => {
  console.log({
    id: i.id || '(no id)',
    accept: i.accept || '(any)',
    capture: i.hasAttribute('capture') ? i.getAttribute('capture') || '(empty)' : null,
    forcesCamera: i.hasAttribute('capture'),
    hiddenBadly: getComputedStyle(i).display === 'none',
  });
});
```

`forcesCamera: true` on an input meant for choosing files is your bug.

To confirm a styled button actually reaches its input without opening a native
dialog, intercept the click:

```js
const input = document.getElementById('YOUR-INPUT-ID');
const orig = input.click;
input.click = function () { console.log('reached', this.id, 'capture:', this.hasAttribute('capture')); };
document.getElementById('YOUR-BUTTON-ID').click();
input.click = orig;
```

---

## Checklist

- [ ] No `capture` attribute on any input meant for choosing existing files
- [ ] Hidden inputs use clip-rect, not `display: none`
- [ ] `input.value` cleared in the `change` handler
- [ ] `accept` is broad enough — `image/*`, and HEIC covered if types are listed
- [ ] Tested on a real iPhone **and** a real Android phone, not just desktop
- [ ] If using `getUserMedia`, the page is served over HTTPS

---

## What this was in this project

`index.html` had a single input shared by two buttons:

```html
<button id="cap-take">📷 Take a photo</button>
<button id="cap-choose">Choose a photo</button>
<input id="cap-file" type="file" accept="image/*" capture="environment" />
```

"Take a photo" opens a live in-page camera via `getUserMedia` in
`js/capture.js` and never touches the input. So `capture="environment"` served
no purpose and turned "Choose a photo" into a second camera button. Removing it
was the whole fix — the input now carries a comment warning against adding it
back.

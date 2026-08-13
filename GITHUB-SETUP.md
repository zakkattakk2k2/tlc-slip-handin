# Putting this app on GitHub Pages — step by step

**Read this first (the important safety point):**

This folder is its **own, self-contained project**. To publish it you will create a
**brand-new, separate repository** on GitHub. Because it is a *different repo* from your
Schedule Maker, **it cannot touch, overwrite, or corrupt the Schedule Maker in any way** —
they live in separate places on GitHub and never interact.

The **only** rule you must follow: when GitHub asks which repository to use, always pick
the **new** one you create below (suggested name: `tlc-slip-handin`). **Never** choose or
upload into your existing Schedule Maker repository.

You have two ways to do this. **Method A needs no command line and is the safest** — use it
if you're unsure. Method B is faster if you're comfortable with git.

---

## Method A — Upload through the GitHub website (recommended, no command line)

1. Go to **https://github.com/new** (this always makes a *new, empty* repository).
2. **Repository name:** type `tlc-slip-handin`.
   - Make sure the name is **new** and is **not** your Schedule Maker's name.
3. Set it to **Public** (required for free GitHub Pages). Leave "Add a README" **unticked**.
4. Click **Create repository**.
5. On the next page, click the link **"uploading an existing file"**
   (under "…or upload files").
6. Open the `TLC-Slip-Handin` folder on your Desktop. Select **everything inside it**:
   - `index.html`, `app.js`, `styles.css`, `firestore.rules`, `README.md`,
     `GITHUB-SETUP.md`, `FIREBASE-SETUP.md`, `.nojekyll`
   - the **`js`** folder (the app will not run without it)
   - the **`assets`** folder (which contains `cover-template.pdf`)
   - Drag them all onto the GitHub upload area. Dragging the `js` and `assets`
     folders keeps their contents in the right place.
   - You don't need `Start TLC App.bat` (the local launcher), the `tools` folder
     (test scripts), or `node_modules` if it exists.
7. Scroll down and click **Commit changes**.
8. Now turn on the website: go to the repo's **Settings → Pages** (left sidebar).
   - **Source:** "Deploy from a branch"
   - **Branch:** `main`, folder `/ (root)` → click **Save**.
9. Wait about a minute, then refresh that Pages screen. It will show your live link:
   **`https://<your-username>.github.io/tlc-slip-handin/`**
10. Open that link — the app runs, fully working. Share it with tutors.

That's it. Your Schedule Maker was never involved.

---

## Method B — Push with git (this folder is already a ready git repo)

I've already initialised git here and made the first commit, so the history is ready to go.
You only need to connect it to the **new** GitHub repo and push.

1. Create the new empty repo first: **https://github.com/new** → name it `tlc-slip-handin`
   → Public → **do not** add a README → **Create repository**.
2. On the new repo's page, copy its URL (looks like
   `https://github.com/<your-username>/tlc-slip-handin.git`).
   **Double-check the name in that URL is `tlc-slip-handin`, not your Schedule Maker.**
3. Open a terminal in this folder and run (replace the URL with the one you copied):

   ```bash
   cd "C:\Users\zakar\OneDrive\Desktop\TLC-Slip-Handin"
   git remote add origin https://github.com/<your-username>/tlc-slip-handin.git
   git push -u origin main
   ```

   > `git remote add origin …` is the line that decides *where this goes*. As long as that
   > URL is the new `tlc-slip-handin` repo, the Schedule Maker is untouched. If you ever
   > need to check, run `git remote -v` — it must show `tlc-slip-handin`.

4. Turn on Pages exactly as in **Method A, steps 8–10**.

---

## ⚠️ Before the site will work: set up Firebase

The app signs tutors in and **stores their slips**, so it needs its own Firebase
project. That is a separate, one-time job — follow **`FIREBASE-SETUP.md`** in this
folder from start to finish.

It creates a brand-new project called `tlc-slips`, which is separate from the
Schedule Maker (`schedulemaker-c212c`) and from Sell Bios (`sell-bios`) and cannot
affect either of them.

Two parts of that guide matter most:

- **Publishing `firestore.rules`.** This is what stops one tutor reading another
  tutor's slips. Do not skip it.
- **Authorized domains.** Add `<your-username>.github.io` under
  **Authentication → Settings → Authorized domains**, or Google will refuse to show
  the sign-in popup on your live site. `localhost` is already allowed, so local
  testing works without it.

> Sign-in is already limited to Genius accounts. To allow any Google account,
> open `index.html`, find `ALLOWED_DOMAIN: 'geniuspremium.com'` in the SETTINGS
> block near the top, and set it to `''`.

## Updating the app later

- **Method A:** repeat the upload (GitHub replaces the changed files in *this* repo only).
- **Method B:** `git add -A` → `git commit -m "your note"` → `git push`.

GitHub Pages redeploys automatically within a minute.

## If you ever swap the cover form

Replace `assets/cover-template.pdf`, re-check the `COVER` coordinate map at the top of
`js/compile.js`, then re-upload / push.

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
   - `index.html`, `app.js`, `styles.css`, `README.md`, `GITHUB-SETUP.md`,
     `.nojekyll`, and the **`assets`** folder (which contains `cover-template.pdf`).
   - Drag them all onto the GitHub upload area. (Dragging the `assets` folder keeps the
     PDF in the right place.)
   - You don't need to upload `Start TLC App.bat` (that's just the local launcher).
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

## ⚠️ One extra step: allow sign-in on your live site

The app requires a **Google sign-in** (same Firebase project as the Schedule Maker,
`schedulemaker-c212c`). Google will only show the sign-in popup on domains you've
approved, so after your site is live you must add its address once:

1. Go to the **Firebase console**: https://console.firebase.google.com/
2. Open the **schedulemaker-c212c** project.
3. Left sidebar → **Authentication** → **Settings** tab → **Authorized domains**.
4. Click **Add domain** and enter your GitHub Pages host **without** `https://` or any path:

   ```
   <your-username>.github.io
   ```

5. Save. Sign-in now works on your live site (it may take a minute).

**This does not affect the Schedule Maker.** Authorized domains is an *additive* list —
you're adding a new domain, not changing the existing ones. `localhost` is already
allowed, so local testing works without this step.

> Want to limit sign-in to Genius accounts only? Open `index.html`, find
> `const ALLOWED_DOMAIN = '';` near the Firebase block, and set it to
> `'geniuspremium.com'`. Anyone signing in with a different account is politely turned away.

## Updating the app later

- **Method A:** repeat the upload (GitHub replaces the changed files in *this* repo only).
- **Method B:** `git add -A` → `git commit -m "your note"` → `git push`.

GitHub Pages redeploys automatically within a minute.

## If you ever swap the cover form

Replace `assets/cover-template.pdf`, re-check the `COVER` coordinate map at the top of
`app.js`, then re-upload / push.

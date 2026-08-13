# Setting up the slip storage — one-time, about 10 minutes

The app now **stores** slips, so it needs somewhere to put them. That means a
Firebase project of its own.

**Read this first (the safety point):** you are creating a **brand-new,
separate** Firebase project. It cannot touch, read or damage the Schedule Maker
(`schedulemaker-c212c`) or Sell Bios (`sell-bios`) — separate projects on
Firebase never interact. The only rule: whenever a screen asks which project you
are in, make sure it says the **new** one.

You only ever do this once. After it's done, tutors just sign in.

---

## Step 1 — Create the project

1. Go to **https://console.firebase.google.com/**
2. Click **Create a project** (or **Add project**).
3. Name it **`tlc-slips`**. Firebase may add a suffix like `tlc-slips-4f2a` —
   that's normal and fine, just remember the full name.
4. Google Analytics is **not needed**. Turn it off.
5. Click **Create project**, then **Continue** when it finishes.

## Step 2 — Turn on Google sign-in

1. In the left sidebar: **Build → Authentication → Get started**.
2. Choose **Google** from the list of providers.
3. Toggle it **Enable**.
4. Pick a **support email** (your own address).
5. Click **Save**.

## Step 3 — Create the database

1. Left sidebar: **Build → Firestore Database → Create database**.
2. Choose **Start in production mode** (the rules in step 4 replace the
   defaults anyway, and production mode is closed by default rather than open).
3. For location choose **`europe-west1`** or another region near South Africa,
   then **Enable**. *(The location cannot be changed later — but any choice
   works, it only affects speed by a few milliseconds.)*

## Step 4 — Publish the security rules ⚠️ **do not skip this**

This is the step that stops one tutor reading another tutor's slips.

1. Still in **Firestore Database**, click the **Rules** tab.
2. Open the file **`firestore.rules`** from this folder in Notepad.
3. Select **all** of the text in the Firebase rules box and delete it.
4. Paste the **whole** contents of `firestore.rules` in its place.
5. Click **Publish**.

You should see "Rules published successfully". If Firebase complains about
syntax, you probably pasted on top of existing text instead of replacing it —
select all, delete, and paste again.

## Step 5 — Register the web app and copy its config

1. Click the **gear icon** (top left, next to "Project Overview") →
   **Project settings**.
2. Scroll to **Your apps** and click the **web icon** — it looks like `</>`.
3. App nickname: **`TLC Slip Hand-in`**. Do **not** tick "Firebase Hosting".
4. Click **Register app**.
5. Firebase shows a block of code. The part you need looks like this:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy………",
     authDomain: "tlc-slips-4f2a.firebaseapp.com",
     projectId: "tlc-slips-4f2a",
     storageBucket: "tlc-slips-4f2a.firebasestorage.app",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abcdef123456"
   };
   ```

6. Open **`index.html`** from this folder in Notepad.
7. Near the top you'll find the **SETTINGS** block with `PASTE_…` placeholders.
   Replace each placeholder with the matching value from Firebase, keeping the
   quotation marks and commas exactly as they are.

   Before:
   ```js
   apiKey:            "PASTE_API_KEY",
   ```
   After:
   ```js
   apiKey:            "AIzaSy………",
   ```

8. Save `index.html`.

> **Is it safe to have the API key in the file?** Yes. A Firebase web API key
> identifies the project; it does not grant access to anything. The rules you
> published in step 4 are what actually protect the slips. Every Firebase web
> app works this way.

## Step 6 — Allow sign-in from your live site

Google only shows its sign-in popup on domains you've approved.

1. **Build → Authentication → Settings** tab → **Authorized domains**.
2. Click **Add domain** and enter your GitHub Pages host, with **no** `https://`
   and no path:

   ```
   zakkattakk2k2.github.io
   ```

3. Save. `localhost` is already allowed, so testing on your own machine works
   without this step.

---

## Checking it worked

1. Open the app (double-click **Start TLC App.bat**, or visit the live site).
2. Sign in with your Genius Google account.
3. Add a slip — photograph anything, it doesn't have to be a real slip.
4. Switch to **This month**. The slip should be listed.
5. Refresh the page. It should **still** be listed — that's the proof it saved
   to Firebase and not just to the browser.

If step 5 fails, the rules in step 4 are the usual cause. Open the browser
console (F12) and look for `permission-denied`.

---

## What it costs

Firebase's free tier ("Spark") covers this comfortably. A slip is around
150–250 KB and the free tier includes 1 GB of storage and 50,000 reads a day.
A tutor doing 40 slips a month uses roughly 8 MB a month.

Two things keep usage low by design: slips are stored as documents rather than
in Firebase Storage (which would require a paid plan), and the app caches
locally so opening the month view repeatedly doesn't re-read everything.

---

## If you ever need to start over

Deleting the `tlc-slips` project deletes every stored slip with it, and there is
no undo. Compile and download the months you care about first — the PDF is the
record that matters.

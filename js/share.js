/* ============================================================================
   share.js — getting a slip into the right WhatsApp group.

   This deliberately mirrors the send flow already proven in the Genius Sell
   Bios app, because the constraint it works around has not changed:

     When a Web Share payload carries a file, WhatsApp keeps the image and
     usually discards the text.

   So the caption is ALSO written to the clipboard inside the same tap. One
   paste and it is in the caption box, on every platform. The clipboard write
   is fired BEFORE share() rather than awaited, because awaiting it can cost
   the user-gesture on iOS and the share sheet then silently refuses to open.

   There is no automatic posting to a group here, and that is not an oversight:
   the official WhatsApp Cloud API cannot post to groups at all, and the
   unofficial libraries that can carry a real risk of the company number being
   banned. The tutor picks the group; everything else is prepared for them.
   ========================================================================== */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-08-13" -> "13 August 2026". Parsed by parts to avoid timezone drift. */
export function longDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * The WhatsApp caption for a slip. Kept short and factual — it is read at a
 * glance in a busy group, alongside the photo it describes.
 */
export function slipCaption(slip, tutorName) {
  const m = slip.meta || {};
  const bits = [];

  bits.push(`Lesson slip — ${m.tutor || tutorName || 'Genius tutor'}`);

  const when = [longDate(slip.date)];
  if (m.timeFrom && m.timeTo) when.push(`${m.timeFrom}–${m.timeTo}`);
  else if (m.hours) when.push(`${m.hours}h`);
  bits.push(when.filter(Boolean).join('  ·  '));

  const who = [m.student, m.subject].filter(Boolean).join(' · ');
  if (who) bits.push(who);

  return bits.join('\n');
}

/** Turn a data URL into a File that WhatsApp will treat as a photo. */
export async function dataUrlToFile(dataUrl, basename) {
  const blob = await (await fetch(dataUrl)).blob();
  const type = blob.type || 'image/jpeg';
  // The extension is derived from the real type, so the file WhatsApp receives
  // is not, say, a PNG called .jpg.
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `${basename}.${ext}`, { type });
}

const safeName = (s) => (s || 'slip').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Can this browser share an actual image file, or only save it? */
export function canShareFiles(file) {
  return !!(navigator.canShare && navigator.canShare({ files: [file] }));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Share one slip. Returns a short status string for the UI to show.
 *
 * MUST be called directly from a click handler: browsers only allow share()
 * and clipboard writes inside a user gesture, and anything awaited beforehand
 * spends it.
 */
export async function shareSlip(slip, tutorName) {
  const caption = slipCaption(slip, tutorName);
  const file = await dataUrlToFile(
    slip.image,
    `Lesson slip ${slip.date} ${safeName((slip.meta || {}).student)}`
  );

  if (canShareFiles(file)) {
    copy(caption);                       // fired, not awaited — see the note above
    try {
      await navigator.share({ files: [file], text: caption, title: 'Lesson slip' });
      return 'Shared — paste the caption in WhatsApp ✓';
    } catch (err) {
      if (err && err.name === 'AbortError') return '';
      console.error(err);
      return 'Sharing was cancelled or is unavailable — the photo can still be saved.';
    }
  }

  // No file sharing (most desktop browsers): save the image and copy the
  // caption, so the tutor can drop both into WhatsApp Web.
  copy(caption);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);          // Safari ignores detached anchors
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'Photo saved and caption copied — attach it in WhatsApp ✓';
}

/** Copy just the caption, for the "Copy caption" button. */
export async function copyCaption(slip, tutorName) {
  const ok = await copy(slipCaption(slip, tutorName));
  return ok ? 'Caption copied ✓' : 'Could not copy — select the text instead';
}

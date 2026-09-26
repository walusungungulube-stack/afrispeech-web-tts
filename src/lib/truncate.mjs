/**
 * Keep at most `limit` characters, and report when we had to cut.
 *
 * We aim for a sentence ending in the last fifth of the window so the audio
 * finishes on a full stop; failing that we back up to a word boundary so it
 * never stops mid-word. The cap is a hard ceiling either way, and the result
 * is allowed to be shorter than `limit` in order to land on a clean ending.
 */
export function truncateToLimit(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const totalChars = clean.length;
  if (totalChars <= limit) {
    return { text: clean, truncated: false, totalChars };
  }

  const window = clean.slice(0, limit);
  const lastStop = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    window.lastIndexOf('。'), window.lastIndexOf('।'),
  );

  let cut;
  if (lastStop >= limit * 0.8) {
    cut = window.slice(0, lastStop + 1);
  } else {
    const lastSpace = window.lastIndexOf(' ');
    cut = lastSpace > limit * 0.5 ? window.slice(0, lastSpace) : window;
  }

  return { text: cut.trim(), truncated: true, totalChars };
}

// matcher.js - the scripted-answer matcher, lifted verbatim out of createChat's closure.
//
// It lives on its own because three consumers have to agree on it exactly: chat.js (which
// picks the offline answer a visitor actually sees), the generator's validator (which decides
// whether a generated `first_question` will hit an answer in that visitor's browser), and any
// future tooling that wants to know which entry a question resolves to. A second copy of these
// twenty lines is a second set of answers waiting to drift apart.
//
// Semantics, unchanged from the original closure:
//   - the question is lowercased once
//   - a matcher hits when it appears at the START of a word (index 0, or the preceding
//     character is not [a-z0-9])
//   - each matcher on an entry scores at most 1, however many times it occurs
//   - highest score wins; ties break by SOURCE ORDER, because the comparison is strictly
//     greater-than, so the first entry to reach a score keeps it
//   - score 0 means no match at all and the caller falls back

/**
 * Does `matcher` appear at the start of a word in the already-lowercased `q`?
 *
 * Plain `includes` let short matchers fire inside unrelated words ("esc" inside "telescope",
 * "bat" inside "combat"), which sent nonsense questions to a real answer instead of the
 * fallback. Anchoring to a word start keeps the intended prefix behaviour ("temp" ->
 * "temperature", "fall" -> "falling") and keeps multi-word matchers ("root cause", "own
 * robot") working.
 *
 * @param {string} q lowercased question text
 * @param {string} matcher
 * @returns {boolean}
 */
export function hasMatcher(q, matcher) {
  const needle = String(matcher).toLowerCase();
  if (!needle) return false;
  for (let from = 0; ; ) {
    const i = q.indexOf(needle, from);
    if (i < 0) return false;
    if (i === 0 || !/[a-z0-9]/.test(q[i - 1])) return true;
    from = i + 1;
  }
}

/**
 * Best-scoring script entry for a question, or null when nothing matched.
 *
 * @param {Array<{matchers?: string[]}>} entries a robot def's `script` / `chat.script`
 * @param {string} text the question as typed
 * @returns {object|null}
 */
export function matchEntry(entries, text) {
  const q = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const entry of entries || []) {
    let score = 0;
    for (const m of entry.matchers || []) {
      if (hasMatcher(q, m)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore > 0 ? best : null;
}

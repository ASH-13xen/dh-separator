const DEVANAGARI_RE = /[ऀ-ॿ]/;
const LATIN_LETTER_RE = /[a-zA-Z]/g;

function countLatinLetters(str) {
  return (str.match(LATIN_LETTER_RE) || []).length;
}

// Strips Hindi (Devanagari-script) text from a bilingual UPSC question, keeping only the
// English portion. Bilingual questions in this dataset show up in two layouts, never
// interleaved mid-sentence:
//   - Hindi-first:  "<Hindi wording, often with a Hindi marks annotation like (10 अंक)>
//                     <English wording>" (either on separate lines, or run together)
//   - English-first: "<English wording> <Hindi translation of the same question>"
//     (e.g. "...Elaborate. भारतीय संविधान में...")
// This detects which side the (single, contiguous) Devanagari block sits on by comparing how
// much real English text surrounds it, and keeps only the English side — trimming
// punctuation/whitespace stranded at the cut (a bare ")" closing a Hindi marks annotation, a
// "?" from a Hindi question ending, or a stray opening quote/bracket that was introducing the
// now-removed Hindi text). If Hindi doesn't cleanly cluster on one side (a small enough amount
// of English on both sides of it to be ambiguous), the text is returned completely unchanged
// so the caller can flag it for manual review instead of guessing.
export function stripHindiText(text) {
  if (!text || typeof text !== 'string') return text;
  if (!DEVANAGARI_RE.test(text)) return text;

  let firstHindiIdx = -1;
  let lastHindiIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (DEVANAGARI_RE.test(text[i])) {
      if (firstHindiIdx === -1) firstHindiIdx = i;
      lastHindiIdx = i;
    }
  }

  const englishBefore = countLatinLetters(text.slice(0, firstHindiIdx));
  const englishAfter = countLatinLetters(text.slice(lastHindiIdx + 1));

  if (englishAfter >= 15 && englishBefore < 5) {
    // Hindi-first layout: keep everything after the last Devanagari character.
    return text.slice(lastHindiIdx + 1).replace(/^[\s?.!)\]]+/, '').trim();
  }

  if (englishBefore >= 15 && englishAfter < 5) {
    // English-first layout: keep everything before the first Devanagari character.
    return text.slice(0, firstHindiIdx).replace(/[\s"'(\[]+$/, '').trim();
  }

  // Ambiguous — leave untouched rather than risk mangling real content.
  return text;
}

// True if `text` still looks like a real English question (used to decide whether a
// Hindi-stripping result is safe to keep). Guards against silently emptying out a record that
// doesn't follow the expected Hindi-then-English layout — those should be left untouched and
// flagged for manual review instead of losing their content.
export function looksLikeEnglishQuestion(text) {
  if (!text) return false;
  const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
  return letterCount >= 15;
}

export function containsHindi(text) {
  return !!text && DEVANAGARI_RE.test(text);
}

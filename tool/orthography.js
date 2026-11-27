// The spelling of the UCLA word lists, read as phonemes and vowel marks.
//
// A port of `_units`, `phonemes_of` and `vowel_marks_of` in
// tools/phonemes/corpus.py, which is the reference: both are checked against
// tools/phonemes/tests/orthography_vectors.tsv. Nothing here decides what a
// mark means; see corpus.py for how the acute accent is read.

const VOWELS = "aio";
const PHONEMES = "ptkʔbgsh" + VOWELS;
// Other spellings of the same phonemes: Everett's x and a question mark for
// the glottal stop, the bilabial trill of /b/, and the lists' asterisk for a
// variant of /g/.
const SAME_PHONEME = { x: "ʔ", "?": "ʔ", ʙ: "b", "*": "g" };
const ACUTE = "́";
// Characters that combine with the one before. Python's reference asks for a
// non-zero combining class; for the marks of these lists the two agree.
const COMBINING = /^\p{M}$/u;
const SPACE = /^\s$/u;

/**
 * A written form as [phoneme, marks] units, or null if it has other letters.
 * `marks` has one character per written letter of the unit: "H" for an acute
 * accent, "L" for no mark, "?" for any other mark. A doubled letter is one
 * unit, so "áa" gives ["a", "HL"]. A word break is the unit [" ", ""].
 */
export function units(text) {
  const found = [];
  for (const char of text.normalize("NFD")) {
    const last = found[found.length - 1];
    if (COMBINING.test(char)) {
      if (last && VOWELS.includes(last[0])) {
        const mark = char === ACUTE ? "H" : "?";
        const before = last[1][last[1].length - 1];
        last[1] = last[1].slice(0, -1) + (before === "L" || before === mark ? mark : "?");
      }
      continue;
    }
    if (char === "-") continue;
    const letter = SAME_PHONEME[char] ?? char.toLowerCase();
    if (SPACE.test(letter)) {
      if (last && last[0] !== " ") found.push([" ", ""]);
    } else if (letter.length === 1 && PHONEMES.includes(letter)) {
      if (last && last[0] === letter) last[1] += "L";
      else found.push([letter, "L"]);
    } else {
      return null;
    }
  }
  while (found.length > 0 && found[0][0] === " ") found.shift();
  while (found.length > 0 && found[found.length - 1][0] === " ") found.pop();
  return found.length > 0 ? found : null;
}

/** The phoneme string of a written form (spaces kept as word breaks), or null. */
export function phonemesOf(text) {
  const found = units(text);
  return found ? found.map(([phoneme]) => phoneme).join("") : null;
}

/** The marks of each vowel of `phonemesOf(text)`, in order, or null. */
export function vowelMarksOf(text) {
  const found = units(text);
  return found ? found.filter(([phoneme]) => VOWELS.includes(phoneme)).map(([, marks]) => marks) : null;
}

// A Praat TextGrid of an annotation document and, with a phoneme model, of
// the model's candidates. Long text format, UTF-8, Unix line ends.
//
// Tiers, found by name by tools/phonemes/human.py:
//   transcription, translation, note      what the person typed (interval tiers, same boundaries)
//   source                                "candidate" where the text was copied from a word candidate
//   word candidates, candidate gloss, verdict   the candidates given, with the person's verdicts
//   phoneme candidates                    a point tier, one point per candidate
// The last four exist only when candidates are given.

import { verdictOf } from "./annotations.js";

const number = (seconds) => seconds.toFixed(6);
const quoted = (text) => `"${String(text).replaceAll('"', '""').replace(/\s+/g, " ")}"`;

/**
 * Praat wants an interval tier to cover the whole duration without a gap:
 * `spans` ([start, end, text], in order, not overlapping) with empty
 * intervals in between. Two intervals that meet share one boundary.
 */
function tiled(spans, duration) {
  const out = [];
  let at = 0;
  for (const [start, end, text] of spans) {
    const from = Math.max(at, Math.min(start, duration));
    const to = Math.min(end, duration);
    if (to <= from) continue;
    if (from > at) out.push([at, from, ""]);
    out.push([from, to, text]);
    at = to;
  }
  if (at < duration || out.length === 0) out.push([at, duration, ""]);
  return out;
}

function intervalTier(name, spans, duration) {
  const intervals = tiled(spans, duration);
  const lines = [
    '        class = "IntervalTier"',
    `        name = ${quoted(name)}`,
    "        xmin = 0",
    `        xmax = ${number(duration)}`,
    `        intervals: size = ${intervals.length}`,
  ];
  intervals.forEach(([start, end, text], index) => {
    lines.push(
      `        intervals [${index + 1}]:`,
      `            xmin = ${number(start)}`,
      `            xmax = ${number(end)}`,
      `            text = ${quoted(text)}`,
    );
  });
  return lines;
}

function pointTier(name, points, duration) {
  const inside = points.filter(([time]) => time >= 0 && time <= duration);
  const lines = [
    '        class = "TextTier"',
    `        name = ${quoted(name)}`,
    "        xmin = 0",
    `        xmax = ${number(duration)}`,
    `        points: size = ${inside.length}`,
  ];
  inside.forEach(([time, mark], index) => {
    lines.push(`        points [${index + 1}]:`, `            number = ${number(time)}`, `            mark = ${quoted(mark)}`);
  });
  return lines;
}

/**
 * `words` are the word candidates to export ({ start, end, phonemes, gloss,
 * fit }, in order) and `letters` the phoneme candidates ({ time, phoneme });
 * both null without a model.
 */
export function textGrid(doc, { words = null, letters = null } = {}) {
  const duration = doc.recording.duration_s;
  const tiers = [
    intervalTier("transcription", doc.intervals.map((i) => [i.start_s, i.end_s, i.text]), duration),
    intervalTier("translation", doc.intervals.map((i) => [i.start_s, i.end_s, i.translation]), duration),
    intervalTier("note", doc.intervals.map((i) => [i.start_s, i.end_s, i.note]), duration),
    intervalTier("source", doc.intervals.map((i) => [i.start_s, i.end_s, i.from_candidate ? "candidate" : ""]), duration),
  ];
  if (words) {
    const verdict = (word) => verdictOf(doc, { start_s: word.start, end_s: word.end, phonemes: word.phonemes }) ?? "";
    tiers.push(
      intervalTier("word candidates", words.map((w) => [w.start, w.end, w.phonemes]), duration),
      intervalTier("candidate gloss", words.map((w) => [w.start, w.end, w.gloss]), duration),
      intervalTier("verdict", words.map((w) => [w.start, w.end, verdict(w)]), duration),
    );
  }
  if (letters) tiers.push(pointTier("phoneme candidates", letters.map((l) => [l.time, l.phoneme]), duration));
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    `xmax = ${number(duration)}`,
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
  ];
  tiers.forEach((tier, index) => lines.push(`    item [${index + 1}]:`, ...tier));
  return `${lines.join("\n")}\n`;
}

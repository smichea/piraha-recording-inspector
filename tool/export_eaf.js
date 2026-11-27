// An ELAN annotation file (EAF 3.0) of an annotation document and, with a
// phoneme model, of the model's candidates.
//
// Tiers as in export_textgrid.js. `transcription`, `word candidates` and
// `phoneme candidates` are aligned with time; `translation`, `note` and
// `source` hang on `transcription`, `candidate gloss` and `verdict` on `word candidates`.
// ELAN has no point tier: a phoneme candidate is the 20 ms around its time.
// Times are whole milliseconds.

import { verdictOf } from "./annotations.js";

const escaped = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replace(/\s+/g, " ");

/**
 * `date` is written as the document's date (an ISO 8601 time with its
 * offset, such as 2026-11-27T12:00:00+00:00). `words` and `letters` as in
 * `textGrid`.
 */
export function eaf(doc, { words = null, letters = null, date }) {
  const durationMs = Math.round(doc.recording.duration_s * 1000);
  const slots = [];
  let annotations = 0;
  const slot = (ms) => {
    slots.push(ms);
    return `ts${slots.length}`;
  };
  const nextId = () => `a${++annotations}`;

  // Spans in whole milliseconds, each at least 1 ms long and not before the end of the one before.
  function aligned(tierId, spans, children) {
    const lines = [`    <TIER LINGUISTIC_TYPE_REF="default-lt" TIER_ID="${escaped(tierId)}">`];
    const ids = [];
    let at = 0;
    for (const [start, end, text] of spans) {
      const from = Math.min(Math.max(at, Math.round(start * 1000)), Math.max(0, durationMs - 1));
      const to = Math.min(Math.max(from + 1, Math.round(end * 1000)), Math.max(durationMs, from + 1));
      const id = nextId();
      ids.push(id);
      lines.push(
        "        <ANNOTATION>",
        `            <ALIGNABLE_ANNOTATION ANNOTATION_ID="${id}" TIME_SLOT_REF1="${slot(from)}" TIME_SLOT_REF2="${slot(to)}">`,
        `                <ANNOTATION_VALUE>${escaped(text)}</ANNOTATION_VALUE>`,
        "            </ALIGNABLE_ANNOTATION>",
        "        </ANNOTATION>",
      );
      at = to;
    }
    lines.push("    </TIER>");
    for (const [childId, texts] of children) {
      lines.push(`    <TIER LINGUISTIC_TYPE_REF="association-lt" PARENT_REF="${escaped(tierId)}" TIER_ID="${escaped(childId)}">`);
      texts.forEach((text, index) => {
        lines.push(
          "        <ANNOTATION>",
          `            <REF_ANNOTATION ANNOTATION_ID="${nextId()}" ANNOTATION_REF="${ids[index]}">`,
          `                <ANNOTATION_VALUE>${escaped(text)}</ANNOTATION_VALUE>`,
          "            </REF_ANNOTATION>",
          "        </ANNOTATION>",
        );
      });
      lines.push("    </TIER>");
    }
    return lines;
  }

  const tiers = aligned("transcription", doc.intervals.map((i) => [i.start_s, i.end_s, i.text]), [
    ["translation", doc.intervals.map((i) => i.translation)],
    ["note", doc.intervals.map((i) => i.note)],
    ["source", doc.intervals.map((i) => (i.from_candidate ? "candidate" : ""))],
  ]);
  if (words) {
    const verdict = (word) => verdictOf(doc, { start_s: word.start, end_s: word.end, phonemes: word.phonemes }) ?? "";
    tiers.push(
      ...aligned("word candidates", words.map((w) => [w.start, w.end, w.phonemes]), [
        ["candidate gloss", words.map((w) => w.gloss)],
        ["verdict", words.map(verdict)],
      ]),
    );
  }
  if (letters) tiers.push(...aligned("phoneme candidates", letters.map((l) => [l.time - 0.01, l.time + 0.01, l.phoneme]), []));

  const media = `./${escaped(doc.recording.filename || "recording.wav")}`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ANNOTATION_DOCUMENT AUTHOR="" DATE="${escaped(date)}" FORMAT="3.0" VERSION="3.0" ` +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">',
    '    <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">',
    `        <MEDIA_DESCRIPTOR MEDIA_URL="${media}" MIME_TYPE="audio/x-wav" RELATIVE_MEDIA_URL="${media}"/>`,
    `        <PROPERTY NAME="lastUsedAnnotationId">${annotations}</PROPERTY>`,
    "    </HEADER>",
    "    <TIME_ORDER>",
    ...slots.map((ms, index) => `        <TIME_SLOT TIME_SLOT_ID="ts${index + 1}" TIME_VALUE="${ms}"/>`),
    "    </TIME_ORDER>",
    ...tiers,
    '    <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="default-lt" TIME_ALIGNABLE="true"/>',
    '    <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="association-lt" TIME_ALIGNABLE="false"/>',
    '    <CONSTRAINT DESCRIPTION="1-1 association with a parent annotation" STEREOTYPE="Symbolic_Association"/>',
    "</ANNOTATION_DOCUMENT>",
  ];
  return `${lines.join("\n")}\n`;
}

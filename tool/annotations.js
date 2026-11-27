// The annotation document: what a person marks and types about one recording.
//
// It holds transcribed stretches ("intervals") and verdicts on the model's
// word candidates. It lives in the page's memory and is kept only by saving
// it as a file; nothing here touches the page, the network or any storage.
//
// Functions change the document they are given and throw an Error whose
// message can be shown as it is.

export const FORMAT = "recording-inspector-annotations/1";
export const VERDICTS = ["right", "wrong", "unsure"];
/** The shortest stretch that can be transcribed, in seconds. */
export const SHORTEST_S = 0.02;

const rounded = (seconds) => Math.round(seconds * 1e4) / 1e4;
const text = (value) => String(value ?? "").normalize("NFC").trim();

/** A new, empty document for the recording of a summary. `modelSha` is null without a phoneme model. */
export function create(summary, modelSha = null) {
  const { wav } = summary;
  return {
    format: FORMAT,
    recording: {
      sha256: summary.sha256,
      filename: summary.filename ?? "",
      duration_s: wav.sample_frames / wav.sample_rate,
      sample_rate: wav.sample_rate,
      channels: wav.channels,
    },
    tool: { name: summary.tool.name, version: summary.tool.version },
    model: modelSha ? { sha256: modelSha } : null,
    intervals: [],
    verdicts: [],
  };
}

function checked(doc, fields, except = -1) {
  const start = rounded(Number(fields.start_s));
  const end = rounded(Number(fields.end_s));
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("A stretch needs a start and an end in seconds.");
  if (start < 0 || end > rounded(doc.recording.duration_s) + 1e-9) throw new Error("The stretch must lie inside the recording.");
  if (end - start < SHORTEST_S - 1e-9) throw new Error("The stretch must be at least 0.02 s long.");
  const words = text(fields.text);
  if (words === "") throw new Error("The transcription is empty.");
  doc.intervals.forEach((other, index) => {
    if (index !== except && start < other.end_s - 1e-9 && other.start_s < end - 1e-9) {
      throw new Error(`The stretch overlaps the one from ${other.start_s.toFixed(2)} to ${other.end_s.toFixed(2)} s.`);
    }
  });
  return {
    start_s: start,
    end_s: end,
    text: words,
    translation: text(fields.translation),
    note: text(fields.note),
    from_candidate: Boolean(fields.from_candidate),
  };
}

const sort = (doc) => doc.intervals.sort((a, b) => a.start_s - b.start_s);

/** Add a transcribed stretch. Returns it. */
export function addInterval(doc, fields) {
  const interval = checked(doc, fields);
  doc.intervals.push(interval);
  sort(doc);
  return interval;
}

/** Change the stretch at `index`; fields left out keep their value. Returns the changed stretch. */
export function updateInterval(doc, index, fields) {
  if (!doc.intervals[index]) throw new Error("There is no such stretch.");
  const interval = checked(doc, { ...doc.intervals[index], ...fields }, index);
  doc.intervals[index] = interval;
  sort(doc);
  return interval;
}

export function removeInterval(doc, index) {
  if (!doc.intervals[index]) throw new Error("There is no such stretch.");
  doc.intervals.splice(index, 1);
}

const same = (verdict, candidate) =>
  verdict.start_s === rounded(candidate.start_s) && verdict.end_s === rounded(candidate.end_s) && verdict.phonemes === candidate.phonemes;

/** The verdict given on a word candidate ({ start_s, end_s, phonemes }), or null. */
export function verdictOf(doc, candidate) {
  return doc.verdicts.find((verdict) => same(verdict, candidate))?.verdict ?? null;
}

/** Give, change or (with null) withdraw the verdict on a word candidate ({ start_s, end_s, phonemes, fit }). */
export function setVerdict(doc, candidate, verdict) {
  if (verdict !== null && !VERDICTS.includes(verdict)) throw new Error("A verdict is right, wrong or unsure.");
  doc.verdicts = doc.verdicts.filter((other) => !same(other, candidate));
  if (verdict !== null) {
    doc.verdicts.push({
      start_s: rounded(candidate.start_s),
      end_s: rounded(candidate.end_s),
      phonemes: candidate.phonemes,
      fit: Number(candidate.fit),
      verdict,
    });
    doc.verdicts.sort((a, b) => a.start_s - b.start_s || a.end_s - b.end_s);
  }
}

/** The verdicts that belong to none of the given candidates: given for the candidates of another model. */
export function strayVerdicts(doc, candidates) {
  return doc.verdicts.filter((verdict) => !candidates.some((candidate) => same(verdict, candidate)));
}

/** The document as the text of an annotation file. The same document always gives the same text. */
export function serialise(doc) {
  const ordered = {
    format: doc.format,
    recording: {
      sha256: doc.recording.sha256,
      filename: doc.recording.filename,
      duration_s: doc.recording.duration_s,
      sample_rate: doc.recording.sample_rate,
      channels: doc.recording.channels,
    },
    tool: { name: doc.tool.name, version: doc.tool.version },
    model: doc.model ? { sha256: doc.model.sha256 } : null,
    intervals: doc.intervals.map((i) => ({
      start_s: i.start_s, end_s: i.end_s, text: i.text, translation: i.translation, note: i.note, from_candidate: i.from_candidate,
    })),
    verdicts: doc.verdicts.map((v) => ({ start_s: v.start_s, end_s: v.end_s, phonemes: v.phonemes, fit: v.fit, verdict: v.verdict })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Read an annotation file for the recording of `summary`. Refuses another
 * format, another recording, and a file that breaks the document's rules.
 */
export function parse(fileText, summary) {
  let read;
  try {
    read = JSON.parse(fileText);
  } catch {
    throw new Error("This is not an annotation file of the recording inspector.");
  }
  if (read === null || typeof read !== "object" || typeof read.format !== "string" || !read.format.startsWith("recording-inspector-annotations/")) {
    throw new Error("This is not an annotation file of the recording inspector.");
  }
  if (read.format !== FORMAT) throw new Error(`This annotation file has the format ${read.format}; this page reads ${FORMAT}.`);
  if (read.recording?.sha256 !== summary.sha256) throw new Error("These annotations are of another recording.");
  const doc = create(summary, typeof read.model?.sha256 === "string" ? read.model.sha256 : null);
  if (!Array.isArray(read.intervals) || !Array.isArray(read.verdicts)) throw new Error("The annotation file is incomplete.");
  for (const interval of read.intervals) addInterval(doc, interval);
  for (const verdict of read.verdicts) setVerdict(doc, verdict, verdict.verdict);
  return doc;
}

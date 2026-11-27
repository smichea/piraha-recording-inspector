// The annotation view: what a person marks and types about the recording.
//
// A lane of transcribed stretches in the detail view, the selection of a
// stretch, an editor, verdicts on the model's word candidates, and the files
// that keep this work: the page stores nothing itself (see annotations.js).

import * as annotations from "./annotations.js";
import { drawIntervals } from "./detail.js";
import { clock } from "./draw.js";
import { eaf } from "./export_eaf.js";
import { textGrid } from "./export_textgrid.js";
import { phonemesOf, vowelMarksOf } from "./orthography.js";

const $ = (id) => document.getElementById(id);
const ACUTE = "́";
const SIGNS = { right: "✓", wrong: "✗", unsure: "?" };
const NAMES = { right: "Right", wrong: "Wrong", unsure: "Unsure" };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * `detail` is the detail view (phonemes.js), `playSpan(from, to)` plays a
 * stretch, `download(name, text)` hands a file to the browser.
 */
export function createAnnotationView({ player, detail, playSpan, download }) {
  const plots = $("detail");
  const state = {
    summary: null,
    modelSha: null,
    doc: null,
    saved: "", // the document's text when it was last saved or opened
    selection: null, // { start, end } in seconds
    drag: null, // the time where a selection being dragged began
    dragged: false, // a drag just ended: the click that follows it is not a click
    chosen: -1, // the stretch chosen in the lane
    editing: null, // null, "new", or the index of the stretch in the editor
    boxes: [],
  };

  const unsaved = () => state.doc !== null && annotations.serialise(state.doc) !== state.saved;
  const stem = () => (state.summary.filename || "recording").replace(/\.[^.]+$/, "");
  const candidate = (word) => ({ start_s: word.start, end_s: word.end, phonemes: word.phonemes, fit: word.fit });

  function message(text) {
    $("annotation-message").textContent = text ?? "";
    $("annotation-message").hidden = !text;
  }

  /** Run a change of the document; a refusal is shown, not thrown. Returns whether it went through. */
  function change(action) {
    try {
      action();
    } catch (error) {
      message(error.message);
      return false;
    }
    message(null);
    refresh();
    return true;
  }

  // -------------------------------------------------------- the recording

  function show(data) {
    state.summary = data.summary;
    state.doc = annotations.create(data.summary, state.modelSha);
    state.saved = annotations.serialise(state.doc);
    state.selection = null;
    state.chosen = -1;
    closeEditor();
    message(null);
    refresh();
  }

  // ------------------------------------------------------ what is on screen

  function refresh() {
    const { doc } = state;
    $("unsaved").hidden = !unsaved();
    const rows = $("interval-rows");
    rows.replaceChildren();
    doc.intervals.forEach((interval, index) => {
      const row = element("tr");
      const play = element("button", `▶ ${clock(interval.start_s, 0.01)}`);
      play.type = "button";
      play.setAttribute("aria-label", `Play the stretch at ${clock(interval.start_s, 0.01)}`);
      play.addEventListener("click", () => choose(index));
      const edit = element("button", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => openEditor(index));
      const cells = [element("td"), element("td", interval.text, "phoneme-text"), element("td", reading(interval.text)), element("td", interval.translation), element("td")];
      cells[0].append(play);
      cells[4].append(edit);
      row.append(...cells);
      rows.append(row);
    });
    $("interval-table").hidden = doc.intervals.length === 0;
    const { selection } = state;
    $("add-interval").disabled = selection === null;
    $("selection-text").textContent = selection
      ? `Selected: ${clock(selection.start, 0.01)} to ${clock(selection.end, 0.01)}.`
      : "Hold Shift and drag over the plots to select a stretch.";
    reviewed();
    detail.render();
  }

  function reading(text) {
    const phonemes = phonemesOf(text);
    if (phonemes === null) return "not readable as Pirahã phonemes";
    return `${phonemes} · marks ${vowelMarksOf(text).join(" ") || "none"}`;
  }

  /** Drawn with the detail view, in its window. */
  function draw(window, colors) {
    if (!state.doc) return;
    state.window = window;
    state.boxes = drawIntervals($("detail-transcription"), { intervals: state.doc.intervals, chosen: state.chosen, ...window }, colors);
    const overlay = $("selection");
    const { selection } = state;
    overlay.hidden = selection === null || selection.end <= window.start || selection.start >= window.start + window.span;
    if (!overlay.hidden) {
      const left = Math.max(0, (selection.start - window.start) / window.span);
      const right = Math.min(1, (selection.end - window.start) / window.span);
      overlay.style.left = `${100 * left}%`;
      overlay.style.width = `${100 * (right - left)}%`;
    }
    plots.dataset.intervals = String(state.doc.intervals.length);
  }

  // ------------------------------------------------------------ selection

  function select(start, end) {
    const duration = state.doc.recording.duration_s;
    const from = Math.max(0, Math.min(start, end));
    const to = Math.min(duration, Math.max(start, end));
    state.selection = to - from >= annotations.SHORTEST_S ? { start: from, end: to } : null;
    refresh();
  }

  plots.addEventListener("pointerdown", (event) => {
    if (!state.doc || !event.shiftKey || event.button !== 0) return;
    state.drag = detail.timeAt(event);
    plots.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  plots.addEventListener("pointermove", (event) => {
    if (state.drag !== null) select(state.drag, detail.timeAt(event));
  });
  plots.addEventListener("pointerup", (event) => {
    if (state.drag === null) return;
    select(state.drag, detail.timeAt(event));
    state.drag = null;
    state.dragged = true;
    setTimeout(() => (state.dragged = false), 0);
  });

  /** A click in the detail view. True when it was this view's: the end of a drag, or on a transcribed stretch. */
  function click(event) {
    if (state.dragged || event.shiftKey) return true;
    const lane = $("detail-transcription").getBoundingClientRect();
    if (event.clientY < lane.top || event.clientY > lane.bottom) return false;
    const x = event.clientX - lane.left;
    const box = state.boxes.find(({ left, right }) => x >= left && x <= right);
    if (!box) return false;
    choose(box.index);
    return true;
  }

  function choose(index) {
    const interval = state.doc.intervals[index];
    state.chosen = index;
    state.selection = { start: interval.start_s, end: interval.end_s };
    playSpan(interval.start_s, interval.end_s);
    refresh();
  }

  // --------------------------------------------------------------- editor

  function openEditor(index) {
    const fresh = index === "new";
    if (fresh && state.selection === null) return;
    const interval = fresh ? { start_s: state.selection.start, end_s: state.selection.end, text: "", translation: "", note: "" } : state.doc.intervals[index];
    state.editing = index;
    $("interval-start").value = interval.start_s.toFixed(2);
    $("interval-end").value = interval.end_s.toFixed(2);
    $("interval-text").value = interval.text;
    $("interval-translation").value = interval.translation;
    $("interval-note").value = interval.note;
    $("interval-delete").hidden = fresh;
    $("interval-editor").hidden = false;
    showReading();
    $("interval-text").focus();
  }

  function closeEditor() {
    state.editing = null;
    $("interval-editor").hidden = true;
  }

  function showReading() {
    const text = $("interval-text").value;
    $("interval-reading").textContent = text.trim() === "" ? "" : `Read as: ${reading(text)}`;
  }

  function insert(text) {
    const field = $("interval-text");
    const at = field.selectionStart ?? field.value.length;
    field.value = (field.value.slice(0, at) + text + field.value.slice(field.selectionEnd ?? at)).normalize("NFC");
    const caret = Math.min(field.value.length, at + (text === ACUTE ? 0 : text.length));
    field.setSelectionRange(caret, caret);
    field.focus();
    showReading();
  }

  $("interval-text").addEventListener("input", showReading);
  $("insert-glottal").addEventListener("click", () => insert("ʔ"));
  $("insert-acute").addEventListener("click", () => insert(ACUTE));
  $("add-interval").addEventListener("click", () => openEditor("new"));
  $("interval-cancel").addEventListener("click", closeEditor);
  $("interval-delete").addEventListener("click", () => {
    const index = state.editing;
    if (change(() => annotations.removeInterval(state.doc, index))) {
      state.chosen = -1;
      closeEditor();
    }
  });
  $("interval-editor").addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = {
      start_s: Number($("interval-start").value),
      end_s: Number($("interval-end").value),
      text: $("interval-text").value,
      translation: $("interval-translation").value,
      note: $("interval-note").value,
    };
    const fresh = state.editing === "new";
    let kept;
    const done = change(() => {
      kept = fresh ? annotations.addInterval(state.doc, { ...fields, from_candidate: false }) : annotations.updateInterval(state.doc, state.editing, fields);
    });
    if (!done) return;
    state.chosen = state.doc.intervals.indexOf(kept);
    state.selection = { start: kept.start_s, end: kept.end_s };
    closeEditor();
    refresh();
    plots.focus();
  });
  $("interval-editor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEditor();
  });

  // ------------------------------------------------------------- verdicts

  const verdictOf = (word) => annotations.verdictOf(state.doc, candidate(word));

  function setVerdict(word, verdict) {
    // The same verdict again withdraws it.
    change(() => annotations.setVerdict(state.doc, candidate(word), verdictOf(word) === verdict ? null : verdict));
    detail.filter();
  }

  /** The cell of a word candidate's row: three buttons and, once it is judged right, a way to transcribe it. */
  function verdictCell(word) {
    const cell = element("td", undefined, "verdict");
    const given = state.doc ? verdictOf(word) : null;
    for (const verdict of annotations.VERDICTS) {
      const button = element("button", SIGNS[verdict]);
      button.type = "button";
      button.dataset.verdict = verdict;
      button.setAttribute("aria-label", `${NAMES[verdict]}: ${word.phonemes} at ${clock(word.start, 0.01)}`);
      button.setAttribute("aria-pressed", String(given === verdict));
      button.addEventListener("click", () => setVerdict(word, verdict));
      cell.append(button);
    }
    if (given === "right") {
      const copy = element("button", "→ transcription");
      copy.type = "button";
      copy.setAttribute("aria-label", `Copy ${word.phonemes} to the transcription`);
      copy.addEventListener("click", () => {
        change(() => annotations.addInterval(state.doc, {
          start_s: Math.max(0, word.start - 0.04),
          end_s: Math.min(state.doc.recording.duration_s, word.end + 0.06),
          text: word.phonemes,
          from_candidate: true,
        }));
      });
      cell.append(copy);
    }
    return cell;
  }

  function reviewed() {
    if (!state.doc) return;
    const { words } = detail.candidates();
    if (words === null) return;
    const counts = { right: 0, wrong: 0, unsure: 0 };
    for (const word of words) {
      const verdict = verdictOf(word);
      if (verdict) counts[verdict] += 1;
    }
    const total = counts.right + counts.wrong + counts.unsure;
    const stray = annotations.strayVerdicts(state.doc, words.map(candidate)).length;
    $("review-count").textContent =
      (total === 0 ? "" : `${total} of ${words.length} reviewed: ${counts.right} right, ${counts.wrong} wrong, ${counts.unsure} unsure.`) +
      (stray === 0 ? "" : ` ${stray} verdict${stray > 1 ? "s" : ""} on candidates not shown here (another fit or another model).`);
  }

  // ----------------------------------------------------------------- keys

  /** A key pressed in the detail view. True when it was this view's. */
  function key(event) {
    if (!state.doc || event.ctrlKey || event.metaKey || event.altKey) return false;
    const word = detail.active();
    const verdict = { y: "right", n: "wrong", u: "unsure" }[event.key];
    if (verdict && word) setVerdict(word, verdict);
    else if (event.key === "[") select(player.currentTime, state.selection?.end ?? state.doc.recording.duration_s);
    else if (event.key === "]") select(state.selection?.start ?? 0, player.currentTime);
    else if (event.key === "t" && state.selection) openEditor("new");
    else if (event.key === "Enter" && state.chosen >= 0) openEditor(state.chosen);
    else if (event.key === "Delete" && state.chosen >= 0) {
      const index = state.chosen;
      state.chosen = -1;
      change(() => annotations.removeInterval(state.doc, index));
    } else if (event.key === "l") {
      $("loop").checked = !$("loop").checked;
    } else return false;
    return true;
  }

  // ---------------------------------------------------------------- files

  function exports() {
    const given = detail.candidates();
    return {
      json: annotations.serialise(state.doc),
      textgrid: textGrid(state.doc, given),
      eaf: eaf(state.doc, { ...given, date: new Date().toISOString().replace(/\.\d+Z$/, "+00:00") }),
    };
  }

  $("save-annotations").addEventListener("click", () => {
    const text = annotations.serialise(state.doc);
    download(`${stem()}.annotations.json`, text);
    state.saved = text;
    refresh();
  });
  $("export-textgrid").addEventListener("click", () => download(`${stem()}.TextGrid`, exports().textgrid));
  $("export-eaf").addEventListener("click", () => download(`${stem()}.eaf`, exports().eaf));
  $("open-annotations").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file || !state.doc) return;
    if (unsaved() && !confirm("Opening a file replaces your unsaved annotations. Open it?")) return;
    const text = await file.text();
    let opened;
    if (!change(() => (opened = annotations.parse(text, state.summary)))) return;
    state.doc = opened;
    state.saved = annotations.serialise(opened);
    state.selection = null;
    state.chosen = -1;
    closeEditor();
    detail.filter();
    refresh();
  });

  $("rate").addEventListener("change", (event) => {
    player.playbackRate = Number(event.target.value);
  });

  addEventListener("beforeunload", (event) => {
    if (!unsaved()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  detail.attach({ show, draw, click, key, verdictOf: (word) => (state.doc ? verdictOf(word) : null), verdictCell, reviewed });

  return { unsaved, exports, setModel: (sha) => (state.modelSha = sha) };
}

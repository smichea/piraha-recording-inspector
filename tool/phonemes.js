// The detail view: a window of a few seconds with the periodicity candidates
// and the envelope and, when the page has the phoneme model, its scores, the
// word candidates, a list of them, and what the model is.

import { FRAME_S, clock, themeColors } from "./draw.js";
import {
  FIRST_S,
  OUTPUTS,
  PITCH_CENTRE_S,
  STEP_S,
  drawDetailAxis,
  drawDetailEnvelope,
  drawLetters,
  drawPitch,
  drawScores,
  drawWords,
  pitchStepAt,
  rowAt,
} from "./detail.js";

const $ = (id) => document.getElementById(id);
const SPANS = [1.5, 3, 6, 12, 24, 48];
const LISTED = 400; // rows of the candidate list drawn at once
const MINUS = "−";
const HINT = "Move the pointer over the plots to read a time and its periodicity candidate; click to move the playback position.";
const HINT_MODEL =
  "Each row of the plot under the phonemes is one phoneme; the darker a cell, the higher its score in those 20 ms. " +
  "Click a word candidate to hear it.";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Rows of a tab-separated table as objects keyed by the header's names. */
function table(text) {
  const [head, ...lines] = text.trimEnd().split("\n");
  const names = head.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((cell, index) => [names[index], cell])));
}

const signed = (value, digits) => value.toFixed(digits).replace("-", MINUS);

/**
 * `player` is the page's audio element, `seek(seconds)` moves it, and
 * `playSpan(from, to)` plays a stretch and stops.
 */
export function createPhonemeView({ player, seek, playSpan }) {
  const plots = $("detail");
  const state = {
    model: null, // the model's own description, when the page has one
    data: null,
    duration: 0,
    peak: 1,
    start: 0,
    span: 6,
    hint: HINT,
    letters: [],
    words: [],
    shown: [], // the words at or above the chosen fit
    boxes: [],
    active: null,
    queued: false,
  };
  // The annotation view (annotate.js), once it has attached itself: it draws its lane with this view's
  // window and takes the clicks and keys that are its own.
  let hooks = null;

  // ------------------------------------------------------------ the model

  function describe(about, entries) {
    state.model = about;
    // The slider starts where the model's description says, when it says so.
    const slider = $("fit");
    const initial = Number(about?.initial_fit);
    if (Number.isFinite(initial) && initial >= Number(slider.min) && initial <= Number(slider.max)) slider.value = String(initial);
    const card = $("model-card");
    card.replaceChildren();
    if (!about) return;
    const list = element("dl");
    const add = (term, value) => {
      if (value) list.append(element("dt", term), element("dd", value));
    };
    add("Trained on", about.trained_on);
    add("Training words", about.train_words ? `${about.train_words.toLocaleString("en-US")} spoken words` : "");
    const held = about.held_out_results?.test;
    if (held) {
      add(
        "Speakers kept apart",
        `Over ${held.words.toLocaleString("en-US")} words of two speakers the model never heard, ` +
          `${(100 * held.phoneme_error_rate).toFixed(0)} % phoneme errors against automatically placed labels; ` +
          `${(100 * held.words_exactly_right).toFixed(0)} % of those words read exactly as the list writes them.`,
      );
    }
    add("Word candidates", about.word_candidates);
    add("Other recordings", about.other_recordings);
    add("Word list", entries > 0 ? `${entries.toLocaleString("en-US")} entries. ${about.word_list ?? ""}` : "");
    add("Licence", about.licence);
    add("Citation", about.citation);
    card.append(list);
    for (const limit of about.limits ?? []) card.append(element("p", limit, "note"));
  }

  // ------------------------------------------------------------- a result

  function show(data, duration, peak) {
    const section = $("phonemes");
    const model = Boolean(data.scores);
    const wordList = "words.tsv" in data.texts;
    state.data = data;
    state.duration = duration;
    state.peak = peak;
    state.letters = table(data.texts["phonemes.tsv"] ?? "time_s\n").map((row) => ({
      time: Number(row.time_s),
      phoneme: row.phoneme,
      probability: Number(row.probability),
    }));
    state.words = table(data.texts["words.tsv"] ?? "start_s\n").map((row) => ({
      start: Number(row.start_s),
      end: Number(row.end_s),
      phonemes: row.phonemes,
      gloss: row.gloss,
      fit: Number(row.fit),
    }));
    state.span = Math.min(6, Math.max(SPANS[0], duration));
    state.start = 0;
    state.active = null;
    // The lanes, notes and list of the phoneme model exist only with a model.
    for (const id of ["detail-title-model", "model-note", "about-model"]) $(id).hidden = !model;
    for (const id of ["letter-lane-label", "detail-letters", "score-labels", "detail-scores"]) $(id).hidden = !model;
    $("word-tools").hidden = !wordList;
    $("word-lane-label").hidden = $("detail-words").hidden = !wordList;
    state.hint = model ? HINT_MODEL : HINT;
    $("detail-readout").textContent = state.hint;
    const { wav, pitch_channel_one_based: channel } = data.summary;
    $("pitch-scale").textContent =
      wav.channels > 1 ? `channel ${channel} of ${wav.channels} · 70 to 500 Hz, log scale` : "70 to 500 Hz, log scale";
    section.hidden = false;
    hooks?.show(data);
    filter();
    // Open on the first candidate, of a phoneme or else of periodicity, rather than on leading silence.
    const first = model ? state.letters[0]?.time : data.pitch.findIndex(Number.isFinite) * FRAME_S + PITCH_CENTRE_S;
    if (first > 0) moveTo(first - 0.5);
    render();
  }

  function hide() {
    state.data = null;
    $("phonemes").hidden = true;
  }

  function filter() {
    const least = Number($("fit").value);
    $("fit-value").textContent = signed(least, 2);
    state.shown = state.words.filter((word) => word.fit >= least);
    const body = $("word-rows");
    body.replaceChildren();
    for (const word of state.shown.slice(0, LISTED)) {
      const row = element("tr");
      const play = element("button", `▶ ${clock(word.start, 0.01)}`);
      play.type = "button";
      play.setAttribute("aria-label", `Play ${word.phonemes} at ${clock(word.start, 0.01)}`);
      play.addEventListener("click", () => choose(word));
      const cell = element("td");
      cell.append(play);
      row.append(
        cell,
        element("td", word.phonemes, "phoneme-text"),
        element("td", word.gloss),
        hooks?.verdictCell(word) ?? element("td"),
        element("td", signed(word.fit, 2)),
      );
      body.append(row);
    }
    const total = state.shown.length;
    $("word-count").textContent =
      total === 0
        ? "No word candidate at this fit."
        : total > LISTED
          ? `${total.toLocaleString("en-US")} word candidates; the first ${LISTED} are listed.`
          : `${total.toLocaleString("en-US")} word candidate${total > 1 ? "s" : ""}.`;
    $("word-table").hidden = total === 0;
    hooks?.reviewed();
    queue();
  }

  function choose(word) {
    state.active = word;
    const room = Math.max(0, state.span - (word.end - word.start));
    moveTo(word.start - Math.min(room / 2, 1));
    playSpan(Math.max(0, word.start - 0.08), word.end + 0.2);
    queue();
  }

  // --------------------------------------------------------------- window

  function moveTo(start) {
    state.start = Math.min(Math.max(0, start), Math.max(0, state.duration - state.span));
    queue();
  }

  function zoom(direction) {
    const index = SPANS.findIndex((span) => span >= state.span - 1e-9);
    const next = SPANS[Math.min(SPANS.length - 1, Math.max(0, (index < 0 ? SPANS.length - 1 : index) + direction))];
    const centre = withinWindow(player.currentTime) ? player.currentTime : state.start + state.span / 2;
    const share = (centre - state.start) / state.span;
    state.span = Math.min(next, Math.max(SPANS[0], state.duration));
    moveTo(centre - share * state.span);
  }

  const withinWindow = (seconds) => seconds >= state.start && seconds < state.start + state.span;

  /**
   * Keep the playback position in the window: turn the page while playing,
   * centre after a jump. Called when the position changes, not when the
   * window does, so that the window can be moved away from the position.
   */
  function follow(seconds) {
    if (!state.data) return;
    if (!withinWindow(seconds)) {
      const turning = !player.paused && seconds >= state.start + state.span && seconds < state.start + state.span + 0.5;
      moveTo(turning ? seconds - 0.05 * state.span : seconds - state.span / 2);
    }
    placeCursor(seconds);
  }

  function placeCursor(seconds) {
    const cursor = $("detail-cursor");
    cursor.hidden = seconds < state.start || seconds > state.start + state.span;
    cursor.style.transform = `translateX(${((seconds - state.start) / state.span) * plots.clientWidth}px)`;
  }

  // -------------------------------------------------------------- drawing

  function queue() {
    if (state.queued) return;
    state.queued = true;
    requestAnimationFrame(() => {
      state.queued = false;
      render();
    });
  }

  function render() {
    const { data } = state;
    if (!data) return;
    const colors = themeColors();
    const window = { start: state.start, span: state.span };
    state.boxes = $("detail-words").hidden
      ? []
      : drawWords($("detail-words"), { words: state.shown, active: state.active, verdict: hooks?.verdictOf, ...window }, colors);
    hooks?.draw(window, colors);
    if (data.scores) {
      drawLetters($("detail-letters"), { letters: state.letters, ...window }, colors);
      drawScores($("detail-scores"), { scores: data.scores, ...window }, colors);
    }
    const marks = drawPitch($("detail-pitch"), { pitch: data.pitch, activity: data.activity, ...window }, colors);
    // For automated checks of the page: the window drawn and its number of marks.
    Object.assign(plots.dataset, { start: String(state.start), span: String(state.span), marks: String(marks) });
    drawDetailEnvelope(
      $("detail-envelope"),
      {
        envelope: data.envelope,
        channels: data.summary.wav.channels,
        frames: data.summary.frames,
        peak: state.peak,
        ...window,
      },
      colors,
    );
    drawDetailAxis($("detail-axis"), window, colors);
    $("window-text").textContent =
      `${clock(state.start, 0.1)} to ${clock(Math.min(state.duration, state.start + state.span), 0.1)}`;
    $("zoom-in").disabled = state.span <= SPANS[0];
    $("zoom-out").disabled = state.span >= SPANS[SPANS.length - 1] || state.span >= state.duration;
    $("earlier").disabled = state.start <= 0;
    $("later").disabled = state.start + state.span >= state.duration;
    // The window's place on the timeline of the whole recording.
    const marker = $("window");
    marker.hidden = false;
    marker.style.left = `${(100 * state.start) / state.duration}%`;
    marker.style.width = `${Math.min(100, (100 * state.span) / state.duration)}%`;
    placeCursor(player.currentTime);
  }

  // ---------------------------------------------------------------- input

  function timeAt(event) {
    const box = plots.getBoundingClientRect();
    return state.start + Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) * state.span;
  }

  function wordAt(event) {
    const lane = $("detail-words");
    if (lane.hidden) return null;
    const box = lane.getBoundingClientRect();
    if (event.clientY < box.top || event.clientY > box.bottom) return null;
    const x = event.clientX - box.left;
    return state.boxes.find(({ left, right }) => x >= left && x <= right)?.word ?? null;
  }

  plots.addEventListener("click", (event) => {
    if (!state.data) return;
    if (hooks?.click(event, timeAt(event))) return;
    const word = wordAt(event);
    if (word) choose(word);
    else seek(timeAt(event));
  });

  plots.addEventListener("pointermove", (event) => {
    if (!state.data) return;
    const seconds = timeAt(event);
    const word = wordAt(event);
    plots.classList.toggle("on-word", word !== null);
    const parts = [`Pointer at ${clock(seconds, 0.01)}`, periodicityAt(seconds)];
    const row = rowAt(seconds);
    const { scores } = state.data;
    if (scores && (row + 1) * OUTPUTS.length <= scores.length) {
      const here = Array.from(scores.subarray(row * OUTPUTS.length, (row + 1) * OUTPUTS.length), (score, index) => ({
        name: index === 0 ? "nothing new" : OUTPUTS[index],
        share: Math.round((100 * score) / 255),
      }));
      const likely = here.filter(({ share }) => share >= 5).sort((a, b) => b.share - a.share);
      parts.push(`model: ${likely.slice(0, 3).map(({ name, share }) => `${name} ${share} %`).join(", ")}`);
    }
    if (word) parts.push(`word candidate ${word.phonemes} (${word.gloss}), fit ${signed(word.fit, 2)}: click to hear it`);
    $("detail-readout").textContent = parts.join(" · ");
  });

  plots.addEventListener("pointerleave", () => {
    plots.classList.remove("on-word");
    $("detail-readout").textContent = state.hint;
  });

  /** What the periodicity lane holds under the pointer: every 20 ms step that falls on that pixel. */
  function periodicityAt(seconds) {
    const { pitch, activity } = state.data;
    const first = pitchStepAt(seconds);
    const last = Math.max(first, pitchStepAt(seconds + state.span / plots.clientWidth - 1e-9));
    const found = [];
    for (let step = Math.max(0, first); step <= Math.min(pitch.length - 1, last); step++) {
      if (Number.isFinite(pitch[step])) found.push(pitch[step]);
    }
    if (last > first) {
      const steps = last - first + 1;
      if (found.length === 0) return `no periodicity candidate in the ${steps} steps of 20 ms under the pointer`;
      const [low, high] = [Math.min(...found), Math.max(...found)];
      const values = low === high ? `${low.toFixed(1)} Hz` : `${low.toFixed(1)} to ${high.toFixed(1)} Hz`;
      return `periodicity candidates in ${found.length} of the ${steps} steps of 20 ms under the pointer: ${values}`;
    }
    if (found.length === 1) {
      const semitones = 12 * Math.log2(found[0] / 100);
      const side = semitones < 0 ? "below" : "above";
      return `periodicity candidate ${found[0].toFixed(1)} Hz, ${Math.abs(semitones).toFixed(1)} semitones ${side} 100 Hz`;
    }
    for (let index = 0; index < activity.length; index += 2) {
      if (first >= activity[index] && first < activity[index + 1]) return "no periodicity candidate for the 54 ms centred here";
    }
    return "no periodicity candidate is kept here: this 20 ms step is outside the activity spans";
  }

  plots.addEventListener("keydown", (event) => {
    if (!state.data) return;
    if (hooks?.key(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft") seek(player.currentTime - (event.shiftKey ? 1 : 0.1));
    else if (event.key === "ArrowRight") seek(player.currentTime + (event.shiftKey ? 1 : 0.1));
    else if (event.key === " ") player.paused ? player.play() : player.pause();
    else if (event.key === "+" || event.key === "=") zoom(-1);
    else if (event.key === "-") zoom(1);
    else return;
    event.preventDefault();
  });

  $("zoom-in").addEventListener("click", () => zoom(-1));
  $("zoom-out").addEventListener("click", () => zoom(1));
  $("earlier").addEventListener("click", () => moveTo(state.start - 0.8 * state.span));
  $("later").addEventListener("click", () => moveTo(state.start + 0.8 * state.span));
  $("play-window").addEventListener("click", () => playSpan(state.start, state.start + state.span));
  $("fit").addEventListener("input", filter);
  new ResizeObserver(queue).observe(plots);

  // The lane labels of the score plot: one per phoneme.
  $("score-labels").replaceChildren(...OUTPUTS.slice(1).map((phoneme) => element("span", phoneme)));

  return {
    describe,
    show,
    follow,
    render: queue,
    hide,
    attach: (given) => (hooks = given),
    timeAt,
    filter,
    window: () => ({ start: state.start, span: state.span }),
    active: () => state.active,
    /** What an export takes from the model: the word candidates shown and the phoneme candidates, or null. */
    candidates: () => ({
      words: state.data && "words.tsv" in state.data.texts ? state.shown : null,
      letters: state.data?.scores ? state.letters : null,
    }),
  };
}

export { FIRST_S, STEP_S };

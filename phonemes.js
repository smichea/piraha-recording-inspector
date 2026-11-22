// The detail view: a window of a few seconds with the phoneme scores of the
// model and the word candidates, a list of the candidates, and what the model is.

import { clock, themeColors } from "./draw.js";
import {
  FIRST_S,
  OUTPUTS,
  STEP_S,
  drawDetailAxis,
  drawDetailEnvelope,
  drawLetters,
  drawScores,
  drawWords,
  rowAt,
} from "./detail.js";

const $ = (id) => document.getElementById(id);
const SPANS = [1.5, 3, 6, 12, 24, 48];
const LISTED = 400; // rows of the candidate list drawn at once
const MINUS = "−";

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
    letters: [],
    words: [],
    shown: [], // the words at or above the chosen fit
    boxes: [],
    active: null,
    queued: false,
  };

  // ------------------------------------------------------------ the model

  function describe(about, entries) {
    state.model = about;
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
    state.data = null;
    section.hidden = true;
    if (!data.scores) return;
    state.data = data;
    state.duration = duration;
    state.peak = peak;
    state.letters = table(data.texts["phonemes.tsv"]).map((row) => ({
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
    $("word-tools").hidden = !("words.tsv" in data.texts);
    $("word-lane-label").hidden = $("detail-words").hidden = !("words.tsv" in data.texts);
    section.hidden = false;
    filter();
    // Open on the first phoneme candidate rather than on leading silence.
    if (state.letters.length > 0) moveTo(state.letters[0].time - 0.5);
    render();
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

  /** Keep the playback position in the window: turn the page while playing, centre after a jump. */
  function follow(seconds) {
    if (!state.data) return;
    if (!withinWindow(seconds)) {
      const turning = !player.paused && seconds >= state.start + state.span && seconds < state.start + state.span + 0.5;
      moveTo(turning ? seconds - 0.05 * state.span : seconds - state.span / 2);
    }
    const x = ((seconds - state.start) / state.span) * plots.clientWidth;
    $("detail-cursor").style.transform = `translateX(${x}px)`;
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
      : drawWords($("detail-words"), { words: state.shown, active: state.active, ...window }, colors);
    drawLetters($("detail-letters"), { letters: state.letters, ...window }, colors);
    drawScores($("detail-scores"), { scores: data.scores, ...window }, colors);
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
    follow(player.currentTime);
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
    const word = wordAt(event);
    if (word) choose(word);
    else seek(timeAt(event));
  });

  plots.addEventListener("pointermove", (event) => {
    if (!state.data) return;
    const seconds = timeAt(event);
    const word = wordAt(event);
    plots.classList.toggle("on-word", word !== null);
    const parts = [`Pointer at ${clock(seconds, 0.01)}`];
    const row = rowAt(seconds);
    const { scores } = state.data;
    if ((row + 1) * OUTPUTS.length <= scores.length) {
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
    $("detail-readout").textContent = DETAIL_HINT;
  });

  plots.addEventListener("keydown", (event) => {
    if (!state.data) return;
    if (event.key === "ArrowLeft") seek(player.currentTime - (event.shiftKey ? 1 : 0.1));
    else if (event.key === "ArrowRight") seek(player.currentTime + (event.shiftKey ? 1 : 0.1));
    else if (event.key === " ") player.paused ? player.play() : player.pause();
    else if (event.key === "+" || event.key === "=") zoom(-1);
    else if (event.key === "-") zoom(1);
    else return;
    event.preventDefault();
  });

  const DETAIL_HINT = $("detail-readout").textContent;
  $("zoom-in").addEventListener("click", () => zoom(-1));
  $("zoom-out").addEventListener("click", () => zoom(1));
  $("earlier").addEventListener("click", () => moveTo(state.start - 0.8 * state.span));
  $("later").addEventListener("click", () => moveTo(state.start + 0.8 * state.span));
  $("play-window").addEventListener("click", () => playSpan(state.start, state.start + state.span));
  $("fit").addEventListener("input", filter);
  new ResizeObserver(queue).observe(plots);

  // The lane labels of the score plot: one per phoneme.
  $("score-labels").replaceChildren(...OUTPUTS.slice(1).map((phoneme) => element("span", phoneme)));

  return { describe, show, follow, render: queue, hide: () => show({ scores: null }, 0, 1) };
}

export { FIRST_S, STEP_S };

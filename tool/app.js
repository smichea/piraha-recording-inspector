// The page: choose a file, hand it to the worker, show what comes back.

import {
  FRAME_S,
  clock,
  drawAxis,
  drawBands,
  drawEnvelope,
  drawSpectrogram,
  spectrogramImage,
  themeColors,
} from "./draw.js";
import { createPhonemeView } from "./phonemes.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const plots = $("plots");
const player = $("player");
const READOUT_HINT = $("readout").textContent;

// What is on screen: the chosen file, the worker's result and the drawing state.
const view = {
  request: 0,
  file: null,
  started: 0,
  result: null,
  duration: 0,
  peak: 1, // largest sample magnitude, the envelope's vertical scale
  channel: 0,
  image: null,
  url: null,
  stopAt: null, // where a stretch being played ends
  model: null, // the phoneme model's own description, when the page has one
};

function setState(state, status) {
  root.dataset.state = state;
  $("status").textContent = status;
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

// ---------------------------------------------------------------- analysis

// The worker starts from a blob: address that only imports worker.js. A
// worker started that way inherits this page's security policy; one started
// from worker.js directly would take its policy from that file's response
// headers, and a static web host sends none.
const workerSource = `import ${JSON.stringify(new URL("./worker.js", import.meta.url).href)};`;
const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })), { type: "module" });

worker.addEventListener("message", ({ data }) => {
  if (data.type === "ready") {
    view.model = data.model;
    phonemeView.describe(data.model, data.words);
    $("model-line").hidden = !data.model;
    setState("ready", "Ready.");
  } else if (data.type === "failed") {
    setState("failed", "");
    showError(`The analysis module could not start: ${data.message}`);
  } else if (data.id !== view.request) {
    // From an analysis that was cancelled or replaced.
  } else if (data.type === "progress") {
    showProgress(data.done, data.total);
  } else if (data.type === "result") {
    showResult(data);
  } else if (data.type === "error") {
    $("progress").hidden = true;
    setState("error", "");
    showError(data.message);
  }
});

worker.addEventListener("error", () => {
  setState("failed", "");
  showError("The analysis module could not start. If audio_core_wasm.js is missing, run tools/web/build.sh.");
});

function analyse(file) {
  if (root.dataset.state === "loading" || root.dataset.state === "failed") return;
  view.request += 1;
  view.file = file;
  view.started = performance.now();
  view.result = null;
  $("error").hidden = true;
  $("result").hidden = true;
  $("window").hidden = true;
  view.stopAt = null;
  player.pause();
  player.removeAttribute("src");
  if (view.url) URL.revokeObjectURL(view.url);
  view.url = null;
  showProgress(0, file.size);
  setState("analysing", `Analysing ${file.name}`);
  worker.postMessage({ type: "analyse", id: view.request, file });
}

function showProgress(done, total) {
  const megabytes = (bytes) => (bytes / 1e6).toFixed(1);
  const elapsed = (performance.now() - view.started) / 1000;
  $("progress").hidden = false;
  $("bar").value = total > 0 ? done / total : 0;
  $("progress-text").textContent = `${megabytes(done)} of ${megabytes(total)} MB · ${elapsed.toFixed(1)} s`;
}

$("cancel").addEventListener("click", () => {
  view.request += 1;
  worker.postMessage({ type: "cancel" });
  $("progress").hidden = true;
  setState("ready", "Cancelled.");
});

$("file").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = ""; // so the same file can be chosen again
  if (file) analyse(file);
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) analyse(file);
});

// ------------------------------------------------------------------ result

function showResult(data) {
  const { summary } = data;
  const seconds = (performance.now() - view.started) / 1000;
  view.result = data;
  view.duration = summary.wav.sample_frames / summary.wav.sample_rate;
  view.channel = summary.pitch_channel_one_based - 1;
  view.image = null;
  view.peak = data.envelope.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 1);

  $("progress").hidden = true;
  $("name").textContent = summary.filename ?? "Recording";
  $("version").textContent = `${summary.tool.name} ${summary.tool.version}`;
  buildChannelControls(summary.wav.channels);
  buildSummary(summary);
  buildExports(data.texts);
  $("readout").textContent = READOUT_HINT;
  $("result").hidden = false;

  view.url = URL.createObjectURL(view.file);
  player.src = view.url;
  render();
  phonemeView.show(data, view.duration, view.peak);
  setState("done", `Analysed in ${seconds.toFixed(1)} s.`);
  // For automated checks of the page.
  globalThis.recordingInspector = { summary, texts: data.texts, seconds, model: view.model };
}

function buildChannelControls(channels) {
  plots.style.setProperty("--channels", channels);
  const labels = $("channel-labels");
  const select = $("channel");
  labels.replaceChildren();
  select.replaceChildren();
  const share = (100 * view.peak) / 32768;
  for (let channel = 0; channel < channels; channel++) {
    const label = element("span", channels === 1 ? "Envelope" : `Envelope ${channel + 1}`);
    label.append(element("small", `\u00b1${fixed(share, share < 10 ? 1 : 0)} % full scale`));
    labels.append(label);
    const option = element("option", `Channel ${channel + 1}`);
    option.value = String(channel);
    select.append(option);
  }
  select.value = String(view.channel);
  select.hidden = channels === 1;
}

$("channel").addEventListener("change", (event) => {
  view.channel = Number(event.target.value);
  view.image = null;
  render();
});

// ----------------------------------------------------------------- drawing

function render() {
  const data = view.result;
  if (!data) return;
  const colors = themeColors();
  const { summary } = data;
  const duration = view.duration;
  drawEnvelope(
    $("envelope"),
    { envelope: data.envelope, channels: summary.wav.channels, frames: summary.frames, duration, peak: view.peak },
    colors,
  );

  // Frequencies up to 8 kHz, as in the reference plot.
  const bins = data.frequencies.length;
  const spectra = data.spectra[view.channel];
  const rows = spectra.length / bins;
  let shown = bins;
  while (shown > 2 && data.frequencies[shown - 1] > 8000) shown--;
  view.image ??= spectrogramImage(spectra, rows, bins, shown);
  drawSpectrogram($("spectrogram"), view.image, { rows, duration, top: shown * data.frequencies[1] }, colors);

  drawBands($("bands"), { activity: data.activity, silence: data.silence, duration }, colors);
  drawAxis($("axis"), duration, colors);
  placeCursor();
  phonemeView.render();
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

new ResizeObserver(queueRender).observe(plots);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", queueRender);

// ---------------------------------------------------- playback and pointer

function placeCursor() {
  if (!view.result) return;
  const x = (player.currentTime / view.duration) * plots.clientWidth;
  $("cursor").style.transform = `translateX(${Math.min(x, plots.clientWidth)}px)`;
}

/** The playback position changed: move both cursors, and the detail window with it. */
function moveCursor() {
  if (!view.result) return;
  placeCursor();
  phonemeView.follow(player.currentTime);
}

function followPlayback() {
  if (view.stopAt !== null && player.currentTime >= view.stopAt) {
    view.stopAt = null;
    player.pause();
  }
  moveCursor();
  if (!player.paused && !player.ended) requestAnimationFrame(followPlayback);
}

for (const type of ["play", "seeking", "seeked", "timeupdate", "loadedmetadata"]) {
  player.addEventListener(type, followPlayback);
}

function seek(seconds) {
  view.stopAt = null;
  player.currentTime = Math.min(Math.max(seconds, 0), view.duration);
  moveCursor();
}

/** Play from one time to another and stop there. */
function playSpan(from, to) {
  seek(from);
  view.stopAt = Math.min(to, view.duration);
  player.play();
}

player.addEventListener("pause", () => {
  view.stopAt = null;
});

const phonemeView = createPhonemeView({ player, seek, playSpan });

function timeAt(event) {
  const box = plots.getBoundingClientRect();
  return Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) * view.duration;
}

plots.addEventListener("click", (event) => {
  if (view.result) seek(timeAt(event));
});

plots.addEventListener("pointermove", (event) => {
  if (!view.result) return;
  const { summary, level, pitch } = view.result;
  const seconds = timeAt(event);
  const frame = Math.floor(seconds / FRAME_S);
  const parts = [`Pointer at ${clock(seconds, 0.01)}`];
  if (frame < summary.frames) {
    parts.push(`frame level ${decibels(level[frame])} dBFS`);
    if (Number.isFinite(pitch[frame])) parts.push(`periodicity candidate ${fixed(pitch[frame], 1)} Hz`);
  } else {
    parts.push("after the last complete 20 ms frame");
  }
  $("readout").textContent = parts.join(" · ");
});

plots.addEventListener("pointerleave", () => {
  $("readout").textContent = READOUT_HINT;
});

plots.addEventListener("keydown", (event) => {
  if (!view.result) return;
  const step = event.shiftKey ? 10 : 1;
  if (event.key === "ArrowLeft") seek(player.currentTime - step);
  else if (event.key === "ArrowRight") seek(player.currentTime + step);
  else if (event.key === " ") player.paused ? player.play() : player.pause();
  else return;
  event.preventDefault();
});

// ----------------------------------------------------------------- summary

const MINUS = "−";

function fixed(value, digits) {
  const text = value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return text.replace("-", MINUS);
}

const count = (value) => fixed(value, 0);
const decibels = (value) => fixed(value, 1);

function span(seconds) {
  if (seconds < 60) return `${fixed(seconds, 2)} s`;
  // Round first, so that 119.96 s reads "2 min 0.0 s" and not "1 min 60.0 s".
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = `${fixed((tenths - minutes * 600) / 10, 1)} s`;
  if (minutes < 60) return `${minutes} min ${rest}`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ${rest}`;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function card(title, rows, note, className = "card") {
  const box = element("section", undefined, className);
  box.append(element("h3", title));
  const list = element("dl");
  for (const [term, value, valueClass] of rows) {
    list.append(element("dt", term), element("dd", value, valueClass));
  }
  box.append(list);
  if (note) box.append(element("p", note, "note"));
  return box;
}

function levelsCard(summary) {
  const box = element("section", undefined, "card wide");
  box.append(element("h3", "Levels"));
  const table = element("table");
  const head = element("tr");
  for (const title of ["Channel", "Peak (dBFS)", "RMS (dBFS)", "Full-scale samples", "Large steps"]) {
    head.append(element("th", title));
  }
  table.append(head);
  summary.peak_dbfs_by_channel.forEach((peak, channel) => {
    const row = element("tr");
    row.append(
      element("td", String(channel + 1)),
      element("td", fixed(peak, 2)),
      element("td", fixed(summary.rms_dbfs_by_channel[channel], 2)),
      element("td", count(summary.rail_samples_by_channel[channel])),
      element("td", count(summary.large_sample_steps_by_channel[channel])),
    );
    table.append(row);
  });
  const scroll = element("div", undefined, "table-scroll");
  scroll.append(table);
  const percentiles = summary.frame_level_percentiles_10_20_50_90_dbfs.map(decibels).join(" / ");
  box.append(
    scroll,
    element(
      "p",
      `Levels are measured over ${count(summary.frames)} frames of 20 ms; a frame takes the level of its louder ` +
        `channel. 10th / 20th / 50th / 90th percentile: ${percentiles} dBFS. A large step is a change of ` +
        "more than 80 % of full scale from one sample to the next.",
      "note",
    ),
  );
  return box;
}

function buildSummary(summary) {
  const { wav } = summary;
  const share = (seconds) => `${fixed((100 * seconds) / view.duration, 1)} % of the recording`;
  const candidates = summary.pitch_candidate_percentiles_10_50_90_hz;
  const peaks = summary.spectral_peak_candidates_hz;

  $("summary").replaceChildren(
    card(
      "File",
      [
        ["Size", `${count(summary.byte_count)} bytes`],
        ["SHA-256", summary.sha256, "mono"],
        [
          "Format",
          `${wav.bits_per_sample}-bit PCM · ${count(wav.sample_rate)} Hz · ${wav.channels} channel${wav.channels > 1 ? "s" : ""}`,
        ],
        ["Duration", `${span(view.duration)} (${count(wav.sample_frames)} sample frames)`],
      ],
      undefined,
      "card wide",
    ),
    levelsCard(summary),
    card(
      "Activity and low level",
      [
        ["Activity threshold", `${decibels(summary.activity_threshold_dbfs)} dBFS`],
        [
          "Activity spans",
          `${count(summary.activity_count)}, in total ${span(summary.activity_seconds)} (${share(summary.activity_seconds)})`,
        ],
        [
          "Low-level intervals",
          `${count(summary.silence_count)}, in total ${span(summary.silence_seconds)} (${share(summary.silence_seconds)})`,
        ],
      ],
      `Based on level alone: an activity span is at least 0.3 s above the threshold, a low-level interval at ` +
        `least 0.3 s below ${decibels(summary.silence_threshold_dbfs)} dBFS. This is not speech detection.`,
    ),
    card(
      "Periodicity candidates",
      [
        ["Channel used", `${summary.pitch_channel_one_based} (highest mean power)`],
        ["Frames with a candidate", count(summary.pitch_candidate_frames)],
        [
          "10th / 50th / 90th percentile",
          candidates.length > 0 ? `${candidates.map((hertz) => fixed(hertz, 1)).join(" / ")} Hz` : "none",
        ],
      ],
      "Autocorrelation candidates between 70 and 500 Hz inside activity spans. They are not validated pitch.",
    ),
    card(
      "Other checks",
      [
        [
          "Spectral peak candidates",
          peaks.length > 0 ? `${peaks.map((hertz) => fixed(hertz, 1)).join(", ")} Hz` : "none",
        ],
        [
          "Channel balance changes",
          wav.channels === 2 ? count(summary.channel_balance_change_candidates) : "not applicable (needs two channels)",
        ],
      ],
      "Spectral peaks stand out from the average spectrum by at least 6 dB, strongest first; they may be tones " +
        "or interference. A balance change is a move of at least 6 dB between activity spans less than 2 s apart.",
    ),
  );
}

// ----------------------------------------------------------------- exports

function buildExports(texts) {
  $("export-buttons").replaceChildren(
    ...Object.entries(texts).map(([name, text]) => {
      const button = element("button", name);
      button.type = "button";
      button.addEventListener("click", () => download(name, text));
      return button;
    }),
  );
}

function download(name, text) {
  const type = name.endsWith(".json") ? "application/json" : "text/tab-separated-values";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

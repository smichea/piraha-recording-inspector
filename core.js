// The analysis module: tools/audio-core compiled to WebAssembly.
//
// The module imports nothing, so it has no way to reach the network, the file
// system or the page. Bytes go in through `push`; results come out by name.

import wasmBase64 from "./audio_core_wasm.js";

const OP_START = 1;
const OP_PUSH = 2;
const OP_FINISH = 3;
const OP_FETCH = 4;
const OP_MODEL = 5;
const OP_WORDS = 6;

/** Largest piece `push` accepts, in bytes. */
export const MAX_PIECE = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let compiled;

export class Core {
  #exports;
  #input = 0;
  #capacity = 0;

  /** A fresh instance with its own memory. The module is compiled once. */
  static async create() {
    compiled ??= WebAssembly.compile(Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0)));
    const module = await compiled;
    if (WebAssembly.Module.imports(module).length > 0) {
      throw new Error("The analysis module must not import anything.");
    }
    const instance = await WebAssembly.instantiate(module, {});
    return new Core(instance.exports);
  }

  constructor(exports) {
    this.#exports = exports;
  }

  /** Begin an analysis. `name` is only copied into the summary. */
  start(name = "") {
    this.#call(OP_START, encoder.encode(name));
  }

  /** Feed the next piece of the file, a `Uint8Array` of at most `MAX_PIECE` bytes. */
  push(bytes) {
    this.#call(OP_PUSH, bytes);
  }

  /** End of file: returns the summary as JSON text. */
  finish() {
    return decoder.decode(this.#call(OP_FINISH, new Uint8Array(0)));
  }

  /**
   * Set the phoneme model that later analyses run: the bytes of a model file
   * of tools/phonemes. Returns the model's own description.
   */
  model(bytes) {
    return JSON.parse(decoder.decode(this.#call(OP_MODEL, bytes)));
  }

  /** Set the word list looked for in the phoneme scores. Returns the number of entries. */
  words(text) {
    return Number(decoder.decode(this.#call(OP_WORDS, encoder.encode(text))));
  }

  /** A text result by name, such as `segments.tsv`. */
  text(name) {
    return decoder.decode(this.#call(OP_FETCH, encoder.encode(name)));
  }

  /** A binary result by name, such as `level.f32`, in a buffer of its own. */
  buffer(name) {
    return this.#call(OP_FETCH, encoder.encode(name)).slice().buffer;
  }

  // Copies `bytes` into the module, runs one operation and returns a view of
  // the reply that stays valid until the next call.
  #call(operation, bytes) {
    const x = this.#exports;
    if (bytes.length > this.#capacity) {
      if (this.#capacity > 0) x.odb_free(this.#input, this.#capacity);
      this.#input = x.odb_alloc(bytes.length);
      this.#capacity = this.#input === 0 ? 0 : bytes.length;
      if (this.#input === 0) throw new Error("The piece is too large for the analysis module.");
    }
    new Uint8Array(x.memory.buffer, this.#input, bytes.length).set(bytes);
    const status = x.odb_call(operation, this.#input, bytes.length);
    // The memory may have grown during the call: look the buffer up again.
    const reply = new Uint8Array(x.memory.buffer, x.odb_output_ptr(), x.odb_output_len());
    if (status !== 0) throw new Error(decoder.decode(reply));
    return reply;
  }
}

/** Names of the text results, in the order the page offers them. */
export const TEXT_RESULTS = [
  "summary.json",
  "segments.tsv",
  "silence.tsv",
  "f0.tsv",
  "large_steps.tsv",
  "channel_changes.tsv",
];

/**
 * Analyse a file delivered by `read(offset, length)`, which resolves to a
 * `Uint8Array`. `progress(done)` is called after each piece and may return
 * `false` to stop; the result is then `null`.
 *
 * With `model` (the bytes of a phoneme model file) the result also has
 * `phonemes.tsv` among its texts and `scores`: for every 20 ms, twelve
 * probabilities scaled to 0..255. With `words` (a word list as text) as well,
 * it has `words.tsv`.
 */
export async function analyse({ name, size, read, progress = () => true, piece = 1 << 20, model = null, words = null }) {
  const core = await Core.create();
  if (model) {
    core.model(model);
    if (words) core.words(words);
  }
  core.start(name);
  let done = 0;
  while (done < size) {
    const bytes = await read(done, Math.min(piece, size - done));
    if (bytes.length === 0) throw new Error("The file could not be read to its end.");
    core.push(bytes);
    done += bytes.length;
    if (progress(done) === false) return null;
  }
  core.finish();
  const summary = JSON.parse(core.text("summary.json"));
  const texts = Object.fromEntries(TEXT_RESULTS.map((result) => [result, core.text(result)]));
  let scores = null;
  if (model) {
    texts["phonemes.tsv"] = core.text("phonemes.tsv");
    if (words) texts["words.tsv"] = core.text("words.tsv");
    scores = new Uint8Array(core.buffer("phoneme_scores.u8"));
  }
  return {
    scores,
    summary,
    texts,
    level: new Float32Array(core.buffer("level.f32")),
    envelope: new Int16Array(core.buffer("envelope.i16")),
    activity: new Uint32Array(core.buffer("activity.u32")),
    silence: new Uint32Array(core.buffer("silence.u32")),
    pitch: new Float32Array(core.buffer("pitch.f32")),
    frequencies: new Float64Array(core.buffer("spectrum_frequencies.f64")),
    spectra: Array.from({ length: summary.wav.channels }, (_, channel) => {
      return new Float32Array(core.buffer(`spectra.${channel}.f32`));
    }),
  };
}

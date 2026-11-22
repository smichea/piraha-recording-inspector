// Runs the analysis off the main thread. The file is read in pieces, so a
// long recording is never held in memory as a whole.

import { Core, analyse } from "./core.js";
// Optional parts, written by tools/phonemes/export_web.py: the phoneme model
// (base64 of a model file) and a word list (text). Each is `null` when absent.
import modelBase64 from "./phoneme_model.js";
import wordList from "./phoneme_words.js";

const model = modelBase64 ? Uint8Array.from(atob(modelBase64), (c) => c.charCodeAt(0)) : null;

// Identifier of the analysis in progress. A newer request or a cancellation
// replaces it, and the older analysis stops at its next piece.
let current = 0;

function reason(error) {
  if (error instanceof WebAssembly.RuntimeError) {
    return "The analysis stopped unexpectedly, possibly for lack of memory.";
  }
  return error instanceof Error ? error.message : String(error);
}

self.addEventListener("message", async ({ data }) => {
  if (data.type === "cancel") {
    current = 0;
    return;
  }
  if (data.type !== "analyse") return;
  const { id, file } = data;
  current = id;
  let lastReport = 0;
  try {
    const result = await analyse({
      model,
      words: wordList,
      name: file.name,
      size: file.size,
      read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
      progress: (done) => {
        if (current !== id) return false;
        const now = performance.now();
        if (now - lastReport >= 100 || done === file.size) {
          lastReport = now;
          self.postMessage({ type: "progress", id, done, total: file.size });
        }
        return true;
      },
    });
    if (result === null || current !== id) return;
    const buffers = [result.level, result.envelope, result.activity, result.silence, result.pitch]
      .concat(result.frequencies, result.spectra, result.scores ?? [])
      .map((array) => array.buffer);
    self.postMessage({ type: "result", id, ...result }, buffers);
  } catch (error) {
    if (current === id) self.postMessage({ type: "error", id, message: reason(error) });
  }
});

// Compile the module before any file is chosen, so that choosing one needs
// nothing more from the server.
try {
  const core = await Core.create();
  // Reading the model here reports a damaged one before any file is chosen.
  const about = model ? core.model(model) : null;
  const entries = model && wordList ? core.words(wordList) : 0;
  self.postMessage({ type: "ready", model: about, words: entries });
} catch (error) {
  self.postMessage({ type: "failed", message: reason(error) });
}

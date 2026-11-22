// Canvas drawing for the detail view: a window of a few seconds with the
// phoneme scores and the word candidates. Times are in seconds.

import { FRAME_S, clock, prepare } from "./draw.js";

/** Seconds between two rows of phoneme scores, and the time of the first row. */
export const STEP_S = 0.02;
export const FIRST_S = 0.0125;

/** The scores of a row: "nothing new", then the eleven phonemes. */
export const OUTPUTS = ["_", "p", "t", "k", "ʔ", "b", "g", "s", "h", "a", "i", "o"];

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** The row of scores nearest to a time. */
export function rowAt(seconds) {
  return Math.max(0, Math.round((seconds - FIRST_S) / STEP_S));
}

/** Lowest and highest sample per pixel column over all channels, for the window. */
export function drawDetailEnvelope(canvas, { envelope, channels, frames, peak, start, span }, colors) {
  const { context, width, height } = prepare(canvas, colors.plot);
  const middle = height / 2;
  const scale = (height / 2 - 2) / peak;
  const framesPerPixel = span / FRAME_S / width;
  const offset = start / FRAME_S;
  context.fillStyle = colors.line;
  context.fillRect(0, Math.round(middle), width, 1);
  context.fillStyle = colors.wave;
  for (let x = 0; x < width; x++) {
    const first = Math.floor(offset + x * framesPerPixel);
    if (first >= frames) break;
    const end = Math.min(frames, Math.max(first + 1, Math.ceil(offset + (x + 1) * framesPerPixel)));
    let low = 32767;
    let high = -32768;
    for (let at = 2 * first * channels; at < 2 * end * channels; at += 2) {
      if (envelope[at] < low) low = envelope[at];
      if (envelope[at + 1] > high) high = envelope[at + 1];
    }
    context.fillRect(x, middle - high * scale, 1, Math.max(1, (high - low) * scale));
  }
}

/** One lane per phoneme; the darker a cell, the higher the phoneme's score in that 20 ms. */
export function drawScores(canvas, { scores, start, span }, colors) {
  const { context, width, height } = prepare(canvas, colors.plot);
  const lanes = OUTPUTS.length - 1;
  const lane = height / lanes;
  const rows = scores.length / OUTPUTS.length;
  const cell = (STEP_S / span) * width;
  context.fillStyle = colors.line;
  for (let index = 1; index < lanes; index++) context.fillRect(0, Math.round(index * lane), width, 1);
  context.fillStyle = colors.ink;
  const first = Math.max(0, rowAt(start) - 1);
  const last = Math.min(rows - 1, rowAt(start + span) + 1);
  for (let row = first; row <= last; row++) {
    const x = ((FIRST_S + row * STEP_S - STEP_S / 2 - start) / span) * width;
    for (let phoneme = 1; phoneme <= lanes; phoneme++) {
      const score = scores[row * OUTPUTS.length + phoneme];
      if (score < 8) continue; // under 3 %
      context.globalAlpha = score / 255;
      context.fillRect(x, (phoneme - 1) * lane + 1, Math.max(1, cell), lane - 1);
    }
  }
  context.globalAlpha = 1;
}

/**
 * The phoneme candidates as letters at their times; the fainter, the less
 * sure. Where letters would overlap, the later one becomes a tick mark.
 */
export function drawLetters(canvas, { letters, start, span }, colors) {
  const { context, width, height, ratio } = prepare(canvas, colors.plot);
  context.font = `600 ${15 * ratio}px ${FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = colors.ink;
  let free = -Infinity; // first x not covered by the last letter drawn
  for (const { time, phoneme, probability } of letters) {
    if (time < start - 0.1) continue;
    if (time > start + span + 0.1) break;
    const x = ((time - start) / span) * width;
    context.globalAlpha = 0.25 + 0.75 * probability;
    const half = context.measureText(phoneme).width / 2 + ratio;
    if (x - half >= free) {
      context.fillText(phoneme, x, height / 2);
      free = x + half;
    } else {
      context.fillRect(Math.round(x), height - 5 * ratio, ratio, 5 * ratio);
    }
  }
  context.globalAlpha = 1;
}

/**
 * The word candidates as boxes from their first to their last phoneme, with
 * the entry's phonemes and gloss. Returns the boxes in CSS pixels, for clicks.
 */
export function drawWords(canvas, { words, start, span, active }, colors) {
  const { context, width, height, ratio } = prepare(canvas, colors.plot);
  const boxes = [];
  const pad = 4 * ratio;
  context.textBaseline = "middle";
  context.textAlign = "left";
  for (const word of words) {
    if (word.end < start) continue;
    if (word.start > start + span) break;
    // A phoneme is heard a little before and after the row where it scores.
    const x0 = ((word.start - 0.04 - start) / span) * width;
    const x1 = ((word.end + 0.06 - start) / span) * width;
    const top = 3 * ratio;
    const tall = height - 6 * ratio;
    context.globalAlpha = word === active ? 0.3 : 0.14;
    context.fillStyle = colors.accent;
    context.fillRect(x0, top, x1 - x0, tall);
    context.globalAlpha = 1;
    context.fillRect(x0, top, x1 - x0, 2 * ratio);
    context.fillRect(x0, top, ratio, tall);
    context.fillRect(x1 - ratio, top, ratio, tall);
    boxes.push({ left: x0 / ratio, right: x1 / ratio, word });

    const room = x1 - x0 - 2 * pad;
    if (room < 12 * ratio) continue;
    context.save();
    context.beginPath();
    context.rect(x0 + pad, top, room, tall);
    context.clip();
    context.fillStyle = colors.ink;
    context.font = `600 ${13 * ratio}px ${FONT}`;
    context.fillText(word.phonemes, x0 + pad, top + tall * 0.34);
    context.fillStyle = colors.muted;
    context.font = `${11 * ratio}px ${FONT}`;
    context.fillText(word.gloss, x0 + pad, top + tall * 0.74);
    context.restore();
  }
  return boxes;
}

/** Tick marks and times for the window. */
export function drawDetailAxis(canvas, { start, span }, colors) {
  const { context, width, height, ratio } = prepare(canvas, colors.plot);
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  const wanted = Math.max(2, Math.floor(width / ratio / 80));
  const step = steps.find((candidate) => span / candidate <= wanted) ?? 60;
  context.fillStyle = colors.muted;
  context.font = `${11 * ratio}px ${FONT}`;
  context.textBaseline = "middle";
  for (let index = Math.ceil(start / step); index * step <= start + span; index++) {
    const x = Math.round(((index * step - start) / span) * width);
    context.fillRect(x, 0, ratio, 5 * ratio);
    const label = clock(index * step, step);
    if (x + 4 * ratio + context.measureText(label).width < width) {
      context.fillText(label, x + 4 * ratio, height / 2 + 2 * ratio);
    }
  }
}

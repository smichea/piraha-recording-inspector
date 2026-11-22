// Canvas drawing for the timeline. Each function maps the whole recording
// onto the width of its canvas; times are in seconds.

/** Length of one analysis frame in seconds. */
export const FRAME_S = 0.02;

/** Colours of the current theme, read from the style sheet. */
export function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim();
  return {
    plot: read("--plot"),
    wave: read("--wave"),
    activity: read("--activity"),
    quiet: read("--quiet"),
    line: read("--line"),
    muted: read("--muted"),
    ink: read("--ink"),
    accent: read("--accent"),
    panel: read("--panel"),
  };
}

/** A time as m:ss or h:mm:ss, with the decimals a step of `step` seconds needs. */
export function clock(seconds, step = 1) {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const scale = 10 ** decimals;
  const rounded = Math.round(seconds * scale) / scale;
  const minutes = Math.floor(rounded / 60);
  const rest = (rounded - minutes * 60).toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, "0");
  if (minutes < 60) return `${minutes}:${rest}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

/** Size the canvas for the screen's pixel density and paint the background. */
export function prepare(canvas, background) {
  const ratio = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  return { context, width, height, ratio };
}

/**
 * Lowest and highest sample per pixel column, one lane per channel.
 * `envelope` holds, for each 20 ms frame and channel, the lowest then the
 * highest sample. A lane's half height stands for `peak`, in 16-bit units.
 */
export function drawEnvelope(canvas, { envelope, channels, frames, duration, peak }, colors) {
  const { context, width, height } = prepare(canvas, colors.plot);
  const lane = height / channels;
  const framesPerPixel = duration / FRAME_S / width;
  for (let channel = 0; channel < channels; channel++) {
    const middle = lane * (channel + 0.5);
    const scale = (lane / 2 - 2) / peak;
    context.fillStyle = colors.line;
    context.fillRect(0, Math.round(middle), width, 1);
    if (channel > 0) context.fillRect(0, Math.round(lane * channel), width, 1);
    context.fillStyle = colors.wave;
    for (let x = 0; x < width; x++) {
      const first = Math.floor(x * framesPerPixel);
      if (first >= frames) break; // past the last complete frame
      const end = Math.min(frames, Math.max(first + 1, Math.ceil((x + 1) * framesPerPixel)));
      let low = 32767;
      let high = -32768;
      for (let frame = first; frame < end; frame++) {
        const at = 2 * (frame * channels + channel);
        if (envelope[at] < low) low = envelope[at];
        if (envelope[at + 1] > high) high = envelope[at + 1];
      }
      const top = middle - high * scale;
      context.fillRect(x, top, 1, Math.max(1, (high - low) * scale));
    }
  }
}

// An approximation of Matplotlib's "magma", the map of the reference plot.
const STOPS = [
  [0, 0, 0, 4],
  [0.13, 28, 16, 68],
  [0.25, 79, 18, 123],
  [0.38, 129, 37, 129],
  [0.5, 181, 54, 122],
  [0.63, 229, 80, 100],
  [0.75, 251, 135, 97],
  [0.88, 254, 194, 135],
  [1, 252, 253, 191],
];
const COLORS = new Uint8ClampedArray(256 * 3);
for (let index = 0; index < 256; index++) {
  const t = index / 255;
  let stop = 1;
  while (STOPS[stop][0] < t) stop++;
  const [t0, ...from] = STOPS[stop - 1];
  const [t1, ...to] = STOPS[stop];
  const mix = (t - t0) / (t1 - t0);
  COLORS.set(from.map((value, part) => value + (to[part] - value) * mix), 3 * index);
}

/** Lowest and highest level of the colour scale, in dBFS per hertz. */
export const SPECTROGRAM_RANGE_DB = [-100, -40];

/**
 * One pixel per second and per frequency bin, low frequencies at the bottom.
 * `spectra` holds `rows * bins` powers per hertz; the first `shown` bins are drawn.
 */
export function spectrogramImage(spectra, rows, bins, shown) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, rows);
  canvas.height = shown;
  const context = canvas.getContext("2d");
  const image = context.createImageData(canvas.width, shown);
  const [floor, ceiling] = SPECTROGRAM_RANGE_DB;
  for (let row = 0; row < rows; row++) {
    for (let bin = 0; bin < shown; bin++) {
      const level = 10 * Math.log10(Math.max(spectra[row * bins + bin], 1e-16));
      const shade = Math.max(0, Math.min(255, Math.round(((level - floor) / (ceiling - floor)) * 255)));
      const at = 4 * ((shown - 1 - bin) * canvas.width + row);
      image.data[at] = COLORS[3 * shade];
      image.data[at + 1] = COLORS[3 * shade + 1];
      image.data[at + 2] = COLORS[3 * shade + 2];
      image.data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Stretch the spectrogram image over its seconds; `top` is the highest frequency drawn. */
export function drawSpectrogram(canvas, image, { rows, duration, top }, colors) {
  const { context, width, height, ratio } = prepare(canvas, colors.plot);
  const drawn = Math.min(width, Math.round((rows / duration) * width));
  // Smooth when squeezing many seconds into a pixel, keep hard edges when stretching.
  context.imageSmoothingEnabled = image.width > drawn;
  context.imageSmoothingQuality = "high";
  if (rows > 0) context.drawImage(image, 0, 0, image.width, image.height, 0, 0, drawn, height);

  context.font = `${11 * ratio}px system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = 3 * ratio;
  context.strokeStyle = "rgba(0, 0, 0, 0.8)";
  for (let hertz = 2000; hertz < top; hertz += 2000) {
    const y = Math.round(height * (1 - hertz / top));
    if (y < 8 * ratio) break; // no room for the label
    context.fillStyle = "rgba(255, 255, 255, 0.55)";
    context.fillRect(0, y, 6 * ratio, ratio);
    context.fillStyle = "#ffffff";
    const label = `${hertz / 1000} kHz`;
    context.strokeText(label, 9 * ratio, y);
    context.fillText(label, 9 * ratio, y);
  }
}

/** Activity spans above, low-level intervals below, as `[start, end)` frame pairs. */
export function drawBands(canvas, { activity, silence, duration }, colors) {
  const { context, width, ratio } = prepare(canvas, colors.plot);
  const lane = 16 * ratio;
  const gap = 4 * ratio;
  const scale = (FRAME_S / duration) * width;
  [
    [activity, colors.activity],
    [silence, colors.quiet],
  ].forEach(([pairs, color], index) => {
    context.fillStyle = color;
    const top = gap + index * (lane + gap);
    for (let at = 0; at < pairs.length; at += 2) {
      // Fractional edges let spans narrower than a pixel show as a lighter shade.
      context.fillRect(pairs[at] * scale, top, Math.max(0.5, (pairs[at + 1] - pairs[at]) * scale), lane);
    }
  });
}

/** Tick marks and times along the bottom. */
export function drawAxis(canvas, duration, colors) {
  const { context, width, height, ratio } = prepare(canvas, colors.plot);
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const wanted = Math.max(2, Math.floor(width / ratio / 90));
  const step = steps.find((candidate) => duration / candidate <= wanted) ?? 3600;
  context.fillStyle = colors.muted;
  context.font = `${11 * ratio}px system-ui, sans-serif`;
  context.textBaseline = "middle";
  for (let index = 0; index * step <= duration; index++) {
    const x = Math.round(((index * step) / duration) * width);
    context.fillRect(x, 0, ratio, 5 * ratio);
    const label = clock(index * step, step);
    if (x + 4 * ratio + context.measureText(label).width < width) {
      context.fillText(label, x + 4 * ratio, height / 2 + 2 * ratio);
    }
  }
}

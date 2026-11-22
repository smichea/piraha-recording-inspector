# Recording inspector

A web page that measures a 16-bit PCM WAV recording inside the browser: levels,
an overview spectrogram, candidate activity spans. For recordings of Pirahã it
also shows phoneme and word candidates from a small experimental model.

**The recording you choose is not uploaded.** The page's security policy
forbids it, and its worker, every network connection; the analysis module is
WebAssembly without any import. Your browser itself, and its extensions, are
outside the page's control.

**The phoneme and word candidates are a machine's reading, not a
transcription.** The model was trained on word lists with automatically made
labels that no person checked; most word candidates are wrong. Its figures and
limits are in the page, under "About the model".

The model and the word list are derived from the Pirahã recordings and word
lists of the UCLA Phonetics Lab Archive and are offered under the archive's
noncommercial terms; see [NOTICE.txt](NOTICE.txt). The page's code is under
the licence in [LICENSE.txt](LICENSE.txt).

This directory is a built copy: `index.html` and the files next to it are
everything the page needs.

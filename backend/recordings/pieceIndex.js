'use strict';

// A recording's index (<file>.index, recordings/Recorder.js): a line per
// piece, { o: where it starts in the file, l: its length, d: seconds, disc?:
// after a break }. Read line by line: a line cut off by a restart, or one
// that isn't a piece, is skipped, and so is a piece that runs past the end of
// the file (the file can be shorter than the index thought).

const fs = require('fs');

const isPiece = (p) => p && Number.isInteger(p.o) && p.o >= 0 && Number.isInteger(p.l) && p.l > 0
  && Number.isFinite(p.d) && p.d >= 0;

/** The good pieces of an index's text, those inside a file of `size` bytes (any size when null). */
function parsePieces(text, size = null) {
  const pieces = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    if (!isPiece(p) || (size != null && p.o + p.l > size)) continue;
    pieces.push(p);
  }
  return pieces;
}

/** A recording file's pieces from `indexPath` — [] when there's no index. */
function readPieces(indexPath, size = null) {
  let text;
  try { text = fs.readFileSync(indexPath, 'utf8'); } catch { return []; }
  return parsePieces(text, size);
}

/** The index's text for `pieces`. */
const indexText = (pieces) => pieces.map((p) => JSON.stringify(p) + '\n').join('');

module.exports = { parsePieces, readPieces, indexText };

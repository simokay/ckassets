// src/detectGridSharp.js
// Projection-based grid detector (sharp). Uses stronger smoothing, peak clustering,
// and automatic k-step spacing selection to avoid over-counting sub-peaks.
// Optional opts.cellsAcross (integer) forces spacing = origWidth / cellsAcross.

const sharp = require('sharp');

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function diffs(arr) {
  const d = [];
  for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i - 1]);
  return d;
}

function smooth(arr, k = 21) {
  const out = new Float64Array(arr.length);
  const half = Math.floor(k / 2);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    const a = Math.max(0, i - half), b = Math.min(arr.length - 1, i + half);
    for (let j = a; j <= b; j++) { s += arr[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

function findPeaks1D(arr, minProm = 0.45) {
  const peaks = [];
  const maxV = Math.max(...arr);
  const thr = maxV * minProm;
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] >= thr) peaks.push(i);
  }
  return peaks;
}

function clusterPeaks(peaks, minGap) {
  if (!peaks || peaks.length === 0) return [];
  peaks.sort((a, b) => a - b);
  const clusters = [];
  let cluster = [peaks[0]];
  for (let i = 1; i < peaks.length; i++) {
    if (peaks[i] - peaks[i - 1] <= minGap) cluster.push(peaks[i]);
    else { clusters.push(cluster); cluster = [peaks[i]]; }
  }
  clusters.push(cluster);
  return clusters.map(c => Math.round(c.reduce((s, v) => s + v, 0) / c.length));
}

async function toGrayRaw(buffer, maxDim = 1600) {
  const img = sharp(buffer).greyscale();
  const meta = await img.metadata();
  const resizeFactor = Math.max(1, Math.max(meta.width / maxDim, meta.height / maxDim));
  const targetWidth = Math.round(meta.width / resizeFactor);
  const pipeline = (meta.width > maxDim || meta.height > maxDim) ? img.resize({ width: targetWidth }) : img;
  const out = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data: out.data, info: out.info, origMeta: meta };
}

function spacingForK(peaksArr, k) {
  const vals = [];
  for (let i = 0; i + k < peaksArr.length; i++) vals.push((peaksArr[i + k] - peaksArr[i]) / k);
  if (!vals.length) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length);
  const relStd = std / Math.max(1e-6, Math.abs(mean));
  return { mean, std, relStd, samples: vals.length };
}

function bestSpacing(peaksArr) {
  if (!peaksArr || peaksArr.length < 2) return null;
  const candidates = [];
  for (let k = 1; k <= 6; k++) {
    const s = spacingForK(peaksArr, k);
    if (s) candidates.push({ k, ...s });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.relStd - b.relStd || b.samples - a.samples);
  return candidates[0];
}

async function detectGrid(buffer, opts = {}) {
  // opts:
  //   maxDim: max detection dimension (default 1600)
  //   minProm: peak prominence (0..1) default 0.45
  //   cellsAcross: optional integer override for number of cells across image
  const maxDim = opts.maxDim || 1600;
  const minProm = typeof opts.minProm === 'number' ? opts.minProm : 0.45;

  const { data, info, origMeta } = await toGrayRaw(buffer, maxDim);
  const W = info.width, H = info.height;

  // column and row sums
  const colSums = new Float64Array(W);
  const rowSums = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let rs = 0;
    for (let x = 0; x < W; x++) {
      const v = data[y * W + x];
      rs += v;
      colSums[x] += v;
    }
    rowSums[y] = rs;
  }

  // invert so dark lines = peaks
  const invCol = Float64Array.from(colSums.map(v => (255 * H - v)));
  const invRow = Float64Array.from(rowSums.map(v => (255 * W - v)));

  // smoothing (adaptive)
  const smoothKx = Math.max(15, Math.round(W / 50));
  const smoothKy = Math.max(15, Math.round(H / 50));
  const sCol = smooth(invCol, smoothKx);
  const sRow = smooth(invRow, smoothKy);

  const rawPeaksCol = findPeaks1D(sCol, minProm);
  const rawPeaksRow = findPeaks1D(sRow, minProm);

  const minGapCol = Math.max(6, Math.round(W / 200));
  const minGapRow = Math.max(6, Math.round(H / 200));
  let peaksCol = clusterPeaks(rawPeaksCol, minGapCol);
  let peaksRow = clusterPeaks(rawPeaksRow, minGapRow);

  // secondary aggressive clustering if too many peaks
  if (peaksCol.length > 50) peaksCol = clusterPeaks(peaksCol, Math.max(minGapCol, Math.round(W / 100)));
  if (peaksRow.length > 50) peaksRow = clusterPeaks(peaksRow, Math.max(minGapRow, Math.round(H / 100)));

  // compute best k-step spacing candidates
  const bestCol = bestSpacing(peaksCol);
  const bestRow = bestSpacing(peaksRow);

  // choose detected spacing in detection pixels
  let detSpacing = null;
  if (bestCol && bestRow) {
    // prefer the one with lower relative stddev
    detSpacing = (bestCol.relStd <= bestRow.relStd) ? bestCol.mean : bestRow.mean;
  } else if (bestCol) detSpacing = bestCol.mean;
  else if (bestRow) detSpacing = bestRow.mean;

  // fallback: simple median of diffs if k-step failed
  if (!detSpacing) {
    const colD = diffs(peaksCol);
    const rowD = diffs(peaksRow);
    const cs = median(colD);
    const rs = median(rowD);
    detSpacing = cs || rs || null;
  }

  if (!detSpacing) return null;

  // convert detection spacing to original image pixels
  const scaleFactor = origMeta.width / W;
  let cellSizePx = Math.max(1, detSpacing * scaleFactor);

  // optional user override: if cellsAcross provided, use that value (most reliable)
  if (opts.cellsAcross && Number.isFinite(opts.cellsAcross) && opts.cellsAcross > 0) {
    const userCell = origMeta.width / opts.cellsAcross;
    // if detection is wildly different from user value, prefer user value
    const relDiff = Math.abs(userCell - cellSizePx) / userCell;
    if (relDiff > 0.15) { // if >15% difference, prefer user
      cellSizePx = userCell;
    } else {
      // else blend small differences (take user as authoritative)
      cellSizePx = userCell;
    }
  }

  const debug = {
    origWidth: origMeta.width,
    origHeight: origMeta.height,
    detWidth: W,
    detHeight: H,
    scaleFactor,
    rawPeaksColCount: rawPeaksCol.length,
    rawPeaksRowCount: rawPeaksRow.length,
    peaksColCount: peaksCol.length,
    peaksRowCount: peaksRow.length,
    bestCol,
    bestRow,
    detSpacing,
    cellSizePx
  };

  return { cellSizePx, angleDeg: 0, peaksRow, peaksCol, debug };
}

module.exports = { detectGrid };

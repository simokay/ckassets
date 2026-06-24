let cvReady = false;
function cvLoaded(){ cv['onRuntimeInitialized'] = () => { cvReady = true; log('OpenCV ready'); }; }

const CELL = 70; // target cell size throughout

// ── DOM refs ──────────────────────────────────────────────────────────────
const fileEl       = document.getElementById('file');
const openFsBtn    = document.getElementById('openFs');
const processBtn   = document.getElementById('process');
const canvas       = document.getElementById('canvas');
const ctx          = canvas.getContext('2d');
const logEl        = document.getElementById('log');
const manualColsEl = document.getElementById('manualCols');
const manualRowsEl = document.getElementById('manualRows');
const cellSizeEl   = document.getElementById('cellSize');
const qualityEl    = document.getElementById('quality');
const qualityValEl = document.getElementById('qualityVal');
const fmtNoteEl    = document.getElementById('fmtNote');
const downloadEl   = document.getElementById('download');
const cropBarEl    = document.getElementById('cropBar');
const gridBarEl    = document.getElementById('gridBar');
const gridToggleBtn= document.getElementById('gridToggle');
const gridOverlay  = document.getElementById('gridOverlay');
const goc          = gridOverlay.getContext('2d');
const gCountEl     = document.getElementById('gCount');
const saveSepEl    = document.getElementById('saveSep');
const saveFolderEl = document.getElementById('saveFolder');
const nameGroupEl  = document.getElementById('nameGroup');
const savePrefixEl = document.getElementById('savePrefix');
const tagEditorEl  = document.getElementById('tagEditor');
const tagChipsEl   = document.getElementById('tagChips');
const tagInputEl   = document.getElementById('tagInput');
const tagDropdownEl= document.getElementById('tagDropdown');
const saveBtnEl    = document.getElementById('saveBtn');
const saveStatusEl = document.getElementById('saveStatus');
const sidebarEl    = document.getElementById('sidebar');
const sidebarToggle= document.getElementById('sidebarToggle');
const assetListEl  = document.getElementById('assetList');
const assetInnerEl = document.getElementById('assetListInner');
const assetFilterEl= document.getElementById('assetFilter');
const assetCountEl = document.getElementById('assetCount');
const canvasWrapEl = document.getElementById('canvasWrap');
const calibBarEl   = document.getElementById('calibBar');
const calibBtnEl   = document.getElementById('calibBtn');
const calibColsEl  = document.getElementById('calibCols');
const calibRowsEl  = document.getElementById('calibRows');
const calibCellEl  = document.getElementById('calibCell');
const calibApplyEl = document.getElementById('calibApply');
const calibClearEl = document.getElementById('calibClear');
const zoomOutEl    = document.getElementById('zoomOut');
const zoomLabelEl  = document.getElementById('zoomLabel');
const zoomInEl     = document.getElementById('zoomIn');

// Zoom: -1 = fit (CSS max-width), 0..N = index into ZOOM_STEPS (% of native resolution)
const ZOOM_STEPS = [25, 50, 75, 100, 150, 200];
let zoomIdx = -1;

function log(...s) { logEl.textContent += s.join(' ') + '\n'; logEl.scrollTop = logEl.scrollHeight; }

const webpSupported = document.createElement('canvas')
  .toDataURL('image/webp').startsWith('data:image/webp');
fmtNoteEl.textContent = webpSupported ? '' : '(WebP encoding not supported — will save PNG)';

// currentAsset tracks what is loaded from the sidebar:
//   { folder, name, savedName, baseName }
//   savedName = the filename currently on disk (updated after each save)
//   baseName  = description part of name used to rebuild filenames on crop
let currentAsset = null;
let originalImageData = null;
let calibMode = false, calibRect = null, calibDragStart = null, calibCellSize = 0;
let selectedTags = [], allKnownTags = [];

// Calibrated from ckassets filenames after the sidebar loads.
// minCells/maxCells narrow the ACF search; the Gaussian prior weights
// scores toward typical cell counts seen in the collection.
let acfPrior = { minCells: 5, maxCells: 100, meanCells: 25, sdCells: 10, calibrated: false };

// ── File loading ──────────────────────────────────────────────────────────

// Extract the tag portion from a filename, stripping any leading or trailing NxM dimension block.
// Handles: "22x31_BeachShipwreck.webp", "22x31 BeachShipwreck.webp", "BeachShipwreck 22x31.webp"
function extractTag(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  let m = base.match(/^\d{1,3}[xX]\d{1,3}[\s_]+(.+)$/);
  if (m) return m[1];
  m = base.match(/^(.+?)[\s_]+\d{1,3}[xX]\d{1,3}$/);
  if (m) return m[1];
  return base;
}

fileEl.addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  currentAsset = { tag: extractTag(f.name) };
  await loadFile(f);
});

openFsBtn.addEventListener('click', async () => {
  if (!window.showOpenFilePicker) { alert('File System Access API not available.'); return; }
  try {
    const [h] = await window.showOpenFilePicker({
      types: [{ accept: { 'image/*': ['.png','.jpg','.jpeg','.webp','.bmp'] } }]
    });
    const file = await h.getFile();
    currentAsset = { tag: extractTag(file.name) };
    await loadFile(file);
  } catch (err) { console.error(err); }
});

async function loadFile(file) {
  const bmp = await createImageBitmap(file);
  canvas.width = bmp.width; canvas.height = bmp.height;
  ctx.drawImage(bmp, 0, 0);
  originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  manualColsEl.value = ''; manualRowsEl.value = '';
  cellSizeEl.textContent = '—';
  hideCropBar(); hideGridBar(); hideSave();
  downloadEl.style.display = 'none';
  calibRect = null; calibDragStart = null; calibCellSize = 0;
  calibCellEl.textContent = 'drag a region on the image';
  calibClearEl.style.display = 'none';
  calibApplyEl.disabled = true;
  calibMode = false; calibBtnEl.classList.remove('active');
  canvasWrapEl.style.cursor = '';
  calibBarEl.style.display = '';
  zoomIdx = -1; applyZoom();
  log('Loaded', canvas.width, '×', canvas.height, file.name ? `(${file.name})` : '');
}

// ── Sidebar ───────────────────────────────────────────────────────────────

sidebarToggle.addEventListener('click', () => {
  const c = sidebarEl.classList.toggle('collapsed');
  sidebarToggle.textContent = c ? '▶' : '◀';
  sidebarToggle.title = c ? 'Expand sidebar' : 'Collapse sidebar';
});

// ── Virtual list ──────────────────────────────────────────────────────────

const ROW_H   = 34;
const OVERSCAN = 4;
const vl = { folder: 'maps', all: [], filtered: [], loadedName: null };

function updateCount() {
  const total = vl.all.length, shown = vl.filtered.length;
  assetCountEl.textContent = total === 0 ? '' :
    shown === total ? `${total} maps` : `${shown} of ${total}`;
}

function vlSetData(files) { vl.all = files; vl.filtered = files.slice(); vlRender(); updateCount(); }

function vlFilter(q) {
  const lq = q.toLowerCase();
  vl.filtered = lq
    ? vl.all.filter(f => f.replace(/\.[^.]+$/, '').toLowerCase().includes(lq))
    : vl.all.slice();
  assetListEl.scrollTop = 0;
  vlRender();
  updateCount();
}

function vlRender() {
  assetInnerEl.style.height = vl.filtered.length * ROW_H + 'px';
  const scrollTop = assetListEl.scrollTop;
  const viewH     = assetListEl.clientHeight || 400;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end   = Math.min(vl.filtered.length - 1, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  assetInnerEl.innerHTML = '';
  for (let i = start; i <= end; i++) {
    const name    = vl.filtered[i];
    const display = name.replace(/\.[^.]+$/, '');
    const row = document.createElement('div');
    row.className = 'asset-row' + (name === vl.loadedName ? ' loaded' : '');
    row.style.top = (i * ROW_H) + 'px';
    row.title = display; row.textContent = display;
    row.addEventListener('click', () => loadAssetFile(vl.folder, name));
    assetInnerEl.appendChild(row);
  }
}

assetListEl.addEventListener('scroll', vlRender);
assetFilterEl.addEventListener('input', e => vlFilter(e.target.value));

function vlShowMessage(msg) {
  assetInnerEl.style.height = 'auto';
  assetInnerEl.innerHTML = `<div class="vl-msg">${msg}</div>`;
}

async function loadAssets(folder) {
  vlShowMessage('Loading…');
  try {
    const res = await fetch(`/api/assets?folder=${folder}`);
    if (!res.ok) throw new Error(await res.text());
    const { files } = await res.json();
    if (!files.length) { vlShowMessage('No files found'); return; }
    vlSetData(files);
    if (folder === 'maps') { calibrateFromSidebar(); buildKnownTags(); }
  } catch (e) { vlShowMessage(`Error: ${e.message}`); }
}

// Build ACF priors from the verified ckassets filenames.
// Filenames are "{cols}x{rows}_tags.webp" and represent manually confirmed cell
// counts, so their distribution tells us what cell counts to expect in real maps.
// No images are fetched — this runs instantly on the already-loaded filename list.
function calibrateFromSidebar() {
  const counts = [];
  for (const name of vl.all) {
    const m = name.match(/^(\d+)x(\d+)_/);
    if (!m) continue;
    counts.push(parseInt(m[1]), parseInt(m[2]));
  }
  if (counts.length < 6) return; // too few samples to be meaningful
  counts.sort((a, b) => a - b);
  const n = counts.length;
  const p5  = counts[Math.max(0, Math.floor(n * 0.05))];
  const p95 = counts[Math.min(n - 1, Math.floor(n * 0.95))];
  const mean = counts.reduce((s, x) => s + x, 0) / n;
  const sd   = Math.sqrt(counts.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  acfPrior = {
    minCells:  Math.max(3, Math.floor(p5 * 0.7)),      // 30% below 5th percentile
    maxCells:  Math.min(200, Math.ceil(p95 * 1.5)),    // 50% above 95th percentile
    meanCells: mean,
    sdCells:   Math.max(sd, 3),                         // floor avoids collapse for small sets
    calibrated: true
  };
  log(`Detection calibrated from ${n >> 1} ckassets maps — cells ${acfPrior.minCells}–${acfPrior.maxCells}, mean ${mean.toFixed(1)} ± ${sd.toFixed(1)}`);
}

async function loadAssetFile(folder, name) {
  vl.loadedName = name; vl.folder = folder; vlRender();

  const url = `/ckassets/${folder}/${encodeURIComponent(name)}`;
  try {
    const blob = await (await fetch(url)).blob();
    await loadFile(new File([blob], name, { type: blob.type }));

    const cols = Math.round(canvas.width / CELL);
    const rows = Math.round(canvas.height / CELL);
    const tag = extractTag(name);

    currentAsset = { folder, name, savedName: name, tag };
    setGridDisplay(cols, rows);
    showCropBar();
    showGridBar();
    showSave();
  } catch (e) {
    log('Failed to load asset:', e.message);
  }
}

loadAssets('maps');

// ── Grid detection ────────────────────────────────────────────────────────
// Autocorrelation of edge-projection profiles finds the periodic grid spacing
// without being confused by complex terrain edges (trees, rocks, water).

function toGray(d, W, H) {
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++)
    g[i] = (d[i*4]*77 + d[i*4+1]*150 + d[i*4+2]*29) >> 8;
  return g;
}

function edgeProjections(gray, W, H) {
  // Use only the central 70% of the image. Maps where the grid doesn't reach the
  // border (crypts, bordered maps) have aperiodic noise in the margins that
  // swamps the real grid period when included in the projection.
  const tx = Math.round(W * 0.15), ty = Math.round(H * 0.15);
  const x0 = tx, x1 = W - tx, y0 = ty, y1 = H - ty;
  const cw = x1 - x0, ch = y1 - y0;
  const col = new Float64Array(cw);
  const row = new Float64Array(ch);
  for (let y = y0; y < y1; y++)
    for (let x = x0 + 1; x < x1; x++)
      col[x - x0] += Math.abs(gray[y*W+x] - gray[y*W+x-1]);
  for (let y = y0 + 1; y < y1; y++)
    for (let x = x0; x < x1; x++)
      row[y - y0] += Math.abs(gray[y*W+x] - gray[(y-1)*W+x]);
  return { col, row };
}

function computeACF(signal, minLag, maxLag) {
  const n = signal.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  let variance = 0;
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) { c[i] = signal[i] - mean; variance += c[i]*c[i]; }
  if (variance < 1) return null;
  const out = new Float64Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += c[i] * c[i+lag];
    out[lag - minLag] = s / variance;
  }
  return out;
}

function findFundamentalPeriod(acfVals, minLag, maxLag, imgDim) {
  // Score every candidate period P by:
  //   harmonic series: ACF[P] + ½·ACF[2P] + ⅓·ACF[3P] + …
  //     — true grid lines produce consistent harmonics; texture noise does not.
  //   divisibility bonus: the true period must divide imgDim into a near-integer
  //     number of cells; spurious texture periods often don't.
  // Pick the highest-scoring candidate rather than the smallest-lag strong peak,
  // which used to bias toward terrain sub-periods.
  if (!acfVals) return null;
  let bestLag = -1, bestScore = -Infinity;
  for (let P = minLag; P <= maxLag; P++) {
    const cells = imgDim / P;
    if (cells < acfPrior.minCells || cells > acfPrior.maxCells) continue;
    const a0 = acfVals[P - minLag];
    if (a0 < 0.03) continue;
    // Weighted harmonic sum
    let hNum = a0, hDen = 1;
    for (let k = 2; P * k <= maxLag; k++) {
      const w = 1 / k;
      hNum += w * Math.max(0, acfVals[P * k - minLag]);
      hDen += w;
    }
    const harmScore = hNum / hDen;
    // Divisibility: 1.0 if imgDim/P is an integer, 0.0 if it's a half-integer
    const frac = cells % 1;
    const divBonus = Math.max(0, 1 - Math.min(frac, 1 - frac) / 0.5);
    // Gaussian prior from ckassets: gently boosts typical cell counts, softly
    // penalises outliers. Only active after calibration; contributes ±30% max.
    const z = acfPrior.calibrated ? (cells - acfPrior.meanCells) / (acfPrior.sdCells * 2) : 0;
    const priorFactor = acfPrior.calibrated ? (0.7 + 0.3 * Math.exp(-0.5 * z * z)) : 1.0;
    const score = harmScore * (0.6 + 0.4 * divBonus) * priorFactor;
    if (score > bestScore) { bestScore = score; bestLag = P; }
  }
  if (bestLag < 0) return null;
  return { lag: bestLag, val: bestScore };
}

function downscaleImageData(imgData, maxDim) {
  const W = imgData.width, H = imgData.height;
  const scale = Math.min(1, maxDim / Math.max(W, H));
  if (scale >= 1) return { imgData, scale: 1 };
  const dw = Math.round(W * scale), dh = Math.round(H * scale);
  const s = document.createElement('canvas'); s.width = W; s.height = H;
  s.getContext('2d').putImageData(imgData, 0, 0);
  const d = document.createElement('canvas'); d.width = dw; d.height = dh;
  d.getContext('2d').drawImage(s, 0, 0, dw, dh);
  return { imgData: d.getContext('2d').getImageData(0, 0, dw, dh), scale };
}

function detectGridCellSize(imgData) {
  const { imgData: det, scale } = downscaleImageData(imgData, 900);
  const W = det.width, H = det.height;
  const gray = toGray(det.data, W, H);
  const { col, row } = edgeProjections(gray, W, H);
  const minCW = Math.max(4, Math.floor(W/100)), maxCW = Math.floor(W/5);
  const minCH = Math.max(4, Math.floor(H/100)), maxCH = Math.floor(H/5);
  const pkCol = findFundamentalPeriod(computeACF(col, minCW, maxCW), minCW, maxCW, W);
  const pkRow = findFundamentalPeriod(computeACF(row, minCH, maxCH), minCH, maxCH, H);
  log(`ACF col: ${pkCol ? `lag=${pkCol.lag} corr=${pkCol.val.toFixed(3)}` : 'no peak'}`);
  log(`ACF row: ${pkRow ? `lag=${pkRow.lag} corr=${pkRow.val.toFixed(3)}` : 'no peak'}`);
  if (!pkCol && !pkRow) return null;
  const cellW = pkCol ? pkCol.lag / scale : null;
  const cellH = pkRow ? pkRow.lag / scale : null;
  let cellSizePx;
  if (cellW && cellH) {
    const ratio = Math.max(cellW, cellH) / Math.min(cellW, cellH);
    cellSizePx = ratio < 1.15 ? (cellW + cellH) / 2 : (pkCol.val >= pkRow.val ? cellW : cellH);
  } else { cellSizePx = cellW ?? cellH; }
  return { cellSizePx, cellW, cellH };
}

// ── Main processing (external images) ────────────────────────────────────

processBtn.addEventListener('click', async () => {
  if (!cvReady) { alert('OpenCV not ready yet.'); return; }
  if (!originalImageData) { alert('Load an image first.'); return; }
  logEl.textContent = '';
  const targetCell = Number(document.getElementById('target').value) || CELL;
  const manualCell = Number(document.getElementById('manualCell').value) || 0;
  await processImage(originalImageData, targetCell, manualCell);
});

async function processImage(imageData, targetCellPx, manualCellPx) {
  const origW = imageData.width, origH = imageData.height;
  let cols, rows, cellSizePx;

  // Manual grid count — edited directly in the Grid status fields.
  // Takes priority over everything except an explicit cell-size override.
  const manualCols = parseInt(manualColsEl.value);
  const manualRows = parseInt(manualRowsEl.value);

  if (manualCellPx > 0) {
    cellSizePx = manualCellPx;
    cols = Math.round(origW / cellSizePx);
    rows = Math.round(origH / cellSizePx);
    log(`Manual cell size: ${cellSizePx}px`);
  } else if (manualCols > 0 && manualRows > 0) {
    cols = manualCols; rows = manualRows;
    cellSizePx = (origW / cols + origH / rows) / 2;
    log(`Manual grid count: ${cols}×${rows}`);
  } else if (calibCellSize > 0) {
    cellSizePx = calibCellSize;
    cols = Math.round(origW / cellSizePx);
    rows = Math.round(origH / cellSizePx);
    log(`Calibrated cell size: ${calibCellSize.toFixed(1)} px`);
  } else {
    log('Detecting grid…');
    const result = detectGridCellSize(imageData);
    if (!result) { log('Detection failed — use calibration or set a manual cell size.'); return; }
    ({ cellSizePx } = result);
    cols = Math.round(origW / cellSizePx);
    rows = Math.round(origH / cellSizePx);
    log(`Detected: ${result.cellW?.toFixed(1) ?? '?'} × ${result.cellH?.toFixed(1) ?? '?'} px cell`);
  }
  const finalW = cols * targetCellPx;
  const finalH = rows * targetCellPx;
  log(`Grid: ${cols}×${rows} | ${origW}×${origH} → ${finalW}×${finalH}`);

  const src = cv.matFromImageData(imageData);
  const dst = new cv.Mat();
  cv.resize(src, dst, new cv.Size(finalW, finalH), 0, 0,
    finalW < origW ? cv.INTER_AREA : cv.INTER_CUBIC);
  cv.imshow(canvas, dst);
  src.delete(); dst.delete();

  setGridDisplay(cols, rows);
  showCropBar();
  showGridBar();
  refreshDownload();
  showSave();
  log('Done.');
}

// ── Crop ──────────────────────────────────────────────────────────────────

document.querySelectorAll('.crop-btn').forEach(btn =>
  btn.addEventListener('click', () => cropEdge(btn.dataset.side))
);

function cropEdge(side) {
  const W = canvas.width, H = canvas.height;
  let sx = 0, sy = 0, sw = W, sh = H;
  if (side === 'left')   { sx = CELL; sw -= CELL; }
  if (side === 'right')  {            sw -= CELL; }
  if (side === 'top')    { sy = CELL; sh -= CELL; }
  if (side === 'bottom') {            sh -= CELL; }
  if (sw < CELL || sh < CELL) return;

  const imgData = ctx.getImageData(sx, sy, sw, sh);
  canvas.width = sw; canvas.height = sh;
  ctx.putImageData(imgData, 0, 0);

  const cols = sw / CELL, rows = sh / CELL;
  setGridDisplay(cols, rows);
  updateCropButtons(cols, rows);
  refreshDownload();
  updateSaveNameDims(cols, rows);
}

function showCropBar() {
  if (canvas.width % CELL !== 0 || canvas.height % CELL !== 0) return;
  cropBarEl.style.display = '';
  updateCropButtons(canvas.width / CELL, canvas.height / CELL);
}

function hideCropBar() { cropBarEl.style.display = 'none'; }

function updateCropButtons(cols, rows) {
  document.querySelectorAll('.crop-btn[data-side="left"], .crop-btn[data-side="right"]')
    .forEach(b => { b.disabled = cols <= 1; });
  document.querySelectorAll('.crop-btn[data-side="top"], .crop-btn[data-side="bottom"]')
    .forEach(b => { b.disabled = rows <= 1; });
}

// ── Status display ────────────────────────────────────────────────────────

function setGridDisplay(cols, rows) {
  manualColsEl.value = cols;
  manualRowsEl.value = rows;
  cellSizeEl.textContent = CELL;
}

// ── Grid overlay ──────────────────────────────────────────────────────────
// Non-destructive purple grid drawn on a separate canvas element.
// Never included in canvas.toBlob() saves or downloads.
//
// Workflow:
//   1. Toggle overlay to see alignment.
//   2. Adjust Cell to match the visible grid spacing.
//   3. Adjust X/Y offset until lines sit on the map's grid lines.
//   4. "Crop offset" — trims the border pixels from all four sides so the
//      grid starts at pixel 0 and both edges land on a whole cell boundary.
//   5. "Scale to 70" — scales the image so the current cell size → 70 px.

let gridVisible = false;
let gCell = CELL, gOpacity = 0.7, gOffX = 0, gOffY = 0;

function showGridBar() {
  gCell = CELL; gOffX = gOffY = 0;
  document.getElementById('gCell').value  = CELL;
  document.getElementById('gOffX').value  = 0;
  document.getElementById('gOffY').value  = 0;
  gridBarEl.style.display = '';
  if (gridVisible) drawGridOverlay();
}

function hideGridBar() {
  gridBarEl.style.display = 'none';
  gridOverlay.width = 1; gridOverlay.height = 1;
}

function syncGridOverlay() {
  if (gridOverlay.width !== canvas.width || gridOverlay.height !== canvas.height) {
    gridOverlay.width  = canvas.width;
    gridOverlay.height = canvas.height;
  }
}

function drawGridOverlay() {
  syncGridOverlay();
  goc.clearRect(0, 0, gridOverlay.width, gridOverlay.height);
  if (!canvas.width) return;

  const W = gridOverlay.width, H = gridOverlay.height;
  const dispScale = (canvas.getBoundingClientRect().width || W) / W;

  // Calibration rectangle (teal) — drawn even when the purple grid is off
  if (calibRect) {
    goc.save();
    goc.strokeStyle = 'rgba(0, 212, 180, 0.9)';
    goc.lineWidth = Math.max(1, Math.round(2 / dispScale));
    if (calibDragStart) goc.setLineDash([6, 4]);
    goc.strokeRect(calibRect.x + 0.5, calibRect.y + 0.5, calibRect.w, calibRect.h);
    goc.restore();
  }

  if (!gridVisible) return;

  const cs = Math.max(1, gCell);
  const lw = Math.max(1, Math.round(1.5 / dispScale));

  goc.strokeStyle = `rgba(210, 0, 255, ${gOpacity})`;
  goc.lineWidth = lw;
  goc.beginPath();

  const sx = ((gOffX % cs) + cs) % cs;
  for (let x = sx; x <= W; x += cs) {
    goc.moveTo(Math.round(x) + 0.5, 0);
    goc.lineTo(Math.round(x) + 0.5, H);
  }
  const sy = ((gOffY % cs) + cs) % cs;
  for (let y = sy; y <= H; y += cs) {
    goc.moveTo(0, Math.round(y) + 0.5);
    goc.lineTo(W, Math.round(y) + 0.5);
  }
  goc.stroke();

  gCountEl.textContent = `${Math.round(W / cs)} × ${Math.round(H / cs)} cells`;
}

gridToggleBtn.addEventListener('click', () => {
  gridVisible = !gridVisible;
  gridToggleBtn.textContent = gridVisible ? 'Hide overlay' : 'Show overlay';
  gridToggleBtn.classList.toggle('active', gridVisible);
  drawGridOverlay();
});

document.getElementById('gOpacity').addEventListener('input', e => {
  gOpacity = Number(e.target.value) / 100;
  document.getElementById('gOpacityVal').textContent = e.target.value;
  drawGridOverlay();
});

// Step (±) buttons — shared for cell size and both offsets.
document.querySelectorAll('.step').forEach(btn => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.for);
    el.value = Number(el.value) + Number(btn.dataset.d);
    el.dispatchEvent(new Event('input'));
  });
});

['gCell','gOffX','gOffY'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    gCell  = Math.max(1, Number(document.getElementById('gCell').value)  || CELL);
    gOffX  = Number(document.getElementById('gOffX').value) || 0;
    gOffY  = Number(document.getElementById('gOffY').value) || 0;
    drawGridOverlay();
  });
});

// Auto-align — given the current cell size, find the X/Y phase (offset within
// one cell period) that best matches where the grid lines actually fall.
//
// Why this is needed: maps often have a decorative border or the grid doesn't
// start at pixel 0.  Resizing with a cell-count hint preserves that border
// proportionally, so the overlay (which starts at 0) appears misaligned even
// when the cell count is correct.  This finds the right offset automatically.
//
// Method: compute the column projection of |dI/dx| for the whole image, then
// for each candidate phase p in [0, cellSize), sum projection[p + k*cellSize]
// over all k.  The phase where grid lines actually fall will have a notably
// higher score because the edge energy at those columns accumulates.
document.getElementById('gridAutoAlign').addEventListener('click', () => {
  const cs = Math.max(1, gCell);
  const W = canvas.width, H = canvas.height;
  if (!W || !H) { log('Load an image first.'); return; }

  const imgData = ctx.getImageData(0, 0, W, H);
  const gray = toGray(imgData.data, W, H);

  // Full-image projections (no edge trim — we need the border pixels here).
  const colProj = new Float64Array(W);
  const rowProj = new Float64Array(H);
  for (let y = 0; y < H; y++)
    for (let x = 1; x < W; x++)
      colProj[x] += Math.abs(gray[y*W+x] - gray[y*W+x-1]);
  for (let y = 1; y < H; y++)
    for (let x = 0; x < W; x++)
      rowProj[y] += Math.abs(gray[y*W+x] - gray[(y-1)*W+x]);

  let bestSx = 0, bestSxScore = -1;
  for (let sx = 0; sx < cs; sx++) {
    let score = 0;
    for (let x = sx; x < W; x += cs) score += colProj[x];
    if (score > bestSxScore) { bestSxScore = score; bestSx = sx; }
  }

  let bestSy = 0, bestSyScore = -1;
  for (let sy = 0; sy < cs; sy++) {
    let score = 0;
    for (let y = sy; y < H; y += cs) score += rowProj[y];
    if (score > bestSyScore) { bestSyScore = score; bestSy = sy; }
  }

  gOffX = bestSx; gOffY = bestSy;
  document.getElementById('gOffX').value = bestSx;
  document.getElementById('gOffY').value = bestSy;
  drawGridOverlay();
  log(`Auto-aligned: offset (${bestSx}, ${bestSy}) px`);
});

// Crop offset — removes the partial-cell border from all four sides.
// Left crop  = gOffX mod cellSize  (the visible offset from the left edge)
// Right crop = whatever pixels remain after removing left border + whole cells
// Same logic vertically.  After this the grid starts at pixel 0 on all sides.
document.getElementById('gridCropOffset').addEventListener('click', () => {
  const cs = Math.max(1, gCell);
  const sx = ((gOffX % cs) + cs) % cs;   // left border
  const sy = ((gOffY % cs) + cs) % cs;   // top border
  const afterLeft = canvas.width  - sx;
  const afterTop  = canvas.height - sy;
  const rx = afterLeft % cs;              // right border
  const ry = afterTop  % cs;             // bottom border
  const newW = afterLeft - rx, newH = afterTop - ry;

  if (newW < cs || newH < cs) { log('Crop offset: nothing to crop or result too small.'); return; }

  const imgData = ctx.getImageData(sx, sy, newW, newH);
  canvas.width = newW; canvas.height = newH;
  ctx.putImageData(imgData, 0, 0);

  gOffX = gOffY = 0;
  document.getElementById('gOffX').value = 0;
  document.getElementById('gOffY').value = 0;

  const cols = Math.round(newW / cs), rows = Math.round(newH / cs);
  setGridDisplay(cols, rows);
  updateSaveNameDims(cols, rows);
  drawGridOverlay();
  refreshDownload();
  log(`Cropped: L=${sx} R=${rx} T=${sy} B=${ry} → ${newW}×${newH} (${cols}×${rows} cells)`);
});

// Scale to 70 — resizes the image so the current cell size becomes exactly 70 px.
// Uses OpenCV for quality when available, canvas 2D otherwise.
document.getElementById('gridScale').addEventListener('click', () => {
  const cs = Math.max(1, gCell);
  if (cs === CELL) { log('Cell size is already 70 px.'); return; }

  const cols = Math.round(canvas.width  / cs);
  const rows = Math.round(canvas.height / cs);
  const newW = cols * CELL, newH = rows * CELL;

  if (cvReady) {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const src = cv.matFromImageData(imgData);
    const dst = new cv.Mat();
    cv.resize(src, dst, new cv.Size(newW, newH), 0, 0, newW > canvas.width ? cv.INTER_CUBIC : cv.INTER_AREA);
    cv.imshow(canvas, dst);
    src.delete(); dst.delete();
  } else {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = canvas.height;
    tmp.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = newW; canvas.height = newH;
    ctx.drawImage(tmp, 0, 0, newW, newH);
  }

  gCell = CELL;
  document.getElementById('gCell').value = CELL;
  drawGridOverlay();
  setGridDisplay(cols, rows);
  updateSaveNameDims(cols, rows);
  refreshDownload();
  log(`Scaled: ${cs} px → 70 px | ${newW}×${newH} (${cols}×${rows} cells)`);
});

// ── WebP download ─────────────────────────────────────────────────────────

qualityEl.addEventListener('input', () => {
  qualityValEl.textContent = qualityEl.value;
  if (downloadEl.style.display !== 'none') refreshDownload();
});

function refreshDownload() {
  const q    = Number(qualityEl.value) / 100;
  const mime = webpSupported ? 'image/webp' : 'image/png';
  const ext  = webpSupported ? 'webp' : 'png';
  canvas.toBlob(blob => {
    if (downloadEl._objUrl) URL.revokeObjectURL(downloadEl._objUrl);
    const url = URL.createObjectURL(blob);
    downloadEl._objUrl = url;
    downloadEl.href = url;
    downloadEl.download = `processed.${ext}`;
    downloadEl.textContent = `Download ${ext.toUpperCase()}`;
    downloadEl.style.display = 'inline';
  }, mime, webpSupported ? q : undefined);
}

// ── Save to ckassets ──────────────────────────────────────────────────────

// Split a CamelCase tag string back into individual tags.
// "BeachShipwreck" → ["Beach", "Shipwreck"]. Returns [] if not clean CamelCase.
function parseTagString(s) {
  if (!s) return [];
  const words = s.match(/[A-Z][a-z0-9]*/g) || [];
  return words.join('') === s ? words : [];
}

// True if the current selectedTags composition already exists in ckassets
// (excluding the file currently being edited so renaming doesn't self-conflict).
function tagConflict() {
  if (!selectedTags.length) return false;
  const composed = selectedTags.join('');
  const self = currentAsset?.savedName;
  return vl.all.some(name => {
    if (name === self) return false;
    const m = name.match(/^\d+x\d+_(.+)\.[^.]+$/);
    return m && m[1] === composed;
  });
}

function updateSaveState() {
  const hasTag  = selectedTags.length > 0;
  const conflict = hasTag && tagConflict();
  saveBtnEl.disabled = !hasTag || conflict;
  if (conflict) {
    saveStatusEl.textContent = '⚠ tag combination already used';
    saveStatusEl.style.color = 'var(--danger)';
  } else if (saveStatusEl.textContent.startsWith('⚠')) {
    saveStatusEl.textContent = '';
    saveStatusEl.style.color = '';
  }
}

function showSave() {
  const cols = Math.round(canvas.width / CELL);
  const rows = Math.round(canvas.height / CELL);
  savePrefixEl.textContent = `${cols}x${rows}_`;
  selectedTags = parseTagString(currentAsset?.tag ?? '');
  renderTagChips();
  if (currentAsset?.folder) saveFolderEl.value = currentAsset.folder;
  [saveSepEl, saveFolderEl, nameGroupEl, saveBtnEl].forEach(el => el.style.display = '');
  updateSaveState();
}

function hideSave() {
  [saveSepEl, saveFolderEl, nameGroupEl, saveBtnEl].forEach(el => el.style.display = 'none');
  saveStatusEl.textContent = '';
  saveStatusEl.style.color = '';
  selectedTags = [];
}

function updateSaveNameDims(cols, rows) {
  if (nameGroupEl.style.display === 'none') return;
  savePrefixEl.textContent = `${cols}x${rows}_`;
  updateSaveState();
}

saveBtnEl.addEventListener('click', async () => {
  const folder = saveFolderEl.value;
  const tagStr = selectedTags.join('');
  if (!tagStr) return;
  const cols = Math.round(canvas.width / CELL);
  const rows = Math.round(canvas.height / CELL);
  const name = `${cols}x${rows}_${tagStr}.webp`;

  saveStatusEl.textContent = 'Saving…';
  saveStatusEl.style.color = '';
  saveBtnEl.disabled = true;

  try {
    const q    = Number(qualityEl.value) / 100;
    const mime = webpSupported ? 'image/webp' : 'image/png';
    const blob = await new Promise(resolve =>
      canvas.toBlob(resolve, mime, webpSupported ? q : undefined)
    );
    const savedName = currentAsset?.savedName;
    let url = `/api/save?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
    if (savedName && savedName !== name) url += `&oldName=${encodeURIComponent(savedName)}`;
    const res  = await fetch(url, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    saveStatusEl.textContent = `✓ Saved to ${data.saved}`;
    log(`Saved → ckassets/${data.saved}`);

    if (currentAsset) { currentAsset.savedName = name; currentAsset.name = name; currentAsset.tag = tagStr; }
    else currentAsset = { folder, name, savedName: name, tag: tagStr };
    vl.loadedName = name;

    if (folder === 'maps') {
      await loadAssets('maps');
      vlFilter(assetFilterEl.value);
      vl.loadedName = name; vlRender();
    }
  } catch (e) {
    saveStatusEl.textContent = `Error: ${e.message}`;
    saveStatusEl.style.color = 'var(--danger)';
    log('Save failed:', e.message);
  } finally {
    updateSaveState();
  }
});

// ── Tag editor ────────────────────────────────────────────────────────────

// Collect every individual tag word seen across all ckassets map names.
function buildKnownTags() {
  const set = new Set();
  for (const name of vl.all) {
    const m = name.match(/^\d+x\d+_(.+)\.[^.]+$/);
    if (!m) continue;
    (m[1].match(/[A-Z][a-z0-9]*/g) || []).forEach(w => set.add(w));
  }
  allKnownTags = [...set].sort();
}

function renderTagChips() {
  tagChipsEl.innerHTML = '';
  for (const tag of selectedTags) {
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    const label = document.createElement('span');
    label.textContent = tag;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'tag-chip-x'; x.textContent = '×'; x.title = `Remove ${tag}`;
    x.addEventListener('click', () => { selectedTags = selectedTags.filter(t => t !== tag); renderTagChips(); updateSaveState(); });
    chip.append(label, x);
    tagChipsEl.appendChild(chip);
  }
}

function refreshDropdown() {
  const q  = tagInputEl.value;
  const lq = q.toLowerCase();
  const suggestions = allKnownTags
    .filter(t => !selectedTags.includes(t) && t.toLowerCase().includes(lq))
    .slice(0, 10);

  tagDropdownEl.innerHTML = '';
  tagDropdownEl._idx = -1;

  for (const tag of suggestions) {
    const li = document.createElement('li');
    li.className = 'tag-opt'; li.textContent = tag; li.dataset.tag = tag;
    tagDropdownEl.appendChild(li);
  }
  // "Create" option when input is valid CamelCase and genuinely new
  if (q && /^[A-Z][a-zA-Z0-9]*$/.test(q) && !allKnownTags.includes(q) && !selectedTags.includes(q)) {
    const li = document.createElement('li');
    li.className = 'tag-opt tag-opt-new'; li.textContent = `Create "${q}"`; li.dataset.tag = q;
    tagDropdownEl.appendChild(li);
  }
  tagDropdownEl.classList.toggle('open', tagDropdownEl.children.length > 0);
}

function hideDropdown() { tagDropdownEl.classList.remove('open'); tagDropdownEl._idx = -1; }

function moveFocus(d) {
  const items = [...tagDropdownEl.querySelectorAll('.tag-opt')];
  if (!items.length) return;
  const next = Math.max(0, Math.min(items.length - 1, (tagDropdownEl._idx ?? -1) + d));
  items.forEach((el, i) => el.classList.toggle('focused', i === next));
  tagDropdownEl._idx = next;
  items[next].scrollIntoView({ block: 'nearest' });
}

function commitTag(tag) {
  if (tag && !selectedTags.includes(tag)) { selectedTags.push(tag); renderTagChips(); updateSaveState(); }
  tagInputEl.value = '';
  hideDropdown();
  tagInputEl.focus();
}

tagInputEl.addEventListener('input', () => {
  // Auto-capitalise the first letter as the user types
  const v = tagInputEl.value;
  if (v && v[0] !== v[0].toUpperCase()) tagInputEl.value = v[0].toUpperCase() + v.slice(1);
  refreshDropdown();
});

tagInputEl.addEventListener('keydown', e => {
  const q = tagInputEl.value;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!tagDropdownEl.classList.contains('open')) refreshDropdown();
    moveFocus(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); moveFocus(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const focused = tagDropdownEl.querySelector('.tag-opt.focused');
    if (focused) { commitTag(focused.dataset.tag); }
    else if (q && /^[A-Z][a-zA-Z0-9]*$/.test(q) && !selectedTags.includes(q)) { commitTag(q); }
  } else if (e.key === 'Escape') {
    hideDropdown();
  } else if (e.key === 'Backspace' && !q && selectedTags.length) {
    selectedTags = selectedTags.slice(0, -1);
    renderTagChips(); updateSaveState();
  }
});

tagInputEl.addEventListener('focus', () => { if (tagInputEl.value || allKnownTags.length) refreshDropdown(); });
tagInputEl.addEventListener('blur',  () => setTimeout(hideDropdown, 150));

// pointerdown (not click) so the input doesn't lose focus before we act
tagDropdownEl.addEventListener('pointerdown', e => {
  const opt = e.target.closest('.tag-opt');
  if (!opt) return;
  e.preventDefault();
  commitTag(opt.dataset.tag);
});

// Click anywhere in the tag editor area focuses the text input
tagEditorEl.addEventListener('click', e => {
  if (!e.target.closest('.tag-chip')) tagInputEl.focus();
});

// ── Calibration ───────────────────────────────────────────────────────────
// User drags a rectangle over a known N×M cell region; cell size is inferred
// from rect.width/N and rect.height/M, then used as the primary cell-size hint
// for the next Process run.

function updateCalib() {
  if (!calibRect) { calibCellSize = 0; calibApplyEl.disabled = true; return; }
  const n = Math.max(1, parseInt(calibColsEl.value) || 1);
  const m = Math.max(1, parseInt(calibRowsEl.value) || 1);
  calibCellSize = (calibRect.w / n + calibRect.h / m) / 2;
  calibCellEl.textContent = `cell ~${calibCellSize.toFixed(1)} px`;
  calibClearEl.style.display = '';
  calibApplyEl.disabled = false;
}

calibColsEl.addEventListener('input', updateCalib);
calibRowsEl.addEventListener('input', updateCalib);

calibBtnEl.addEventListener('click', () => {
  calibMode = !calibMode;
  calibBtnEl.classList.toggle('active', calibMode);
  canvasWrapEl.style.cursor = calibMode ? 'crosshair' : '';
});

calibClearEl.addEventListener('click', () => {
  calibRect = null; calibDragStart = null; calibCellSize = 0;
  calibCellEl.textContent = 'drag a region on the image';
  calibClearEl.style.display = 'none';
  calibApplyEl.disabled = true;
  drawGridOverlay();
});

function canvasCoords(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - r.left)  * (canvas.width  / r.width)),
    y: Math.round((e.clientY - r.top)   * (canvas.height / r.height))
  };
}

canvasWrapEl.addEventListener('mousedown', e => {
  if (!calibMode || !canvas.width) return;
  calibDragStart = canvasCoords(e);
  calibRect = null;
  e.preventDefault();
});

canvasWrapEl.addEventListener('mousemove', e => {
  if (!calibMode || !calibDragStart) return;
  const pt = canvasCoords(e);
  calibRect = {
    x: Math.min(calibDragStart.x, pt.x),
    y: Math.min(calibDragStart.y, pt.y),
    w: Math.abs(pt.x - calibDragStart.x),
    h: Math.abs(pt.y - calibDragStart.y)
  };
  drawGridOverlay();
});

canvasWrapEl.addEventListener('mouseup', e => {
  if (!calibMode || !calibDragStart) return;
  const pt = canvasCoords(e);
  const dx = Math.abs(pt.x - calibDragStart.x), dy = Math.abs(pt.y - calibDragStart.y);
  if (dx < 5 || dy < 5) {
    calibDragStart = null; calibRect = null; drawGridOverlay(); return;
  }
  calibRect = {
    x: Math.min(calibDragStart.x, pt.x),
    y: Math.min(calibDragStart.y, pt.y),
    w: dx, h: dy
  };
  calibDragStart = null;
  calibMode = false;
  calibBtnEl.classList.remove('active');
  canvasWrapEl.style.cursor = '';
  updateCalib();
  drawGridOverlay();
});

// ── Apply calibration ─────────────────────────────────────────────────────
// Rescales directly from originalImageData so quality is never lost through
// intermediate saves — even if the canvas has already been processed once.

calibApplyEl.addEventListener('click', async () => {
  if (!cvReady) { alert('OpenCV not ready yet.'); return; }
  if (!originalImageData) { alert('Load an image first.'); return; }
  if (calibCellSize <= 0) return;

  const origW = originalImageData.width, origH = originalImageData.height;
  const cols = Math.round(origW / calibCellSize);
  const rows = Math.round(origH / calibCellSize);
  const finalW = cols * CELL, finalH = rows * CELL;

  logEl.textContent = '';
  log(`Calibrated: cell ${calibCellSize.toFixed(1)} px → ${cols}×${rows} | ${origW}×${origH} → ${finalW}×${finalH}`);

  const src = cv.matFromImageData(originalImageData);
  const dst = new cv.Mat();
  cv.resize(src, dst, new cv.Size(finalW, finalH), 0, 0,
    finalW < origW ? cv.INTER_AREA : cv.INTER_CUBIC);
  cv.imshow(canvas, dst);
  src.delete(); dst.delete();

  setGridDisplay(cols, rows);
  showCropBar();
  showGridBar();
  refreshDownload();
  showSave();

  // Clear calibration — coordinates are invalid after the image has been resized
  calibRect = null; calibDragStart = null; calibCellSize = 0;
  calibCellEl.textContent = 'drag a region on the image';
  calibClearEl.style.display = 'none';
  calibApplyEl.disabled = true;

  zoomIdx = -1; applyZoom();
  log('Done.');
});

// ── Zoom ──────────────────────────────────────────────────────────────────

function applyZoom() {
  if (zoomIdx < 0) {
    canvas.style.width = '';
    canvasWrapEl.style.maxWidth = '';
    zoomLabelEl.textContent = 'Fit';
  } else {
    const pct = ZOOM_STEPS[zoomIdx];
    canvas.style.width = Math.round(canvas.width * pct / 100) + 'px';
    canvasWrapEl.style.maxWidth = 'none';
    zoomLabelEl.textContent = pct + '%';
  }
  zoomOutEl.disabled = zoomIdx <= -1;
  zoomInEl.disabled  = zoomIdx >= ZOOM_STEPS.length - 1;
  drawGridOverlay();
}

zoomOutEl.addEventListener('click', () => { if (zoomIdx > -1) { zoomIdx--; applyZoom(); } });
zoomInEl.addEventListener('click',  () => { if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; applyZoom(); } });

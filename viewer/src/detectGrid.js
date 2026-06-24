// detectGrid(cv.Mat) => { cellSizePx, rotationDeg, gridRect }
// gridRect: { x,y,width,height } bounding the main grid area (if found)

const cv = require('opencv4nodejs');

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = arr.slice().sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

function computeSpacing(linesCoords) {
  if (!linesCoords || linesCoords.length < 2) return null;
  linesCoords.sort((a,b)=>a-b);
  const diffs = [];
  for (let i=1;i<linesCoords.length;i++) diffs.push(Math.abs(linesCoords[i]-linesCoords[i-1]));
  return median(diffs);
}

function linesFromHoughP(houghLines) {
  // returns array of {x1,y1,x2,y2}
  if (!houghLines) return [];
  return houghLines.map(l => {
    // opencv4nodejs returns Vec4 or arrays
    return { x1: l.x1 || l[0], y1: l.y1 || l[1], x2: l.x2 || l[2], y2: l.y2 || l[3] };
  });
}

function angleDeg(x1,y1,x2,y2) {
  return Math.atan2(y2-y1, x2-x1) * 180/Math.PI;
}

function detectGrid(mat) {
  try {
    const gray = mat.bgrToGray();
    const blur = gray.gaussianBlur(new cv.Size(5,5), 0);
    const thresh = blur.adaptiveThreshold(255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 3);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3));
    const morph = thresh.morphologyEx(kernel, cv.MORPH_CLOSE, new cv.Point(-1,-1), 1);

    const edges = morph.canny(50, 150);

    const rawLines = edges.houghLinesP(1, Math.PI/180, 100, 50, 10) || [];
    const lines = linesFromHoughP(rawLines);

    // classify lines into horizontal and vertical
    const horizCenters = [];
    const vertCenters = [];
    const angles = [];
    for (const l of lines) {
      const a = angleDeg(l.x1,l.y1,l.x2,l.y2);
      angles.push(a);
      const absA = Math.abs(a);
      if (absA < 20) {
        // horizontal
        horizCenters.push((l.y1 + l.y2) / 2);
      } else if (Math.abs(Math.abs(a) - 90) < 20) {
        // vertical
        vertCenters.push((l.x1 + l.x2) / 2);
      } else {
        // near diagonal — ignore
      }
    }

    if (horizCenters.length < 2 || vertCenters.length < 2) {
      // fallback: try Hough on resized image or lower thresholds could be added
      return null;
    }

    const hSpacing = computeSpacing(horizCenters);
    const vSpacing = computeSpacing(vertCenters);
    const cellSizePx = (hSpacing + vSpacing) / 2;

    // compute rotation: median angle of all near-horizontal lines (should be near 0) -> rotation to apply = -medianAngle
    const horizAngles = angles.filter(a => Math.abs(a) < 20);
    const medianAngle = median(horizAngles || [0]);
    const rotationDeg = medianAngle || 0;

    // grid bounding rectangle: find largest contour from the morph image which has many grid lines
    const contours = morph.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let gridRect = null;
    if (contours && contours.length) {
      const sorted = contours.sort((a,b)=>b.area - a.area);
      const box = sorted[0].boundingRect();
      gridRect = { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    return { cellSizePx, rotationDeg, gridRect };
  } catch (err) {
    console.error('detectGrid error', err);
    return null;
  }
}

module.exports = { detectGrid };

// deskewMatToBuffer(mat, rotationDeg) => Buffer (PNG)
const cv = require('opencv4nodejs');
const sharp = require('sharp');

function deskewMatToBuffer(mat, rotationDeg) {
  // rotate around center by -rotationDeg so horizontal lines become horizontal
  if (!rotationDeg || Math.abs(rotationDeg) < 0.5) {
    // no-op: encode to buffer directly
    return cv.imencode('.png', mat);
  }
  const center = new cv.Point2(mat.cols/2, mat.rows/2);
  const M = cv.getRotationMatrix2D(center, -rotationDeg, 1.0);
  const rotated = mat.warpAffine(M, new cv.Size(mat.cols, mat.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255));
  return cv.imencode('.png', rotated);
}

module.exports = { deskewMatToBuffer };

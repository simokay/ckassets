// deskewBuffer(buffer, angleDeg) => rotated buffer
const sharp = require('sharp');

async function deskewBuffer(buffer, angleDeg) {
  // rotate around center; background white
  return sharp(buffer)
    .rotate(angleDeg, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .toBuffer();
}

module.exports = { deskewBuffer };

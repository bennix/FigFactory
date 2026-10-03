const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { readPsd, initializeCanvas } = require('ag-psd');
initializeCanvas(() => { throw new Error('Canvas should not be needed'); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
const { makePSD } = require('../src/psd.cjs');
function png(red, alpha, width = 2) {
  const image = new PNG({ width, height: 2 });
  for (let i = 0; i < image.data.length; i += 4) { image.data[i] = red; image.data[i + 3] = alpha; }
  return `data:image/png;base64,${PNG.sync.write(image).toString('base64')}`;
}
test('PSD contains separate named RGBA layers in correct stacking order', () => {
  const buffer = makePSD({ composite: png(255, 255), layers: [{ name: '文字', url: png(255, 100) }, { name: '背景', url: png(0, 255) }] });
  assert.equal(buffer.toString('ascii', 0, 4), '8BPS');
  const document = readPsd(buffer, { useImageData: true, skipThumbnail: true });
  assert.equal(document.width, 2);
  assert.deepEqual(document.children.map(layer => layer.name), ['背景', '文字']);
  assert.equal(document.children[1].imageData.data[3], 100);
  assert.equal(document.children[0].imageData.data[3], 255);
});
test('PSD rejects mismatched layer sizes rather than silently stretching them', () => {
  assert.throws(() => makePSD({ composite: png(255, 255), layers: [{ name: 'bad', url: png(0, 255, 3) }] }), /尺寸/);
});

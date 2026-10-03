const { writePsdBuffer } = require('ag-psd');
const { PNG } = require('pngjs');
function pngData(url) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw new Error('PSD 图层必须为 PNG。');
  const decoded = PNG.sync.read(Buffer.from(match[1], 'base64'));
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
}
function makePSD({ layers, composite }) {
  if (!layers?.length) throw new Error('请先拆层，再导出 PSD。');
  const imageData = pngData(composite);
  const children = layers.map(layer => {
    const pixels = pngData(layer.url);
    if (pixels.width !== imageData.width || pixels.height !== imageData.height) throw new Error('图层尺寸必须与原图一致，请检查模型输出。');
    return { name: layer.name || '图层', top: 0, left: 0, imageData: pixels, blendMode: 'normal', opacity: 1 };
  }).reverse(); // ag-psd stores children bottom-to-top; UI is top-to-bottom.
  return writePsdBuffer({ width: imageData.width, height: imageData.height, imageData, children }, { generateThumbnail: false, noBackground: true });
}
module.exports = { makePSD };

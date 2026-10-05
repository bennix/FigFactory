// Actual local inference smoke test; run only after preparing the selected weights.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PNG } = require('pngjs');
const { WeightStore, selection } = require('../src/local-weights.cjs');
const { LocalEngine } = require('../src/local-ai.cjs');
const root = process.env.FIGFACTORY_DATA || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support/BodyFactory 形体工坊' : process.platform === 'win32' ? 'AppData/Roaming/BodyFactory 形体工坊' : '.config/BodyFactory 形体工坊');
const output = path.join(root, 'local-smoke');
const weights = new WeightStore(path.join(root, 'local-models'));
const engine = new LocalEngine(path.join(root, 'local-engine'), weights);
const options = { dit: 'dit-Q4_K_M', encoder: process.env.FIGFACTORY_ENCODER || 'te-Q4_K_M', size: '1024x1024' };
const log = data => console.log(new Date().toISOString(), data.message);
function save(name, url) {
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  const png = PNG.sync.read(bytes);
  if (png.width < 256 || png.height < 256 || new Set(png.data).size < 8) throw new Error('Output is empty or invalid');
  fs.writeFileSync(path.join(output, name), bytes);
  return { width: png.width, height: png.height, bytes: bytes.length };
}
process.on('SIGINT', () => { engine.stop(); weights.cancel(); process.exit(130); });
process.on('SIGTERM', () => { engine.stop(); weights.cancel(); process.exit(143); });
(async () => {
  fs.mkdirSync(output, { recursive: true });
  // --wait monitors ongoing preparation without starting duplicate installers/downloads.
  if (process.argv.includes('--wait')) {
    console.log('Waiting for verified weights and installed engine…');
    while (true) {
      const catalog = await weights.catalog();
      if (engine.status().installed && selection(options.dit, options.encoder).every(id => catalog.find(item => item.id === id)?.downloaded)) break;
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
  const results = { mode: 'turbo-4step', sampler: { steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple', negativePrompt: '' } };
  try {
    console.log('Real text-to-image inference');
    const first = await engine.generate({ ...options, prompt: 'A full body studio photograph of one adult wearing a blue jacket, white shirt, black trousers and sneakers, standing naturally against a plain light gray background, realistic lighting, fully clothed, no text.' }, log);
    results.textToImage = save('text-to-image.png', first.images[0]);
    console.log('Real reference-image inference');
    const second = await engine.generate({ ...options, images: [first.images[0]], prompt: 'Use Image 1 as the reference. Keep the same person, face, hairstyle, blue jacket, white shirt, black trousers, sneakers and standing pose. Change only the background to a simple indoor cafe with warm soft window lighting. Preserve clothing. No additional people, no text.' }, log);
    results.referenceImage = save('reference-image.png', second.images[0]);
    if (first.images[0] === second.images[0]) throw new Error('Reference edit returned unchanged image');
    results.status = 'passed';
    results.runtime = await engine.json(engine.url('/system_stats'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log('PASS real text-to-image and reference-image inference:', output);
  } finally { engine.stop(); }
})().catch(error => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', error: error.message }, null, 2)); console.error(error.message); engine.stop(); process.exitCode = 1; });

// Real inference using synthetic references from the original smoke test.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { PNG } = require('pngjs');
const { WeightStore } = require('../src/local-weights.cjs');
const { LocalEngine } = require('../src/local-ai.cjs');
const root = process.env.FIGFACTORY_DATA || path.join(os.homedir(), 'Library/Application Support/BodyFactory 形体工坊');
const sceneOnly = process.argv.includes('--scene-only');
const output = path.join(root, 'local-smoke', sceneOnly ? 'scene-retest' : 'stages');
const engine = new LocalEngine(path.join(root, 'local-engine'), new WeightStore(path.join(root, 'local-models')));
const reference = name => 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'local-smoke', name)).toString('base64');
const record = { status: 'running', steps: [], visualQuality: 'pending review' };
const write = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(record, null, 2));
process.on('SIGINT', () => { engine.stop(); process.exit(130); });
process.on('SIGTERM', () => { engine.stop(); process.exit(143); });
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { buildLocalStages } = await import('../src/js/local-stages.mjs');
  let plan = buildLocalStages({ text: 'A full body studio photograph of one adult standing naturally, fully clothed, no text.', people: [{ id: 1 }], references: [
    { kind: 'clothing', person: 1, url: reference('text-to-image.png') },
    { kind: 'scene', url: reference('reference-image.png') },
    { kind: 'face', person: 1, url: reference('text-to-image.png') },
  ], scene: true });
  let previous;
  if (sceneOnly) {
    plan = plan.filter(step => step.kind === 'scene');
    previous = reference('stages/2-clothing.png');
  }
  write();
  try {
    for (const [index, step] of plan.entries()) {
      const started = Date.now();
      console.log(`START ${index + 1}/${plan.length} ${step.label}`);
      const result = await engine.generate({ dit: 'dit-Q4_K_M', encoder: 'te-w4a8', size: '1024x1024', prompt: step.prompt, images: previous ? [previous, step.reference] : [] }, info => console.log(new Date().toISOString(), step.label, info.message));
      previous = result.images[0];
      const bytes = Buffer.from(previous.split(',')[1], 'base64'), png = PNG.sync.read(bytes);
      if (png.width < 256 || png.height < 256 || new Set(png.data).size < 8) throw new Error('Invalid stage output');
      const filename = `${index + 1}-${step.kind}.png`;
      fs.writeFileSync(path.join(output, filename), bytes);
      record.steps.push({ kind: step.kind, label: step.label, filename, width: png.width, height: png.height, seconds: (Date.now() - started) / 1000 });
      write(); console.log(`DONE ${step.label}`);
    }
    record.status = 'execution-passed'; write();
  } catch (error) { record.status = 'failed'; record.error = error.message; write(); throw error; }
  finally { engine.stop(); }
})().catch(error => { console.error(error); engine.stop(); process.exitCode = 1; });

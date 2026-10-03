const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, readResponse, requestPayload } = require('../src/zenmux.cjs');
const image = 'data:image/png;base64,aGVsbG8=';
const model = { id: 'openai/gpt-image-2.5-flare', protocol: 'openai-images', references: true, maxReferences: 16 };
test('OpenAI reference images use JSON images edits with high input fidelity', () => {
  const request = buildRequest({ model, prompt: 'Preserve identity', images: [image, image] });
  assert.equal(request.url, 'https://zenmux.ai/api/v1/images/edits');
  assert.deepEqual(request.body.images, [{ image_url: image }, { image_url: image }]);
  assert.equal(request.body.input_fidelity, 'high');
  assert.equal(buildRequest({ model, prompt: 'Draw' }).url, 'https://zenmux.ai/api/v1/images/generations');
});
test('Vertex predicts references with IDs and does not use OpenAI endpoint', () => {
  const request = buildRequest({ model: { ...model, id: 'qwen/custom', protocol: 'vertex-predict' }, prompt: 'Draw', images: [image] });
  assert.equal(request.url, 'https://zenmux.ai/api/vertex-ai/v1/publishers/qwen/models/custom:predict');
  assert.equal(request.body.instances[0].referenceImages[0].referenceId, 1);
  assert.equal(request.body.instances[0].referenceImages[0].referenceImage.bytesBase64Encoded, 'aGVsbG8=');
});
test('Reference limits and text-only models cannot silently drop reference images', () => {
  assert.throws(() => buildRequest({ model: { ...model, references: false }, prompt: 'Draw', images: [image] }), /不支持参考图/);
  assert.throws(() => buildRequest({ model: { ...model, maxReferences: 1 }, prompt: 'Draw', images: [image, image] }), /最多接收 1/);
});
test('Gemini generates content with image response modality', () => {
  const request = buildRequest({ model: { ...model, id: 'google/custom', protocol: 'gemini-content' }, prompt: 'Draw', images: [image] });
  assert.ok(request.url.endsWith(':generateContent'));
  assert.deepEqual(request.body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
});
test('Normalize provider responses and report empty results', () => {
  assert.deepEqual(readResponse({ data: [{ b64_json: 'aGVsbG8=' }] }).images, [image]);
  assert.deepEqual(readResponse({ predictions: [{ bytesBase64Encoded: 'aGVsbG8=', mimeType: 'image/png' }] }).images, [image]);
  assert.deepEqual(readResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } }] }).images, [image]);
  assert.equal(readResponse({ choices: [{ message: { content: 'prompt' } }] }, 'text').text, 'prompt');
  assert.throws(() => readResponse({ predictions: [] }), /没有返回图片/);
});
test('Ming models never send rejected sizes and layer model requires one reference', () => {
  const ming = { id: 'inclusionai/ming-image-0.1-design', protocol: 'vertex-predict', references: false, maxReferences: 0 };
  const request = buildRequest({ model: ming, prompt: 'Poster' });
  assert.equal(request.url, 'https://zenmux.ai/api/v1/images/generations');
  assert.equal(request.body.size, undefined);
  assert.equal(request.body.n, undefined);
  const layer = { ...ming, id: 'inclusionai/ming-image-0.1-design-layer', references: true, maxReferences: 1 };
  assert.throws(() => buildRequest({ model: layer, prompt: 'Split' }), /恰好一张/);
  const split = buildRequest({ model: layer, prompt: 'Split into 4 layers', images: [image] });
  assert.equal(split.url, 'https://zenmux.ai/api/v1/images/edits');
  assert.equal(split.body.size, undefined);
  assert.equal(split.body.input_fidelity, undefined);
  assert.equal(split.body.output_format, 'png');
  const uploaded = requestPayload(split);
  assert.equal(uploaded.body.getAll('image[]').length, 1);
  assert.equal(uploaded.body.get('size'), null);
  assert.equal(uploaded.body.get('input_fidelity'), null);
});

test('Local references upload as multipart files with intact bytes, order and parameters', async () => {
  const built = buildRequest({ model, prompt: 'Preserve identity', images: [image, 'data:image/jpeg;base64,d29ybGQ='], size: '1536x1024' });
  const payload = requestPayload(built);
  assert.equal(payload.transport, 'multipart/form-data');
  assert.equal(payload.headers['Content-Type'], undefined);
  assert.equal(payload.body.get('images'), null);
  assert.equal(payload.body.get('prompt'), 'Preserve identity');
  assert.equal(payload.body.get('model'), model.id);
  assert.equal(payload.body.get('size'), '1536x1024');
  assert.equal(payload.body.get('input_fidelity'), 'high');
  const files = payload.body.getAll('image[]');
  assert.deepEqual(files.map(f => [f.name, f.type]), [['reference-1.png', 'image/png'], ['reference-2.jpg', 'image/jpeg']]);
  assert.deepEqual(await Promise.all(files.map(f => f.text())), ['hello', 'world']);
  const wire = new Request(built.url, { method: 'POST', headers: payload.headers, body: payload.body });
  assert.match(wire.headers.get('content-type'), /multipart\/form-data; boundary=/);
  const encoded = await wire.text();
  assert.match(encoded, /name="image\[\]"; filename="reference-1.png"/);
  assert.match(encoded, /Content-Type: image\/png/);
  assert.ok(encoded.includes('hello') && encoded.includes('world'));
});
test('Text and image generation continue to send JSON; malformed edit inputs fail locally', () => {
  const built = buildRequest({ model, prompt: 'Draw' });
  const payload = requestPayload(built);
  assert.equal(payload.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(payload.body), built.body);
  assert.throws(() => requestPayload(buildRequest({ model, prompt: 'Draw', images: ['data:image/png;base64,invalid!'] })), /参考图片格式/);
});

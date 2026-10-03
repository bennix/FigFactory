const { test } = require('node:test');
const assert = require('node:assert/strict');
const { responseFailure } = require('../src/zenmux-errors.cjs');
const args = { status: 500, model: 'openai/gpt-image-2.5-sunburst', endpoint: 'https://zenmux.ai/api/v1/images/edits', imageCount: 1 };
test('500 keeps request ID and context without declaring parameter cause', () => {
  const result = responseFailure({ ...args, data: { error: { type: 'internal_server_error', message: 'Server encountered an unexpected error. (request_id: ba9341ccd98d40609c3978a571361836)' } } });
  assert.equal(result.diagnostics.requestId, 'ba9341ccd98d40609c3978a571361836');
  assert.equal(result.diagnostics.endpoint, '/api/v1/images/edits');
  assert.equal(result.diagnostics.referenceImages, 1);
  assert.match(result.error, /平台或上游返回内部异常/);
});
test('Header request ID is preserved even without a JSON error response', () => {
  const result = responseFailure({ ...args, requestId: 'header-id', data: { error: { message: '非 JSON 响应' } } });
  assert.equal(result.diagnostics.requestId, 'header-id');
});
test('Diagnostics never contain credentials or image/prompt payloads', () => {
  const result = responseFailure({ ...args, key: 'secret-key', data: { error: { message: 'secret-key failed' } } });
  assert.ok(!JSON.stringify(result).includes('secret-key'));
  assert.deepEqual(Object.keys(result.diagnostics), ['time', 'model', 'endpoint', 'referenceImages', 'transport', 'status', 'errorType', 'requestId']);
});

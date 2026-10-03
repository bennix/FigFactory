const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readTextStream } = require('../src/zenmux-stream.cjs');
async function* bytes(value) { for (const byte of Buffer.from(value)) yield Uint8Array.of(byte); }
test('SSE handles split UTF-8, CRLF, comments and incremental content', async () => {
  const updates = [];
  const body = ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n';
  assert.equal((await readTextStream(bytes(body), text => updates.push(text))).text, '你好世界');
  assert.deepEqual(updates, ['你好', '你好世界']);
});
test('SSE surfaces provider failure and truncation without returning a partial success', async () => {
  await assert.rejects(readTextStream(bytes('data: {"error":{"message":"provider failed"}}\n\n'), () => {}), /provider failed/);
  await assert.rejects(readTextStream(bytes('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {}), /提前中断/);
});

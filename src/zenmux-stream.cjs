// Decode OpenAI-compatible SSE without losing split UTF-8 characters or frames.
async function readTextStream(body, onText) {
  const decoder = new TextDecoder();
  let pending = '', text = '', finished = false;
  function frame(value) {
    const lines = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    if (!lines.length) return;
    const data = lines.join('\n');
    if (data === '[DONE]') { finished = true; return; }
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message || '文字流式请求失败。');
    const choice = event.choices?.[0];
    const content = choice?.delta?.content;
    const delta = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('') : '';
    if (delta) { text += delta; onText(text); }
    if (choice?.finish_reason) finished = true;
  }
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      frame(pending.slice(0, boundary.index));
      pending = pending.slice(boundary.index + boundary[0].length);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) frame(pending);
  if (!finished) throw new Error('文字输出连接提前中断，请重试。');
  if (!text) throw new Error('模型没有返回提示词文本。');
  return { text };
}
module.exports = { readTextStream };

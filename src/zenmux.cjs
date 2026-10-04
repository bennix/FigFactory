// Protocols verified against ZenMux documentation; model availability may change.
const BASE = 'https://zenmux.ai/api/v1';
function parseImage(url) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw new Error('参考图片格式不正确，请使用 PNG、JPEG 或 WebP。');
  return { mimeType: match[1], bytesBase64Encoded: match[2] };
}
function buildRequest({ model, prompt, images = [], purpose = 'image', stream = false, size = '1024x1024' }) {
  if (!model?.id || !prompt?.trim()) throw new Error('请选择模型并填写提示词。');
  if (purpose === 'text') return {
    url: `${BASE}/chat/completions`,
    body: { model: model.id, stream, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(image_url => ({ type: 'image_url', image_url: { url: image_url } }))] }] },
  };
  if (model.id === 'inclusionai/ming-image-0.1-design-layer' && images.length !== 1) throw new Error('Ming Design Layer 必须接收恰好一张参考图。');
  if (images.length && !model.references) throw new Error('此模型不支持参考图，请更换模型或关闭参考图。');
  if (images.length > model.maxReferences) throw new Error(`此模型最多接收 ${model.maxReferences} 张参考图，当前 ${images.length} 张。`);
  if (model.id === 'x-ai/grok-imagine-image-2.0') {
    const [width, height] = size.split('x').map(Number);
    return {
      url: `${BASE}/images/${images.length ? 'edits' : 'generations'}`,
      body: { model: model.id, prompt, n: 1, response_format: 'b64_json', resolution: '1k', aspect_ratio: width === height ? '1:1' : width > height ? '3:2' : '2:3', ...(images.length ? { images: images.map(image_url => ({ image_url })) } : {}) },
    };
  }
  const ming = ['inclusionai/ming-image-0.1-design', 'inclusionai/ming-image-0.1-design-layer'].includes(model.id);
  if (ming || model.protocol === 'openai-images') return {
    url: `${BASE}/images/${images.length ? 'edits' : 'generations'}`,
    body: { model: model.id, prompt, output_format: 'png', ...(!ming ? { n: 1, size } : {}), ...(images.length ? { images: images.map(image_url => ({ image_url })), ...(!ming && !/^(?:openai\/)?gpt-image-2$/.test(model.id) ? { input_fidelity: 'high' } : {}) } : {}) },
  };
  const [provider, ...rest] = model.id.split('/');
  if (!rest.length) throw new Error('Vertex 模型名称必须为 provider/model。');
  const path = `https://zenmux.ai/api/vertex-ai/v1/publishers/${encodeURIComponent(provider)}/models/${encodeURIComponent(rest.join('/'))}`;
  if (model.protocol === 'gemini-content') return {
    url: `${path}:generateContent`,
    body: { contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map(url => { const image = parseImage(url); return { inlineData: { mimeType: image.mimeType, data: image.bytesBase64Encoded } }; })] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
  };
  if (model.protocol !== 'vertex-predict') throw new Error('不支持的模型接口。');
  const referenceImages = images.map((url, i) => ({ referenceId: i + 1, referenceType: 'REFERENCE_TYPE_RAW', referenceImage: parseImage(url) }));
  const [width, height] = size.split('x').map(Number);
  return { url: `${path}:predict`, body: {
    instances: [{ prompt, ...(images.length ? { referenceImages } : {}) }],
    parameters: { sampleCount: 1, ...(provider === 'inclusionai' && model.id.startsWith('inclusionai/ming-image-0.1-design') ? { outputOptions: { mimeType: 'image/png' } } : provider === 'openai' ? { imageSize: size } : { aspectRatio: width === height ? '1:1' : width > height ? '3:2' : '2:3' }) },
  } };
}
function readResponse(data, purpose) {
  if (purpose === 'text') {
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : content?.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!text) throw new Error('模型没有返回提示词文本。');
    return { text };
  }
  const images = [];
  for (const item of data.data || []) {
    if (item.b64_json) images.push(`data:image/${data.output_format || (item.b64_json.startsWith('/9j/') ? 'jpeg' : 'png')};base64,${item.b64_json}`);
    else if (item.url) images.push(item.url);
  }
  for (const item of data.predictions || []) {
    if (item.bytesBase64Encoded) images.push(`data:${item.mimeType || 'image/png'};base64,${item.bytesBase64Encoded}`);
    else if (item.gcsUri?.startsWith('https://')) images.push(item.gcsUri);
  }
  for (const candidate of data.candidates || []) for (const part of candidate.content?.parts || []) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) images.push(`data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}`);
  }
  if (!images.length) throw new Error('模型没有返回图片。可能是模型不支持此输入或请求被过滤。');
  return { images };
}
// Follow the documented local-file upload example for image edits.
function requestPayload(request) {
  if (request.url.endsWith('/images/edits')) {
    const form = new FormData();
    for (const [name, value] of Object.entries(request.body)) {
      if (name === 'images') continue;
      form.append(name, String(value));
    }
    for (const [index, image] of request.body.images.entries()) {
      const parsed = parseImage(image.image_url);
      const extension = parsed.mimeType === 'image/jpeg' ? 'jpg' : parsed.mimeType.split('/')[1];
      form.append('image[]', new Blob([Buffer.from(parsed.bytesBase64Encoded, 'base64')], { type: parsed.mimeType }), `reference-${index + 1}.${extension}`);
    }
    // fetch must set the multipart boundary; never supply Content-Type here.
    return { headers: {}, body: form, transport: 'multipart/form-data' };
  }
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), transport: 'application/json' };
}
module.exports = { buildRequest, readResponse, parseImage, requestPayload };

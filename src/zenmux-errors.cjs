// Keep enough request context to diagnose gateway errors without storing user inputs.
function responseFailure({ status, data, requestId, model, endpoint, imageCount, transport = 'application/json', key = '' }) {
  const raw = String(data?.error?.message || data?.message || '服务未返回具体错误说明。');
  const message = key ? raw.replaceAll(key, '[隐藏]') : raw;
  const id = requestId || data?.error?.request_id || data?.request_id || /request_id:\s*([\w-]+)/i.exec(message)?.[1] || null;
  const type = data?.error?.type || null;
  const hint = status >= 500 ? 'ZenMux 平台或上游返回内部异常；仅凭 500 无法确定是否由参考图兼容性引起。稍后手动重试；持续失败时可携带请求编号联系平台支持。'
    : status === 404 ? '请核对模型名称、所选接口和账号是否有模型使用权限。'
    : status === 400 || status === 422 ? '请检查模型是否支持这些参考图和参数。'
    : status === 402 ? '请检查 ZenMux 余额或订阅额度。'
    : status === 403 ? '请检查 API Key 权限或平台返回的内容限制说明。'
    : status === 429 ? '请求频率受限，请稍后再试。' : '请求失败，请查看请求详情。';
  return {
    error: `ZenMux HTTP ${status}：${message.slice(0, 600)}\n${hint}`,
    diagnostics: { time: new Date().toISOString(), model, endpoint: new URL(endpoint).pathname, referenceImages: imageCount, transport, status, errorType: type, requestId: id },
  };
}
module.exports = { responseFailure };

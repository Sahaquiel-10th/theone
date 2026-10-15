import type { Message, ModelConfig } from './types.js';
import { parseProviderUsage } from './modelGateway.js';
import {fetchWithSafeRetries,type ProviderRetryOptions} from './providerRetry.js';

type ImageOutput = { type?: string; status?: string; result?: string; output_format?: string; content?: { type?: string; text?: string }[] };
type ResponsePayload = { status?: string; output?: ImageOutput[]; usage?: unknown };
export class ChatImageGatewayError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) {
    super(code === 'authorization' ? '图片生成授权不可用，请联系管理员核对模型分组'
      : code === 'timeout' ? '图片生成等待超时，结果尚未确认；不会自动重试'
      : '图片生成未完成或结果未确认；不会自动重试');
  }
}

/** No provider text is exposed: errors may echo request data or credentials. */
export function chatImageFailureCategory(payload: unknown) {
  const error = (payload as { error?: { message?: unknown } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (/model.*(not|unknown|unavailable)|模型.*(不存在|不可用)/.test(message)) return 'model_unavailable';
  if (/quota|balance|insufficient|额度|余额/.test(message)) return 'quota';
  if (/auth|permission|forbidden|权限|授权/.test(message)) return 'authorization';
  if (/tool|parameter|参数|工具/.test(message)) return 'tool_or_parameter';
  return 'upstream_unknown';
}

/** Only a completed response with exactly one real image can be accepted. */
export function parseChatImageResponse(payload: ResponsePayload) {
  if (payload?.status !== 'completed' || !Array.isArray(payload.output)) throw new ChatImageGatewayError('incomplete');
  const images = payload.output.filter(item => item.type === 'image_generation_call');
  if (images.length !== 1) throw new ChatImageGatewayError('image_count');
  const image = images[0];
  if (image.status !== 'completed' || typeof image.result !== 'string' || !image.result.length
    || image.result.length > 36 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.result)) throw new ChatImageGatewayError('invalid_image');
  const bytes = Buffer.from(image.result, 'base64');
  if (!bytes.length || bytes.length > 25 * 1024 * 1024 || bytes.toString('base64') !== image.result) throw new ChatImageGatewayError('invalid_image');
  const format = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
    : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'webp' : undefined;
  if (!format || (image.output_format && image.output_format !== format)) throw new ChatImageGatewayError('invalid_image');
  const content = payload.output.filter(item => item.type === 'message').flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n');
  return { content: content || '图片已生成', imageUrl: `data:image/${format};base64,${image.result}`, imageCount: 1 as const,
    usage: parseProviderUsage(payload.usage), finishReason: 'stop' as const };
}

export function parseChatImageSse(body: string) {
  let completed: ResponsePayload | undefined;
  for (const frame of body.replace(/\r\n/g,'\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event: { type?: string; response?: ResponsePayload };
    try { event = JSON.parse(data); } catch { throw new ChatImageGatewayError('invalid_response'); }
    if (['error','response.failed','response.incomplete'].includes(event.type || '')) throw new ChatImageGatewayError('incomplete');
    if (event.type === 'response.completed') {
      if (completed) throw new ChatImageGatewayError('duplicate_completion');
      completed = event.response;
    }
  }
  if (!completed) throw new ChatImageGatewayError('incomplete');
  return parseChatImageResponse(completed);
}

/** Integration boundary only: caller must authorize workspace, reserve picture
 * AND chat cost, and persist the image privately before exposing it to a client.
 * Never automatically retry an uncertain paid call. Not enabled by model name.
 */
export async function callChatImage(model: ModelConfig, messages: Message[], options: { imageModel?: string; timeoutMs?: number; retry?: ProviderRetryOptions } = {}) {
  if (!model.enabled || model.kind !== 'chat' || model.protocol !== 'openai' || !model.apiKey) throw new ChatImageGatewayError('configuration');
  const inputImages = messages.flatMap(m => m.inputImageDataUrls || []);
  if (inputImages.length > 5 || inputImages.some(url => !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url) || url.length > 36 * 1024 * 1024)) throw new ChatImageGatewayError('invalid_input_image');
  const endpoint = new URL(`${model.baseUrl.replace(/\/$/,'')}/responses`);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ChatImageGatewayError('configuration');
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);
  try {
    const response = await fetchWithSafeRetries(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify({ model: model.model, store: false, stream: true, parallel_tool_calls: false, max_output_tokens: 3000,
        input: [...(model.systemPrompt ? [{ role: 'system', content: model.systemPrompt }] : []), ...messages.map(m => ({ role: m.role,
          content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content },
            ...(m.role === 'user' ? (m.inputImageDataUrls || []).map(image_url => ({ type: 'input_image', image_url })) : [])] }))],
        tools: [{ type: 'image_generation', ...(options.imageModel ? { model: options.imageModel } : {}), size: '1024x1024', output_format: 'png' }],
        tool_choice: { type: 'image_generation' } }) }, options.retry);
    const reader = response.body?.getReader();
    if (!reader) throw new ChatImageGatewayError('invalid_response',response.status);
    const chunks: Uint8Array[] = []; let count = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        count += part.value.length;
        if (count > 48 * 1024 * 1024) { controller.abort(); throw new ChatImageGatewayError('oversized_response'); }
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const body = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      let payload: unknown; try { payload = JSON.parse(body); } catch { /* no raw text logging */ }
      throw new ChatImageGatewayError(chatImageFailureCategory(payload),response.status);
    }
    if (response.headers.get('content-type')?.includes('text/event-stream')) return parseChatImageSse(body);
    let payload: ResponsePayload; try { payload = JSON.parse(body); } catch { throw new ChatImageGatewayError('invalid_response'); }
    return parseChatImageResponse(payload);
  } catch (error) {
    if (error instanceof ChatImageGatewayError) throw error;
    throw new ChatImageGatewayError(controller.signal.aborted ? 'timeout' : 'connection');
  } finally { clearTimeout(deadline); }
}

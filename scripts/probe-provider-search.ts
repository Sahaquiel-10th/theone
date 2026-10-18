import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { decryptCredential } from '../server/knowledge/credentialCipher.js';
import { providerSearchEvidence, safeProbeError } from './provider-search-evidence.js';
import type { ModelConfig } from '../server/types.js';

// Explicit operator diagnostic. Reads model settings only, never conversations,
// private knowledge, local documents, prices or the production usage ledger.
// The supplier may bill this synthetic request. No retries and no config writes.
async function main() {
  if (!process.argv.includes('--allow-supplier-call')) throw Error('opt_in_required');
  let models: ModelConfig[];
  if (process.env.DB_PROVIDER === 'mysql') {
    const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectTimeout: 10_000 });
    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT record_json FROM models');
      models = rows.map(row => typeof row.record_json === 'string' ? JSON.parse(row.record_json) : row.record_json);
    } finally { await connection.end(); }
  } else {
    const db = JSON.parse(await fs.readFile(path.join(process.env.ONE_DATA_DIR || 'data', 'db.json'), 'utf8'));
    models = db.models;
  }
  const candidates = models.filter(model => model.enabled && model.kind === 'chat' && model.protocol === 'openai'
    && new URL(model.baseUrl).hostname === 'app.yylx.io');
  const explicit = process.argv.find(value => value.startsWith('--model-id='))?.slice('--model-id='.length);
  const model = explicit ? candidates.find(model => model.id === explicit) : candidates.find(model => model.isDefault) || (candidates.length === 1 ? candidates[0] : undefined);
  if (!model) throw Error('configured_model_required');
  const key = model.encryptedApiKey ? decryptCredential(model.encryptedApiKey) : model.apiKey;
  if (!key) throw Error('credential_unavailable');
  const endpoint = new URL(`${model.baseUrl.replace(/\/$/, '')}/responses`);
  if (endpoint.origin !== 'https://app.yylx.io' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('invalid_endpoint');
  const preview = process.argv.includes('--preview');
  const tool = preview ? 'web_search_preview' : 'web_search';
  const started = Date.now();
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: model.model, stream: true, store: false, max_output_tokens: 1800,
      tools: [{ type: tool }], tool_choice: 'required',
      input: 'Perform one real web search to find the official MDN Geolocation API documentation. In at most two sentences, say whether browser geolocation requires user permission and cite the MDN source. Use only this public question. Do not create files, use other tools, or pretend to search if web search is unavailable.' }) });
  const requestIdValue = response.headers.get('x-request-id');
  const requestId = requestIdValue && /^[A-Za-z0-9_.:-]{1,160}$/.test(requestIdValue) && !requestIdValue.startsWith('sk-') ? requestIdValue : undefined;
  const base = { stage: 'supplier_native_search', modelId: model.id, model: model.model, tool, httpStatus: response.status, requestId };
  if (!response.body) throw Error('empty_response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', bytes = 0, completed: Record<string, unknown> | undefined, failure: ReturnType<typeof safeProbeError> | undefined;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 1024 * 1024) throw Error('response_too_large');
      pending += decoder.decode(part.value, { stream: true });
      if (!response.headers.get('content-type')?.includes('text/event-stream')) continue;
      pending = pending.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.type === 'response.completed') completed = event.response;
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) failure = safeProbeError(event.response || event);
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    try {
      const body = JSON.parse(pending);
      if (response.ok && body.object === 'response') completed = body;
      else failure = safeProbeError(body);
    } catch { failure = { code: undefined, hint: 'non_protocol_response' }; }
  }
  const evidence = providerSearchEvidence(completed || {});
  const usage = completed?.usage as any;
  console.log(JSON.stringify({ ...base, elapsedMs: Date.now() - started, ...evidence,
    inputTokens: Number.isSafeInteger(usage?.input_tokens) ? usage.input_tokens : undefined,
    outputTokens: Number.isSafeInteger(usage?.output_tokens) ? usage.output_tokens : undefined,
    error: failure, passed: response.ok && !failure && evidence.passed }));
  if (!response.ok || failure || !evidence.passed) process.exitCode = 1;
}
main().catch(error => {
  const known = ['opt_in_required', 'configured_model_required', 'credential_unavailable', 'invalid_endpoint', 'response_too_large', 'empty_response'];
  console.log(JSON.stringify({ stage: 'supplier_native_search', passed: false,
    error: known.includes(error?.message) ? error.message : error?.name === 'TimeoutError' ? 'timeout' : 'probe_failed',
    note: 'No automatic retry. Credentials, private content and upstream error bodies were not logged.' }));
  process.exitCode = 1;
});

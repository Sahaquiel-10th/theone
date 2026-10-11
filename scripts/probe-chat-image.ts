import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { decryptCredential } from '../server/knowledge/credentialCipher.js';
import type { ModelConfig } from '../server/types.js';
import { callChatImage, ChatImageGatewayError } from '../server/responsesImageGateway.js';

// Explicit, single paid diagnostic. No user content, ledger writes or retries.
// Never print keys, upstream bodies, base64 or provider URLs.
async function main() {
  // Do not initialize the application Store: initialization may migrate/write.
  // Production diagnostic reads ONLY model configuration, never user history.
  const models: ModelConfig[] = process.argv[2] === '--mysql' ? await readModels() : JSON.parse(fs.readFileSync(process.argv[2] || 'data/db.json', 'utf8')).models;
  if (process.argv.includes('--list-models')) {
    console.log(JSON.stringify(models.map(m=>({id:m.id,model:m.model,kind:m.kind,enabled:m.enabled,protocol:m.protocol,hasKey:!!(m.encryptedApiKey||m.apiKey)}))));
    return;
  }
  const configured = models.find(m => m.enabled && m.kind === 'chat' && m.protocol === 'openai' && (!process.argv[3] || m.id === process.argv[3] || m.model === process.argv[3]));
  if (!configured) throw Error('No configured chat model');
  const key = configured.encryptedApiKey ? decryptCredential(configured.encryptedApiKey) : configured.apiKey;
  if (!key) throw Error('No credential');
  const override = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : undefined;
  const model = { ...configured, apiKey: key, model: override || configured.model, systemPrompt:'' };
  const result = await callChatImage(model,[{role:'user',content:'Generate exactly one small image: a plain blue circle on a white background. No text. This is an API integration test.',createdAt:new Date().toISOString()}],
    process.argv.includes('--default-image-tool') ? {} : {imageModel:'gpt-image-2'});
  const bytes = Buffer.from(result.imageUrl.split(',')[1],'base64');
  console.log(JSON.stringify({stage:'chat_image',model:model.model,completed:true,imageCalls:result.imageCount,
    bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),usage:result.usage,passed:true}));
}
async function readModels(): Promise<ModelConfig[]> {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_DATABASE || !process.env.MYSQL_USER) throw Error('Database configuration unavailable');
  const connection = await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectTimeout:5000});
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>({sql:'SELECT record_json FROM models',timeout:5000});
    return rows.map(row=>typeof row.record_json==='string'?JSON.parse(row.record_json):row.record_json);
  } finally { await connection.end(); }
}
main().catch(error=>{
  console.error(JSON.stringify({stage:'chat_image',passed:false,
    code:error instanceof ChatImageGatewayError ? error.code : 'configuration',
    httpStatus:error instanceof ChatImageGatewayError ? error.httpStatus : undefined,
    automaticRetry:false}));
  process.exitCode=1;
});

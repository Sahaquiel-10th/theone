import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import mysql from 'mysql2/promise';

// Explicit, authorized activation. This changes no database/model/price records.
const root = '/srv/theone', file = `${root}/shared/.env`;
const modelId = process.argv[2];
if (process.getuid?.() !== 0 || !/^mdl_[a-zA-Z0-9]+$/.test(modelId || '')) throw Error('Run with sudo and a configured model id');
const previous = fs.readFileSync(file, 'utf8'), config = parse(previous);
if (config.DB_PROVIDER !== 'mysql' || config.MYSQL_DATABASE !== 'theone_prod') throw Error('Production database scope mismatch');
const db = await mysql.createConnection({ host: config.MYSQL_HOST || '127.0.0.1', port: Number(config.MYSQL_PORT || 3306), user: config.MYSQL_USER, password: config.MYSQL_PASSWORD, database: config.MYSQL_DATABASE });
try {
  const [rows] = await db.execute('SELECT record_json FROM models WHERE id = ?', [modelId]);
  const model = typeof rows[0]?.record_json === 'string' ? JSON.parse(rows[0].record_json) : rows[0]?.record_json;
  if (!model?.enabled || model.protocol !== 'openai' || model.kind !== 'chat' || !model.pricing?.version || !(model.apiKey || model.encryptedApiKey)) throw Error('Enabled, priced OpenAI model required');
} finally { await db.end(); }
function run(command, args) { const result = spawnSync(command, args, { stdio: 'inherit' }); if (result.status !== 0) throw Error('Activation check failed'); }
run('/usr/bin/node', [`${root}/current/deploy/check-mysql-schema.mjs`, '--env', file]);
const stat = fs.statSync(file), next = `${file}.codex-gateway.${process.pid}.next`;
const replacement = previous.split('\n').filter(line => !/^ONE_CODEX_GATEWAY_(ENABLED|MODEL_ID|URL)=/.test(line)).join('\n').trimEnd()
  + `\nONE_CODEX_GATEWAY_ENABLED=true\nONE_CODEX_GATEWAY_MODEL_ID=${modelId}\nONE_CODEX_GATEWAY_URL=https://theone.aiarrival.cn/api/executor-gateway/v1\n`;
fs.writeFileSync(next, replacement, { mode: 0o600, flag: 'wx' });
fs.chownSync(next, stat.uid, stat.gid);
fs.renameSync(next, file);
try {
  run('systemctl', ['restart', 'theone.service']);
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { healthy = (await fetch('http://127.0.0.1:3091/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!healthy) throw Error('Gateway activation unhealthy');
  console.log('ONE Codex gateway enabled; pricing and user records unchanged. Verify real-device execution separately.');
} catch (error) {
  fs.writeFileSync(next, previous, { mode: 0o600, flag: 'wx' }); fs.chownSync(next, stat.uid, stat.gid); fs.renameSync(next, file);
  spawnSync('systemctl', ['restart', 'theone.service'], { stdio: 'inherit' });
  throw error;
}

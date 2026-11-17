import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// CI-only public fixture dependency. No installation, account or model call.
const directory = process.argv[2];
if (!directory) throw Error('A fresh fixture directory is required');
fs.mkdirSync(directory, { recursive: false });
const version = '0.160.1';
const name = 'codex-package-x86_64-pc-windows-msvc.tar.gz';
const metadataResponse = await fetch(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`,
  { redirect: 'error', signal: AbortSignal.timeout(30_000) });
if (!metadataResponse.ok) throw Error('Official Codex fixture metadata unavailable');
const metadata = await metadataResponse.json();
const asset = metadata.assets?.find(item => item.name === name);
if (!asset || asset.browser_download_url !== `https://github.com/openai/codex/releases/download/rust-v${version}/${name}`
  || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !Number.isSafeInteger(asset.size)
  || asset.size <= 0 || asset.size > 512 * 1024 * 1024) throw Error('Official Codex fixture metadata invalid');
const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) });
if (!response.ok || !response.body) throw Error('Official Codex fixture download failed');
const target = path.join(directory, name), file = fs.openSync(target, 'wx', 0o600);
const digest = crypto.createHash('sha256');
let size = 0;
try {
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > asset.size) throw Error('Codex fixture download exceeds declared size');
    digest.update(chunk); fs.writeSync(file, chunk);
  }
} finally { fs.closeSync(file); }
if (size !== asset.size || `sha256:${digest.digest('hex')}` !== asset.digest) {
  fs.unlinkSync(target); throw Error('Codex fixture checksum mismatch');
}
console.log(JSON.stringify({ artifact: name, size, officialDigest: asset.digest, version }));

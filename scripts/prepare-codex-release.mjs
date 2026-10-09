import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

// Build reviewed public artifacts only. This never installs a tool or runs it.
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const required = name => { const v = value(name); if (!v) throw Error(`${name} required`); return v; };
const version = required('--version'), architecture = required('--architecture');
if (!/^\d+\.\d+\.\d+$/.test(version) || !['arm64','x86_64'].includes(architecture)) throw Error('Invalid reviewed target');
const triple = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const packagePath = path.resolve(required('--package')), output = path.resolve(required('--output'));
const origin = new URL(value('--origin') || 'https://theone.aiarrival.cn');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error('Invalid ONE download origin');
if (fs.existsSync(output)) throw Error('Use a new output directory; previous artifacts are preserved');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const response = await fetch(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`, { redirect:'error' });
if (!response.ok) throw Error('Official release metadata unavailable');
const metadata = await response.json(), asset = metadata.assets?.find(a => a.name === `codex-package-${triple}.tar.gz`);
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || asset.size > 256 * 1024 * 1024) throw Error('Official package has no verified digest');
const officialBytes = fs.readFileSync(packagePath);
if (officialBytes.length !== asset.size || `sha256:${hash(officialBytes)}` !== asset.digest) throw Error('Official package checksum mismatch');
const names = execFileSync('/usr/bin/tar',['-tzf',packagePath],{encoding:'utf8',maxBuffer:1024*1024}).trim().split('\n');
const safe = name => /^[a-zA-Z0-9_./-]+$/.test(name) && !name.split('/').some(p => p === '..');
if (names.some(n => !safe(n))) throw Error('Official package paths need review');
const find = matcher => { const found = names.filter(n => matcher.test(n)); if (found.length !== 1) throw Error(`Package member needs review: ${matcher}`); return found[0]; };
const members = [
  ['bin/codex', find(/(^|\/)codex(?:-(?:aarch64|x86_64)-apple-darwin)?$/), 0o700],
  ['bin/codex-code-mode-host', find(/(^|\/)codex-code-mode-host(?:-(?:aarch64|x86_64)-apple-darwin)?$/), 0o700]
];
members.push(['codex-path/rg',find(/^codex-path\/rg$/),0o700]);
members.push(['codex-package.json',find(/^codex-package\.json$/),0o600]);
for (const label of ['LICENSE','NOTICE']) {
  const result = await fetch(`https://raw.githubusercontent.com/openai/codex/rust-v${version}/${label}`,{redirect:'error'});
  if (!result.ok) throw Error(`Official ${label} missing`);
  const data = Buffer.from(await result.arrayBuffer());
  if (!data.length || data.length > 1024*1024) throw Error(`Official ${label} size invalid`);
  members.push([label,data,0o600]);
}
// Preserve license materials shipped in the official distribution too.
for (const name of names.filter(n => /(?:LICENSE|NOTICE|licenses|COPYING)/i.test(n) && !n.endsWith('/'))) {
  members.push([`third-party/${name.replace(/^\.\//,'')}`,name,0o600]);
}
if (members.length > 40) throw Error('License material count needs review');
const parts = [], licenseFiles = [];
for (const [name,source,mode] of members) {
  const bytes = Buffer.isBuffer(source) ? source : execFileSync('/usr/bin/tar',['-xOzf',packagePath,source],{maxBuffer:320*1024*1024});
  if (!bytes.length || name.length > 99) throw Error('Member size or path needs review');
  const header = Buffer.alloc(512), field = (text,offset) => header.write(text,offset,'ascii');
  field(name,0);field(mode.toString(8).padStart(7,'0'),100);field('0000000',108);field('0000000',116);
  field(bytes.length.toString(8).padStart(11,'0'),124);field('00000000000',136);header.fill(32,148,156);
  header[156]=48;field('ustar',257);field('00',263);
  field(header.reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0'),148);header[154]=0;header[155]=32;
  parts.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  if(name==='LICENSE'||name==='NOTICE'||name.startsWith('third-party/'))licenseFiles.push(name);
}
parts.push(Buffer.alloc(1024));const tar=Buffer.concat(parts);
if(tar.length>384*1024*1024)throw Error('Managed package too large');
const archive=gzipSync(tar);
const name=`codex-macos-${architecture}-${version}.tar.gz`;
const catalog={kind:'one-managed-executors',schemaVersion:1,releasedAt:new Date().toISOString(),releases:[{
  executor:'codex',version,platform:'macos',architecture,url:new URL(`/executor-downloads/${name}`,origin).toString(),
  sourceUrl:asset.browser_download_url,sha256:hash(archive),size:archive.length,entrypoint:'bin/codex',license:'Apache-2.0',licenseFiles
}]};
let signed;
if(value('--private-key')) {
  const key=crypto.createPrivateKey(fs.readFileSync(path.resolve(value('--private-key'))));
  const publicRaw=crypto.createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64url');
  const expected=fs.readFileSync(value('--public-key') || 'config/runtime-update-public-key.txt','utf8').trim();
  if(publicRaw!==expected)throw Error('Signing key differs from launcher trust key');
  const payload=Buffer.from(JSON.stringify(catalog));signed={payload:payload.toString('base64url'),signature:crypto.sign(null,payload,key).toString('base64url')};
}
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),archive,{flag:'wx'});
fs.writeFileSync(path.join(output,signed?'catalog.json':'unsigned-catalog-review.json'),JSON.stringify(signed || catalog,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({artifact:name,sha256:hash(archive),size:archive.length,signed:Boolean(signed),officialPackageDigest:asset.digest,licenseFiles}));

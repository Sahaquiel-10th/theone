import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const triple = 'x86_64-pc-windows-msvc';
const maximumPackageSize = 512 * 1024 * 1024;
const maximumFileSize = 320 * 1024 * 1024;
// The reviewed 0.160.1 Windows package expands to 450,588,539 bytes before
// adding ONE's root LICENSE and NOTICE files. Match the installer allowance.
const maximumUnpackedSize = 512 * 1024 * 1024;
const tarProgram = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';

export function windowsCodexMembers(names) {
  if (!Array.isArray(names) || !names.length || names.length > 256) throw Error('Official package member count needs review');
  const originals = new Set(), normalized = new Set();
  const files = [];
  for (const original of names) {
    if (typeof original !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(original)) throw Error('Official package path needs review');
    const name = original.replace(/^\.\//, '');
    if (!name || name.split('/').some(part => part === '..' || part === '.' || !part)) {
      if (name.endsWith('/') && name.split('/').slice(0, -1).every(part => part && part !== '..' && part !== '.')) continue;
      throw Error('Official package path needs review');
    }
    if (originals.has(original) || normalized.has(name.toLowerCase())) throw Error('Official package has repeated members');
    originals.add(original); normalized.add(name.toLowerCase());
    files.push({ original, name });
  }
  const executable = files.filter(file => new RegExp(`(^|/)codex(?:-${triple})?\\.exe$`).test(file.name));
  const ripgrep = files.filter(file => /(^|\/)codex-path\/rg\.exe$/.test(file.name));
  const metadata = files.filter(file => /(^|\/)codex-package\.json$/.test(file.name));
  if (executable.length !== 1 || ripgrep.length !== 1 || metadata.length !== 1) throw Error('Official package entrypoints need review');
  const members = files.map(file => {
    let destination;
    if (file === executable[0]) destination = 'bin/codex.exe';
    else if (file === ripgrep[0]) destination = 'codex-path/rg.exe';
    else if (file === metadata[0]) destination = 'codex-package.json';
    // The official manifest resolves voice helpers and their DLLs relative to
    // codex-resources. Keep that complete resource tree and its license files.
    else if (file.name.startsWith('codex-resources/')) destination = file.name;
    else if (/\.exe$/i.test(file.name)) destination = `bin/${path.posix.basename(file.name).replace(`-${triple}.exe`, '.exe')}`;
    else if (/(?:LICENSE|NOTICE|COPYING|licenses)/i.test(file.name)) destination = `third-party/${file.name}`;
    else throw Error(`Official package member needs review: ${file.name}`);
    return { source: file.original, path: destination, executable: /\.exe$/i.test(destination) };
  });
  for (const helper of ['bin/codex-code-mode-host.exe', 'codex-resources/codex-windows-sandbox-setup.exe', 'codex-resources/codex-command-runner.exe']) {
    if (!members.some(member => member.path === helper)) throw Error(`Official package helper missing: ${helper}`);
  }
  const outputPaths = members.map(member => member.path.toLowerCase());
  // Match the managed installer's bounded regular-file allowance.
  if (new Set(outputPaths).size !== outputPaths.length || members.length + 2 > 80) throw Error('Managed package members need review');
  return members;
}

export function ustarFileHeader(name, size, executable = false) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.length > 240 || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(size) || size <= 0 || size > maximumFileSize) throw Error('Managed file needs review');
  let filename = name;
  let prefix = '';
  if (name.length > 100) {
    const separator = [...name.matchAll(/\//g)].map(match => match.index)
      .findLast(index => index <= 155 && name.length - index - 1 <= 100);
    if (separator === undefined) throw Error('Managed file path cannot fit ordinary ustar');
    prefix = name.slice(0, separator);
    filename = name.slice(separator + 1);
  }
  const header = Buffer.alloc(512);
  const field = (value, offset) => header.write(value, offset, 'ascii');
  field(filename, 0);
  field((executable ? 0o700 : 0o600).toString(8).padStart(7, '0'), 100);
  field('0000000', 108); field('0000000', 116);
  field(size.toString(8).padStart(11, '0'), 124); field('00000000000', 136);
  header.fill(32, 148, 156); header[156] = 48;
  field('ustar', 257); field('00', 263); field(prefix, 345);
  field(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0'), 148);
  header[154] = 0; header[155] = 32;
  return header;
}

async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? '' : args[index + 1]; };
  const required = flag => { const result = value(flag); if (!result) throw Error(`${flag} required`); return result; };
  const version = required('--version');
  if (!/^\d+\.\d+\.\d+$/.test(version) || value('--architecture') && value('--architecture') !== 'amd64') throw Error('Invalid reviewed Windows target');
  const packagePath = path.resolve(required('--package')), output = path.resolve(required('--output'));
  const origin = new URL(value('--origin') || 'https://theone.aiarrival.cn');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error('Invalid ONE download origin');
  if (fs.existsSync(output)) throw Error('Use a new output directory; previous artifacts are preserved');
  const response = await fetch(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error('Official release metadata unavailable');
  const metadata = await response.json();
  const asset = metadata.assets?.find(item => item.name === `codex-package-${triple}.tar.gz`);
  const expectedSource = `https://github.com/openai/codex/releases/download/rust-v${version}/codex-package-${triple}.tar.gz`;
  if (!asset || asset.browser_download_url !== expectedSource || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximumPackageSize) throw Error('Official package has no verified digest');
  if (!fs.lstatSync(packagePath).isFile() || fs.statSync(packagePath).size !== asset.size || `sha256:${await fileHash(packagePath)}` !== asset.digest) throw Error('Official package checksum mismatch');
  const names = execFileSync(tarProgram, ['-tzf', packagePath], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split(/\r?\n/);
  const members = windowsCodexMembers(names);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'one-windows-codex-package-'));
  try {
    const staged = [];
    for (const [index, member] of members.entries()) {
      const file = path.join(temporary, `member-${index}`);
      const descriptor = fs.openSync(file, 'wx', 0o600);
      try { execFileSync(tarProgram, ['-xOzf', packagePath, member.source], { stdio: ['ignore', descriptor, 'pipe'], maxBuffer: 1024 * 1024 }); }
      finally { fs.closeSync(descriptor); }
      staged.push({ ...member, file });
    }
    for (const label of ['LICENSE', 'NOTICE']) {
      const license = await fetch(`https://raw.githubusercontent.com/openai/codex/rust-v${version}/${label}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!license.ok) throw Error(`Official ${label} missing`);
      const bytes = Buffer.from(await license.arrayBuffer());
      if (!bytes.length || bytes.length > 1024 * 1024 || label === 'LICENSE' && !bytes.toString('utf8').includes('Apache License')) throw Error(`Official ${label} invalid`);
      const file = path.join(temporary, label); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      staged.push({ path: label, executable: false, file });
    }
    const tarPath = path.join(temporary, 'managed.tar');
    const descriptor = fs.openSync(tarPath, 'wx', 0o600);
    let unpackedSize = 0;
    try {
      for (const member of staged) {
        const size = fs.statSync(member.file).size;
        unpackedSize += size;
        if (unpackedSize > maximumUnpackedSize) throw Error('Managed package is too large');
        fs.writeSync(descriptor, ustarFileHeader(member.path, size, member.executable));
        const input = fs.openSync(member.file, 'r'), buffer = Buffer.alloc(1024 * 1024);
        try { let count; while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) fs.writeSync(descriptor, buffer, 0, count); }
        finally { fs.closeSync(input); }
        fs.writeSync(descriptor, Buffer.alloc((512 - size % 512) % 512));
      }
      fs.writeSync(descriptor, Buffer.alloc(1024));
    } finally { fs.closeSync(descriptor); }
    const artifact = `codex-windows-amd64-${version}.tar.gz`, archivePath = path.join(temporary, artifact);
    await pipeline(fs.createReadStream(tarPath), createGzip(), fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
    const sha256 = await fileHash(archivePath), size = fs.statSync(archivePath).size;
    if (size > maximumPackageSize) throw Error('Managed compressed package is too large');
    const licenseFiles = staged.filter(member => /(?:LICENSE|NOTICE|COPYING|licenses)/i.test(member.path)).map(member => member.path);
    const catalog = { kind: 'one-managed-executors', schemaVersion: 1, releasedAt: new Date().toISOString(), releases: [{
      executor: 'codex', version, platform: 'windows', architecture: 'amd64', url: new URL(`/executor-downloads/${artifact}`, origin).toString(),
      sourceUrl: asset.browser_download_url, sha256, size, entrypoint: 'bin/codex.exe', license: 'Apache-2.0', licenseFiles
    }] };
    let signed;
    if (value('--private-key')) {
      const key = crypto.createPrivateKey(fs.readFileSync(path.resolve(value('--private-key'))));
      if (key.asymmetricKeyType !== 'ed25519') throw Error('Signing key must be Ed25519');
      const publicRaw = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
      const expected = fs.readFileSync(value('--public-key') || 'config/runtime-update-public-key.txt', 'utf8').trim();
      if (publicRaw !== expected) throw Error('Signing key differs from launcher trust key');
      const payload = Buffer.from(JSON.stringify(catalog));
      signed = { payload: payload.toString('base64url'), signature: crypto.sign(null, payload, key).toString('base64url') };
    }
    fs.mkdirSync(output, { recursive: false });
    fs.copyFileSync(archivePath, path.join(output, artifact), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(output, signed ? 'catalog.json' : 'unsigned-catalog-review.json'), JSON.stringify(signed || catalog, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ artifact, sha256, size, unpackedSize, files: staged.map(member => member.path), signed: Boolean(signed), officialPackageDigest: asset.digest, licenseFiles }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

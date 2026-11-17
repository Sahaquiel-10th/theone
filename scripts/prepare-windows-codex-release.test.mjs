import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { windowsCodexMembers, ustarFileHeader } from './prepare-windows-codex-release.mjs';

const official = [
  'bin/codex.exe', 'bin/codex-code-mode-host.exe',
  'codex-resources/codex-windows-sandbox-setup.exe', 'codex-resources/codex-command-runner.exe',
  'codex-path/rg.exe', 'codex-package.json', 'licenses/ripgrep/LICENSE-MIT'
];

test('Windows package retains the main executable, every helper, ripgrep and license material', () => {
  const members = windowsCodexMembers([...official, 'codex-extra-helper.exe']);
  assert.equal(members.find(member => member.source === official[0]).path, 'bin/codex.exe');
  for (const helper of ['bin/codex-code-mode-host.exe', 'codex-resources/codex-windows-sandbox-setup.exe', 'codex-resources/codex-command-runner.exe', 'bin/codex-extra-helper.exe']) assert(members.some(member => member.path === helper && member.executable));
  assert(members.some(member => member.path === 'codex-path/rg.exe'));
  assert(members.some(member => member.path === 'third-party/licenses/ripgrep/LICENSE-MIT' && !member.executable));
});

test('official voice resources retain their complete relative layout and executable locations', () => {
  const resources = [
    'codex-resources/voice/bin/codex-voice-host.exe',
    'codex-resources/voice/bin/gio-2.0-0.dll',
    'codex-resources/voice/bin/libgstreamer-1.0-0.dll',
    'codex-resources/voice/lib/gstreamer-1.0/gstcoreelements.dll',
    'codex-resources/voice/runtime.json',
    'codex-resources/voice/windows-crt.json',
    'codex-resources/voice/manifest.json',
    'codex-resources/voice/NOTICE.md',
    'codex-resources/voice/licenses/LGPL-2.1.txt',
    'codex-resources/voice/licenses/PCRE2.md',
  ];
  const members = windowsCodexMembers([...official, 'codex-resources/', 'codex-resources/voice/', ...resources]);
  for (const resource of resources) {
    const member = members.find(candidate => candidate.source === resource);
    assert.equal(member.path, resource);
    assert.equal(member.executable, resource.endsWith('.exe'));
  }
  assert(!members.some(member => member.path === 'bin/codex-voice-host.exe'));
});

test('the complete reviewed 0.160.1 Windows inventory preserves all 45 original paths', () => {
  const fixture = new URL('../docs/testing/2026-11-17-codex-bridge/windows-codex-0.160.1-inventory.json', import.meta.url);
  const inventory = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.equal(inventory.files.length, 45);
  assert.equal(inventory.files.reduce((sum, file) => sum + file.size, 0), 450_588_539);
  const members = windowsCodexMembers(inventory.files.map(file => file.path));
  assert.equal(members.length, 45);
  for (const file of inventory.files) {
    assert.equal(members.find(member => member.source === file.path).path, file.path);
    assert.equal(ustarFileHeader(file.path, file.size).length, 512);
  }
});

test('Windows repackaging rejects paths, collisions and incomplete helper packages', () => {
  for (const invalid of [
    [...official, '../escape.exe'], [...official, '/escape.exe'], [...official, 'folder/./escape.exe'],
    [...official, 'codex-extra-helper.exe', 'CODEX-EXTRA-HELPER.exe'], [...official, official[0]],
    official.filter(name => !name.endsWith('codex-code-mode-host.exe')), [...official, 'unknown-data.txt']
  ]) assert.throws(() => windowsCodexMembers(invalid));
});

test('managed Windows headers are checksummed regular ustar files', () => {
  const header = ustarFileHeader('bin/codex.exe', 12345, true);
  assert.equal(header.length, 512);
  assert.equal(header[156], 48);
  assert.equal(header.subarray(257, 263).toString('ascii'), 'ustar\0');
  assert.equal(parseInt(header.subarray(124, 136).toString('ascii'), 8), 12345);
  const stored = parseInt(header.subarray(148, 154).toString('ascii'), 8);
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  assert.equal(stored, checksum);
  for (const [name, size] of [['../escape', 1], ['/absolute', 1], ['bin/empty.exe', 0], ['bin/codex.exe', Infinity], ['bin/codex.exe', 321 * 1024 * 1024]]) assert.throws(() => ustarFileHeader(name, size));
});

test('ordinary ustar prefix preserves longer official resource paths', () => {
  const name = `codex-resources/voice/lib/gstreamer-1.0/${'nested-runtime-'.repeat(5)}/synthetic-library.dll`;
  assert(name.length > 100);
  const header = ustarFileHeader(name, 1024);
  const filename = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('ascii').replace(/\0.*$/, '');
  assert.equal(`${prefix}/${filename}`, name);
  assert.equal(header[156], 48);
  assert.throws(() => ustarFileHeader(`codex-resources/${'a'.repeat(101)}`, 1));
});

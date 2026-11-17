import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsCodexMembers, ustarFileHeader } from './prepare-windows-codex-release.mjs';

const official = [
  'codex-x86_64-pc-windows-msvc.exe', 'codex-code-mode-host-x86_64-pc-windows-msvc.exe',
  'codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe', 'codex-command-runner-x86_64-pc-windows-msvc.exe',
  'codex-path/rg.exe', 'codex-package.json', 'licenses/ripgrep/LICENSE-MIT'
];

test('Windows package retains the main executable, every helper, ripgrep and license material', () => {
  const members = windowsCodexMembers([...official, 'codex-extra-helper.exe']);
  assert.equal(members.find(member => member.source === official[0]).path, 'bin/codex.exe');
  for (const helper of ['codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe', 'codex-extra-helper.exe']) assert(members.some(member => member.path === `bin/${helper}` && member.executable));
  assert(members.some(member => member.path === 'codex-path/rg.exe'));
  assert(members.some(member => member.path === 'third-party/licenses/ripgrep/LICENSE-MIT' && !member.executable));
});

test('Windows repackaging rejects paths, collisions and incomplete helper packages', () => {
  for (const invalid of [
    [...official, '../escape.exe'], [...official, '/escape.exe'], [...official, 'folder/./escape.exe'],
    [...official, 'codex-extra-helper.exe', 'CODEX-EXTRA-HELPER.exe'], [...official, official[0]],
    official.filter(name => !name.startsWith('codex-code-mode-host')), [...official, 'unknown-data.txt']
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
  for (const [name, size] of [['../escape', 1], ['/absolute', 1], ['bin/empty.exe', 0], ['bin/codex.exe', Infinity]]) assert.throws(() => ustarFileHeader(name, size));
});

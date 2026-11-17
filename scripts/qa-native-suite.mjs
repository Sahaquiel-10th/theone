import {spawn, execFileSync} from 'node:child_process';

// CI-only watchdog for our synthetic native suite. Never targets an unrelated
// process by name; retain the one child handle from this invocation.
const executable = process.argv[2];
if (!executable) throw new Error('Native suite executable required');
const child = spawn(executable, [], {stdio: ['ignore','inherit','inherit']});
const timer = setTimeout(() => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  console.error('Native suite exceeded its 45 second deadline; sampling its owned process.');
  try {
    const sample = execFileSync('/usr/bin/sample', [String(child.pid), '1', '1'], {encoding:'utf8',timeout:8000,maxBuffer:1024*1024});
    console.error(sample);
  } catch (error) { console.error('Native process sample unavailable:', error.code ?? 'unknown'); }
  child.kill('SIGKILL');
}, 45000);
child.once('error', error => {clearTimeout(timer); console.error(error.message); process.exitCode=1;});
child.once('close', code => {clearTimeout(timer); process.exitCode=code ?? 1;});

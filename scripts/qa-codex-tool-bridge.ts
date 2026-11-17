import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';

// Real Codex process with a local synthetic Responses service. This verifies
// the pinned executable's tool protocol without using a supplier or an account.
const executable = process.argv[2];
const controllerFixture = process.argv[3];
const commandFirst = process.argv.includes('--command-first');
const environmentProof = process.argv.includes('--environment-proof');
const startupProof = process.argv.includes('--startup-proof');
assert(!environmentProof || commandFirst && controllerFixture, 'Environment proof requires a production controller command fixture');
const syntheticToken = 'SYNTHETIC_HTTP_AUTH_ONLY_NEVER_A_REAL_TOKEN';
assert(executable && fs.existsSync(executable), 'Pass the fixed Codex executable');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'one-tool-bridge-'));
const home = path.join(directory, 'home');
const project = path.join(directory, 'project');
fs.mkdirSync(home, { mode: 0o700 });
fs.mkdirSync(project, { mode: 0o700 });
if(environmentProof)fs.writeFileSync(path.join(home,'config.toml'),'[shell_environment_policy]\ninherit="all"\nignore_default_excludes=true\n[shell_environment_policy.set]\nONE_EXECUTOR_TOKEN="SYNTHETIC_INJECTED_SET_TOKEN"\nONE_QA_INJECTED_TOKEN="SYNTHETIC_INJECTED_SET_TOKEN"\n');
const startupMarkers=['home-mcp-started','project-mcp-started','hook-started'].map(name=>path.join(directory,name));
if(startupProof){
  assert(controllerFixture&&process.platform!=='win32','Startup marker proof currently uses the Mac production fixture');
  const git=spawnSync('/usr/bin/git',['-c','init.templateDir=','init','--quiet',directory],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  assert.equal(git.status,0,'Initialize the isolated parent repository');
  const mcp=(marker:string)=>`command="/usr/bin/touch"\nargs=[${JSON.stringify(marker)}]\nstartup_timeout_sec=1\nenabled=true\n`;
  const hookCommand=`/usr/bin/touch '${startupMarkers[2].replaceAll("'","'\\''")}'`;
  fs.appendFileSync(path.join(home,'config.toml'),`\n[projects.${JSON.stringify(directory)}]\ntrust_level="trusted"\n[mcp_servers.one_home_startup]\n${mcp(startupMarkers[0])}\n[hooks]\nSessionStart=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]\n`);
  fs.mkdirSync(path.join(directory,'.codex'));
  fs.writeFileSync(path.join(directory,'.codex','config.toml'),`[features]\nplugins=true\ncodex_hooks=true\nhooks=true\nplugin_hooks=true\n[mcp_servers.one_project_startup]\n${mcp(startupMarkers[1])}`);
}
const marker = 'ONE-QA-CODEX-BRIDGE-20261117';
let modelRequests = 0;
let writes = 0;
const calls = new Map<string, string>();
const callbacks: string[] = [];
const notifications = new Set<string>();
const toolItems: Array<{ event: string; type: string; status?: string; success?: boolean; keys: string[] }> = [];
let threadId = '';
let turnId = '';
let protocolError: Error | undefined;
let toolCatalog: Array<{type:string;name?:string;tools?:Array<{type:string;name?:string}>}> = [];
const outside = path.join(directory, 'outside-synthetic.txt');
if (commandFirst) fs.writeFileSync(outside, 'SYNTHETIC_OUTSIDE_SCOPE');

function fixtureCommand() {
  const blocked = path.join(directory, 'blocked.txt');
  if (process.platform === 'win32') {
    const quote = (value:string) => `'${value.replaceAll("'", "''")}'`;
    const proof=environmentProof?`; $e='TOKEN_HIDDEN'; if($env:ONE_EXECUTOR_TOKEN -or $env:ONE_QA_INJECTED_TOKEN){$e='TOKEN_VISIBLE'}; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'environment-proof.txt'),$e)`:'';
    return `$ErrorActionPreference='Stop'; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'command-proof.txt'), ${quote(marker)}); $r='READ_DENIED'; try {[System.IO.File]::ReadAllText(${quote(outside)}) | Out-Null; $r='READ_ALLOWED'} catch {}; $w='WRITE_DENIED'; try {[System.IO.File]::WriteAllText(${quote(blocked)}, 'blocked'); $w='WRITE_ALLOWED'} catch {}; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'scope-proof.txt'), "$r $w"); Write-Output "$r $w"${proof}`;
  }
  const quote = (value:string) => `'${value.replaceAll("'", "'\\''")}'`;
  const proof=environmentProof?`; if [ -n "\${ONE_EXECUTOR_TOKEN-}" ] || [ -n "\${ONE_QA_INJECTED_TOKEN-}" ]; then printf TOKEN_VISIBLE; else printf TOKEN_HIDDEN; fi > environment-proof.txt`:'';
  return `printf %s ${quote(marker)} > command-proof.txt; if cat ${quote(outside)} >/dev/null 2>&1; then r=READ_ALLOWED; else r=READ_DENIED; fi; if (printf blocked > ${quote(blocked)}) 2>/dev/null; then w=WRITE_ALLOWED; else w=WRITE_DENIED; fi; printf '%s %s' "$r" "$w" > scope-proof.txt; cat scope-proof.txt${proof}`;
}

function stream(response: http.ServerResponse, step: number) {
  const logicalStep = step - (commandFirst ? 1 : 0);
  const responseId = `resp_fixture_${step}`;
  const responseBase = { id: responseId, object: 'response', model: 'one-executor',
    created_at: 0, status: 'in_progress', output: [] };
  const output = commandFirst && step === 0
    ? {id:'fc_native_command',type:'function_call',status:'completed',name:'exec_command',call_id:'native_command',
      arguments:JSON.stringify({cmd:fixtureCommand(),workdir:project,yield_time_ms:1000,max_output_tokens:2000})}
    : logicalStep < 2 || logicalStep === 3
    ? { id: `fc_${step}`, type: 'function_call', status: 'completed',
      name: logicalStep === 1 ? 'one_fixture_save' : 'one_fixture_read',
      call_id: `fixture_call_${step}`, arguments: JSON.stringify(logicalStep === 1 ? { content: marker } : {}) }
    : { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: marker, annotations: [] }] };
  const events = [
    { type: 'response.created', response: responseBase },
    { type: 'response.output_item.added', output_index: 0, item: output },
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response: { ...responseBase, status: 'completed', output: [output],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 0 } } } }
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert(request.url?.endsWith('/responses'));
    if(environmentProof)assert.equal(request.headers.authorization,`Bearer ${syntheticToken}`,'Model service must retain its separate synthetic authentication');
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString();
      assert(body.length < 2_000_000);
    }
    const input = JSON.parse(body);
    if(environmentProof) { assert(!body.includes(syntheticToken),'Authentication must not enter model input'); assert(!body.includes('SYNTHETIC_INJECTED_SET_TOKEN'),'Loaded shell token must not enter model input'); }
    if (!toolCatalog.length) toolCatalog = input.tools.map((tool:any) => ({type:tool.type,name:tool.name,
      ...(tool.tools ? {tools:tool.tools.map((nested:any)=>({type:nested.type,name:nested.name}))} : {})}));
    assert(input.tools.some((tool: { name?: string }) => tool.name === 'one_fixture_read'));
    stream(response, modelRequests++);
  } catch (error) {
    protocolError = error as Error;
    response.writeHead(500).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const settings = [
  'model="one-executor"', 'model_provider="one_fixture"', 'web_search="disabled"',
  'model_providers.one_fixture.name="ONE fixture"',
  `model_providers.one_fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
  'model_providers.one_fixture.wire_api="responses"',
  'model_providers.one_fixture.requires_openai_auth=false',
  'model_providers.one_fixture.request_max_retries=0',
  'model_providers.one_fixture.stream_max_retries=0'
];
const environment = { ...process.env, CODEX_HOME: home, NO_PROXY: 'localhost,127.0.0.1' };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ONE_EXECUTOR_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete (environment as Record<string, string | undefined>)[key];
}
if(environmentProof) { (environment as Record<string,string|undefined>).ONE_QA_ENV_PROOF='1'; (environment as Record<string,string|undefined>).ONE_EXECUTOR_TOKEN=syntheticToken; }
if (controllerFixture) {
  const child = spawn(controllerFixture, [executable, `http://127.0.0.1:${address.port}/v1`, project, home, marker],
    { env: environment, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 45_000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    if (protocolError) throw protocolError;
    const evidence = JSON.parse(output.trim());
    assert(evidence.passed && evidence.canCompleteNormally);
    assert.equal(evidence.writes, 1);
    assert.equal(modelRequests, commandFirst ? 4 : 3);
    if (commandFirst) {
      assert.equal(fs.readFileSync(path.join(project,'command-proof.txt'),'utf8'),marker);
      const scope = fs.readFileSync(path.join(project,'scope-proof.txt'),'utf8');
      assert(scope.includes('WRITE_DENIED'), 'Outside workspace write was not denied');
      if (process.env.ONE_CODEX_PERMISSION_PROFILE) assert(scope.includes('READ_DENIED'), 'Outside workspace read was not denied');
      assert(!fs.existsSync(path.join(directory,'blocked.txt')));
      if(environmentProof)assert.equal(fs.readFileSync(path.join(project,'environment-proof.txt'),'utf8'),'TOKEN_HIDDEN','Loaded shell set must not reintroduce a token');
    }
    assert.equal(fs.readFileSync(path.join(project, 'result.txt'), 'utf8'), marker);
    if(startupProof)assert(startupMarkers.every(marker=>!fs.existsSync(marker)),'Inherited MCP or hooks started a host process');
    // A new controller and a new Codex process load the prior thread from the
    // isolated home. Its original dynamic tools must still be callable.
    const resumed = spawn(controllerFixture, [executable, `http://127.0.0.1:${address.port}/v1`, project, home, marker, evidence.threadId],
      { env: environment, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let resumedOutput = '', resumedErrors = '';
    resumed.stdout.on('data', bytes => { resumedOutput += bytes; });
    resumed.stderr.on('data', bytes => { resumedErrors += bytes; });
    const resumeWatchdog = setTimeout(() => resumed.kill('SIGTERM'), 45_000);
    let resumedEvidence;
    try {
      const [resumedCode] = await once(resumed, 'close');
      assert.equal(resumedCode, 0, resumedErrors);
      resumedEvidence = JSON.parse(resumedOutput.trim());
      assert.equal(resumedEvidence.threadId, evidence.threadId);
      assert.equal(resumedEvidence.writes, 0);
      assert.deepEqual(resumedEvidence.toolCallbacks, ['one_fixture_read']);
      assert.equal(modelRequests, commandFirst ? 6 : 5);
      assert.equal(fs.readFileSync(path.join(project, 'result.txt'), 'utf8'), marker);
      if(startupProof)assert(startupMarkers.every(marker=>!fs.existsSync(marker)),'Resume started an inherited host process');
    } finally {
      clearTimeout(resumeWatchdog);
      if (resumed.exitCode === null) resumed.kill('SIGTERM');
    }
    const result = { ...evidence, runtime: executable, directory, modelRequests, toolCatalog,
      resumedEvidence, resumedAcrossNewProcesses: true,
      ...(commandFirst ? {nativeCommand:true,scopeProof:fs.readFileSync(path.join(project,'scope-proof.txt'),'utf8')} : {}),
      ...(environmentProof ? {environmentProof:'TOKEN_HIDDEN',modelHTTPAuthentication:'synthetic bearer verified'} : {}),
      ...(startupProof?{startupProof:'home/project MCP and hooks did not start'}:{}),
      modelService: 'local synthetic Responses fixture', supplierCalls: 0 };
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
} else {
const child = spawn(executable, [...settings.flatMap(value => ['-c', value]),
  'app-server', '--listen', 'stdio://'], { env: environment, cwd: project,
  stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let complete: (value: any) => void = () => {};
const completed = new Promise<any>(resolve => { complete = resolve; });
const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
const rpc = (method: string, params: object) => new Promise<any>((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  try {
    const frame = JSON.parse(line);
    if (frame.method === 'item/tool/call' && frame.id !== undefined) {
      const call = frame.params;
      assert.equal(call.threadId, threadId);
      if (turnId) assert.equal(call.turnId, turnId);
      assert(['one_fixture_read', 'one_fixture_save'].includes(call.tool));
      callbacks.push(call.tool);
      let text = calls.get(call.callId);
      if (!text) {
        if (call.tool === 'one_fixture_save') {
          assert.equal(call.arguments.content, marker);
          fs.writeFileSync(path.join(project, 'result.txt'), marker, { flag: 'wx', mode: 0o600 });
          writes++;
        }
        text = JSON.stringify(call.tool === 'one_fixture_read'
          ? { content: marker, source: 'synthetic' }
          : { saved: true, artifactRef: 'fixture_artifact', deliveryId: 'fixture_delivery' });
        calls.set(call.callId, text);
      }
      send({ id: frame.id, result: { success: true, contentItems: [{ type: 'inputText', text }] } });
    } else if (frame.id !== undefined && pending.has(frame.id)) {
      const request = pending.get(frame.id)!;
      pending.delete(frame.id);
      if (frame.error) request.reject(new Error(JSON.stringify(frame.error)));
      else request.resolve(frame.result);
    } else if (frame.method) {
      notifications.add(frame.method);
      if (frame.params?.item?.type === 'dynamicToolCall') {
        const item = frame.params.item;
        toolItems.push({ event: frame.method, type: item.type, status: item.status,
          success: item.success, keys: Object.keys(item).sort() });
      }
      if (frame.method === 'turn/completed') complete(frame.params);
    }
  } catch (error) {
    protocolError = error as Error;
    complete(undefined);
  }
});
const timeout = setTimeout(() => {
  protocolError = new Error('Synthetic Codex tool bridge timed out');
  for (const request of pending.values()) request.reject(protocolError);
  complete(undefined);
  child.kill('SIGTERM');
}, 45_000);
try {
  await rpc('initialize', { clientInfo: { name: 'one_bridge_qa', version: '1' },
    capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const thread = await rpc('thread/start', { model: 'one-executor', cwd: project,
    approvalPolicy: 'never', sandbox: 'workspace-write',
    dynamicTools: [
      { type: 'function', name: 'one_fixture_read', description: 'Read synthetic source', inputSchema: schema },
      { type: 'function', name: 'one_fixture_save', description: 'Save synthetic result',
        inputSchema: { ...schema, properties: { content: { type: 'string' } }, required: ['content'] } }
    ] });
  threadId = thread.thread.id;
  const turn = await rpc('turn/start', { threadId, model: 'one-executor',
    input: [{ type: 'text', text: 'Read the synthetic source, save it using the provided tools, then report completion.' }],
    approvalPolicy: 'never' });
  turnId = turn.turn.id;
  const terminal = await completed;
  if (protocolError) throw protocolError;
  assert.equal(terminal?.threadId, threadId);
  assert.equal(terminal?.turn.status, 'completed');
  assert.deepEqual(callbacks, ['one_fixture_read', 'one_fixture_save']);
  assert.equal(writes, 1);
  assert.equal(fs.readFileSync(path.join(project, 'result.txt'), 'utf8'), marker);
  assert.equal(modelRequests, 3);
  const result = { passed: true, runtime: executable, directory, modelRequests, toolCatalog,
    toolCallbacks: callbacks, writes, threadRetained: true, notifications: [...notifications].sort(), toolItems,
    modelService: 'local synthetic Responses fixture', supplierCalls: 0 };
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timeout);
  lines.close();
  child.stdin.end();
  child.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyManagedExecutorCatalog } from '../server/managedExecutorCatalog.js';
const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`${name} required`);return args[i+1];};
const privatePath=value('--private-key'),output=path.resolve(value('--output'));
if(fs.existsSync(output))throw Error('New output directory required');
const key=crypto.createPrivateKey(fs.readFileSync(privatePath));
const publicKey=fs.readFileSync('config/runtime-update-public-key.txt','utf8').trim();
const actual=(crypto.createPublicKey(key).export({format:'der',type:'spki'}) as Buffer).subarray(-32).toString('base64url');
if(actual!==publicKey)throw Error('Signing key mismatch');
const sources=args.filter((a,i)=>i>0&&args[i-1]==='--source').map(p=>path.resolve(p));
if(!sources.length)throw Error('At least one --source required');
const origins=['https://theone.aiarrival.cn'];
const catalogs=sources.map(dir=>verifyManagedExecutorCatalog(JSON.parse(fs.readFileSync(path.join(dir,'catalog.json'),'utf8')),publicKey,origins));
const catalog={kind:'one-managed-executors',schemaVersion:1,releasedAt:new Date().toISOString(),releases:catalogs.flatMap(c=>c.releases)};
const payload=Buffer.from(JSON.stringify(catalog));const envelope={payload:payload.toString('base64url'),signature:crypto.sign(null,payload,key).toString('base64url')};
verifyManagedExecutorCatalog(envelope,publicKey,origins);
const files=catalogs.flatMap((c,i)=>c.releases.map(release=>{
  const name=path.basename(new URL(release.url).pathname),file=path.join(sources[i],name);
  if(!/^codex-macos-(arm64|x86_64)-\d+(?:\.\d+){1,3}\.tar\.gz$/.test(name)||!fs.lstatSync(file).isFile()||fs.statSync(file).size!==release.size
    ||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==release.sha256)throw Error('Package integrity failed');
  return {name,file};
}));
fs.mkdirSync(output,{recursive:true});for(const file of files)fs.copyFileSync(file.file,path.join(output,file.name),fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(output,'catalog.json'),JSON.stringify(envelope,null,2)+'\n',{flag:'wx'});
console.log(`Signed Codex catalog: ${files.length} reviewed package(s)`);

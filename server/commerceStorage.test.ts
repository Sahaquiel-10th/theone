import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { request } from 'node:https';
import sharp from 'sharp';
import { createCommerceImageDownloader, readCommerceImages, saveCommerceImage, COMMERCE_IMAGE_MAX_BYTES } from './commerceStorage.js';
import { defaultCommerceBrief, type CommerceJob, type CommerceVariant } from './commerceTypes.js';

function fixture(taskType:CommerceJob['taskType']='main',kind:CommerceJob['kind']='product_creative'){
  const variant:CommerceVariant={id:'variant',name:'结果',reason:'',headline:'',subline:'',imagePrompt:'',title:'',titleReason:'',status:'generating',attempts:1};
  const job={id:'job',kind,taskType,workspaceId:'workspace',userId:'user',brief:{...defaultCommerceBrief(),productName:'商品'},variants:[variant]} as CommerceJob;
  return {job,variant};
}
const dataUrl=(data:Buffer,mime='image/png')=>`data:${mime};base64,${data.toString('base64')}`;

test('main/SKU and portrait export exact dimensions with contained pixels, private modes and explicit source size',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-storage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=await sharp({create:{width:200,height:100,channels:3,background:'red'}}).png().toBuffer();
  for(const taskType of ['main','sku','portrait'] as const){
    const {job,variant}=fixture(taskType),saved=await saveCommerceImage(dataUrl(source),job,variant,dir),metadata=await sharp(saved.storagePath).metadata();
    assert.equal(metadata.width,1440);assert.equal(metadata.height,taskType==='portrait'?1920:1440);assert.equal(saved.mimeType,'image/png');assert.equal(saved.status,'ready');assert.equal(saved.conversationId,'industry:commerce');assert.equal(saved.workspaceId,job.workspaceId);assert.equal(saved.userId,job.userId);
    assert.equal((await fs.stat(saved.storagePath)).mode&0o777,0o600);assert.equal(variant.sourceWidth,200);assert.equal(variant.sourceHeight,100);assert.match(variant.qualityNote!,/按比例留白/);assert.match(variant.qualityNote!,/这是导出尺寸/);
    const {data,info}=await sharp(saved.storagePath).raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data.subarray(0,3)],[255,255,255]);const center=(Math.floor(info.height/2)*info.width+Math.floor(info.width/2))*info.channels;assert.deepEqual([...data.subarray(center,center+3)],[255,0,0]);
    const loaded=await readCommerceImages([saved]);assert.equal(loaded.length,1);assert.match(loaded[0],/^data:image\/png;base64,/);assert.ok(!loaded[0].includes(dir));
  }
});

test('image edits preserve provider bytes and displayed dimensions, including EXIF orientation',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-native-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const orientation of [1,6]){
    const source=await sharp({create:{width:320,height:211,channels:3,background:'blue'}}).jpeg().withMetadata({orientation}).toBuffer(),{job,variant}=fixture(undefined,'image_edit');
    const saved=await saveCommerceImage(dataUrl(source,'image/jpeg'),job,variant,dir);assert.deepEqual(await fs.readFile(saved.storagePath),source);assert.equal(saved.mimeType,'image/jpeg');
    assert.equal(variant.outputWidth,orientation===6?211:320);assert.equal(variant.outputHeight,orientation===6?320:211);assert.equal(variant.qualityNote,undefined);
  }
  assert.equal((await fs.readdir(dir)).length,2,'each saved image has a fresh non-overwriting path');
});

test('MIME spoofing, truncated pixels, excessive encoded bytes and pixel bombs never create saved files',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-invalid-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const png=await sharp({create:{width:20,height:10,channels:3,background:'red'}}).png().toBuffer(),jpeg=await sharp(png).jpeg().toBuffer();
  const bomb=Buffer.from(png);bomb.writeUInt32BE(10000,16);bomb.writeUInt32BE(10000,20);
  for(const raw of [dataUrl(jpeg),dataUrl(Buffer.from('<svg></svg>')),dataUrl(jpeg.subarray(0,Math.floor(jpeg.length/2)),'image/jpeg'),dataUrl(bomb),`data:image/png;base64,${'A'.repeat(Math.ceil(COMMERCE_IMAGE_MAX_BYTES/3)*4+201)}`]){
    const {job,variant}=fixture(undefined,'image_edit');await assert.rejects(saveCommerceImage(raw,job,variant,dir));
  }
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('image reads reject non-ready, mixed-owner, wrong-scope and symlink attachments',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-read-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const png=await sharp({create:{width:20,height:10,channels:3,background:'red'}}).png().toBuffer(),{job,variant}=fixture(undefined,'image_edit'),saved=await saveCommerceImage(dataUrl(png),job,variant,dir);
  for(const changed of [{status:'parsing'},{conversationId:'teaching:private'},{mimeType:'image/jpeg'},{size:saved.size+1}])await assert.rejects(readCommerceImages([{...saved,...changed} as typeof saved]));
  await assert.rejects(readCommerceImages([saved,{...saved,userId:'another-user'}]));await assert.rejects(readCommerceImages([saved,{...saved,workspaceId:'another-workspace'}]));
  const link=path.join(dir,'symlink.png');await fs.symlink(saved.storagePath,link);await assert.rejects(readCommerceImages([{...saved,storagePath:link}]));
});

type SyntheticResponse={status?:number;headers?:Record<string,string>;body?:Buffer;chunks?:Buffer[];complete?:boolean};
function syntheticTransport(reply:(url:URL,index:number)=>SyntheticResponse,addresses:(host:string)=>Promise<string[]>=async()=>['8.8.8.8']){
  const requests:URL[]=[],pins:string[]=[],resolved:string[]=[];
  const deps={resolve4:(async(host:string)=>{resolved.push(host);return addresses(host);}) as typeof import('node:dns/promises').resolve4,request:((url:URL,options:any,receive:any)=>{
    requests.push(url);assert.equal(options.agent,false);assert.equal(options.family,4);assert.equal(options.headers['Accept-Encoding'],'identity');assert.ok(!options.headers.Authorization);assert.ok(!options.headers.Cookie);
    options.lookup(url.hostname,{},(error:unknown,ip:string,family:number)=>{assert.equal(error,null);assert.equal(family,4);pins.push(ip);});
    const req=new EventEmitter() as any;req.end=()=>{const response=reply(url,requests.length-1);const stream=Readable.from(response.chunks??[response.body??Buffer.alloc(0)]) as any;stream.statusCode=response.status??200;stream.headers=response.headers??{'content-type':'image/png'};stream.complete=response.complete??true;receive(stream);};return req;
  }) as typeof request};
  return {deps,requests,pins,resolved};
}

test('HTTPS downloader pins vetted IPv4 once per hop and retains signed queries without forwarding credentials',async()=>{
  const png=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
  const transport=syntheticTransport((url,index):SyntheticResponse=>index===0?{status:302,headers:{location:'https://cdn.example/final?signature=signed-value'}}:{headers:{'content-type':'image/png','content-length':String(png.length)},body:png},async host=>host==='images.example'?['8.8.8.8']:['1.1.1.1']);
  const downloaded=await createCommerceImageDownloader(transport.deps)('https://images.example/start?signature=original-value');assert.deepEqual(downloaded.data,png);assert.deepEqual(transport.resolved,['images.example','cdn.example']);assert.deepEqual(transport.pins,['8.8.8.8','1.1.1.1']);assert.equal(transport.requests[1].search,'?signature=signed-value');assert.equal(transport.requests[0].hostname,'images.example','TLS hostname remains the original public host');
});

test('downloader refuses unsafe endpoints, mixed/private DNS and redirects into local networks',async()=>{
  const transport=syntheticTransport(()=>({})),download=createCommerceImageDownloader(transport.deps);
  for(const url of ['http://images.example/x','https://127.0.0.1/x','https://[::1]/x','https://localhost/x','https://secret:password@images.example/x','https://images.internal/x','https://images.example:444/x','https://images.example/x#fragment'])await assert.rejects(download(url));
  assert.equal(transport.requests.length,0);assert.equal(transport.resolved.length,0);
  for(const ips of [['8.8.8.8','127.0.0.1'],['169.254.169.254'],['10.0.0.1'],['100.64.0.1'],['::1']]){
    const privateDns=syntheticTransport(()=>({}),async()=>ips);await assert.rejects(createCommerceImageDownloader(privateDns.deps)('https://images.example/x'));assert.equal(privateDns.requests.length,0);
  }
  const redirect=syntheticTransport(()=>({status:302,headers:{location:'https://127.0.0.1/private'}}));await assert.rejects(createCommerceImageDownloader(redirect.deps)('https://images.example/x'));assert.equal(redirect.requests.length,1);
  const rebinding=syntheticTransport(()=>({status:302,headers:{location:'https://private.example/metadata'}}),async host=>host==='private.example'?['169.254.169.254']:['8.8.8.8']);await assert.rejects(createCommerceImageDownloader(rebinding.deps)('https://images.example/x'));assert.equal(rebinding.requests.length,1);
});

test('download bounds redirect count, response size, MIME and total DNS timeout',async()=>{
  const png=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
  const redirects=syntheticTransport((_url,index)=>({status:302,headers:{location:`https://images.example/x?hop=${index+1}`}}));await assert.rejects(createCommerceImageDownloader(redirects.deps)('https://images.example/x'),/跳转过多/);assert.equal(redirects.requests.length,4);
  const responses:SyntheticResponse[]=[
    {headers:{'content-type':'image/png','content-length':'1025'},body:png},
    {headers:{'content-type':'image/png'},chunks:[Buffer.alloc(512),Buffer.alloc(513)]},
    {headers:{'content-type':'image/jpeg'},body:png},
    {headers:{'content-type':'text/html'},body:png},
    {headers:{'content-type':'image/png','content-encoding':'gzip'},body:png},
    {headers:{'content-type':'image/png'},body:png,complete:false},
  ];
  for(const response of responses){const transport=syntheticTransport(()=>response);await assert.rejects(createCommerceImageDownloader(transport.deps)('https://images.example/x',1024));}
  const stalled=syntheticTransport(()=>({}),()=>new Promise(()=>undefined));await assert.rejects(createCommerceImageDownloader(stalled.deps,20)('https://images.example/x'),/超时/);assert.equal(stalled.requests.length,0);
});

test('download and filesystem failures do not disclose provider errors, signatures or private paths',async t=>{
  const transport=syntheticTransport(()=>({}),async()=>{throw Error('PRIVATE_PROVIDER_CREDENTIAL');});
  await assert.rejects(createCommerceImageDownloader(transport.deps)('https://images.example/x?signature=PRIVATE_SIGNATURE'),error=>{
    assert.doesNotMatch((error as Error).message,/PRIVATE_PROVIDER|PRIVATE_SIGNATURE|images\.example/);return true;
  });
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-errors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer(),{job,variant}=fixture(undefined,'image_edit'),saved=await saveCommerceImage(dataUrl(source),job,variant,dir);
  await fs.unlink(saved.storagePath);
  await assert.rejects(readCommerceImages([saved]),error=>{assert.ok(!(error as Error).message.includes(dir));assert.doesNotMatch((error as Error).message,/ENOENT/);return true;});
});

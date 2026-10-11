import express, { type Express, type RequestHandler } from 'express';
import type { Store } from './db.js';
import type { Database } from './types.js';
import { asyncRoute } from './middleware.js';
import { credentialOwner, credentialStatuses, setFeatureCredential, revokeFeatureCredential, toolCredential, verifyCredentialBindings } from './featureCredentials.js';
import { featureAllowedEndpoints, featureMcpEndpoints, featureToolEndpoint } from './featureTools.js';
import { openFeatureMcp, mcpDefinition } from './connectors/featureMcp.js';
import type { ToolExchange } from './connectors/boundedHttps.js';
import { featureEntitled, featureRelease } from './enterprisePolicy.js';

export function credentialEndpointAllowed(db: Database, scope: {workspaceId:string;userId:string}, endpoint:string, auth:string) {
  const user=credentialOwner(db,scope);
  if(!['bearer','api_key'].includes(auth))return false;
  if(user.role==='admin')return [...featureAllowedEndpoints(),...featureMcpEndpoints()].includes(endpoint);
  return (db.settings.officialFeatures??[]).some(f=>f.status==='approved'&&featureEntitled(db,scope,f)&&f.history.find(v=>v.version===featureRelease(db,scope,f)?.version)?.values.tools?.some(t=>{
    try{return t.auth===auth&&featureToolEndpoint(t)===endpoint;}catch{return false;}
  }));
}

export function installFeatureConnectionRoutes(app:Express,keyAuth:readonly RequestHandler[],admin:readonly RequestHandler[],store:Store,verifyKey:(req:express.Request)=>Promise<void>,exchange?:ToolExchange){
  const scope=(req:express.Request)=>({workspaceId:req.workspaceId!,userId:req.user!.id});
  const router=express.Router();router.use(...keyAuth);
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/',asyncRoute(async(req,res)=>{res.json({items:credentialStatuses(await store.read(),scope(req))});}));
  router.post('/',asyncRoute(async(req,res)=>{
    const {endpoint,auth,secret}=req.body??{};
    await verifyKey(req);
    await store.mutate(db=>{if(!credentialEndpointAllowed(db,scope(req),endpoint,auth))throw new Error('denied');setFeatureCredential(db,scope(req),endpoint,auth,secret);});
    res.json({ok:true});
  }));
  router.delete('/',asyncRoute(async(req,res)=>{
    await verifyKey(req);
    const {endpoint,auth}=req.body??{};
    if(typeof endpoint!=='string'||!['bearer','api_key'].includes(auth)){res.status(400).json({error:'凭证标识无效'});return;}
    await store.mutate(db=>revokeFeatureCredential(db,scope(req),endpoint,auth));res.json({ok:true});
  }));
  router.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(400).json({error:'凭证操作失败。请检查 Key、接口权限及凭证格式（8–8000 位，不含空白）'});});
  app.use('/api/feature-credentials',router);

  const discovering=new Set<string>();
  app.post('/api/admin/official-features/mcp-discover',...admin,asyncRoute(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const s=scope(req),key=JSON.stringify(s),{endpoint,auth}=req.body??{};
    if(!featureMcpEndpoints().includes(endpoint)||(auth!==undefined&&!['bearer','api_key'].includes(auth))){res.status(400).json({error:'请选择已审核的 MCP 地址与鉴权方式'});return;}
    if(discovering.has(key)||discovering.size>=4){res.status(429).json({error:'正在发现工具，请稍后再试'});return;}
    discovering.add(key);
    try{
      await verifyKey(req);const db=await store.read();credentialOwner(db,s);
      const credential=toolCredential(db,s,endpoint,auth);
      const bindings=credentialStatuses(db,s).filter(c=>c.endpoint===endpoint&&c.auth===auth);
      const client=await openFeatureMcp(endpoint,credential.headers,exchange);
      const rows=await client.list();
      await verifyKey(req);verifyCredentialBindings(await store.read(),s,bindings);
      // A remote server must not smuggle the supplied secret into saved tool definitions.
      const reflects=(v:unknown):boolean=>typeof v==='string'?!!credential.secret&&v.includes(credential.secret):Array.isArray(v)?v.some(reflects):!!v&&typeof v==='object'&&Object.entries(v).some(([k,val])=>reflects(k)||reflects(val));
      if(rows.some(reflects))throw new Error('secret reflection');
      const tools=rows.flatMap(row=>{try{return [mcpDefinition(row)];}catch{return [];}});
      const unique=tools.filter(t=>tools.filter(other=>other.name===t.name).length===1);
      res.json({tools:unique,unsupported:rows.length-unique.length});
    }catch{res.status(400).json({error:'未能发现工具，请检查本人的凭证、服务协议与只读工具定义。未执行任何工具。'});}
    finally{discovering.delete(key);}
  }));
}

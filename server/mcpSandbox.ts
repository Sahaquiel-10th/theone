import express, {type Express} from 'express';
import {mcpDefinition,mcpValidate} from './connectors/featureMcp.js';
export const syntheticMcpTool=mcpDefinition({name:'synthetic_inventory',description:'查询虚构库存；itemId 101 白板笔、102 笔记本。仅用于验证链路。',inputSchema:{type:'object',properties:{itemId:{type:'integer'}},required:['itemId'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}});
/** Stateless synthetic MCP: no credentials, model, Store or arbitrary reflection. */
export function installMcpSandbox(app:Express){
  const router=express.Router();let start=Date.now(),count=0;
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');if(Date.now()-start>60000){start=Date.now();count=0;}if(++count>120){res.sendStatus(429);return;}if(req.headers.origin&&req.headers.origin!=='https://theone.aiarrival.cn'){res.sendStatus(403);return;}next();});
  router.post('/',express.json({limit:'16kb'}),(req,res)=>{
    const b=req.body;
    if(!b||b.jsonrpc!=='2.0'||JSON.stringify(b).length>16000||(b.id!==undefined&&(!Number.isSafeInteger(b.id)||b.id<0))){res.sendStatus(400);return;}
    if(b.method==='notifications/initialized'&&b.id===undefined){res.sendStatus(202);return;}
    if(b.id===undefined){res.sendStatus(400);return;}
    const reply=(result:unknown)=>res.json({jsonrpc:'2.0',id:b.id,result});
    if(b.method==='initialize'){reply({protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'ONE-synthetic-only',version:'1.0'}});return;}
    if(b.method==='tools/list'){reply({tools:[syntheticMcpTool]});return;}
    if(b.method==='tools/call'&&b.params?.name===syntheticMcpTool.name){
      try{const args=mcpValidate(syntheticMcpTool,b.params.arguments);if(![101,102].includes(args.itemId as number))throw new Error('unsupported');reply({content:[{type:'text',text:args.itemId===101?'虚构白板笔库存：12。':'虚构笔记本库存：0。'}]});return;}catch{res.json({jsonrpc:'2.0',id:b.id,error:{code:-32602,message:'Invalid synthetic input'}});return;}
    }
    res.json({jsonrpc:'2.0',id:b.id,error:{code:-32601,message:'Method not supported'}});
  });
  router.use((_req,res)=>{res.setHeader('Allow','POST');res.sendStatus(405);});app.use('/api/adapter-sandbox/mcp',router);
}

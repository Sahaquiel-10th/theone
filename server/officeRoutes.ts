import fs from 'node:fs/promises';
import type {Express,RequestHandler} from 'express';
import type {Store} from './db.js';
import {asyncRoute} from './middleware.js';
import {ownedAttachment} from './attachmentService.js';
import {featureMember} from './featureRuns.js';
export function installOfficeRoutes(app:Express,auth:readonly RequestHandler[],store:Store){
 app.get('/api/office-files/:id/view',...auth,asyncRoute(async(req,res)=>{
  const db=await store.read(),scope={workspaceId:req.workspaceId!,userId:req.user!.id};featureMember(db,scope);const f=ownedAttachment(db.attachments,scope,String(req.params.id));
  if(f.officeArtifact!=='slides'||f.mimeType!=='text/html'||f.status!=='ready'||f.size>25*1024*1024)return res.status(404).json({error:'演示稿暂时不可用'});
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-downloads allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  const bytes=await fs.readFile(f.storagePath);if(bytes.length!==f.size)return res.status(404).json({error:'演示稿尚未就绪'});res.type('html').send(bytes);
 }));
}

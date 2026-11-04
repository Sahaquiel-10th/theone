import express from "express";
import fs from "node:fs/promises";
import JSZip from "jszip";
import type { Express, Request, RequestHandler } from "express";
import { type IndustryStore as Store, assertIndustryActor, runIndustryOperation } from "./industryState.js";
import { asyncRoute } from "./middleware.js";
import { CommerceService, commerceAttachments, commerceJobAccess, commerceModels, imageEditModel, publicCommerceJob, COMMERCE_MAIN_AGENT_ID, COMMERCE_EDIT_AGENT_ID, commerceRequestActor, type CommerceDependencies } from "./commerce.js";
import { compositionAssetIds } from "./commerceComposition.js";
import { createCommerceMaterialsRouter } from "./commerceMaterials.js";

export type CommerceRouteDependencies = CommerceDependencies & { verifyKey?: (req:Request)=>Promise<void> };
export function installCommerceRoutes(app:Express, keyAuth:readonly RequestHandler[], store:Store, deps:CommerceRouteDependencies) {
  const router = express.Router(), service = new CommerceService(store,deps);
  const ready = service.recover();
  if (deps.autoSchedule !== false) void ready.then(()=>service.tick()).catch(()=>undefined);
  const timer = deps.autoSchedule === false ? undefined : setInterval(()=>{void service.tick().catch(()=>undefined);},10000);
  timer?.unref();
  router.use("/commerce",...keyAuth,(req,res,next)=>{
    res.setHeader("Cache-Control","no-store");
    void ready.then(async()=>{
      assertIndustryActor(await store.read(),commerceRequestActor(req));
      if (!["GET","HEAD"].includes(req.method)) await deps.verifyKey?.(req);
      next();
    }).catch(next);
  });
  router.get("/commerce/config",asyncRoute(async(req,res)=>{
    const db = await store.read(); let ready = true, message = "";
    try { commerceModels(db,commerceRequestActor(req)); } catch(e) { ready=false;message=e instanceof Error ? e.message : "模型暂不可用"; }
    res.json({agentId:COMMERCE_MAIN_AGENT_ID,ready,message});
  }));
  router.get("/commerce/edit-config",asyncRoute(async(req,res)=>{
    const db = await store.read(); let ready=true,message="";
    try { imageEditModel(db); } catch(e) { ready=false;message=e instanceof Error ? e.message : "图片编辑模型暂不可用"; }
    res.json({agentId:COMMERCE_EDIT_AGENT_ID,ready,message});
  }));
  router.post("/commerce/edits", asyncRoute(async (req, res) => {
    const job = await service.createEdit(commerceRequestActor(req), String(req.body.agentId || ""), req.body, String(req.body.requestKey || ""));
    res.status(202).json({ job: publicCommerceJob(job) });
  }));

  const recognitionActive = new Set<string>();
  router.use("/commerce", createCommerceMaterialsRouter(store, service, recognitionActive));
  router.post("/commerce/recognize", asyncRoute(async (req, res) => {
    const ids: unknown = req.body.imageIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || ids.some(id => typeof id !== "string")) throw new Error("请上传1至3张商品图");
    if (recognitionActive.has(`${commerceRequestActor(req).workspaceId}:${commerceRequestActor(req).id}`)) return res.status(429).json({ error: "正在识别商品，请稍等" });
    recognitionActive.add(`${commerceRequestActor(req).workspaceId}:${commerceRequestActor(req).id}`);
    try { const recognition=await runIndustryOperation(store,commerceRequestActor(req),{requestKey:req.body.requestKey,tool:"product_creative",kind:"recognize",usageSessionId:req.body.usageSessionId,payload:{imageIds:ids}},op=>service.recognize(commerceRequestActor(req),ids,op));res.json({recognition}); }
    finally { recognitionActive.delete(`${commerceRequestActor(req).workspaceId}:${commerceRequestActor(req).id}`); }
  }));

  // Share the per-member guard across all auxiliary AI calls.
  router.post(["/commerce/reference/recognize", "/commerce/modules/suggest"], asyncRoute(async (req, res) => {
    if (recognitionActive.has(`${commerceRequestActor(req).workspaceId}:${commerceRequestActor(req).id}`)) return res.status(429).json({ error: "正在识别或整理建议，请稍等" });
    recognitionActive.add(`${commerceRequestActor(req).workspaceId}:${commerceRequestActor(req).id}`);
    try {
      if (req.path === "/commerce/reference/recognize") {
        if (typeof req.body.imageId !== "string") throw new Error("请选择主要参考图");
        const reference=await runIndustryOperation(store,commerceRequestActor(req),{requestKey:req.body.requestKey,tool:"product_creative",kind:"reference",usageSessionId:req.body.usageSessionId,payload:{imageId:req.body.imageId}},op=>service.recognizeReference(commerceRequestActor(req),req.body.imageId,op));res.json({reference});
      } else { const {requestKey,usageSessionId,...payload}=req.body; const suggestions=await runIndustryOperation(store,commerceRequestActor(req),{requestKey,tool:"product_creative",kind:"module",usageSessionId,payload},op=>service.suggestModule(commerceRequestActor(req),payload,op));res.json({suggestions}); }
    } finally { recognitionActive.delete(`${commerceRequestActor(req).workspaceId}:${commerceRequestActor(req).id}`); }
  }));

  router.get("/commerce/jobs", asyncRoute(async (req, res) => {
    const db = await store.read();
    const kind = req.query.kind === "image_edit" ? "image_edit" : "product_creative";
    const jobs = (db.commerceJobs || []).filter(j => (j.kind || "product_creative") === kind && j.userId === commerceRequestActor(req).id && j.workspaceId === commerceRequestActor(req).workspaceId && j.agentId === (kind === "image_edit" ? COMMERCE_EDIT_AGENT_ID : COMMERCE_MAIN_AGENT_ID))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40)
      .map(j => ({ id: j.id, productName: j.brief.productName, platform: j.brief.platform, status: j.status, phase: j.phase, createdAt: j.createdAt, completed: j.variants.filter(v => v.status === "completed").length, count: j.brief.count }));
    res.json({ jobs });
  }));
  router.post("/commerce/jobs", asyncRoute(async (req, res) => {
    const job = await service.create(commerceRequestActor(req), String(req.body.agentId || ""), req.body.brief, String(req.body.requestKey || ""), String(req.body.usageSessionId || ""));
    res.status(202).json({ job: publicCommerceJob(job) });
  }));
  router.get("/commerce/jobs/:id", asyncRoute(async (req, res) => {
    const db = await store.read();
    res.json({ job: publicCommerceJob(commerceJobAccess(db, commerceRequestActor(req), String(req.params.id))) });
  }));
  router.post("/commerce/jobs/:id/generate", asyncRoute(async (req, res) => {
    await service.generate(commerceRequestActor(req), String(req.params.id), typeof req.body.variantId === "string" ? req.body.variantId : undefined, typeof req.body.referenceImageId === "string" ? req.body.referenceImageId : undefined, String(req.body.requestKey || ""), String(req.body.usageSessionId || ""));
    res.status(202).json({ ok: true });
  }));
  router.post("/commerce/jobs/:id/retry", asyncRoute(async (req, res) => {
    await service.retry(commerceRequestActor(req), String(req.params.id), typeof req.body.variantId === "string" ? req.body.variantId : undefined, typeof req.body.referenceImageId === "string" ? req.body.referenceImageId : undefined, typeof req.body.requestKey === "string" ? req.body.requestKey : undefined, String(req.body.usageSessionId || ""));
    res.status(202).json({ ok: true });
  }));
  router.post("/commerce/jobs/:id/derive", asyncRoute(async (req, res) => {
    const job = await service.derive(commerceRequestActor(req), String(req.params.id), req.body);
    res.status(202).json({ job: publicCommerceJob(job) });
  }));
  router.get("/commerce/jobs/:id/download", asyncRoute(async (req, res) => {
    const db = await store.read();
    const job = commerceJobAccess(db, commerceRequestActor(req), String(req.params.id));
    const zip = new JSZip();
    let count = 0;
    const isEdit = job.kind === "image_edit";
    const titleLines = isEdit ? ["小修小改 · 图片修改说明", `统一修改要求：${job.brief.notes || "按各张图片的单独要求修改"}`, ""] : [`${job.brief.productName} · ${job.brief.platform}`, job.summary, `规格：${job.brief.specification}`, `确认卖点：${job.brief.facts.join("、")}`, `标题关键词：${job.brief.keywords.join("、")}`, `其他要求：${job.brief.notes}`, ""];
    for (const module of job.brief.composition?.modules.filter(m => m.enabled) || []) titleLines.push(`模块「${module.name}」：${module.content}；位置：${module.location || "自动安排"}；样式：${module.appearance || "自动安排"}`);
    for (const [index, variant] of job.variants.entries()) {
      if (isEdit) {
        const sourceId = variant.productImageIds?.[0] || job.brief.productImageIds[index];
        const source = db.attachments.find(a => a.id === sourceId && a.userId === commerceRequestActor(req).id && a.workspaceId === commerceRequestActor(req).workspaceId);
        titleLines.push(`${index + 1}. ${variant.name}`, `原图：${source?.originalName || "原始图片"}`, `修改要求：${variant.editInstruction || job.brief.notes}`, `状态：${variant.status === "completed" ? "已完成" : variant.status === "failed" ? "未完成" : "处理中"}`, ...(variant.error ? [`失败原因：${variant.error}`] : []), `导出尺寸：${variant.outputWidth || "待确认"}×${variant.outputHeight || "待确认"}`, `图片检查：${variant.qualityNote || "待检查"}`, "");
      } else titleLines.push(`${index + 1}. ${variant.name}`, variant.title, `标题说明：${variant.titleReason}`, `方案说明：${variant.reason}`, `本张参考：${variant.referenceImageId ? `参考图${job.brief.referenceImageIds.indexOf(variant.referenceImageId) + 1}` : "无参考或沿用底图"}`, `导出尺寸：${variant.outputWidth || "待确认"}×${variant.outputHeight || "待确认"}`, `图片检查：${variant.qualityNote || "待检查"}`, "");
      const a = db.attachments.find(a => a.id === variant.imageAttachmentId && a.userId === commerceRequestActor(req).id && a.workspaceId === commerceRequestActor(req).workspaceId && a.status === "ready" && a.conversationId === "industry:commerce");
      if (!a) continue;
      const ext = a.mimeType === "image/jpeg" ? "jpg" : a.mimeType === "image/webp" ? "webp" : "png";
      zip.file(`${index + 1}-${variant.name.replace(/[^\p{L}\p{N}_-]/gu, "_")}.${ext}`, await fs.readFile(a.storagePath)); count++;
    }
    if (!count) throw new Error(isEdit ? "还没有可下载的修改结果" : "还没有可下载的主图");
    if (req.query.handoff === "1") {
      const ids = [...new Set([...job.brief.productImageIds, ...job.brief.referenceImageIds, ...compositionAssetIds(job.brief, true), ...job.variants.flatMap(v => [...(v.productImageIds || []), ...(v.sourceImageId ? [v.sourceImageId] : [])])])];
      for (const [index, asset] of commerceAttachments(db, commerceRequestActor(req), ids).entries()) zip.file(`原始素材/${index + 1}-${asset.originalName.replace(/[^\p{L}\p{N}_.-]/gu, "_")}`, await fs.readFile(asset.storagePath));
      titleLines.push("交付说明：包含选定效果图、确认文案和原始素材。请对照图片检查商品包装、文字、规格与赠品；需要完善的位置可在方案说明后补充。");
    }
    zip.file(isEdit ? "修改说明.txt" : "标题与方案说明.txt", titleLines.join("\n"));
    // Recheck immediately before serving saved private assets.
    commerceJobAccess(await store.read(), commerceRequestActor(req), job.id);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(isEdit ? "修改结果.zip" : job.brief.productName.slice(0, 40) + "-主图与标题.zip")}`);
    const bytes=await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    commerceJobAccess(await store.read(),commerceRequestActor(req),job.id);
    res.send(bytes);
  }));
  router.use((error: unknown,_req:Request,res:express.Response,_next:express.NextFunction)=>{
    const e=error as {status?:number;code?:string;message?:string};
    res.status(e.status && e.status >=400 && e.status <600 ? e.status : 400).json({error:e.message || "请求暂未完成，请稍后重试",...(e.code ? {code:e.code} : {})});
  });
  app.use("/api",router);
  return {service,close:()=>{if(timer)clearInterval(timer);}};
}

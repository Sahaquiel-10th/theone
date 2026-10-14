import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, Image, Lightbulb, MessageSquare, ThumbsDown, ThumbsUp } from "lucide-react";
import type { AccountProfile, ProfilePatch } from "../server/betaProfile";
import type { BetaFeedbackInput, OwnBetaFeedback } from "../server/betaFeedback";
import type { OnboardingHandbookOffer } from "../server/onboardingHandbook";

export type { AccountProfile, ProfilePatch, OwnBetaFeedback };

const failureText = (error: unknown) => error instanceof Error ? error.message : "没有保存成功，请稍后再试";

export function ProfileNameEditor({ profile, onSave }: { profile: AccountProfile; onSave: (patch: ProfilePatch) => Promise<unknown> }) {
  const id = useId();
  const [name, setName] = useState(profile.displayName);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { setName(profile.displayName); setNotice(""); }, [profile.workspaceId, profile.displayName]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice("");
    try { await onSave({ displayName: name }); setNotice("称呼已保存"); }
    catch (error) { setNotice(failureText(error)); }
    finally { setBusy(false); }
  }
  return <form className="one-profile-name" onSubmit={save}>
    <label htmlFor={id}>ONE 怎么称呼你？</label>
    <div className="one-profile-name-row"><input id={id} autoComplete="nickname" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="写一个你喜欢的称呼" required disabled={busy} /><button type="submit" disabled={busy || !name.trim() || [...name.trim()].length > 40 || name.trim() === profile.displayName}>{busy ? "保存中…" : "保存称呼"}</button></div>
    {notice ? <p role="status">{notice}</p> : null}
  </form>;
}

/** Inline welcome surface: navigating to knowledge settings must remain possible. */
export function Onboarding({ profile, knowledgeConnected, handbookOffer, onSave, onOpenKnowledge, onStartQuestion }: {
  profile: AccountProfile;
  knowledgeConnected: boolean;
  handbookOffer?: OnboardingHandbookOffer;
  onSave: (patch: ProfilePatch) => Promise<unknown>;
  onOpenKnowledge: () => void;
  onStartQuestion: (suggestedQuestion: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(profile.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setName(profile.displayName); setError(""); }, [profile.workspaceId, profile.displayName]);
  const step = profile.onboarding.completedAt ? "complete" : !profile.displayName || !profile.onboarding.nameSetAt ? "name" : profile.onboarding.knowledgeChoice === "pending" ? "knowledge" : "ready";
  if (step === "complete") return null;
  async function save(patch: ProfilePatch, after?: () => void) {
    setBusy(true); setError("");
    try { await onSave(patch); after?.(); }
    catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  }
  function saveName(event: FormEvent) { event.preventDefault(); void save({ displayName: name }); }
  const connected = knowledgeConnected || profile.onboarding.knowledgeChoice === "connected";
  const guidePrice = handbookOffer?.pricePower;
  const canDraw = handbookOffer?.available === true && typeof guidePrice === "number" && Number.isFinite(guidePrice) && guidePrice > 0 && guidePrice <= .5;
  function start(withGuide: boolean) { void save({ onboardingAction: "complete", handbookChoice: withGuide ? "create" : "skip", ...(withGuide ? { handbookBudgetPower: guidePrice } : {}) }, () => onStartQuestion(connected ? "请从我的知识中查找：" : "")); }
  return <section className="one-onboarding" aria-labelledby={`${id}-title`}>
    <div className="one-onboarding-top"><span aria-hidden="true" /><span>{step === "name" ? "01" : step === "knowledge" ? "02" : "03"} / 03</span></div>
    {step === "name" ? <>
      <h2 id={`${id}-title`}>怎么称呼你？</h2>
      <form onSubmit={saveName}>
        <label className="one-onboarding-label" htmlFor={`${id}-name`}>称呼</label>
        <input id={`${id}-name`} value={name} maxLength={80} autoComplete="nickname" placeholder="比如，小马" onChange={(event) => setName(event.target.value)} required disabled={busy} />
        <button type="submit" disabled={busy || !name.trim() || [...name.trim()].length > 40}>{busy ? "保存中…" : "下一步"}<ArrowUpRight size={17} /></button>
      </form>
    </> : step === "knowledge" ? <>
      <h2 id={`${id}-title`}>{profile.displayName}，连接你的知识</h2>
      <div className="one-onboarding-actions">
        {knowledgeConnected ? <button disabled={busy} onClick={() => void save({ onboardingAction: "knowledge_connected" })}><Check size={17} />已连接，继续</button> : <button disabled={busy} onClick={onOpenKnowledge}>连接知识来源<ArrowUpRight size={17} /></button>}
        <button className="one-onboarding-quiet" disabled={busy} onClick={() => void save({ onboardingAction: "knowledge_skipped" })}>稍后再说</button>
      </div>
    </> : <>
      <h2 id={`${id}-title`}>现在，问我一件事</h2>
      <div className="one-onboarding-guide">
        <Image size={22} aria-hidden="true" />
        <div><strong>{canDraw ? "给你画一张自己的 ONE 小指南" : "准备好了，我们从一件小事开始"}</strong><p>{canDraw ? "里面会有你的称呼，还有你已经连接的知识来源。画好后会放进「任务」，你可以边聊边等，不用守着。" : "直接告诉我想做什么就好。需要独立完成的工作会放进「任务」，随时可以回来看看。"}</p>
        {canDraw ? <small>{typeof guidePrice === "number" ? `1 张图片 · 使用现有额度 ${guidePrice.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 电力` : "生成 1 张图片，使用你现有的额度"} · 只用称呼与平台名称，不读取你的知识内容</small> : null}</div>
      </div>
      <div className="one-onboarding-actions"><button disabled={busy} onClick={() => start(canDraw)}>{busy ? "准备中…" : canDraw ? "开始，顺便画给我" : "开始"}<ArrowUpRight size={17} /></button>{canDraw ? <button className="one-onboarding-quiet" disabled={busy} onClick={() => start(false)}>先聊聊，不画指南</button> : null}</div>
      <small>保持 ONE Key 插入 · 问答按电力计费 · 问题与引用资料会交给 AI 服务处理</small>
    </>}
    {error ? <p className="one-onboarding-error" role="alert">{error}</p> : null}
  </section>;
}

/** Optional light welcome note. This is queue feedback, not a success claim. */
export function OnboardingHandbookNotice({ profile, onOpenTask }: { profile: AccountProfile; onOpenTask?: (taskId: string) => void }) {
  const guide = profile.onboarding.handbook;
  if (!guide || guide.status !== "queued" || !guide.taskId) return null;
  return <aside className="one-onboarding-handbook-note" role="status"><Lightbulb size={17} aria-hidden="true" /><span>你的个人小指南在「任务」里，想看进度或结果，随时去看看。</span>{onOpenTask ? <button type="button" onClick={() => onOpenTask(guide.taskId!)}>去看看<ArrowUpRight size={13} /></button> : null}</aside>;
}

export function BetaFeedbackControls({ messageId, requestId, feedback, onSave }: {
  messageId: string; requestId?: string; feedback?: OwnBetaFeedback;
  onSave: (input: BetaFeedbackInput) => Promise<OwnBetaFeedback>;
}) {
  const id = useId();
  const [saved, setSaved] = useState(feedback);
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const activeMessage = useRef(messageId);
  activeMessage.current = messageId;
  useEffect(() => { setSaved(feedback); setComment(feedback?.comment ?? ""); setConsent(false); setNotice(""); setBusy(false); }, [messageId, feedback]);
  async function submit(rating: "helped" | "not_solved", withComment = false) {
    setBusy(true); setNotice("");
    try {
      const next = await onSave({ messageId, rating, ...(withComment ? { comment, shareComment: consent } : {}) });
      if (activeMessage.current !== messageId) return;
      setSaved(next); setExpanded(false); setComment(next.comment ?? ""); setConsent(false);
      setNotice("收到，谢谢。");
    } catch (error) { if (activeMessage.current === messageId) setNotice(failureText(error)); }
    finally { if (activeMessage.current === messageId) setBusy(false); }
  }
  async function copyRequestId() {
    try { await navigator.clipboard.writeText(requestId || saved?.requestId || ""); setNotice("已复制，可发给管理员。"); }
    catch { setNotice(`问题编号：${requestId || saved?.requestId || "暂无"}`); }
  }
  return <div className="one-beta-feedback">
    <div className="one-beta-feedback-actions" aria-label="这次回答帮上忙了吗？">
      <button type="button" aria-pressed={saved?.rating === "helped"} disabled={busy} onClick={() => void submit("helped")}><ThumbsUp size={13} />帮上忙了</button>
      <button type="button" aria-pressed={saved?.rating === "not_solved"} disabled={busy} onClick={() => void submit("not_solved")}><ThumbsDown size={13} />没解决</button>
      <button type="button" aria-expanded={expanded} aria-controls={`${id}-note`} disabled={busy} onClick={() => { setExpanded(!expanded); setNotice(""); }}><MessageSquare size={13} />补充反馈</button>
      {requestId || saved?.requestId ? <button type="button" onClick={() => void copyRequestId()}>复制问题编号</button> : null}
    </div>
    {expanded ? <div className="one-beta-feedback-note" id={`${id}-note`}>
      <label htmlFor={`${id}-text`}>补充说明（选填，最多 500 字）</label>
      <textarea id={`${id}-text`} value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} rows={3} placeholder="只填写你愿意分享的内容" disabled={busy} />
      <label className="one-beta-feedback-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} />我同意将这段说明发给内测管理员。不会附带聊天、附件或知识资料。</label>
      <div className="one-beta-feedback-actions"><button type="button" disabled={busy || Boolean(comment.trim()) && !consent || [...comment.trim()].length > 500} onClick={() => void submit(saved?.rating ?? "not_solved", true)}>{busy ? "发送中…" : "发送反馈"}</button><button type="button" disabled={busy} onClick={() => setExpanded(false)}>取消</button></div>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}

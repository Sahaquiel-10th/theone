import { useEffect, useState } from "react";
import type { adminBetaFeedback } from "../server/betaFeedback";
import type { betaEngagementSummary } from "../server/betaEngagement";

type BetaUserResult = { engagement: ReturnType<typeof betaEngagementSummary>; feedback: ReturnType<typeof adminBetaFeedback> };
const dateTime = (value?: string) => value ? new Date(value).toLocaleString() : "尚未发生";

/** Mount inside an already authorized admin user detail, never on an ordinary account page. */
export function BetaUserInsights({ userId, api }: { userId: string; api: <T>(path: string, options?: RequestInit) => Promise<T> }) {
  const [expandedUserId, setExpandedUserId] = useState("");
  const [page, setPage] = useState({ userId, offset: 0 });
  const [result, setResult] = useState<{ userId: string; offset: number; data: BetaUserResult } | null>(null);
  const [failure, setFailure] = useState<{ userId: string; offset: number; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const expanded = expandedUserId === userId;
  const offset = page.userId === userId ? page.offset : 0;
  const data = result?.userId === userId && result.offset === offset ? result.data : null;
  const error = failure?.userId === userId && failure.offset === offset ? failure.message : "";

  useEffect(() => {
    if (!expanded || !userId) return;
    const controller = new AbortController();
    let active = true;
    setResult(null); setFailure(null);
    api<BetaUserResult>(`/api/admin/users/${encodeURIComponent(userId)}/beta?limit=20&offset=${offset}`, { signal: controller.signal })
      .then((value) => { if (active) setResult({ userId, offset, data: value }); })
      .catch((error) => { if (active && !controller.signal.aborted) setFailure({ userId, offset, message: error instanceof Error ? error.message : "内测使用情况暂时无法读取" }); });
    return () => { active = false; controller.abort(); };
  }, [api, userId, expanded, offset, retry]);

  return <details className="one-beta-insights" open={expanded} onToggle={(event) => setExpandedUserId(event.currentTarget.open ? userId : "")}>
    <summary>实际使用与内测反馈</summary>
    {expanded ? <div className="one-beta-insights-body">
      <p className="one-beta-insights-explanation">仅统计已完成问答 · 不展示对话、知识原文或附件</p>
      {error ? <div role="alert" className="one-beta-insights-error">{error}<button type="button" onClick={() => setRetry((value) => value + 1)}>重新读取</button></div> : !data ? <p role="status">正在读取这位用户的使用情况…</p> : <>
        {data.engagement ? <>
          <div className="one-beta-insights-grid">
            <div><span>已完成问答</span><strong>{data.engagement.completedAnswers.toLocaleString()}</strong><small>今日 {data.engagement.todayCompletedAnswers.toLocaleString()} 次</small></div>
            <div><span>用到知识的回答</span><strong>{data.engagement.knowledgeGroundedAnswers.toLocaleString()}</strong></div>
            <div><span>近 7 天有效使用天数</span><strong>{data.engagement.meaningfulActiveDays7d} 天</strong><small>{data.engagement.returnedOnAnotherDay ? "已跨日使用" : "未跨日使用"}</small></div>
            <div><span>已完成本机任务</span><strong>{data.engagement.completedLocalTasks.toLocaleString()}</strong><small>不含失败或取消</small></div>
          </div>
          <dl className="one-beta-insights-milestones"><div><dt>第一次成功问答</dt><dd>{dateTime(data.engagement.firstSuccessfulChatAt)}</dd></div><div><dt>第一次知识回答</dt><dd>{dateTime(data.engagement.firstKnowledgeAnswerAt)}</dd></div><div><dt>最近一次有效使用</dt><dd>{dateTime(data.engagement.lastMeaningfulUseAt)}</dd></div></dl>
        </> : <p>暂无这位用户的使用统计。</p>}
        <details className="one-beta-insights-feedback">
          <summary>用户反馈 · 帮上忙 {data.feedback.helped} 次 / 没解决 {data.feedback.notSolved} 次</summary>
          <p className="one-beta-insights-explanation">每个回答显示最新反馈 · 说明仅在用户同意后展示，不附带聊天</p>
          {data.feedback.items.length ? <ul>{data.feedback.items.map((item) => <li key={item.id}>
            <div><strong>{item.rating === "helped" ? "帮上忙了" : "没解决"}</strong><time dateTime={item.updatedAt}>{dateTime(item.updatedAt)}</time></div>
            {item.sharedComment && item.comment ? <p className="one-beta-insights-comment">{item.comment}</p> : <p>未分享说明</p>}
            <small>问题编号：{item.requestId || "该历史回答暂无编号"}</small>
          </li>)}</ul> : <p>还没有收到反馈。</p>}
          {data.feedback.pagination.total > data.feedback.pagination.limit ? <div className="one-beta-insights-pagination"><button type="button" disabled={offset === 0} onClick={() => setPage({ userId, offset: Math.max(0, offset - 20) })}>上一页</button><span>第 {Math.floor(offset / 20) + 1} / {Math.ceil(data.feedback.pagination.total / 20)} 页</span><button type="button" disabled={!data.feedback.pagination.hasMore} onClick={() => setPage({ userId, offset: offset + 20 })}>下一页</button></div> : null}
        </details>
      </>}
    </div> : null}
  </details>;
}

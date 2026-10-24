export type MessageSource = { title: string; url: string; snippet: string };
export type MessageKnowledgeDiagnostics = {
  status: 'used' | 'no_match' | 'not_connected' | 'partial' | 'failed';
  failures: { message: string }[];
};
export type MessageSourceDetails = {
  sources?: MessageSource[];
  knowledgeDiagnostics?: MessageKnowledgeDiagnostics;
  attachmentWarning?: string;
};

/** A citation label can remain useful even when its destination is not a web URL. */
export function sourceWebUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url.href;
  } catch { /* The source is still shown as plain text. */ }
}

const knowledgeLabels: Record<MessageKnowledgeDiagnostics['status'], string> = {
  used: '已参考你的知识',
  no_match: '没有找到相关知识',
  not_connected: '未连接知识来源',
  partial: '已参考部分知识',
  failed: '知识读取失败 · 本次未使用你的知识',
};

/** Shared by the main and task conversations; rendering never requests knowledge. */
export function MessageSources({ message }: { message: MessageSourceDetails }) {
  const { sources, knowledgeDiagnostics: knowledge, attachmentWarning } = message;
  if (!sources?.length && !knowledge && !attachmentWarning) return null;
  const warning = Boolean(attachmentWarning || knowledge?.status === 'failed' || knowledge?.status === 'partial');
  const title = knowledge ? knowledgeLabels[knowledge.status] : sources?.length ? '查看参考资料' : '附件读取提示';
  return <details className={`one-answer-sources${warning ? ' has-warning' : ''}`}>
    <summary>{title}{sources?.length ? ` · ${sources.length} 条来源` : ''}</summary>
    <div className="one-answer-source-details">
      {knowledge?.failures.map((failure, index) => <p className="one-source-warning" key={index}>{failure.message}</p>)}
      {attachmentWarning ? <p className="one-source-warning">{attachmentWarning}</p> : null}
      {sources?.map((source, index) => {
        const href = sourceWebUrl(source.url);
        return <section key={`${source.url}-${index}`}>
          {href ? <a href={href} target="_blank" rel="noopener noreferrer">{index + 1}. {source.title}</a> : <strong>{index + 1}. {source.title}</strong>}
          {source.snippet ? <p>{source.snippet}</p> : null}
        </section>;
      })}
    </div>
  </details>;
}

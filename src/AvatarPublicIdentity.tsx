export function AvatarPublicIdentity({ name, authorName, description, mode }: {
    name: string;
    authorName?: string;
    description: string;
    mode?: 'consultation' | 'knowledge';
}) {
    return <header className="avatar-public-identity"><div className="avatar-byline"><span className="avatar-author-mark" aria-hidden="true">{Array.from(authorName || name)[0] || '一'}</span><div><span>作者 · {authorName || '发布者'}</span><small>AI 分身 · {mode === 'knowledge' ? '知识服务' : '咨询服务'}</small></div><span className="avatar-powered-by">由 ONE 连接</span></div><h1>{name}</h1>{description ? <p>{description}</p> : null}</header>;
}

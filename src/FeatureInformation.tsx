type InformationFeature = {
  description: string;
  limitations: string;
  usageMultiplier?: number;
  knowledgeMode: string;
  destinations: string[];
  experience?: { promptPlaceholder?: string; actions: { id: string; label: string }[] };
};

/** Inspection uses the published feature facts; it never starts a task. */
export function FeatureInformation({ feature, accessLabel = '已为你开放' }: { feature: InformationFeature; accessLabel?: string }) {
  const knowledge = feature.knowledgeMode === 'required' ? '需要选择知识来源' : feature.knowledgeMode === 'optional' ? '可选择知识来源' : '无需个人知识来源';
  return <div className="feature-information-layout">
    <div className="feature-access-status" title="功能开通状态"><span aria-hidden="true"/>{accessLabel}</div>
    <div className="feature-information-main">
      <section className="feature-information-section"><h4>用途</h4><p>{feature.description}</p></section>
      {feature.experience?.actions.length ? <section className="feature-information-section"><h4>可以完成</h4><ul>{feature.experience.actions.map(action => <li key={action.id}>{action.label}</li>)}</ul></section> : null}
      <section className="feature-information-section"><h4>使用说明</h4><p>{feature.experience?.promptPlaceholder || '写下目标和交付要求，需要时添加材料。'}</p></section>
      {feature.limitations.trim() ? <section className="feature-information-section"><h4>限制与注意</h4><p>{feature.limitations}</p></section> : null}
    </div>
    <aside className="feature-information-facts" aria-label="费用与使用范围">
      <section className="feature-information-section"><h4>费用</h4><dl><div><dt>用量倍率</dt><dd>{feature.usageMultiplier ?? .6} 倍</dd></div></dl><p>按实际用量扣除，创建任务前可设置电力上限。</p></section>
      <section className="feature-information-section"><h4>知识来源</h4><p>{knowledge}</p>{feature.knowledgeMode !== 'none' ? <small>仅使用你为本次任务选择的已授权连接。</small> : null}</section>
      <section className="feature-information-section"><h4>工具范围</h4>{feature.destinations.length ? <details className="feature-tool-scope"><summary>{feature.destinations.length} 个外部只读接口</summary><ul>{feature.destinations.map(destination => <li key={destination}>{destination}</li>)}</ul></details> : <p>不使用外部数据接口</p>}</section>
    </aside>
  </div>;
}

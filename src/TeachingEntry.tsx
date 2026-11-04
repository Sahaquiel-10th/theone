import {ArrowUpRight,GraduationCap} from 'lucide-react';
/** A full teaching workflow belongs in the industry directory, outside Skills selection. */
export function TeachingEntry({onOpen}:{onOpen:()=>void}) {
  return <article className="industry-workspace-row" aria-label="工作台：课程工作台"><span className="industry-workspace-symbol" aria-hidden="true"><GraduationCap size={22} strokeWidth={1.5}/></span><div><h3>课程工作台</h3><p>知识问答、文字游戏、上传试卷与批改作业。课程资料单独管理，按需选择工具。</p><small>课前 · 课中 · 课后</small></div><button type="button" onClick={onOpen}>打开工作台<ArrowUpRight size={15} aria-hidden="true"/></button></article>;
}

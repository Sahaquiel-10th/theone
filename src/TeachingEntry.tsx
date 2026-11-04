import {ArrowUpRight,GraduationCap} from 'lucide-react';
/** A full teaching workflow belongs in the industry directory, outside Skills selection. */
export function TeachingEntry({onOpen}:{onOpen:()=>void}) {
  return <article className="industry-workspace-row" aria-label="工作台：课程教学"><span className="industry-workspace-symbol" aria-hidden="true"><GraduationCap size={22} strokeWidth={1.5}/></span><div><h3>课程教学</h3><p>创建课程、准备资料，再使用课前问答、课中游戏和课后收作业与批改。</p><small>课程资料 · 学生提交 · 课前课中课后</small></div><button type="button" onClick={onOpen}>打开工作台<ArrowUpRight size={15} aria-hidden="true"/></button></article>;
}

import {ArrowUpRight,GraduationCap} from 'lucide-react';
/** A full teaching workflow belongs in the industry directory, outside Skills selection. */
export function TeachingEntry({onOpen}:{onOpen:()=>void}) {
  return <article className="industry-workspace-row" aria-label="工作台：教师工作台"><span className="industry-workspace-symbol" aria-hidden="true"><GraduationCap size={22} strokeWidth={1.5}/></span><div><h3>教师工作台</h3><p>批改作业、让学生提问，或准备测验与课堂文字游戏。按步骤完成，资料和记录归在一起。</p><small>教材 · 学生作业 · 已连接知识库</small></div><button type="button" onClick={onOpen}>打开工作台<ArrowUpRight size={15} aria-hidden="true"/></button></article>;
}

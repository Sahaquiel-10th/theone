import {ArrowUpRight,GraduationCap} from 'lucide-react';
import './teaching-entry.css';

export function matchesTeachingEntry(query='',category='all') {
  if(!['all','teaching','training'].includes(category))return false;
  const text='教师工作台 教学 教研 分身 老师 作业 批改 评分 试卷 测验 课前 课中 课后 教材 导学 Notion 知识库 图片 博物馆 研学 文字游戏';
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word=>text.toLowerCase().includes(word));
}

/** One workbench is the catalog unit. Teaching phases stay inside the workbench. */
export function TeachingEntry({onOpen}:{onOpen:()=>void}) {
  return <article className="feature-shelf-card teaching-workbench-entry" aria-label="功能：教师工作台"><header><span className="feature-shelf-symbol" aria-hidden="true"><GraduationCap size={17}/></span><h3>教师工作台</h3><span className="teaching-workbench-label">工作台</span></header><p className="feature-shelf-description">批改作业、让学生向你的分身提问，或准备测验与课堂文字游戏。按步骤完成，资料和记录自动归在一起。</p><footer><span>支持文件与已连接知识库</span><button type="button" className="feature-shelf-item" onClick={onOpen}>打开工作台<ArrowUpRight size={15} aria-hidden="true"/></button></footer></article>;
}

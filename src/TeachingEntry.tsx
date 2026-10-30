import {BookOpen,Presentation,ClipboardCheck,ArrowRight} from 'lucide-react';
import type {TeachingStage} from '../server/teachingTypes';
import './teaching-entry.css';

const toolkits = [
  {stage:'before',name:'课前工具包',description:'准备导学资料，了解学生关注什么。',keywords:'教学 备课 教材 调研 学情',Icon:BookOpen},
  {stage:'during',name:'课中工具包',description:'情境互动与实地导学，让知识进入体验。',keywords:'教学 老师 课堂 研学 拍照 博物馆',Icon:Presentation},
  {stage:'after',name:'课后工具包',description:'发布测验、收取作业、AI 批改与反馈。',keywords:'教学 老师 考试 评分 试卷 学情',Icon:ClipboardCheck},
] as const;

export function TeachingEntry({onOpen,query=''}:{onOpen:(stage:TeachingStage)=>void;query?:string}) {
  const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible=toolkits.filter(item=>words.every(word=>`${item.name} ${item.description} ${item.keywords}`.toLowerCase().includes(word)));
  if(!visible.length)return null;
  return <section className="teaching-entry" aria-label="教学工具包"><header><span>教学工具包</span><small>从备课到反馈，在一个工作区完成</small></header><div>{visible.map(({stage,name,description,Icon})=><button type="button" key={stage} onClick={()=>onOpen(stage)}><Icon size={21} aria-hidden="true"/><strong>{name}</strong><span>{description}</span><ArrowRight size={16} aria-hidden="true"/></button>)}</div></section>;
}

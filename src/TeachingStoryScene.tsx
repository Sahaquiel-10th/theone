import {useEffect,useRef} from 'react';
import {ArrowRight,BookOpen,Compass,Flag,RotateCcw,ScrollText,Sparkles} from 'lucide-react';
import {MessageMarkdown} from './MessageMarkdown';
import type {TeachingOperation} from '../server/teachingTypes';
import type {StoryScript,StoryTurn,StoryImage} from '../server/teachingStories';
import './teaching-story-scene.css';

type Props={story?:StoryScript;turns:TeachingOperation[];last?:StoryTurn;image?:TeachingOperation;busy:boolean;working:boolean;pending:boolean;error:string;onAction:(choice?:string)=>void;onRecover:()=>void;onImage:()=>void;onRestart:()=>void};
const chapters=['第一幕','第二幕','第三幕','第四幕','第五幕'];
export function TeachingStoryScene({story,turns,last,image,busy,working,pending,error,onAction,onRecover,onImage,onRestart}:Props){
 const scene=useRef<HTMLElement>(null),complete=last?.round??0,locked=busy||working||pending;
 const decisions=turns.filter(o=>o.status==='completed').slice(1);
 useEffect(()=>{if(last)scene.current?.focus({preventScroll:true});},[last?.answer]);
 return <section className="teaching-story-player" aria-label="历史选择游戏">
  <header className="story-game-heading"><div><span className="story-game-kicker"><Compass size={15} aria-hidden="true"/>杭州 · 小人物走进大历史</span><h2>{story?.title??'正在打开历史篇章…'}</h2></div><span className="story-game-edition">五次抉择<br/><strong>一个人的命运</strong></span></header>
  <div className="story-game-landscape"><span>历史入局</span><p>以小人物之身，走进杭州往事</p><small>AI 教学想象场景 · 非历史影像</small></div>
  <ol className="story-game-progress" aria-label={`已完成 ${complete} 次选择，共5次`}>{chapters.map((name,i)=><li key={name} className={i<complete?'is-complete':i===complete?'is-current':''} aria-current={i===complete?'step':undefined}><span>{i<complete?'✓':String(i+1).padStart(2,'0')}</span><small>{name}</small></li>)}</ol>
  <div className="story-game-board">
   <aside className="story-game-role"><div className="story-game-seal" aria-hidden="true"><ScrollText size={28}/></div><span className="story-game-kicker">你的角色</span><h3>{story?.role??'等待角色入场'}</h3><div className="story-game-anchor"><span>历史锚点</span><p>{story?.event??'正在核对作品…'}</p></div><p className="story-game-note">你可以改变自己的经历。历史的基本走向，仍有它的边界。</p><span className="story-game-fiction">人物与具体情节含教学虚构</span>{story?.citations?.length?<details className="story-game-evidence"><summary>查看史实依据</summary>{story.citations.map((item,index)=><blockquote key={index}>{item.quote}</blockquote>)}</details>:null}</aside>
   <div className="story-game-main">
    <article ref={scene} tabIndex={-1} className="story-game-scene" aria-label={last?.ended?'个人结局':chapters[Math.min(complete,4)]}>
     <div className="story-game-scene-label"><span>{last?.ended?<Flag size={16} aria-hidden="true"/>:<BookOpen size={16} aria-hidden="true"/>}{last?.ended?'终章 · 你的结局':last?`${chapters[Math.min(complete,4)]} · 故事正在发生`:'序章 · 即将入局'}</span><small>{last?.ended?'5 / 5 次选择':`已选择 ${complete} / 5`}</small></div>
     {last?<div className="story-game-prose"><MessageMarkdown>{last.answer}</MessageMarkdown></div>:<div className="story-game-prologue"><h3>大时代里，轮到你作选择。</h3><p>一位普通人的生计、人情与责任，将与你眼前的杭州历史相遇。</p><p>阅读每一幕，点击一个行动，看看你的选择会带来什么。</p><button type="button" className="story-game-start" disabled={locked||!story} onClick={()=>onAction()}>启程 · 进入第一幕<ArrowRight size={18} aria-hidden="true"/></button></div>}
     {working&&!last?.ended?<p className="story-game-wait" role="status"><Sparkles size={15} aria-hidden="true"/>你的选择正在改变接下来的故事…</p>:null}
    </article>
    {error?<p className="story-game-error" role="alert">{error}</p>:null}
    {pending?<button className="story-game-recover" type="button" disabled={busy||working} onClick={onRecover}>找回这次选择的结果</button>:null}
    {last&&!last.ended?<section className="story-game-actions" aria-label="选择下一步行动"><div><span className="story-game-kicker">抉择时刻</span><p>你决定怎么做？</p></div><div className="story-game-option-grid">{last.choices.map((choice,i)=><button type="button" key={choice} disabled={locked} onClick={()=>onAction(choice)}><span className="story-game-option-letter">{i?'B':'A'}</span><span>{choice}</span><ArrowRight size={18} aria-hidden="true"/></button>)}</div><small>点击一个行动，AI将根据你的选择推演后果。</small></section>:null}
    {last?.ended?<section className="story-game-ending"><div className="story-game-ending-heading"><Flag size={18} aria-hidden="true"/><h3>一段命运，汇入一座城</h3></div>{image?.status==='completed'?<figure><img src={(image.result as StoryImage).imageUrl} alt="根据本局角色结局生成的历史想象插画"/><figcaption>AI生成的教学想象画面，非历史影像。</figcaption></figure>:image?<p className="story-game-note" role="status">{image.status==='running'?'正在为你的结局绘制一幅画…':image.error??'配图结果尚未确认，文字结局已保留。'}</p>:<button type="button" disabled={busy} onClick={onImage}>绘制结局插画</button>}<div className="story-game-reflection"><span className="story-game-kicker">从故事回到历史</span><p>{last.historyExplanation}</p><span className="story-game-kicker">留一个问题给自己</span><p>{last.reflection}</p></div><button className="story-game-restart" type="button" disabled={locked} onClick={onRestart}><RotateCcw size={16} aria-hidden="true"/>再走一遍，探索另一种命运</button></section>:null}
    {decisions.length?<details className="story-game-journal"><summary>选择手记 · 已留下 {decisions.length} 次抉择</summary><ol>{decisions.map((turn,i)=><li key={turn.id}><span>{String(i+1).padStart(2,'0')}</span><div><strong>{turn.question}</strong><details><summary>回看这一选择的后果</summary><MessageMarkdown>{(turn.result as StoryTurn).answer}</MessageMarkdown></details></div></li>)}</ol></details>:null}
   </div>
  </div>
 </section>;
}

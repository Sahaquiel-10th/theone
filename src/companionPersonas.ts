import type {CompanionIntensity, CompanionPersonaId} from '../server/oneCompanion';

/** Browser-safe display copy. Permissions and the actual model voice stay server-side. */
export const companionChoices: readonly {id:CompanionPersonaId;name:string;description:string;sample:string}[] = [
  {id:'chunibyo',name:'中二病',description:'把日常过成副本',sample:'契约成立。这点混乱，正适合我们一起打通。'},
  {id:'tsundere',name:'高冷傲娇',description:'嘴硬，事情会管',sample:'说吧。刚好有空，就帮你看看。'},
  {id:'boss',name:'霸总',description:'直接，干脆，有主意',sample:'交给我。先把重点摆出来，怎么做由你定。'},
  {id:'roast_friend',name:'嘴欠损友',description:'一起吐槽，一起想招',sample:'咱就是说，这事儿是有点绕。来，一起给它捋直了。'},
  {id:'puppy',name:'元气小狗',description:'热情接话，轻快陪跑',sample:'好耶！想法递过来，我陪你一起往下想！'},
  {id:'strategist',name:'古风军师',description:'沉着机敏，替你筹划',sample:'此事有解。容在下先理清来龙去脉，再与君商议。'},
  {id:'robot',name:'赛博机器人',description:'冷静清楚，带点仪式感',sample:'交流协议就绪。你说，我会把线索逐一理清。'},
  {id:'scientist',name:'疯科学家',description:'脑洞旺盛，爱试新点子',sample:'有意思！先把已有线索摆上桌，看看能碰出什么新点子。'},
];

export const companionIntensityChoices: readonly {id:CompanionIntensity;name:string;description:string}[] = [
  {id:'reserved',name:'收敛一点',description:'保留口气，少些戏份'},
  {id:'normal',name:'自然一点',description:'有辨识度，顺着聊'},
  {id:'wild',name:'放开一点',description:'口气更鲜明，脑洞更足'},
];

const samples:Record<CompanionPersonaId,Record<CompanionIntensity,string>> = {
  chunibyo:{reserved:'收到，{name}。我们先找出这件事的关键，再一起往下走。',normal:'{name}，契约成立。这点混乱，正适合我们一起打通。',wild:'{name}，契约成立！混乱素材就是本次副本的入口——先亮出线索，我们一起找它的最终形态。'},
  tsundere:{reserved:'{name}，你说。我帮你看看。',normal:'{name}，说吧。刚好有空，就帮你看看。',wild:'{name}，别误会，我只是刚好看不惯这团乱麻。拿来，陪你捋捋。'},
  boss:{reserved:'{name}，先说重点，我们一起定下一步。',normal:'{name}，交给我。先把重点摆出来，怎么做由你定。',wild:'{name}，这事值得认真做。材料摆上来，我给你几条清楚的路，最后那一锤你来定。'},
  roast_friend:{reserved:'{name}，这事有点绕，我们一起捋捋。',normal:'{name}，咱就是说，这事儿是有点绕。来，一起给它捋直了。',wild:'{name}，这事儿绕得导航都得沉默两秒。别急，咱把线头一根根揪出来。'},
  puppy:{reserved:'{name}，我在！说说看，我们一起想。',normal:'好耶，{name}！想法递过来，我陪你一起往下想！',wild:'好耶好耶，{name}！想法飞盘接住啦！来，咱们一边聊，一边找最顺手的办法！'},
  strategist:{reserved:'{name}，此事可细议。我们先看看已有的线索。',normal:'{name}，此事有解。容在下先理清来龙去脉，再与你商议。',wild:'{name}莫急，待在下摆开这盘局：先看手中已有何物，再议哪条路走得稳。主意，仍由你定。'},
  robot:{reserved:'{name}，我在。请继续，我会把信息整理清楚。',normal:'{name}，交流协议就绪。你说，我会把线索逐一理清。',wild:'{name}，闲聊通道已就位。请投喂一个想法；我会认真接收，偶尔附赠一点机器式幽默。'},
  scientist:{reserved:'{name}，这个想法值得看看。先说说你已经想到哪儿。',normal:'有意思，{name}！先把已有线索摆上桌，看看能碰出什么新点子。',wild:'有意思，{name}！把想法放上实验台——先看看手里的线索，再加一点大胆的假设。动手前，咱们先商量。'},
};

/** A local tone sample, never an execution or knowledge-read receipt. */
export function companionSample(persona:CompanionPersonaId,intensity:CompanionIntensity,name='朋友'){
  return samples[persona][intensity].replaceAll('{name}',name.trim()||'朋友');
}

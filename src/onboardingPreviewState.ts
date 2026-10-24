import type {OnboardingPurpose} from './onboardingPurposes';

export const onboardingPreviewSteps=[
  {id:'name',label:'认识一下',title:'我在。怎么称呼你？',description:'你可以把 ONE 当作一个一起想办法的伙伴。从一句话开始就好。'},
  {id:'knowledge',label:'带上资料',title:'有依据，心里更有底。',description:'需要时，ONE 可以参考你授权连接的资料。没连接也能先聊天。'},
  {id:'device',label:'交到电脑上',title:'想法，也可以变成文件。',description:'需要用这台电脑时，执行进度会在旁边出现。你的主对话一直留在原处。'},
  {id:'features',label:'按你的节奏',title:'第一件事，想从哪里开始？',description:'选一两个方向，或者先随便聊聊。以后都可以换。'},
] as const;
export type OnboardingPreviewState={step:number;name:string;purposes:OnboardingPurpose[];expanded:boolean;demoComplete:boolean;ending:boolean};
export type OnboardingPreviewAction={type:'next'|'back'|'toggle-preview'|'complete-demo'|'finish'}|{type:'name';value:string}|{type:'purpose';id:OnboardingPurpose};
export function createOnboardingPreview(initialName=''):OnboardingPreviewState{return{step:0,name:initialName,purposes:[],expanded:false,demoComplete:false,ending:false};}

/** A deliberately local rehearsal. It has no save, authorization or execution actions. */
export function onboardingPreviewReducer(state:OnboardingPreviewState,action:OnboardingPreviewAction):OnboardingPreviewState {
  if(state.ending)return state;
  if(action.type==='name')return{...state,name:action.value.slice(0,40)};
  if(action.type==='purpose')return{...state,purposes:state.purposes.includes(action.id)?state.purposes.filter(id=>id!==action.id):state.purposes.length<2?[...state.purposes,action.id]:state.purposes};
  if(action.type==='toggle-preview')return{...state,expanded:!state.expanded};
  if(action.type==='complete-demo')return{...state,demoComplete:true};
  if(action.type==='finish')return state.step===3?{...state,ending:true,expanded:false}:state;
  const step=Math.max(0,Math.min(onboardingPreviewSteps.length-1,state.step+(action.type==='next'?1:-1)));
  return step===state.step?state:{...state,step,expanded:false,demoComplete:false};
}

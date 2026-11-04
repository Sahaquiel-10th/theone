export type CommerceWorkspaceKind='product_creative'|'image_edit'|'review_reply';
export type IndustryWorkspaceId='teaching'|CommerceWorkspaceKind;
export type IndustryCategory='all'|'teaching'|'commerce';
export const primaryWorkspaceNavigation=[{id:'chat',label:'主页'},{id:'things',label:'任务'},{id:'features',label:'Skills'},{id:'workbenches',label:'行业工作台'},{id:'avatars',label:'分身'}] as const;
export const industryCategories=[{id:'teaching',label:'教学教研',description:'备课、课堂互动与作业批改'},{id:'commerce',label:'电商运营',description:'商品内容、图片修改与买家沟通'}] as const;
export const industryWorkspaces:{id:IndustryWorkspaceId;category:Exclude<IndustryCategory,'all'>;name:string;description:string;materials:string;keywords:string}[]=[
  {id:'teaching',category:'teaching',name:'教师工作台',description:'从批改作业、学生提问、在线测验或课堂文字游戏开始，按步骤准备并使用。',materials:'教材 · 学生作业 · 已连接知识库',keywords:'教学 教师 老师 教研 备课 批改 评分 测验 试卷 导学 研学 游戏'},
  {id:'product_creative',category:'commerce',name:'主图与标题',description:'放入商品图与卖点，准备商品主图和标题，检查后再使用。',materials:'商品原图 · 卖点与要求',keywords:'电商 商品 主图 标题 创意 产品 卖点 生成'},
  {id:'image_edit',category:'commerce',name:'小修小改',description:'围绕已有图片说明要改的地方，保留商品细节，查看修改结果。',materials:'已有图片 · 修改说明',keywords:'电商 图片 修改 局部 修图 小修小改 编辑'},
  {id:'review_reply',category:'commerce',name:'评价回复',description:'放入买家评价，结合商品与回复要求，准备可检查和复制的回复。',materials:'买家评价 · 商品信息与回复口吻',keywords:'电商 评价 回复 客服 售后 买家 差评 好评'},
];
export type IndustryDirectoryState={category:IndustryCategory;query:string;workspace:IndustryWorkspaceId|null;collection:'all'|'favorites'};
export const emptyIndustryDirectory=():IndustryDirectoryState=>({category:'all',query:'',workspace:null,collection:'all'});
export function filterIndustryWorkspaces(query:string,category:IndustryCategory,favorites?:readonly IndustryWorkspaceId[]){const words=query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);return industryWorkspaces.filter(entry=>(category==='all'||entry.category===category)&&(!favorites||favorites.includes(entry.id))&&words.every(word=>`${entry.name} ${entry.description} ${entry.materials} ${entry.keywords}`.normalize('NFKC').toLocaleLowerCase().includes(word)));}
export function industryDirectoryTransition(state:IndustryDirectoryState,action:{type:'open';workspace:IndustryWorkspaceId}|{type:'back'}|{type:'category';category:IndustryCategory}|{type:'query';query:string}):IndustryDirectoryState{
  if(action.type==='open')return industryWorkspaces.some(entry=>entry.id===action.workspace)?{...state,workspace:action.workspace}:state;
  if(action.type==='back')return {...state,workspace:null};
  if(action.type==='category')return {...state,workspace:null,category:action.category};
  return {...state,query:action.query};
}
export const industryDirectoryStorageKey=(scopeKey:string)=>`one-industry-location:v1:${encodeURIComponent(scopeKey)}`;
export function decodeIndustryDirectory(value:string|null,scopeKey:string):IndustryDirectoryState{try{const data=JSON.parse(value??'null') as {scopeKey?:string;state?:IndustryDirectoryState}|null,state=data?.state;if(data?.scopeKey!==scopeKey||!state||!['all','teaching','commerce'].includes(state.category)||typeof state.query!=='string'||state.workspace!==null&&!industryWorkspaces.some(entry=>entry.id===state.workspace)||state.collection!==undefined&&!['all','favorites'].includes(state.collection))return emptyIndustryDirectory();return {category:state.category,workspace:state.workspace,query:state.query.slice(0,200),collection:state.collection??'all'};}catch{return emptyIndustryDirectory();}}
export const encodeIndustryDirectory=(state:IndustryDirectoryState,scopeKey:string)=>JSON.stringify({scopeKey,state});

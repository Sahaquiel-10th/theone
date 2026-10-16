import {visualToolPresets} from './visualTools.js';
/** Same reviewed function handlers used by the welcome pipeline. */
export const visualFeatureLibrary=visualToolPresets.map((tool,index)=>({id:index?'one-visual-html':'one-visual-flow',sourceId:index?'VISUAL_HTML':'VISUAL_FLOW',values:{
  name:tool.name,description:tool.description,author:'ONE',integration:'question_answer',category:'general',knowledgeMode:'optional',usageMultiplier:.6,
  instructions:`先理解用户的具体目标与已有材料，选 2–6 个有差别的使用场景或阶段，不为凑页面重复同一句话。每个场景写清情况、实际动作、优势、用户得到的益处、怎样核对结果和 2–5 个步骤，另给一句可直接使用的示例。调用 ${tool.id} 交付真实文件，不能只返回代码或声称已生成。工具参数 version=1；title、intro；scenes 内包含 id（英文字母开头）、title、situation、feature、advantage、benefit、evidence、steps（字符串数组）、prompt、capabilityIds（普通文档可空数组）。只有真实工具回执才表示完成。文字像朋友解释，不写营销口号、重复旁白或虚假的客户证据。不得捏造资料、链接、时效性事实或未授权能力。`,
  limitations:'生成私有成果，不自动发布或发送。只处理本次授权资料；不接受可执行脚本、任意 HTML 或联网资源。简单短答不需要本功能。',
  tools:[{id:tool.id,description:tool.description}],skillAttribution:'ONE 自编场景与 FABE 策划、安全结构化渲染。设计参考：Anthropic frontend-design（Apache-2.0，固定版本见 skills-library/upstream/README.md）；不执行远程脚本。',
  experience:{inputs:[],actions:[{id:'create',label:index?'做成交互网页':'整理成完整流程图',instruction:'按用户实际材料和目的整理结构，再调用工具生成可查看与保存的成果。'}],promptPlaceholder:index?'例如：把这些资料做成一份可以点开步骤的入门说明':'例如：把从收集需求到交付成果的过程画清楚',tags:index?['说明','攻略','网页']:['流程','分工','全图']}
}}));

export const onboardingPurposes = [
  {id:'writing',title:'写作与表达',description:'文章、文案、把想法说清楚',words:['写作','文案','文章','朋友圈','内容','润色']},
  {id:'work',title:'处理工作',description:'方案、汇报、把事情理顺',words:['方案','项目','汇报','报价','客户','会议','计划']},
  {id:'learning',title:'学习与查资料',description:'找依据、读懂资料、整理知识',words:['知识','资料','学习','研究','阅读','总结']},
  {id:'files',title:'整理文件与表格',description:'做文档、算表格、交付文件',words:['表格','文件','文档','数据','PPT','演示']},
  {id:'life',title:'安排日常生活',description:'旅行、活动、生活里的小计划',words:['旅行','活动','生活','安排','攻略','计划']},
  {id:'explore',title:'先聊聊再说',description:'想到什么，就从什么开始',words:[]},
] as const;
export type OnboardingPurpose = typeof onboardingPurposes[number]['id'];

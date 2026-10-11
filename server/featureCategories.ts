export const featureCategories=[{id:'general',name:'通用助手'},{id:'knowledge',name:'问答检索'},{id:'writing',name:'写作整理'},{id:'research',name:'研究分析'},{id:'office',name:'办公效率'},{id:'creative',name:'创意设计'},{id:'store',name:'门店经营'},{id:'marketing',name:'营销获客'},{id:'service',name:'客户服务'},{id:'training',name:'学习培训'}] as const;
export type FeatureCategory=typeof featureCategories[number]['id'];

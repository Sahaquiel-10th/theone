import type { ReviewDraft, ReviewTemplate } from "./reviewReplyTypes.js";

export function defaultReviewDraft(): ReviewDraft {
  return {
    name: "我的店铺回复规则", shopName: "", brand: "", platform: "天猫",
    settings: {
      tone: "真诚温和、专业克制，像熟悉产品的店员自然交流", length: "medium", count: 2,
      marketing: "light", address: "自然称呼", emoji: false, signature: "", closing: "",
      goals: ["回应真实体验", "解答问题", "需要时补充产品信息"], forbiddenPhrases: ["亲亲", "绝对有效", "百分百"],
      afterSales: "遇到售后问题先理解顾客感受，引导通过店铺官方客服核实，不编造处理进度或赔付承诺。",
      sceneRules: {
        "具体好评": "回应评价里的具体体验，避免重复堆砌广告。", "简短好评": "简短感谢，不为凑字数添加功效。",
        "复购": "客户明确说复购时再感谢持续选择。", "混合评价": "先回应不满意的地方，再回应肯定之处。",
        "产品疑问": "仅使用已确认且与所选商品相关的事实，资料不足时引导核实。", "投诉或不适": "优先关心与解决问题，停止营销，必要时引导官方客服或专业帮助。",
      },
    },
    products: [], facts: [], examples: [], rules: [], sourceAttachmentIds: [],
  };
}

export function reviewReplyTemplates(_user?: unknown): ReviewTemplate[] {
  const templates: ReviewTemplate[] = [{ id: "blank", name: "从空白开始", description: "填写店铺资料，或上传资料让 AI 先整理一份草稿。", draft: defaultReviewDraft() }];
  return templates;
}

# ONE 工作技能候选清单（待用户选择）

调研日期：2026-10-10。仅查看公开仓库、说明和许可；未下载、安装、上架第三方 skill。以下是工作流程及产品适配评估，不是 ONE 中的运行效果验收。

## 现有产品接入方式

后台官方功能维护说明、模型、知识使用方式和受审工具，保存草稿后试运行、认定版本、定向上架。核心调度选择本人可用的已发布功能；任务使用固定版本的说明，工具权限和知识连接由代码及 workspace 授权限制。不能把 skill 文本、MCP 连接和本机执行器混为一件事。

首批建议使用用户提供的文本或其本人已授权知识生成工作成果。外部 CRM、邮箱、日历、项目管理系统的读写动作需要独立适配；skill 本身不会使这些服务自动可用。涉及文件和脚本的技能需要本机执行路径单独验收。

## 优先候选：Anthropic Knowledge Work Plugins

来源：https://github.com/anthropics/knowledge-work-plugins

许可：https://github.com/anthropics/knowledge-work-plugins/blob/main/LICENSE （Apache 2.0；保留许可、署名、适用 NOTICE，并注明修改）。作者明确将工作插件开源。只考虑官方目录，partner-built 需另审。

| 路径 / 原名 | ONE 用户看到的功能 | 适配边界 | 建议 |
| --- | --- | --- | --- |
| operations/skills/status-report | 周报、月报与项目进展 | 用户资料生成汇报；不默认读取团队聊天或发布 | 首批 |
| operations/skills/process-doc | 岗位经验整理成 SOP | 保留触发条件、步骤、责任和例外；不自动写入外部知识库 | 首批 |
| sales/skills/call-summary | 客户会议复盘与跟进稿 | 使用记录或转写文本；邮件发送和 CRM 更新另接 | 首批 |
| customer-support/skills/draft-response | 客户沟通与回复草稿 | 不承诺未经证实的赔付、时限或已完成动作 | 首批 |
| customer-support/skills/kb-article | 处理经验整理成 FAQ / 帮助文章 | 输出草稿，不自动发布到知识库 | 首批 |
| product-management/skills/write-spec | 想法整理成需求说明 | 明确问题、范围、需求、验收标准 | 首批 |
| product-management/skills/synthesize-research | 用户访谈与调研总结 | 使用所提供的材料，保留证据和不确定项 | 首批 |
| product-management/skills/competitive-brief | 竞品分析简报 | 公开资料调研需适配 ONE 搜索并验证引用 | 第二批 |
| operations/skills/process-optimization | 工作流程改进 | 提出建议，不自动变更业务流程 | 第二批 |

以上逐项阅读公开 SKILL.md；其中一些超过 ONE 现有 12000 字说明上限或引用目录外 CONNECTORS.md，需要在选定后做中文适配、补齐依赖或拆分，不能直接声称原包即插即用。

## 内容营销候选：Corey Haines Marketing Skills

来源：https://github.com/coreyhaines31/marketingskills

许可：https://github.com/coreyhaines31/marketingskills/blob/main/LICENSE （MIT，保留许可与版权声明）。README 明确技能库免费且以 MIT 发布，由合作伙伴资助。作者也提供代理、培训和付费产品；目前证据支持免费技能库与付费服务分开。如果用户希望连有商业服务的作者也排除，则整组移入自主编写需求，不直接引入。

| 原名 | 用途 | 建议 |
| --- | --- | --- |
| copywriting | 产品、网站与活动营销文案 | 首批备选；适配中文语境 |
| copy-editing | 修改文案、提升清晰度和说服力 | 首批备选 |
| content-strategy | 内容选题与发布计划 | 首批备选 |
| customer-research | 客户访谈、评论和需求研究 | 与 synthesize-research 去重后选 |
| sales-enablement | 销售介绍、异议处理与演示材料 | 第二批 |
| seo-audit | 网站搜索表现诊断 | 第二批，需要网页读取和工具验证 |
| ad-creative | 广告标题及素材文案 | 第二批；不包含自动投放 |

已阅读 copywriting/copy-editing/content-strategy/customer-research/sales-enablement 的公开说明；seo-audit/ad-creative 在仓库目录与说明中确认，本轮未做实际运行验证。技能之间引用 product-marketing 及 references，选定后需逐项核对完整依赖与许可证。

## 其他

- anthropics/skills 的 internal-comms：Apache 2.0，适合内部沟通、进度更新和 FAQ；需携带 examples，可能与 status-report 重复。
- anthropics/skills 的 frontend-design：单项 LICENSE.txt 为 Apache 2.0，适合网站与页面制作；需本机执行能力，暂不列入首批通用办公功能。
- anthropics/skills 的 doc-coauthoring：工作流程有参考价值，但目录只有 SKILL.md，没有该项单独 LICENSE.txt；本轮不归入已确认可直接引入清单。

## 不直接引入，记录用户需求

1. alirezarezvani/claude-skills：虽然仓库是 MIT，但 STORE.md 明确规划商业技能包、单项技能销售。遵照用户的商业意图筛选标准，不直接引入。记录原名：contract-and-proposal-writer（方案与报价/项目范围草拟）、competitive-teardown（竞品拆解）、runbook-generator（操作手册）、landing-page-generator（营销页面）、email-template-builder（邮件模板）。需求若入选，独立设计输入、步骤、验收和输出，不复制付费实现。合同类需要本地业务与法律语境另审。
   证据：https://github.com/alirezarezvani/claude-skills/blob/main/STORE.md
2. anthropics/skills 的 docx / xlsx / pptx / pdf：仓库声明 source-available、非开源；docx/LICENSE.txt 限制复制、修改和分发，不直接作为 ONE 的商用技能。记录需求：Word 文档、Excel 表格、PPT 演示和 PDF 处理，未来寻找授权清楚的独立实现或自行开发。
   证据：https://github.com/anthropics/skills/blob/main/skills/docx/LICENSE.txt
3. ComposioHQ/awesome-claude-skills：发现会议分析、发票归类、文件整理、资料写作等工作场景；README 声明整个仓库为 Apache 2.0，同时提示单项技能可能采用不同许可；本轮根目录和相关目录未发现完整 LICENSE 文件，单项授权范围尚未核实。不能将公开代码或聚合目录等同于可商用授权；暂缓。记录原名：meeting-insights-analyzer、invoice-organizer、file-organizer、content-research-writer。
   来源：https://github.com/ComposioHQ/awesome-claude-skills

## 选定后的本地保存约定

用户确定前不建立第三方技能副本。选定后在项目的 skills-library/ 下保存原始包、完整许可与 NOTICE、仓库 URL、确切 commit SHA、检查日期，以及独立的 ONE 中文适配版本与验收记录。原始文件和适配文件分开，保留作者署名，先在测试账号验证再通过现有认定/上架流程发布。

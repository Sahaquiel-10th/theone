# 工作面板默认尺寸、返回入口与功能页宽度回归修复

基线a885b31。修改前备份：/Users/machao/Desktop/ONE-UI备份/20261024-layer-bounds（336个前端/资源/构建/配置文件与SHA256）。隔离副本：/Users/machao/.codex/worktrees/one-ui-layer-bounds-20261024。

## 问题和修复

- 任务与成果默认以居中窗口打开，宽度不超过1180px、高度不超过800px，并保留至少48px的上下与左右空间（桌面验收范围）。手动“放大”仍可占满工作区，“还原”回到普通窗口；从最大状态关闭再打开也默认普通窗口。
- 顶部提供明确的X＋返回对话＋Esc按钮，36px高，1280px视口实测宽约127px。放大/还原也有文字。只通过可选closeLabel改变FluidWorkLayer，普通嵌套设置弹窗保持原关闭行为。
- 功能页由grid改为column flex后，继承的align-items:start导致shelf按内容收缩，最大化也未拉宽。现对features-page、account-body与shelf明确设置stretch、width:100%、min-width:0、max-width:none。未改功能选择、计费或运行逻辑。

## 实际浏览器证据

1920×960真实CSS视口，最大化且详情打开时，account-body宽1870px，修复前shelf仅302.41px（左128px/右164px）；修复后shelf1870px（左736px/右1110px）。

1280×720任务窗口实测1180×624，左50px、上48px；1440×900任务窗口1180×800，左130px、上50px。已检查先开详情再最大化、栏目往返、还原、保留详情时切1440宽度、连续多选、点击返回及Esc、从最大状态关闭后重开。

宽桌面诊断使用output/playwright/wide-workspace.html：只设iframe真实viewport与外层显示比例；可见“读取布局尺寸”按钮只读布局，不注入内部样式或状态、不自动点击。所有测试数据为本地合成，未访问生产私人会话、调用模型或操作设备。

## 检查与发布

1236项测试中1235通过、0失败、1项既有跳过；TypeScript、生产构建、git diff --check及4个应用文件的独立审查通过。截图、各阶段尺寸与发布读回保存在docs/testing/2026-10-24-layer-bounds/；正式部署以deployment.json和production-after.json为准。

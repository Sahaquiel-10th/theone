# 等待区整体重排与启动旧界面闪现修复

## 设计与范围

等待状态改为与助手正文左边缘对齐的 440px 烟银玻璃气泡：阶段为主信息，右侧为紧凑计时和停止按钮，内部为 4px 中性银灰模拟进度线。去掉金色、旋转图标和重复等待旁白。模拟线仍缓慢推进，真实回复返回才填满；不显示伪造百分比或完成时间。停止时保存屏幕上的实际宽度，失败时恢复并提供重试提示。减弱动态效果时保留静态进度线。

沿用现有玻璃、边界、文字与浅深色语义变量，不增加全屏模糊或阴影。未改变模型调用、计费、任务权限或已有任务状态。

## 启动根因与修复

`useCoordinator` 首次快照未到时，enabled 默认为 false。旧逻辑立即渲染旧工作台，待接口返回 true 后才切成新版。管理员与公司管理初始页面也要等 effect 转入新版工作层。Mac/Windows 启动器仅打开带一次性登录码的基础地址，没有主动选择旧版。

现在区分“首次未知”“首读失败”“明确关闭”“新版已确认”：前两种保持新版玻璃启动壳，失败可重新连接；服务端明确关闭时才保留旧界面。已有快照的后台刷新失败不切换界面。没有强制启用后端功能或跳过授权。

启动壳退出后才启用依赖 canvas 的尺寸、内容流、活动高度与滚动监听，避免首次空 ref 导致工作区几何失效。

## 验证

- TypeScript、生产构建、`git diff --check` 通过。
- 全量测试 1,695 项：1,694 通过，1 项跳过，0 失败。
- 29 项定向测试覆盖等待文案/计时/尾态、启动未知/失败/明确关闭、目的页接入、工作区隔离及安全合成预览。
- 使用 IAB 实际渲染：浅色和本机执行深色等待气泡；停止请求延迟 3 秒后失败，停止前后宽度均为 357.367px，恢复后继续增长，按钮可重试。
- 合成一次性登录慢读：`auth → startup:loading → startup:retry → workspace`，没有 legacy；12 秒延迟触发原有超时后自动恢复。
- 首次失败手动重连：`auth → startup:loading → startup:retry → workspace`，没有 legacy。
- 管理员、公司管理：均 `auth → startup:loading → workspace`，没有 legacy。
- 服务端明确 disabled：允许进入原有旧界面，保留真实功能开关。
- 启动后 canvas 1180×696，缩窗后 1052×696；正文阅读宽度 948→884，任务自然高度与跟随最新滚动标记正常。

截图及内容无关的 DOM 状态记录见同目录。预览使用合成数据，未请求真实模型、执行真实本机任务或消耗电力；真实 ONE Key 硬件启动的用户验收另行确认。

## 复现

本地 Vite 下打开 `/output/playwright/focus-preview.html`：

- `?statusAudit=1&statusCase=waiting&scene=graphite`
- `?statusAudit=1&statusCase=local&scene=graphite`
- `?statusAudit=1&statusCase=stop-rejected&statusStopDelay=3000&scene=graphite`
- `?startupAudit=1&startupDelay=12000&scene=graphite#one-key=fixture-startup-code`
- `?startupAudit=1&startupFailures=1&scene=graphite#one-key=fixture-startup-code`
- `?startupAudit=1&startupRole=admin&startupDelay=1000&scene=graphite#one-key=fixture-startup-code`
- `?startupAudit=1&startupRole=company&startupDelay=1000&scene=graphite#one-key=fixture-startup-code`
- `?startupAudit=1&startupDisabled=1&scene=graphite#one-key=fixture-startup-code`

这些 audit 参数强制本地合成拦截，不可用来访问生产数据。

## 备份

改前完整前端及启动器备份：桌面 `ONE-UI备份/20261029-等待区与启动修复/before-source.zip`，CRC 已验证。源代码修改位于独立工作副本，原始桌面仓库的未提交文件未被覆盖。

## 已发布与线上读回

源码提交 `b7a963b953571864105c35f12e1b6ed947fb0018` 已上线。[Actions 40791282760](https://github.com/Sahaquiel-10th/theone/actions/runs/40791282760) 四个 job 全成功，部署于北京时间 2026-10-29 08:19:09 完成。08:20:29 UTC+8 读回首页与 `/api/health` 均为 200；首页引用的 JS/CSS 路径与本地生产构建一致，两文件 SHA-256 字节核对一致。详细哈希、缓存头与 job 时间见 `release.json`。

线上资源一致性与公开健康已确认；本轮浏览器交互为本地合成验收，未代替用户真实 ONE Key 冷启动验收。

# ONE

ONE 是一个面向个人用户的多租户 AI 工作台。首版聚焦 ONE Key 身份入口、知识平台一键连接，以及把已授权知识实时注入 AI 上下文。得到大脑是第一个 Connector，不是长期唯一知识来源。

## 本地开发

```bash
cp .env.example .env
npm install
npm run dev
```

前端默认运行在 `http://localhost:5173`，服务端运行在 `http://localhost:3001`。

## 得到大脑连接

1. ONE 运营方只需申请一次得到开放平台应用，并把 Client ID 写入服务端 `GETNOTE_CLIENT_ID`；每位客户无需申请应用。
2. 登录 ONE，进入“得到大脑”，点击“连接得到大脑”。
3. 客户在打开的得到官方页面登录并确认授权，ONE 自动轮询并保存授权结果；客户不需要进入开发者后台或复制 API Key。当前前提是该用户已经注册得到大脑并开通会员；无账号用户暂由运营人工协助。
4. ONE 加密保存每个 Workspace 独立凭据，后续聊天直接进行全局语义检索，并把结果加入 AI 上下文。
5. 不同 Workspace 的凭据和检索日志互不共用。首版不把第三方知识正文同步保存到 ONE。

生产环境必须设置长度不少于 32 个字符的 `PROVIDER_CREDENTIALS_KEY`，知识平台凭据只以 AES-256-GCM 密文持久化。

## Notion 连接

登录 ONE 后进入“知识来源”，点击“连接 Notion”，在 Notion 官方页面确认一次即可。服务端默认通过 Notion 官方 MCP 的动态客户端注册完成初始化；生产环境也可预置 `NOTION_MCP_CLIENT_ID` 和 `NOTION_MCP_CLIENT_SECRET`。Notion 首版只允许搜索和读取，不开放任何创建、更新、评论或删除工具。

## macOS ONE Key 原型

超管在运营后台的“ONE Key”页为用户签发凭证并下载 JSON。开发环境可运行：

```bash
npm run build:one-key:mac -- --credential /path/to/credential.json
```

便携测试可以把生成目录整体复制到 U 盘。正式方案是在新 Mac 上把内置 Runtime 的 `ONE.app` 安装到“应用程序”一次，U 盘以后只保存很小的设备凭证；本地 App 会自动寻找已插入的 ONE Key。macOS 不允许普通 U 盘在插入时静默自动运行；完全零点击需要用户预装受信任的常驻 Helper，不属于 V0.1。当前构建使用本机 ad-hoc 签名供开发测试，正式交付需要 Developer ID 签名和 Apple 公证。

开发版会依次寻找 App 内置 Runtime、ChatGPT 内置 Codex 和系统 Codex。正式安装包应固定并内置经过验证的 Runtime，用户只安装一次，日常执行不会下载或显示安装进度：

```bash
npm run build:one-key:mac -- --credential /path/to/credential.json --codex-bin /path/to/codex
```

首次从消息旁点击执行时选择一个本地工作文件夹；之后 ONE 在黑色执行页直接显示 Codex 的过程和结果，切回普通聊天不会中断任务。

## 验证

```bash
npm test
npm run build
```

项目边界、数据模型、接口和后续执行项见 [docs/ONE-PROJECT-EXECUTION-CHECKLIST.md](docs/ONE-PROJECT-EXECUTION-CHECKLIST.md)。

# ONE Mac 静态网页预览验收

0.4.13 增加 ONE 自己管理的本机静态预览，不改变 Codex 沙箱。网页入口在事情和工作台的执行详情内。选择授权文件夹中的 HTML 相对路径，启动后打开预览，也可停止；每台电脑同时保留一个预览，新预览替换旧预览。

## 范围和权限

只提供 UTF-8 HTML、CSS、JS、SVG 文件，每个文件沿用本机文件工具的 2 MB 上限。预览限制在入口文件所在项目目录，不展示目录，不支持上传，不执行工程命令，不支持图片等二进制资源。监听地址为 127.0.0.1，自动选择空闲端口；地址带随机访问标识并校验 Host。符号链接、隐藏文件、越界路径沿用受限文件工具的拒绝规则。

拔掉 Key、变更授权文件夹或驻留连接退出时停止，最长持续 30 分钟。新预览不会停止独立 Codex 任务。浏览器禁止跨站资源和接口请求；此能力不是对网页所有浏览器行为的通用隔离。Vite、Next、Node 工程服务，以及 Windows 预览未实现；Windows 仅同步启动器版本，不声明工程执行或预览验收通过。

## 自动验收结果

| 预期 | 实际 | 证据 |
| --- | --- | --- |
| 正常页面能通过本机 HTTP 返回 | 200，返回预设正文 | LocalPreviewTests.swift 实际连接本机监听器 |
| 中文文件名能打开 | 编码地址可读，返回中文正文 | 同上 |
| 无标识、伪造 Host、越界路径、符号链接不可读 | 403 或 404，不返回目录外正文 | 同上 |
| Key 不在场不得启动，移除后不能继续访问 | 启动被拒绝；运行后移除模拟在场信号，2.5 秒后连接失败 | 同上，不等同真实拔盘测试 |
| 手动停止后不能访问 | 连接失败 | 同上 |
| 其他工作区、用户、设备、安装实例或事情不能发预览命令 | 拒绝 | staticPreview.test.ts |
| 运行中的任务、旧启动器、断开连接不能伪报预览成功 | 拒绝 | staticPreview.test.ts |
| 地址必须是有标识的本机有效端口，确认时重新核验归属 | 正常回执通过，伪造地址和归属变更拒绝 | staticPreview.test.ts；模拟回执，不等同真实驻留回传 |

隔离本次改动后的类型检查与生产构建通过。应用测试 488 项，487 通过，1 项原有压测跳过。Mac 原生 HTTP 测试通过，Windows Go 测试通过；Mac Universal 与 Windows x64 构建完成，签名清单及制品校验返回 VERIFIED_VERSION=0.4.13。本次隔离验证避免混入另一个正在开发的会员计费和 skills 改动。

## 发布与真实页面验收

更新包 output/theone-runtime-0.4.13.tar.gz，约 4.1 MB，不包含新的 Codex 工具包、私钥、供应商凭据或用户资料。SHA-256 为 82838d02187dceacd698a9105fff07a5db08e2f6e991db0c67ed670be70afd2a。

上传到服务器 /home/ubuntu 后执行：

```bash
(
set -e
printf '%s\n' '82838d02187dceacd698a9105fff07a5db08e2f6e991db0c67ed670be70afd2a  /home/ubuntu/theone-runtime-0.4.13.tar.gz' | sha256sum -c -
release_stage=$(mktemp -d /tmp/theone-runtime-0.4.13.XXXXXX)
tar -xzf /home/ubuntu/theone-runtime-0.4.13.tar.gz -C "$release_stage"
sudo bash /srv/theone/current/deploy/install-runtime-update.sh "$release_stage/one-runtime-0.4.13"
)
```

真实 ONE 页面验收尚待新版启动器上线并实际连接。保留桌面 test 内原工程及任务历史，通过原事情的执行详情启动 qa-codex-20261010/index.html，检查页面与交互、停止后的断开、目录变更和真实拔盘后的停止。网站部署成功或原生 HTTP 单元测试不能替代这一验收。

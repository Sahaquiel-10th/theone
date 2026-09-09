# ONE Key 灌装与交付

## 当前 V0.1 流程

1. 超管先在“账号”中创建用户。
2. 在“ONE Key”中选中该用户，填写印在 U 盘标签上的唯一序列号。
3. 点击“生成并下载凭证”。私钥只会下载这一次，服务端只保存公钥。
4. 把 U 盘插入用于灌装的 Mac，执行：

```bash
npm run provision:one-key:mac -- --list-volumes
npm run provision:one-key:mac -- --credential ~/Downloads/ONE-序列号.one-key.json --volume /Volumes/U盘名称
```

如果这只 U 盘以前灌装过，确认需要替换后增加 `--replace`。脚本会先把旧的 `ONE.app` 和 `.one` 目录移动到带时间戳的备份目录，不会格式化 U 盘，也不会修改其他文件。

5. 需要兼容 Windows 时，在同一只已经写入凭证的 U 盘上继续执行：

```bash
npm run provision:one-key:windows -- --volume /Volumes/U盘名称
```

Windows 构建需要 Go 1.23 或更高版本。可用 `--go-bin /完整路径/go` 指定不安装到系统的 Go 工具链。重复灌装时增加 `--replace`。

6. 弹出再插入 U 盘：macOS 双击 `ONE.app`，Windows 双击 `ONE.exe`。两端共用 `.one/credential.json`，因此对应同一个 ONE Key、账号和 Workspace。
7. 在超管后台核对序列号、绑定用户和最后使用时间，再贴标并交付。

## 当前边界

- 序列号是运营标签，不是普通 U 盘可靠的硬件唯一标识。
- 普通 U 盘里的私钥仍可被复制；挂失会让该设备 ID 的所有副本一起失效。
- 当前是“超管创建账号并预绑定 U 盘”，还不是用户收到未绑定 U 盘后自行认领。
- macOS 和 Windows 都不应依赖普通 U 盘自动运行应用；V0.1 保留“插入后双击对应 ONE 图标”。
- 启动器首次运行后会把“同一枚 Key 仍可读取”视为在场状态：休眠、临时断网和服务重启后持续自动重连；拔出时每次请求无法完成新签名，重新插回同一枚 Key 后可在当前系统会话内恢复。电脑重启或手动退出启动器后仍需再次双击。
- ONE Key 浏览器会话默认有效 30 天，但每次受保护请求仍须由当前插着的 U 盘实时签名；延长浏览器会话不会让未插 Key 的页面继续使用。
- Windows V0.2 启动器内置 ONE Local Agent：首次执行选择授权文件夹；读取限制在该目录，写文件和运行 PowerShell 命令需要逐次确认。
- Windows 首版的命令确认不是完整系统沙箱；只应批准看得懂且符合当前任务的命令。正式大规模交付前还需完成 Authenticode 签名与系统沙箱加固。

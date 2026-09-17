# Windows 在线升级真机验收清单

## 2026-09-17 实测记录

用户确认在 Windows 网页点击更新成功。TOMATO ONE 返回 Mac 后复核：Windows EXE SHA-256 与 0.3.8 发布包完全一致；小星凭证和 Mac 主程序的 SHA-256 均与升级前相同；存在 `ONE-for-Windows-0.3.6.exe` 备份；Mac 签名有效；按实时卷路径执行 `diskutil verifyVolume`，`fsck_msdos` 返回 0。双系统更新的文件完整性检查通过。

Windows 更新后的拔插恢复、休眠唤醒、重启尚待测试人明确确认，不据上述结果自动勾选。

测试对象：`TOMATO ONE`（小星）

升级路径：Windows `0.3.6 → 0.3.8`

服务器稳定版：`0.3.8`
测试原则：不重新灌装、不替换凭证、不格式化；任何异常先停止并保留现场。

## 一、去 Windows 电脑前的已知基线

| 项目 | 升级前预期 |
| --- | --- |
| 小星凭证 SHA-256 | `c9f793b0849f174f9f7b6ee6ae0adfe37a7973bbf0eb7981574e263babb519b5` |
| Mac 主程序 SHA-256 | `2d89f9d2cdd3f385b8bcd9c19dd09ce82842a8ea28ff9a6ec01cf67f0a737409` |
| Windows 旧版 SHA-256 | `2ec55938752f75ef89b12ee114bd5a142d5a6fad8a45839bb8ef74693bb3c77a` |
| Windows 新版 SHA-256 | `97f17c772d3dfb4d70b60d76f2f00dd8c76128551d7c10aaf5e4ed7dd9fd2a3d` |

## 二、记录盘符与升级前哈希

插入 `TOMATO ONE` 后，用 PowerShell 运行。不要照抄某个固定盘符，命令会按卷名解析当前盘符：

```powershell
$one = Get-Volume -FileSystemLabel 'TOMATO ONE' | Where-Object DriveLetter | Select-Object -First 1
if (-not $one) { throw '没有找到 TOMATO ONE' }
$drive = "$($one.DriveLetter):"
$drive
Get-ChildItem "$drive\" -Force
Get-FileHash "$drive\.one\credential.json" -Algorithm SHA256
Get-FileHash "$drive\ONE for Mac.app\Contents\MacOS\ONE" -Algorithm SHA256
Get-FileHash "$drive\ONE for Windows.exe" -Algorithm SHA256
```

三项哈希应与上表升级前预期一致。若电脑同时插着同名卷，不继续测试；先只保留小星盘。

## 三、启动与账号确认

1. 双击 `ONE for Windows.exe`。
2. 浏览器应自动打开 ONE，并进入小星账号；不能进入 admin 或另一名用户。
3. 知识连接应显示已经接入，不要求重复授权。
4. 提问“小星的跨设备召回测试码是什么？”应能召回此前测试知识。若调用模型会产生电力，先确认账户有测试额度。
5. 记录是否出现 SmartScreen/未知发布者提示。内测阶段可能出现，但不得出现程序损坏或凭证错误。

## 四、执行在线升级

1. 页面应显示 `ONE 可以更新`；若没有，先刷新一次并等待驻留上线，不重复双击多次。
2. 只点击一次更新，观察下载、校验、安装、完成状态。
3. 更新过程中不拔盘、不休眠、不关闭浏览器。
4. 完成后更新提醒应消失，新版驻留应自动接管；不应要求重新登录或重新授权知识库。
5. 再双击一次 `ONE for Windows.exe`，应打开/聚焦页面，不应产生多个常驻进程或重复弹窗。

## 五、升级后完整性检查

在 PowerShell 继续运行：

```powershell
Get-FileHash "$drive\.one\credential.json" -Algorithm SHA256
Get-FileHash "$drive\ONE for Mac.app\Contents\MacOS\ONE" -Algorithm SHA256
Get-FileHash "$drive\ONE for Windows.exe" -Algorithm SHA256
Get-ChildItem "$drive\.one\update-backups" -Force
Get-ChildItem "$drive\" -Force | Where-Object Name -Like '.one-*-update*'
chkdsk $drive
```

验收标准：

- 凭证仍为 `c9f793...19b5`。
- Mac 主程序仍为 `2d89f9...7409`。
- Windows 新版变为 `97f17c...d2a3d`。
- `.one\update-backups` 中存在旧 Windows 备份；根目录没有残留 `.one-windows-update.exe`。
- `chkdsk` 不报告文件系统错误。

## 六、Key 在场回归

1. 保持网页打开并正常发送一条测试消息。
2. 拔出 U 盘，再发消息：应立即提示插入 Key，并且不等待模型返回、不消耗电力。
3. 重新插入同一盘，等待约 1～2 秒；不刷新、不重新双击，再发消息应恢复。
4. 让电脑休眠后唤醒：Key 插着时应自行恢复；若网页标签已关闭，再双击启动器应能重新打开。
5. 重启 Windows：重启后允许要求双击一次；进入的仍必须是小星账号。

## 七、多盘与盘符变化抽检

完成单盘测试后，才可以插入另一枚 ONE Key：

- Windows 可能给两只盘分配不同且可变化的盘符，这是正常现象。
- 从哪只盘双击，就必须进入那只盘绑定的账号；驻留重连只接受同一 `deviceId`。
- 拔掉小星盘不能由另一枚 Key 代替小星完成在场证明。
- 不以盘符或卷名判断身份，以签名凭证和服务端绑定为准。

## 八、停止条件与回传材料

出现以下任一情况立即停止，不反复点击更新：账号串号、凭证哈希变化、Mac 文件变化、更新临时文件残留、文件系统错误、拔盘后仍能发消息、重插必须刷新/重启、重复常驻进程或持续弹权限窗口。

请带回：升级前后三项哈希、`update-backups` 列表、`chkdsk` 最后一段结果、更新界面截图、插拔与重启结果。通过后再把 Windows 项在量产放行文档中勾选。

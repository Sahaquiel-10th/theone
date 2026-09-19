#!/usr/bin/env python3
"""Copy running relay payment configuration into ONE; never restart either service."""
import base64
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile


def run(args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError("只读检查失败，未显示可能含敏感信息的命令输出")
    return result.stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError("请用 sudo python3 运行")
    os.umask(0o077)
    target = Path("/srv/theone/shared/.env")
    if target.is_symlink() or not target.is_file():
        raise RuntimeError("ONE .env 不存在或是符号链接，停止")
    original = target.read_bytes()
    owner = pwd.getpwnam("theone")
    ids = run(["docker", "compose", "--project-directory", "/opt/super-relay", "-f",
               "/opt/super-relay/docker-compose.yml", "ps", "-q", "app"]).decode().split()
    if len(ids) != 1:
        raise RuntimeError("无法唯一确定运行中的中转站容器")
    # Config and files never pass through stdout of this installer or command arguments.
    reader = """const fs=require('fs');const names=['APP_ID','MCH_ID','MERCHANT_SERIAL_NO','PUBLIC_KEY_ID','API_V3_KEY'];
const env=Object.fromEntries(names.map(n=>['WECHAT_PAY_'+n,process.env['WECHAT_PAY_'+n]||'']));
const files={};for(const n of ['PRIVATE_KEY_PATH','PUBLIC_KEY_PATH']) files[n]=fs.readFileSync(process.env['WECHAT_PAY_'+n]).toString('base64');
process.stdout.write(JSON.stringify({env,files}));"""
    payload = json.loads(run(["docker", "exec", ids[0], "node", "-e", reader]))
    env = payload["env"]
    if any(not isinstance(v, str) or not v or not re.fullmatch(r"[A-Za-z0-9_-]+", v) for v in env.values()):
        raise RuntimeError("支付配置缺失或格式不受支持，未修改 ONE")
    if len(env["WECHAT_PAY_API_V3_KEY"].encode()) != 32:
        raise RuntimeError("API v3 密钥长度不正确")
    private = base64.b64decode(payload["files"]["PRIVATE_KEY_PATH"], validate=True)
    public = base64.b64decode(payload["files"]["PUBLIC_KEY_PATH"], validate=True)
    run(["openssl", "pkey", "-check", "-noout"], private)
    run(["openssl", "pkey", "-pubin", "-noout"], public)
    # A new private directory on every run preserves earlier configuration/certificates.
    directory = Path(tempfile.mkdtemp(prefix="wechat-config-", dir=target.parent))
    os.chown(directory, 0, owner.pw_gid)
    os.chmod(directory, 0o750)
    backup = directory / "previous.env"
    backup.write_bytes(original)  # root-only backup, potentially contains other ONE secrets.
    for name, data in [("apiclient_key.pem", private), ("wechatpay_public_key.pem", public)]:
        destination = directory / name
        destination.write_bytes(data)
        os.chown(destination, 0, owner.pw_gid)
        os.chmod(destination, 0o640)
        run(["runuser", "-u", "theone", "--", "test", "-r", str(destination)])
    env.update({"WECHAT_PAY_PRIVATE_KEY_PATH": str(directory / "apiclient_key.pem"),
                "WECHAT_PAY_PUBLIC_KEY_PATH": str(directory / "wechatpay_public_key.pem"),
                "WECHAT_PAY_NOTIFY_URL": "https://theone.aiarrival.cn/api/pay/wechat/notify"})
    lines = [line for line in original.decode().splitlines()
             if not re.match(r"^\s*(?:export\s+)?WECHAT_PAY_[A-Z0-9_]+\s*=", line)]
    staged = directory / "next.env"
    staged.write_text("\n".join(lines) + "\n" + "\n".join(f'{k}="{v}"' for k, v in env.items()) + "\n")
    os.chown(staged, owner.pw_uid, owner.pw_gid)
    os.chmod(staged, 0o600)
    if target.read_bytes() != original:
        raise RuntimeError("ONE 配置被其他操作更改，停止替换；备份已保留")
    os.replace(staged, target)
    print("ONE_WECHAT_CONFIG_READY")
    print(f"ONE 原配置备份：{backup}")
    print("未修改中转站；未重启任何服务；未发起支付；等待部署 ONE 后再验证。")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, RuntimeError):
            print(str(error))
        else:
            print(f"检查失败类型：{type(error).__name__}（敏感内容已隐藏）")
        print("配置未完成。原配置未替换时仍可继续运行；请勿发送密钥、环境变量内容或证书内容。")
        raise SystemExit(1)

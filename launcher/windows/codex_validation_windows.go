package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type windowsCodexValidation struct {
	root, path, version, stamp string
	checkedAt                  time.Time
	failure                    error
}

// Readiness polls use metadata of a package already verified by this process.
// Actual task admission separately verifies signed package bytes and files.
func windowsCodexStatusStamp(root, executable string) (string, error) {
	var stamp strings.Builder
	for _, target := range []string{filepath.Join(root, "active.json"), filepath.Dir(filepath.Dir(executable))} {
		if err := managedCheckPath(target); err != nil {
			return "", err
		}
		count := 0
		err := filepath.WalkDir(target, func(name string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			count++
			if count > 120 {
				return errors.New("Codex 工具目录条目异常")
			}
			if err := managedCheckPath(name); err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			fmt.Fprintf(&stamp, "%s:%d:%d:%d\n", name, info.Size(), info.ModTime().UnixNano(), info.Mode())
			return nil
		})
		if err != nil {
			return "", err
		}
	}
	return codexHash(stamp.String()), nil
}

func (host *windowsCodexHost) installedRuntime(root, origin string, force bool) (string, string, error) {
	host.mu.Lock()
	cached := host.validated
	host.mu.Unlock()
	if !force && cached != nil && cached.root == root && (cached.failure == nil || time.Since(cached.checkedAt) < 30*time.Second) {
		stamp, err := windowsCodexStatusStamp(root, cached.path)
		if err == nil && stamp == cached.stamp {
			return cached.path, cached.version, cached.failure
		}
	}
	executable, version, err := installedManagedCodex(root, updatePublicKeyRaw, origin)
	if err != nil || executable == "" {
		return executable, version, err
	}
	stamp, err := windowsCodexStatusStamp(root, executable)
	if err != nil {
		return "", "", err
	}
	probeErr := checkWindowsCodexPermissions(executable)
	host.mu.Lock()
	host.validated = &windowsCodexValidation{root: root, path: executable, version: version, stamp: stamp, checkedAt: time.Now(), failure: probeErr}
	host.mu.Unlock()
	return executable, version, probeErr
}

// This uses generated files only and makes no model or network request. The
// fixed binary must prove project writes work and neighboring reads/writes fail.
func checkWindowsCodexPermissions(executable string) error {
	cache, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	parent := filepath.Join(cache, "ONE", "permission-probes")
	if err := managedCheckPath(parent); err != nil {
		return err
	}
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	probe, err := os.MkdirTemp(parent, "check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(probe)
	inside := filepath.Join(probe, "project")
	if err := os.Mkdir(inside, 0700); err != nil {
		return err
	}
	outside := filepath.Join(probe, "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		return err
	}
	args, environment, home, _, err := windowsCodexLaunch(&windowsCodexGateway{BaseURL: "https://theone.aiarrival.cn/api/executor-gateway/v1", Token: strings.Repeat("A", 43), Model: "one-executor"}, "permission-probe", codexRandomID(), inside, executable, true)
	if err != nil {
		return err
	}
	defer os.RemoveAll(home)
	literal := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	written := filepath.Join(inside, "written.txt")
	script := "$ErrorActionPreference='Stop';[IO.File]::WriteAllText(" + literal(written) + ",'inside');if([IO.File]::ReadAllText(" + literal(written) + ") -ne 'inside'){exit 2};try{[IO.File]::ReadAllText(" + literal(outside) + ")|Out-Null;exit 3}catch{};try{[IO.File]::WriteAllText(" + literal(outside) + ",'changed');exit 4}catch{};[Console]::Out.Write('ONE_PERMISSION_PROBE_OK')"
	args = append(args[:len(args)-3], "sandbox", "windows", "--", "powershell.exe", "-NoLogo", "-NoProfile", "-Command", script)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	command.Env = environment
	command.Dir = inside
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, runErr := command.CombinedOutput()
	if runErr != nil || !strings.Contains(string(output), "ONE_PERMISSION_PROBE_OK") {
		if strings.Contains(string(output), "native MXC is unavailable") {
			return errors.New("这台 Windows 尚未具备 Codex 所需的文件夹隔离能力，请升级到受支持的 Windows 11 版本后再准备。ONE 内置文件工具仍可使用")
		}
		return errors.New("Codex 文件夹隔离检查未通过，本机执行暂未就绪。ONE 内置文件工具仍可使用，请联系 ONE 检查本机执行环境")
	}
	actual, err := os.ReadFile(outside)
	if err != nil || string(actual) != "outside" {
		return errors.New("Codex 目录隔离检查未通过")
	}
	return nil
}

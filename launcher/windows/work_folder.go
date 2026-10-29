package main

import (
	"errors"
	"os"
	"path/filepath"
)

func launcherCapabilities() []string {
	return []string{"local_tools_v1", "runtime_update_v1", "local_configuration_v1"}
}

// Settings reads never request new authorization. Only an explicit change may
// replace an existing device's saved work folder.
func configureWorkFolder(saved string, change bool, available func(string) bool, choose func() (string, error), persist func(string) error) (string, error) {
	if change {
		return resolveWorkFolder("", available, choose, persist)
	}
	if saved != "" && !available(saved) {
		return "", errors.New("已选的 ONE 工作文件夹暂时不可用，请恢复该文件夹或在设置里重新选择")
	}
	return saved, nil
}

// Stage settings beside the existing file so a failed write cannot truncate a
// previously authorized folder. Windows supplies an atomic MoveFileEx replace.
func writeWorkFolderConfig(path, workspace string, replace func(string, string) error) error {
	staged, err := os.CreateTemp(filepath.Dir(path), ".workspace-*")
	if err != nil {
		return err
	}
	defer os.Remove(staged.Name())
	if _, err := staged.WriteString(workspace); err != nil {
		staged.Close()
		return err
	}
	if err := staged.Sync(); err != nil {
		staged.Close()
		return err
	}
	if err := staged.Close(); err != nil {
		return err
	}
	return replace(staged.Name(), path)
}

// A remembered folder is a device-scoped authorization, not a reason to open
// a new picker for each task. An unavailable saved folder must be repaired or
// changed explicitly rather than silently replacing the authorized root.
func resolveWorkFolder(saved string, available func(string) bool, choose func() (string, error), persist func(string) error) (string, error) {
	if saved != "" {
		if !available(saved) {
			return "", errors.New("已选的 ONE 工作文件夹暂时不可用，请恢复该文件夹后继续；本轮尚未操作文件")
		}
		return saved, nil
	}
	selected, err := choose()
	if err != nil {
		return "", err
	}
	if selected == "" || !available(selected) {
		return "", errors.New("选择的 ONE 工作文件夹不可用；本轮尚未操作文件")
	}
	if err := persist(selected); err != nil {
		return "", errors.New("没能记住 ONE 工作文件夹，本轮尚未操作文件，请重新选择")
	}
	return selected, nil
}

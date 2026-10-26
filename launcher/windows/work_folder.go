package main

import "errors"

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

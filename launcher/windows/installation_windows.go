package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// A computer-local identifier, not a USB secret or hardware attestation.
func installationID() (string, error) {
	// UserConfigDir uses roaming AppData: a domain account could carry the same
	// ID to another computer. LocalAppData must be used for a computer binding.
	root, err := os.UserCacheDir()
	if err != nil {
		return "", errors.New("无法读取当前电脑的 ONE 配置目录")
	}
	directory := filepath.Join(root, "ONE")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	target := filepath.Join(directory, "installation-id")
	if data, err := os.ReadFile(target); err == nil {
		id := strings.TrimSpace(string(data))
		if decoded, decodeErr := hex.DecodeString(id); decodeErr == nil && len(decoded) == 32 {
			return id, nil
		}
		return "", errors.New("ONE 电脑标识损坏，请联系管理员，不要复制其他电脑的配置")
	} else if !os.IsNotExist(err) {
		return "", err
	}
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	id := hex.EncodeToString(data)
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return installationID()
	}
	if err != nil {
		return "", err
	}
	_, writeErr := file.WriteString(id)
	closeErr := file.Close()
	if writeErr != nil {
		return "", writeErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	return id, nil
}

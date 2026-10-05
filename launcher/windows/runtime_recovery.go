package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type runtimeRecoveryRecord struct {
	RequestID      string `json:"requestId"`
	Version        string `json:"version"`
	CredentialHash string `json:"credentialHash"`
	BackupName     string `json:"backupName"`
	PreviousHash   string `json:"previousHash"`
	InstalledHash  string `json:"installedHash"`
}

func recoveryFileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	digest := sha256.New()
	if _, err = io.Copy(digest, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
func saveRuntimeRecovery(credential, backup, installed, journal string, metadata ...string) error {
	credentialHash, err := recoveryFileHash(credential)
	if err != nil {
		return err
	}
	previousHash, err := recoveryFileHash(backup)
	if err != nil {
		return err
	}
	installedHash, err := recoveryFileHash(installed)
	if err != nil {
		return err
	}
	record := runtimeRecoveryRecord{CredentialHash: credentialHash, BackupName: filepath.Base(backup), PreviousHash: previousHash, InstalledHash: installedHash}
	if len(metadata) == 2 {
		record.RequestID = metadata[0]
		record.Version = metadata[1]
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(journal), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(journal), ".recovery-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), journal)
}

// Called only after the caller loads the credential with the expected device ID.
// A renamed mount is safe; another Key with different credential bytes is not.
func recoverRuntimeFiles(credential, journal string, copyFile func(string, string) error, replace func(string, string) error) error {
	data, err := os.ReadFile(journal)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var record runtimeRecoveryRecord
	if err = json.Unmarshal(data, &record); err != nil {
		return err
	}
	credentialHash, err := recoveryFileHash(credential)
	if err != nil {
		return err
	}
	if credentialHash != record.CredentialHash || filepath.Base(record.BackupName) != record.BackupName || strings.ContainsAny(record.BackupName, "/\\") || !strings.HasPrefix(record.BackupName, "ONE-for-Windows-") || !strings.HasSuffix(record.BackupName, ".exe") {
		return errors.New("更新恢复记录与当前 Key 不匹配，未修改启动器")
	}
	root := filepath.Dir(filepath.Dir(credential))
	target := filepath.Join(root, "ONE for Windows.exe")
	hash, _ := recoveryFileHash(target)
	if hash == record.InstalledHash || hash == record.PreviousHash {
		return nil
	}
	backup := filepath.Join(filepath.Dir(credential), "update-backups", record.BackupName)
	hash, err = recoveryFileHash(backup)
	if err != nil {
		return err
	}
	if hash != record.PreviousHash {
		return errors.New("更新备份未通过校验，未修改启动器")
	}
	staged := filepath.Join(root, ".one-windows-recovery.exe")
	if err = copyFile(backup, staged); err != nil {
		return err
	}
	if err = replace(staged, target); err != nil {
		return err
	}
	hash, err = recoveryFileHash(target)
	if err != nil {
		return err
	}
	if hash != record.PreviousHash {
		return errors.New("启动器恢复校验未完成")
	}
	return nil
}

func runtimeRecoveryReport(credential, journal string) (*runtimeRecoveryRecord, string, error) {
	data, err := os.ReadFile(journal)
	if os.IsNotExist(err) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	var record runtimeRecoveryRecord
	if err = json.Unmarshal(data, &record); err != nil {
		return nil, "", err
	}
	hash, err := recoveryFileHash(credential)
	if err != nil || hash != record.CredentialHash {
		return nil, "", errors.New("恢复记录不属于当前 Key")
	}
	hash, err = recoveryFileHash(filepath.Join(filepath.Dir(filepath.Dir(credential)), "ONE for Windows.exe"))
	if err != nil {
		return nil, "", err
	}
	if hash == record.InstalledHash {
		return &record, "completed", nil
	}
	if hash == record.PreviousHash {
		return &record, "failed", nil
	}
	return nil, "", errors.New("尚未校验启动器恢复结果")
}
func acknowledgeRuntimeRecovery(credential, journal, requestID string) error {
	record, _, err := runtimeRecoveryReport(credential, journal)
	if err != nil {
		return err
	}
	if record != nil && record.RequestID == requestID {
		return os.Remove(journal)
	}
	return nil
}

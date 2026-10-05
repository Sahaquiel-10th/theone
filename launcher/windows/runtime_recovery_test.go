package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixtureCopy(a, b string) error {
	data, err := os.ReadFile(a)
	if err != nil {
		return err
	}
	return os.WriteFile(b, data, 0700)
}
func TestRuntimeRecoveryAfterUnplugAndMountRename(t *testing.T) {
	for _, phase := range []string{"before-replace", "complete", "missing", "partial"} {
		t.Run(phase, func(t *testing.T) {
			local := t.TempDir()
			root := filepath.Join(local, "volume")
			one := filepath.Join(root, ".one")
			os.MkdirAll(filepath.Join(one, "update-backups"), 0700)
			credential := filepath.Join(one, "credential.json")
			os.WriteFile(credential, []byte("key-one"), 0600)
			target := filepath.Join(root, "ONE for Windows.exe")
			backup := filepath.Join(one, "update-backups", "ONE-for-Windows-0.4.1.exe")
			staged := filepath.Join(root, "new.exe")
			journal := filepath.Join(local, "journal.json")
			os.WriteFile(target, []byte("old"), 0700)
			os.WriteFile(backup, []byte("old"), 0700)
			os.WriteFile(staged, []byte("new"), 0700)
			if err := saveRuntimeRecovery(credential, backup, staged, journal); err != nil {
				t.Fatal(err)
			}
			if phase == "complete" {
				os.WriteFile(target, []byte("new"), 0700)
			}
			if phase == "missing" {
				os.Remove(target)
			}
			if phase == "partial" {
				os.WriteFile(target, []byte("partial"), 0700)
			}
			// Missing mount leaves the journal untouched; another mount name still binds by Key hash.
			moved := filepath.Join(local, "renamed-volume")
			os.Rename(root, moved)
			if err := recoverRuntimeFiles(credential, journal, fixtureCopy, os.Rename); err == nil {
				t.Fatal("missing disk was treated as recovered")
			}
			credential = filepath.Join(moved, ".one", "credential.json")
			target = filepath.Join(moved, "ONE for Windows.exe")
			if err := recoverRuntimeFiles(credential, journal, fixtureCopy, os.Rename); err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(target)
			want := "old"
			if phase == "complete" {
				want = "new"
			}
			if string(data) != want {
				t.Fatal("wrong restored bytes")
			}
			data, _ = os.ReadFile(credential)
			if !bytes.Equal(data, []byte("key-one")) {
				t.Fatal("credential modified")
			}
			if _, err := os.Stat(journal); err != nil {
				t.Fatal("lost unacknowledged recovery")
			}
			if err := acknowledgeRuntimeRecovery(credential, journal, "wrong-request"); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(journal); err != nil {
				t.Fatal("wrong receipt cleared recovery")
			}
			if err := acknowledgeRuntimeRecovery(credential, journal, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(journal); !os.IsNotExist(err) {
				t.Fatal("recovery not acknowledged")
			}
		})
	}
}
func TestRecoveryNeverUsesAnotherKeyOrUnverifiedBackup(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".one", "update-backups"), 0700)
	credential := filepath.Join(root, ".one", "credential.json")
	backup := filepath.Join(root, ".one", "update-backups", "ONE-for-Windows-0.4.1.exe")
	staged := filepath.Join(root, "new.exe")
	journal := filepath.Join(t.TempDir(), "record.json")
	os.WriteFile(credential, []byte("one"), 0600)
	os.WriteFile(backup, []byte("old"), 0700)
	os.WriteFile(staged, []byte("new"), 0700)
	saveRuntimeRecovery(credential, backup, staged, journal)
	os.WriteFile(credential, []byte("other"), 0600)
	if err := recoverRuntimeFiles(credential, journal, fixtureCopy, os.Rename); err == nil {
		t.Fatal("cross-Key recovery allowed")
	}
	os.WriteFile(credential, []byte("one"), 0600)
	os.WriteFile(backup, []byte("tampered"), 0700)
	if err := recoverRuntimeFiles(credential, journal, fixtureCopy, os.Rename); err == nil {
		t.Fatal("unverified backup allowed")
	}
	data, _ := os.ReadFile(journal)
	var record runtimeRecoveryRecord
	json.Unmarshal(data, &record)
	record.BackupName = "../outside.exe"
	data, _ = json.Marshal(record)
	os.WriteFile(journal, data, 0600)
	if err := recoverRuntimeFiles(credential, journal, fixtureCopy, os.Rename); err == nil {
		t.Fatal("path escape allowed")
	}
}

package main

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestSettingsCapabilityMatchesImplementedProtocol(t *testing.T) {
	capabilities := launcherCapabilities()
	for _, capability := range []string{"local_configuration_v1", "local_tools_v1", "runtime_update_v1"} {
		if !slices.Contains(capabilities, capability) {
			t.Fatal("missing implemented capability", capability)
		}
	}
	if slices.Contains(capabilities, "managed_codex_v1") || slices.Contains(capabilities, "codex_exec_v1") {
		t.Fatal("built-in file tools must not advertise an unimplemented Codex runtime")
	}
}

func TestSettingsReadNeverOpensFolderPickerOrChangesAuthorization(t *testing.T) {
	byDevice := map[string]string{"key-a": "folder-a"}
	for _, device := range []string{"key-a", "key-b"} {
		root, err := configureWorkFolder(byDevice[device], false, func(value string) bool { return value == "folder-a" }, func() (string, error) {
			t.Fatal("read-only settings opened a picker")
			return "", nil
		}, func(string) error { t.Fatal("read-only settings changed authorization"); return nil })
		if err != nil || root != byDevice[device] {
			t.Fatal(device, root, err)
		}
	}
}

func TestSettingsReadMissingFolderDoesNotReplaceIt(t *testing.T) {
	root, err := configureWorkFolder("missing", false, func(string) bool { return false }, func() (string, error) {
		t.Fatal("settings silently reauthorized a missing folder")
		return "replacement", nil
	}, func(string) error { t.Fatal("settings replaced missing saved authorization"); return nil })
	if err == nil || root != "" {
		t.Fatal("unavailable settings folder accepted", root, err)
	}
}

func TestSettingsChangeReplacesOnlySelectedDeviceAfterSuccess(t *testing.T) {
	byDevice := map[string]string{"key-a": "folder-a", "key-b": "folder-b"}
	root, err := configureWorkFolder(byDevice["key-a"], true, func(value string) bool { return value == "new-folder" }, func() (string, error) {
		return "new-folder", nil
	}, func(value string) error { byDevice["key-a"] = value; return nil })
	if err != nil || root != "new-folder" || byDevice["key-a"] != root || byDevice["key-b"] != "folder-b" {
		t.Fatal("settings did not preserve device isolation", root, byDevice, err)
	}
}

func TestSettingsCancelledOrUnavailableChoicePreservesPreviousFolder(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		root, err := configureWorkFolder("existing", true, func(string) bool { return false }, func() (string, error) {
			if cancelled {
				return "", errors.New("已取消选择，原授权目录保持不变")
			}
			return "unavailable", nil
		}, func(string) error { t.Fatal("unsuccessful settings choice replaced old folder"); return nil })
		if err == nil || root != "" {
			t.Fatal("unsuccessful choice accepted", root, err)
		}
	}
}

func TestSettingsFailedSaveDoesNotAuthorizeUnsavedChoice(t *testing.T) {
	root, err := configureWorkFolder("existing", true, func(string) bool { return true }, func() (string, error) {
		return "new-folder", nil
	}, func(string) error { return errors.New("disk unavailable") })
	if err == nil || root != "" {
		t.Fatal("unremembered settings authorization used", root, err)
	}
}

func TestSettingsFailedReplacementPreservesSavedFolder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key-a.txt")
	if err := os.WriteFile(path, []byte("previous-folder"), 0600); err != nil {
		t.Fatal(err)
	}
	err := writeWorkFolderConfig(path, "new-folder", func(string, string) error { return errors.New("settings file locked") })
	data, readErr := os.ReadFile(path)
	if err == nil || readErr != nil || string(data) != "previous-folder" {
		t.Fatal("failed settings save replaced existing authorization", string(data), err, readErr)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatal("failed settings save left a staged authorization", entries, err)
	}
	if err := writeWorkFolderConfig(path, "new-folder", os.Rename); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(path)
	if err != nil || string(data) != "new-folder" {
		t.Fatal("successful settings replacement was not persisted", string(data), err)
	}
}

func TestWorkFolderIsReusedWithoutAnotherPicker(t *testing.T) {
	saved, choices, writes := "", 0, 0
	choose := func() (string, error) { choices++; return "folder-a", nil }
	persist := func(value string) error { saved = value; writes++; return nil }
	available := func(value string) bool { return value == "folder-a" }
	for task := 0; task < 4; task++ {
		root, err := resolveWorkFolder(saved, available, choose, persist)
		if err != nil || root != "folder-a" {
			t.Fatal(root, err)
		}
	}
	if choices != 1 || writes != 1 {
		t.Fatal("a new task prompted for the same folder", choices, writes)
	}
}

func TestMissingRememberedFolderNeverImplicitlyReauthorizes(t *testing.T) {
	chosen := false
	_, err := resolveWorkFolder("missing", func(string) bool { return false }, func() (string, error) {
		chosen = true
		return "replacement", nil
	}, func(string) error { t.Fatal("must not rewrite remembered authorization"); return nil })
	if err == nil || chosen {
		t.Fatal("missing root silently prompted for replacement", err, chosen)
	}
}

func TestUnpersistedOrCancelledChoiceDoesNotStart(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		root, err := resolveWorkFolder("", func(string) bool { return true }, func() (string, error) {
			if cancel {
				return "", errors.New("cancelled")
			}
			return "new", nil
		}, func(string) error { return errors.New("disk unavailable") })
		if err == nil || root != "" {
			t.Fatal("unremembered authorization used", root, err)
		}
	}
}

func TestDeviceScopedSavedFoldersAreNotInferredFromAnotherDevice(t *testing.T) {
	byDevice := map[string]string{"key-a": "folder-a"}
	choices := 0
	root, err := resolveWorkFolder(byDevice["key-b"], func(string) bool { return true }, func() (string, error) {
		choices++
		return "folder-b", nil
	}, func(value string) error { byDevice["key-b"] = value; return nil })
	if err != nil || root != "folder-b" || choices != 1 || byDevice["key-a"] != "folder-a" {
		t.Fatal("another Key reused authorization", root, choices, err)
	}
}

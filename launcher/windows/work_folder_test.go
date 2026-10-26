package main

import (
	"errors"
	"testing"
)

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

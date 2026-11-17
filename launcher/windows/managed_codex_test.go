package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type managedTestMember struct {
	name, content string
	kind          byte
	declared      int64
}

func managedTestRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func managedTestArchive(t *testing.T, members []managedTestMember) []byte {
	t.Helper()
	var output bytes.Buffer
	gz := gzip.NewWriter(&output)
	tarred := tar.NewWriter(gz)
	for _, member := range members {
		size := int64(len(member.content))
		if member.declared > 0 {
			size = member.declared
		}
		kind := member.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		header := &tar.Header{Name: member.name, Typeflag: kind, Mode: 0700, Size: size}
		if kind != tar.TypeReg {
			header.Size = 0
			header.Linkname = "../outside"
		}
		if err := tarred.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if kind == tar.TypeReg {
			if _, err := tarred.Write([]byte(member.content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	// An oversized/truncated declared member is deliberate hostile input.
	_ = tarred.Close()
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func managedTestFiles() []managedTestMember {
	return []managedTestMember{{name: "bin/codex.exe", content: "MZ synthetic executable"},
		{name: "bin/codex-command-runner.exe", content: "MZ synthetic helper"},
		{name: "LICENSE", content: "Apache License\nVersion 2.0"}, {name: "NOTICE", content: "Synthetic test material"}}
}

func managedTestRelease(archive []byte, version string) managedCodexRelease {
	return managedCodexRelease{Executor: "codex", Version: version, Platform: "windows", Architecture: "amd64",
		URL: "https://one.example/executor-downloads/codex.tar.gz", SourceURL: "https://github.com/openai/codex/releases/download/rust-v" + version + "/codex-package-x86_64-pc-windows-msvc.tar.gz",
		SHA256: managedDigest(archive), Size: int64(len(archive)), Entrypoint: "bin/codex.exe", License: "Apache-2.0", LicenseFiles: []string{"LICENSE", "NOTICE"}}
}

func managedTestSign(t *testing.T, release managedCodexRelease, private ed25519.PrivateKey) managedCodexEnvelope {
	t.Helper()
	payload, err := json.Marshal(managedCodexCatalog{Kind: "one-managed-executors", SchemaVersion: 1, ReleasedAt: "2026-11-17T00:00:00Z", Releases: []managedCodexRelease{release}})
	if err != nil {
		t.Fatal(err)
	}
	return managedCodexEnvelope{Payload: base64.RawURLEncoding.EncodeToString(payload), Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, payload))}
}

func managedTestKey(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(public), private
}

func TestManagedCodexSignedCatalogBindsExactOriginPlatformAndArtifact(t *testing.T) {
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	key, private := managedTestKey(t)
	envelope := managedTestSign(t, release, private)
	actual, err := verifyManagedCodex(envelope, key, "https://one.example", "0.160.1")
	if err != nil || actual.SHA256 != release.SHA256 {
		t.Fatal(actual, err)
	}
	for _, mutate := range []func(*managedCodexRelease){
		func(r *managedCodexRelease) { r.URL = "https://other.example/executor-downloads/codex.tar.gz" },
		func(r *managedCodexRelease) { r.URL = "https://one.example/executor-downloads/../private/codex.tar.gz" },
		func(r *managedCodexRelease) {
			r.SourceURL = "https://other.example/openai/codex/releases/download/fake"
		},
		func(r *managedCodexRelease) { r.Platform = "macos" }, func(r *managedCodexRelease) { r.Architecture = "arm64" },
		func(r *managedCodexRelease) { r.Entrypoint = "../codex.exe" }, func(r *managedCodexRelease) { r.LicenseFiles = []string{"../LICENSE"} },
		func(r *managedCodexRelease) { r.SHA256 = "invalid" }, func(r *managedCodexRelease) { r.Size = 513 * 1024 * 1024 },
	} {
		changed := release
		mutate(&changed)
		if _, err := verifyManagedCodex(managedTestSign(t, changed, private), key, "https://one.example", ""); err == nil {
			t.Fatal("invalid catalog accepted", changed)
		}
	}
	changed := envelope
	signature, _ := base64.RawURLEncoding.DecodeString(changed.Signature)
	signature[0] ^= 1
	changed.Signature = base64.RawURLEncoding.EncodeToString(signature)
	if _, err := verifyManagedCodex(changed, key, "https://one.example", ""); err == nil {
		t.Fatal("modified signature accepted")
	}
	changed = envelope
	changed.Payload = base64.RawURLEncoding.EncodeToString([]byte(`{"kind":"forged"}`))
	if _, err := verifyManagedCodex(changed, key, "https://one.example", ""); err == nil {
		t.Fatal("modified payload accepted")
	}
	otherKey, _ := managedTestKey(t)
	if _, err := verifyManagedCodex(envelope, otherKey, "https://one.example", ""); err == nil {
		t.Fatal("wrong trust key accepted")
	}
	if _, err := verifyManagedCodex(envelope, key, "https://one.example", "0.160.2"); err == nil {
		t.Fatal("different pinned version accepted")
	}
}

func TestManagedCodexRejectsChangedBytesUnsafePathsAndCaseAliases(t *testing.T) {
	for _, name := range []string{"../escape.exe", "/absolute.exe", "bin/../codex.exe", "bin\\codex.exe", "bin/CON.exe", "bin/LPT1.txt", "bin/trailing./codex.exe"} {
		t.Run(name, func(t *testing.T) {
			files := append(managedTestFiles(), managedTestMember{name: name, content: "MZ bad"})
			archive := managedTestArchive(t, files)
			if _, err := managedCodexFiles(archive, managedTestRelease(archive, "0.160.1")); err == nil {
				t.Fatal("unsafe member accepted")
			}
		})
	}
	for _, extra := range []managedTestMember{{name: "bin/CODEX.exe", content: "MZ alias"}, {name: "bin/linked.exe", kind: tar.TypeSymlink}, {name: "bin/", kind: tar.TypeDir}, {name: "bin/oversized.exe", content: "MZ", declared: 321 * 1024 * 1024}} {
		archive := managedTestArchive(t, append(managedTestFiles(), extra))
		if _, err := managedCodexFiles(archive, managedTestRelease(archive, "0.160.1")); err == nil {
			t.Fatal("unsafe member accepted", extra.name)
		}
	}
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	changed := bytes.Clone(archive)
	changed[len(changed)/2] ^= 1
	if _, err := managedCodexFiles(changed, release); err == nil {
		t.Fatal("changed package accepted")
	}
	files := managedTestFiles()
	files[0].content = "not an executable"
	archive = managedTestArchive(t, files)
	if _, err := managedCodexFiles(archive, managedTestRelease(archive, "0.160.1")); err == nil {
		t.Fatal("invalid entrypoint accepted")
	}
}

func TestManagedCodexFailedHealthOrPointerCommitKeepsPreviousInstall(t *testing.T) {
	root := managedTestRoot(t)
	key, private := managedTestKey(t)
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	envelope := managedTestSign(t, release, private)
	checks := 0
	health := func(file, version string) error {
		checks++
		data, err := os.ReadFile(file)
		if err != nil || !bytes.HasPrefix(data, []byte("MZ")) {
			return errors.New("unavailable")
		}
		return nil
	}
	entry, err := commitManagedCodex(archive, envelope, release, root, health, os.Rename)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(filepath.Join(root, "active.json"))
	if err != nil {
		t.Fatal(err)
	}
	newFiles := managedTestFiles()
	newFiles[0].content = "MZ new synthetic executable"
	nextArchive := managedTestArchive(t, newFiles)
	nextRelease := managedTestRelease(nextArchive, "0.160.2")
	nextEnvelope := managedTestSign(t, nextRelease, private)
	for _, failure := range []string{"health", "pointer"} {
		check := health
		replace := os.Rename
		if failure == "health" {
			check = func(string, string) error { return errors.New("health failed") }
		} else {
			replace = func(string, string) error { return errors.New("disk replacement failed") }
		}
		if _, err := commitManagedCodex(nextArchive, nextEnvelope, nextRelease, root, check, replace); err == nil {
			t.Fatal("failed installation accepted", failure)
		}
		after, err := os.ReadFile(filepath.Join(root, "active.json"))
		if err != nil || !bytes.Equal(after, original) {
			t.Fatal("previous pointer changed", failure, err)
		}
		actual, version, err := installedManagedCodex(root, key, "https://one.example")
		if err != nil || actual != entry || version != "0.160.1" {
			t.Fatal("previous install lost", actual, version, err)
		}
	}
	if checks < 1 {
		t.Fatal("health callback never checked staged executable")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".prepare-") {
			t.Fatal("failed staging directory retained")
		}
	}
}

func TestManagedCodexRestartRechecksSignedPackageDespiteEditedPointerHashes(t *testing.T) {
	root := managedTestRoot(t)
	key, private := managedTestKey(t)
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	entry, err := commitManagedCodex(archive, managedTestSign(t, release, private), release, root, func(string, string) error { return nil }, os.Rename)
	if err != nil {
		t.Fatal(err)
	}
	changed := []byte("MZ locally replaced executable")
	if err := os.WriteFile(entry, changed, 0700); err != nil {
		t.Fatal(err)
	}
	pointerPath := filepath.Join(root, "active.json")
	data, err := os.ReadFile(pointerPath)
	if err != nil {
		t.Fatal(err)
	}
	var pointer managedCodexPointer
	if err := json.Unmarshal(data, &pointer); err != nil {
		t.Fatal(err)
	}
	pointer.Hashes[release.Entrypoint] = managedDigest(changed)
	data, _ = json.Marshal(pointer)
	if err := os.WriteFile(pointerPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedManagedCodex(root, key, "https://one.example"); err == nil {
		t.Fatal("forged pointer digest hid an altered executable")
	}
}

func TestManagedCodexRejectsLinkedInstallRoot(t *testing.T) {
	root := managedTestRoot(t)
	outside := managedTestRoot(t)
	linked := filepath.Join(root, "linked")
	if err := os.Symlink(outside, linked); err != nil {
		t.Skip("symlink creation unavailable on this host")
	}
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	_, private := managedTestKey(t)
	if _, err := commitManagedCodex(archive, managedTestSign(t, release, private), release, linked, func(string, string) error { t.Fatal("linked path reached health check"); return nil }, os.Rename); err == nil {
		t.Fatal("linked install root accepted")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("linked external directory modified", err)
	}
}

func TestManagedCodexSameVersionDamageCanBeRepaired(t *testing.T) {
	root := managedTestRoot(t)
	key, private := managedTestKey(t)
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	envelope := managedTestSign(t, release, private)
	healthChecks := 0
	health := func(file, version string) error {
		healthChecks++
		content, err := os.ReadFile(file)
		if err != nil || string(content) != managedTestFiles()[0].content || version != release.Version {
			return errors.New("staged executable did not match the reviewed package")
		}
		return nil
	}
	entry, err := commitManagedCodex(archive, envelope, release, root, health, os.Rename)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("MZ damaged same-version executable"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedManagedCodex(root, key, "https://one.example"); err == nil {
		t.Fatal("damaged install was still ready")
	}
	repaired, err := commitManagedCodex(archive, envelope, release, root, health, os.Rename)
	if err != nil || repaired != entry {
		t.Fatal("same-version repair failed", repaired, err)
	}
	actual, version, err := installedManagedCodex(root, key, "https://one.example")
	if err != nil || actual != entry || version != release.Version || healthChecks != 2 {
		t.Fatal("repaired package was not verified", actual, version, healthChecks, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatal("repair retained staging or backup entries", entries, err)
	}
}

func TestManagedCodexFailedSameVersionActivationRestoresOriginalDamagedFiles(t *testing.T) {
	root := managedTestRoot(t)
	key, private := managedTestKey(t)
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	envelope := managedTestSign(t, release, private)
	health := func(string, string) error { return nil }
	entry, err := commitManagedCodex(archive, envelope, release, root, health, os.Rename)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(root, "active.json"))
	if err != nil {
		t.Fatal(err)
	}
	damaged := []byte("MZ previous damaged executable kept for recovery")
	if err := os.WriteFile(entry, damaged, 0700); err != nil {
		t.Fatal(err)
	}
	extraPath := filepath.Join(filepath.Dir(entry), "diagnostic.dll")
	if err := os.WriteFile(extraPath, []byte("previous damaged package diagnostic"), 0600); err != nil {
		t.Fatal(err)
	}
	failCommit := func(string, string) error { return errors.New("simulated pointer replacement failure") }
	if _, err := commitManagedCodex(archive, envelope, release, root, health, failCommit); err == nil {
		t.Fatal("failed same-version activation succeeded")
	}
	after, err := os.ReadFile(filepath.Join(root, "active.json"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed activation changed the previous pointer", err)
	}
	actual, err := os.ReadFile(entry)
	if err != nil || !bytes.Equal(actual, damaged) {
		t.Fatal("failed activation lost the previous damaged executable", err)
	}
	if actual, err := os.ReadFile(extraPath); err != nil || string(actual) != "previous damaged package diagnostic" {
		t.Fatal("failed activation lost the previous package's extra file", err)
	}
	if _, _, err := installedManagedCodex(root, key, "https://one.example"); err == nil {
		t.Fatal("rolled-back damaged package was reported ready")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatal("failed activation retained staging or backup entries", entries, err)
	}
}

func TestManagedCodexUnexpectedDLLIsRejectedBeforeExecution(t *testing.T) {
	root := managedTestRoot(t)
	key, private := managedTestKey(t)
	archive := managedTestArchive(t, managedTestFiles())
	release := managedTestRelease(archive, "0.160.1")
	entry, err := commitManagedCodex(archive, managedTestSign(t, release, private), release, root, func(string, string) error { return nil }, os.Rename)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(entry), "unexpected.dll"), []byte("unreviewed library"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedManagedCodex(root, key, "https://one.example"); err == nil {
		t.Fatal("unreviewed DLL next to the signed executable was accepted")
	}
}

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type managedCodexEnvelope struct {
	Payload string `json:"payload"`
	Signature string `json:"signature"`
}

type managedCodexRelease struct {
	Executor string `json:"executor"`
	Version string `json:"version"`
	Platform string `json:"platform"`
	Architecture string `json:"architecture"`
	URL string `json:"url"`
	SourceURL string `json:"sourceUrl"`
	SHA256 string `json:"sha256"`
	Size int64 `json:"size"`
	Entrypoint string `json:"entrypoint"`
	License string `json:"license"`
	LicenseFiles []string `json:"licenseFiles"`
}

type managedCodexCatalog struct {
	Kind string `json:"kind"`
	SchemaVersion int `json:"schemaVersion"`
	ReleasedAt string `json:"releasedAt"`
	Releases []managedCodexRelease `json:"releases"`
}

type managedCodexPointer struct {
	Envelope managedCodexEnvelope `json:"envelope"`
	Version string `json:"version"`
	Hashes map[string]string `json:"hashes"`
}

var managedVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){1,3}$`)
var managedHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var managedMemberPattern = regexp.MustCompile(`^[a-zA-Z0-9_./-]+$`)
var managedNativePathCheck = func(string) error { return nil }

func managedCheckPath(target string) error {
	absolute, err := filepath.Abs(target)
	if err != nil { return err }
	parent := filepath.Dir(absolute)
	if parent != absolute {
		if err := managedCheckPath(parent); err != nil { return err }
	}
	info, err := os.Lstat(absolute)
	if os.IsNotExist(err) { return nil }
	if err != nil { return err }
	if info.Mode()&os.ModeSymlink != 0 { return errors.New("ONE 执行工具目录包含链接，请恢复原目录") }
	return managedNativePathCheck(absolute)
}

func managedVersionCompare(a, b string) int {
	aa, bb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(aa), len(bb)); i++ {
		var av, bv uint64
		if i < len(aa) { av, _ = strconv.ParseUint(aa[i], 10, 32) }
		if i < len(bb) { bv, _ = strconv.ParseUint(bb[i], 10, 32) }
		if av < bv { return -1 }
		if av > bv { return 1 }
	}
	return 0
}

func managedSafeMember(name string) bool {
	if len(name) == 0 || len(name) > 240 || !managedMemberPattern.MatchString(name) || path.IsAbs(name) || path.Clean(name) != name { return false }
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") { return false }
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || regexp.MustCompile(`^(COM|LPT)[0-9]$`).MatchString(base) { return false }
	}
	return true
}

func managedDecode(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil { return err }
	if decoder.Decode(new(any)) != io.EOF { return errors.New("工具清单格式无效") }
	return nil
}

func verifyManagedCodex(envelope managedCodexEnvelope, publicKeyRaw, serverOrigin string, wantedVersion string) (managedCodexRelease, error) {
	fail := func() (managedCodexRelease, error) { return managedCodexRelease{}, errors.New("ONE 执行工具清单校验失败") }
	key, err := base64.RawURLEncoding.DecodeString(publicKeyRaw)
	if err != nil || len(key) != ed25519.PublicKeySize { return fail() }
	payload, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil || len(payload) == 0 || len(payload) > 128*1024 { return fail() }
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, payload, signature) { return fail() }
	var catalog managedCodexCatalog
	if managedDecode(payload, &catalog) != nil || catalog.Kind != "one-managed-executors" || catalog.SchemaVersion != 1 || len(catalog.Releases) == 0 || len(catalog.Releases) > 24 { return fail() }
	origin, err := url.Parse(serverOrigin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" { return fail() }
	var selected managedCodexRelease
	for _, release := range catalog.Releases {
		if release.Platform != "windows" || release.Architecture != "amd64" || wantedVersion != "" && release.Version != wantedVersion { continue }
		download, downloadErr := url.Parse(release.URL)
		source, sourceErr := url.Parse(release.SourceURL)
		if release.Executor != "codex" || !managedVersionPattern.MatchString(release.Version) || !managedHashPattern.MatchString(release.SHA256) || release.Size <= 0 || release.Size > 512*1024*1024 || release.License != "Apache-2.0" || !managedSafeMember(release.Entrypoint) || !strings.HasSuffix(strings.ToLower(release.Entrypoint), ".exe") || len(release.LicenseFiles) == 0 || len(release.LicenseFiles) > 24 { return fail() }
		if downloadErr != nil || download.Scheme != "https" || download.Host != origin.Host || download.User != nil || download.RawQuery != "" || download.Fragment != "" || !strings.HasPrefix(download.Path, "/executor-downloads/") || path.Clean(download.Path) != download.Path { return fail() }
		if sourceErr != nil || source.Scheme != "https" || source.Host != "github.com" || source.User != nil || source.RawQuery != "" || source.Fragment != "" || !strings.HasPrefix(source.Path, "/openai/codex/releases/download/") { return fail() }
		licenseSeen := false
		for _, name := range release.LicenseFiles {
			if !managedSafeMember(name) { return fail() }
			if path.Base(name) == "LICENSE" { licenseSeen = true }
		}
		if !licenseSeen { return fail() }
		if selected.Version == "" || managedVersionCompare(release.Version, selected.Version) > 0 { selected = release }
	}
	if selected.Version == "" { return managedCodexRelease{}, errors.New("尚未发布适用于 Windows 的 Codex 工具包") }
	return selected, nil
}

func managedCodexFiles(archive []byte, release managedCodexRelease) (map[string][]byte, error) {
	fail := func() (map[string][]byte, error) { return nil, errors.New("Codex 工具包完整性或文件路径校验失败") }
	digest := sha256.Sum256(archive)
	if int64(len(archive)) != release.Size || hex.EncodeToString(digest[:]) != release.SHA256 { return fail() }
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil { return fail() }
	defer gz.Close()
	reader := tar.NewReader(io.LimitReader(gz, 384*1024*1024+1))
	files := make(map[string][]byte)
	seen := make(map[string]bool)
	var total int64
	for {
		header, err := reader.Next()
		if err == io.EOF { break }
		if err != nil || header.Typeflag != tar.TypeReg || !managedSafeMember(header.Name) || header.Size <= 0 || header.Size > 320*1024*1024 || len(files) >= 80 || seen[strings.ToLower(header.Name)] { return fail() }
		total += header.Size
		if total > 384*1024*1024 { return fail() }
		content, err := io.ReadAll(io.LimitReader(reader, header.Size+1))
		if err != nil || int64(len(content)) != header.Size { return fail() }
		seen[strings.ToLower(header.Name)] = true
		files[header.Name] = content
	}
	executable := files[release.Entrypoint]
	if len(executable) < 2 || string(executable[:2]) != "MZ" { return fail() }
	for _, name := range release.LicenseFiles {
		if len(files[name]) == 0 { return fail() }
	}
	if !bytes.Contains(files["LICENSE"], []byte("Apache License")) || !bytes.Contains(files["LICENSE"], []byte("Version 2.0")) { return fail() }
	return files, nil
}

func managedDigest(data []byte) string { value := sha256.Sum256(data); return hex.EncodeToString(value[:]) }

func commitManagedCodex(archive []byte, envelope managedCodexEnvelope, release managedCodexRelease, root string, health func(string, string) error, replace func(string,string) error) (string, error) {
	files, err := managedCodexFiles(archive, release)
	if err != nil { return "", err }
	if err := managedCheckPath(root); err != nil { return "", err }
	if err := os.MkdirAll(root, 0700); err != nil { return "", err }
	stage, err := os.MkdirTemp(root, ".prepare-")
	if err != nil { return "", err }
	defer os.RemoveAll(stage)
	if err := managedCheckPath(stage); err != nil { return "", err }
	for name, content := range files {
		file := filepath.Join(stage, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil { return "", err }
		if err := os.WriteFile(file, content, 0700); err != nil { return "", err }
	}
	if err := os.WriteFile(filepath.Join(stage, ".one-package.tar.gz"), archive, 0600); err != nil { return "", err }
	if err := health(filepath.Join(stage, filepath.FromSlash(release.Entrypoint)), release.Version); err != nil { return "", err }
	target := filepath.Join(root, "codex-windows-amd64-"+release.Version+"-"+release.SHA256[:16])
	if err := managedCheckPath(target); err != nil { return "", err }
	if _, err := os.Stat(target); err == nil {
		for name, content := range files {
			actual, err := os.ReadFile(filepath.Join(target, filepath.FromSlash(name)))
			if err != nil || !bytes.Equal(actual, content) { return "", errors.New("已安装的 Codex 文件发生变化") }
		}
	} else if !os.IsNotExist(err) { return "", err } else if err := os.Rename(stage, target); err != nil { return "", err }
	hashes := make(map[string]string, len(files))
	for name, content := range files { hashes[name] = managedDigest(content) }
	pointer, err := json.Marshal(managedCodexPointer{Envelope: envelope, Version: release.Version, Hashes: hashes})
	if err != nil { return "", err }
	if err := managedCheckPath(filepath.Join(root, "active.json")); err != nil { return "", err }
	if err := writeWorkFolderConfig(filepath.Join(root, "active.json"), string(pointer), replace); err != nil { return "", err }
	return filepath.Join(target, filepath.FromSlash(release.Entrypoint)), nil
}

func installedManagedCodex(root, key, origin string) (string, string, error) {
	if err := managedCheckPath(filepath.Join(root, "active.json")); err != nil { return "", "", err }
	data, err := os.ReadFile(filepath.Join(root, "active.json"))
	if os.IsNotExist(err) { return "", "", nil }
	if err != nil || len(data) > 128*1024 { return "", "", errors.New("无法读取已准备的 Codex 工具") }
	var pointer managedCodexPointer
	if managedDecode(data, &pointer) != nil { return "", "", errors.New("Codex 安装记录无效") }
	release, err := verifyManagedCodex(pointer.Envelope, key, origin, pointer.Version)
	if err != nil { return "", "", err }
	if len(pointer.Hashes) == 0 || len(pointer.Hashes) > 80 || pointer.Hashes[release.Entrypoint] == "" { return "", "", errors.New("Codex 安装记录不完整") }
	target := filepath.Join(root, "codex-windows-amd64-"+release.Version+"-"+release.SHA256[:16])
	archivePath := filepath.Join(target, ".one-package.tar.gz")
	if err := managedCheckPath(archivePath); err != nil { return "", "", err }
	archive, err := os.ReadFile(archivePath)
	if err != nil { return "", "", errors.New("Codex 原始校验包暂时不可用") }
	files, err := managedCodexFiles(archive, release)
	if err != nil { return "", "", err }
	if len(files) != len(pointer.Hashes) { return "", "", errors.New("Codex 安装记录不完整") }
	for name, expected := range files {
		digest := managedDigest(expected)
		if pointer.Hashes[name] != digest { return "", "", errors.New("Codex 安装记录与签名包不符") }
		if !managedSafeMember(name) || !managedHashPattern.MatchString(digest) { return "", "", errors.New("Codex 安装记录无效") }
		file := filepath.Join(target, filepath.FromSlash(name))
		if err := managedCheckPath(file); err != nil { return "", "", err }
		info, err := os.Lstat(file)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 { return "", "", errors.New("Codex 工具文件暂时不可用") }
		content, err := os.ReadFile(file)
		if err != nil || managedDigest(content) != digest { return "", "", fmt.Errorf("Codex 工具文件校验失败") }
	}
	return filepath.Join(target, filepath.FromSlash(release.Entrypoint)), release.Version, nil
}

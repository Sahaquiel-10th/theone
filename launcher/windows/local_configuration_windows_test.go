package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

func TestWindowsPowerShellWorkFolderOutputPreservesChinesePath(t *testing.T) {
	selected := filepath.Join(t.TempDir(), "中文 工作文件夹")
	if err := os.Mkdir(selected, 0700); err != nil {
		t.Fatal(err)
	}
	// Exercise the exact process/encoding boundary used by the native picker,
	// without opening a GUI or granting a work-folder authorization.
	literal := strings.ReplaceAll(selected, "'", "''")
	output, err := workspacePickerOutput(`[Console]::Out.Write('` + literal + `')`)
	if err != nil {
		t.Fatal("real Windows PowerShell failed to return a folder", err)
	}
	if !utf8.Valid(output) || string(output) != selected {
		t.Fatalf("PowerShell changed the UTF-8 work-folder path: got %q, want %q", output, selected)
	}
	if !directoryExists(strings.TrimSpace(string(output))) {
		t.Fatal("PowerShell output no longer resolves to the selected Chinese folder")
	}
}

// This runs the Windows socket loop with a substituted folder picker. The real
// native dialog still needs Windows device acceptance after the runtime ships.
func TestWindowsSettingsKeepsProofsLiveAndReusesChangedFolder(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	pub, private, _ := ed25519.GenerateKey(rand.Reader)
	credential := filepath.Join(t.TempDir(), "credential.json")
	data, _ := json.Marshal(deviceCredential{Version: 1, DeviceID: "settings-key-a", PrivateKeyRaw: base64.RawURLEncoding.EncodeToString(private.Seed()), ServerBaseURL: "https://example.com"})
	if err := os.WriteFile(credential, data, 0600); err != nil {
		t.Fatal(err)
	}
	previous, selected, other := t.TempDir(), t.TempDir(), t.TempDir()
	if err := saveWorkspace("settings-key-a", previous); err != nil {
		t.Fatal(err)
	}
	if err := saveWorkspace("settings-key-b", other); err != nil {
		t.Fatal(err)
	}
	peers := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			peers <- peer
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	peer := <-peers
	defer peer.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var choices atomic.Int32
	result := make(chan error, 1)
	go func() {
		result <- serveProofsWithWorkspaceChooser(client, credential, "settings-key-a", func(runtimeUpdateArtifact, string, func(string)) error {
			return errors.New("no runtime installation in settings test")
		}, func() (string, error) {
			if choices.Add(1) > 1 {
				return "", errors.New("已取消选择，原授权目录保持不变")
			}
			close(entered)
			<-release
			return selected, nil
		})
	}()
	write := func(message socketMessage) {
		t.Helper()
		if err := peer.WriteJSON(message); err != nil {
			t.Fatal(err)
		}
	}
	read := func() map[string]any {
		t.Helper()
		peer.SetReadDeadline(time.Now().Add(3 * time.Second))
		var response map[string]any
		if err := peer.ReadJSON(&response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	write(socketMessage{Type: "local_configuration", RequestID: "read-settings"})
	response := read()
	if response["type"] != "local_ready" || response["requestId"] != "read-settings" || response["taskId"] != "device_settings" || response["targetName"] != previous {
		t.Fatal("settings read did not return saved path", response)
	}
	write(socketMessage{Type: "local_configuration", RequestID: "change-settings", Change: true})
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("explicit settings change did not open picker")
	}
	nonce := make([]byte, 32)
	rand.Read(nonce)
	write(socketMessage{Type: "request_challenge", ChallengeID: "picker-proof", Nonce: base64.RawURLEncoding.EncodeToString(nonce)})
	response = read()
	signature, _ := base64.RawURLEncoding.DecodeString(response["signature"].(string))
	if response["type"] != "proof_response" || response["challengeId"] != "picker-proof" || !ed25519.Verify(pub, nonce, signature) {
		t.Fatal("native folder selection blocked Key verification", response)
	}
	write(socketMessage{Type: "update_install", RequestID: "update-during-picker"})
	if response = read(); response["type"] != "update_event" || response["requestId"] != "update-during-picker" || response["status"] != "failed" || !strings.Contains(fmt.Sprint(response["error"]), "选择工作文件夹") {
		t.Fatal("runtime update overlapped active native folder selection", response)
	}
	write(socketMessage{Type: "local_configuration", RequestID: "duplicate-settings", Change: true})
	if response = read(); response["type"] != "local_error" || response["requestId"] != "duplicate-settings" {
		t.Fatal("concurrent picker was not rejected", response)
	}
	releaseOnce.Do(func() { close(release) })
	response = read()
	if response["type"] != "local_ready" || response["requestId"] != "change-settings" || response["taskId"] != "device_settings" || response["output"] != selected {
		t.Fatal("settings choice was not confirmed", response)
	}
	write(socketMessage{Type: "local_prepare", TaskID: "new-task", RequestID: "prepare-changed"})
	if response = read(); response["type"] != "local_ready" || response["targetName"] != filepath.Base(selected) {
		t.Fatal("new task did not reuse changed folder without reconnecting", response)
	}
	write(socketMessage{Type: "local_configuration", RequestID: "cancel-settings", Change: true})
	if response = read(); response["type"] != "local_error" || response["requestId"] != "cancel-settings" {
		t.Fatal("cancelled selection reported success", response)
	}
	write(socketMessage{Type: "local_configuration", RequestID: "reread-settings"})
	if response = read(); response["type"] != "local_ready" || response["targetName"] != selected {
		t.Fatal("cancelled selection lost saved authorization", response)
	}
	if loadSavedWorkspace("settings-key-a") != selected || loadSavedWorkspace("settings-key-b") != other || choices.Load() != 2 {
		t.Fatal("settings persistence or device isolation failed")
	}
	peer.Close()
	select {
	case <-result:
	case <-time.After(3 * time.Second):
		t.Fatal("settings socket did not exit")
	}
}

func TestWindowsSettingsDoesNotPersistAfterAuthorizationChanges(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	previous, selected := t.TempDir(), t.TempDir()
	if err := saveWorkspace("settings-key-a", previous); err != nil {
		t.Fatal(err)
	}
	executor := &localExecutor{root: previous}
	checks := 0
	root, err := executor.configure("settings-key-a", true, func() (string, error) { return selected, nil }, func() error {
		checks++
		if checks > 1 {
			return errors.New("Key removed or settings connection changed")
		}
		return nil
	})
	if err == nil || root != "" || executor.root != previous || loadSavedWorkspace("settings-key-a") != previous {
		t.Fatal("expired picker authorization changed saved or active folder", root, err)
	}
}

func TestWindowsDisconnectedSettingsPickerCannotSaveLater(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	credential := filepath.Join(t.TempDir(), "credential.json")
	data, _ := json.Marshal(deviceCredential{Version: 1, DeviceID: "disconnected-key", PrivateKeyRaw: base64.RawURLEncoding.EncodeToString(private.Seed()), ServerBaseURL: "https://example.com"})
	if err := os.WriteFile(credential, data, 0600); err != nil {
		t.Fatal(err)
	}
	previous, selected := t.TempDir(), t.TempDir()
	if err := saveWorkspace("disconnected-key", previous); err != nil {
		t.Fatal(err)
	}
	peers := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			peers <- peer
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	peer := <-peers
	defer peer.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	result := make(chan error, 1)
	go func() {
		result <- serveProofsWithWorkspaceChooser(client, credential, "disconnected-key", func(runtimeUpdateArtifact, string, func(string)) error { return nil }, func() (string, error) {
			close(entered)
			<-release
			return selected, nil
		})
	}()
	if err := peer.WriteJSON(socketMessage{Type: "local_configuration", RequestID: "disconnected-picker", Change: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("native picker did not open")
	}
	peer.Close()
	select {
	case <-result:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnected socket waited for native picker")
	}
	releaseOnce.Do(func() { close(release) })
	// Observe the post-return worker too: releasing the picker must not cause a
	// delayed write after the owning connection has ended.
	deadline := time.Now().Add(100 * time.Millisecond)
	for time.Now().Before(deadline) {
		if loadSavedWorkspace("disconnected-key") != previous {
			t.Fatal("disconnected native picker changed authorization")
		}
		time.Sleep(time.Millisecond)
	}
}

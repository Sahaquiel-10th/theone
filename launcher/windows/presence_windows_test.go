package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Runs the actual Windows socket loop; only disk installation is substituted.
func TestWindowsUpdateKeepsProofsAndJoinsAfterDisconnect(t *testing.T) {
	pub, private, _ := ed25519.GenerateKey(rand.Reader)
	oldVersion, oldKey := version, updatePublicKeyRaw
	version, updatePublicKeyRaw = "0.3.10", base64.RawURLEncoding.EncodeToString(pub)
	defer func() { version, updatePublicKeyRaw = oldVersion, oldKey }()
	credential := filepath.Join(t.TempDir(), "credential.json")
	data, _ := json.Marshal(deviceCredential{Version: 1, DeviceID: "key-a", PrivateKeyRaw: base64.RawURLEncoding.EncodeToString(private.Seed()), ServerBaseURL: "https://example.com"})
	if err := os.WriteFile(credential, data, 0600); err != nil {
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
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	installed := &runtimeUpdateInstalled{target: "verified.exe"}
	result := make(chan error, 1)
	go func() {
		result <- serveProofsWithInstaller(client, credential, "key-a", func(_ runtimeUpdateArtifact, _ string, _ func(string)) error {
			close(entered)
			<-release
			return installed
		})
	}()
	payload, _ := json.Marshal(runtimeUpdatePayload{SchemaVersion: 1, Channel: "stable", Artifacts: []runtimeUpdateArtifact{{Platform: "windows", Architecture: "amd64", Version: "0.3.11", URL: "https://example.com/update.exe", Size: 1, SHA256: strings.Repeat("a", 64)}}})
	envelope := signedRuntimeUpdate{Payload: base64.RawURLEncoding.EncodeToString(payload), Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, payload))}
	if err := peer.WriteJSON(socketMessage{Type: "update_install", RequestID: "update-a", Envelope: envelope}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("installer not started")
	}
	nonce := make([]byte, 32)
	rand.Read(nonce)
	if err := peer.WriteJSON(socketMessage{Type: "request_challenge", ChallengeID: "proof-a", Nonce: base64.RawURLEncoding.EncodeToString(nonce)}); err != nil {
		t.Fatal(err)
	}
	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		var response socketResponse
		if err := peer.ReadJSON(&response); err != nil {
			t.Fatal("proof reader blocked during installation", err)
		}
		if response.Type != "proof_response" {
			continue
		}
		signature, _ := base64.RawURLEncoding.DecodeString(response.Signature)
		if response.ChallengeID != "proof-a" || !ed25519.Verify(pub, nonce, signature) {
			t.Fatal("invalid proof")
		}
		break
	}
	// Transport disappears BEFORE installer completion; old code abandoned it.
	peer.Close()
	select {
	case <-result:
		t.Fatal("returned before installer completed")
	case <-time.After(40 * time.Millisecond):
	}
	close(release)
	select {
	case got := <-result:
		if got != installed {
			t.Fatalf("lost committed target: %v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handoff did not finish")
	}
}

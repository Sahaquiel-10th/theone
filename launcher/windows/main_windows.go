package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

const version = "0.1.0"

type deviceCredential struct {
	Version       int    `json:"version"`
	DeviceID      string `json:"deviceId"`
	PrivateKeyRaw string `json:"privateKeyRaw"`
	ServerBaseURL string `json:"serverBaseUrl"`
}

type socketMessage struct {
	Type        string `json:"type"`
	ChallengeID string `json:"challengeId,omitempty"`
	Nonce       string `json:"nonce,omitempty"`
	DeviceID    string `json:"deviceId,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
}

type socketResponse struct {
	Type        string `json:"type"`
	ChallengeID string `json:"challengeId"`
	Signature   string `json:"signature"`
}

type apiFailure struct {
	Error string `json:"error"`
}

var httpClient = &http.Client{Timeout: 12 * time.Second}

func main() {
	if err := run(); err != nil {
		showError("无法打开 ONE", err.Error())
		os.Exit(1)
	}
}

func run() error {
	credentialPath, err := findCredential()
	if err != nil {
		return err
	}
	credential, err := loadCredential(credentialPath, "")
	if err != nil {
		return err
	}
	base := strings.TrimRight(credential.ServerBaseURL, "/")
	openedLogin := false

	for failures := 0; ; {
		connection, err := connectLauncher(base, credentialPath, credential.DeviceID)
		if err == nil {
			if !openedLogin {
				if err = openLoginPage(base, credentialPath, credential.DeviceID); err != nil {
					connection.Close()
					return err
				}
				openedLogin = true
			}
			failures = 0
			err = serveProofs(connection, credentialPath, credential.DeviceID)
		}

		if !fileExists(credentialPath) {
			return nil
		}
		var closeError *websocket.CloseError
		if errors.As(err, &closeError) && closeError.Code == 4009 {
			// A newer ONE.exe instance has taken over this Key. Exit the old
			// background process quietly instead of showing a misleading error.
			return nil
		}
		if errors.As(err, &closeError) && closeError.Code == 4003 {
			return fmt.Errorf("ONE Key 已挂失或凭证无效")
		}
		failures++
		if !openedLogin || failures > 10 {
			return fmt.Errorf("ONE Key 连接已断开，请确认网络正常后重新双击 ONE.exe")
		}
		time.Sleep(time.Duration(min(failures*3, 15)) * time.Second)
	}
}

func findCredential() (string, error) {
	executable, err := os.Executable()
	if err == nil {
		portable := filepath.Join(filepath.Dir(executable), ".one", "credential.json")
		if fileExists(portable) {
			return portable, nil
		}
	}
	for drive := 'D'; drive <= 'Z'; drive++ {
		candidate := fmt.Sprintf("%c:\\.one\\credential.json", drive)
		if fileExists(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("没有找到 ONE Key，请确认 U 盘已插入，并且 ONE.exe 位于 U 盘根目录")
}

func loadCredential(path string, expectedDeviceID string) (deviceCredential, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return deviceCredential{}, errors.New("ONE Key 已拔出或凭证不存在")
	}
	var credential deviceCredential
	if err := json.Unmarshal(data, &credential); err != nil {
		return deviceCredential{}, errors.New("ONE Key 凭证格式无效")
	}
	if credential.Version != 1 || credential.DeviceID == "" || credential.PrivateKeyRaw == "" || credential.ServerBaseURL == "" {
		return deviceCredential{}, errors.New("ONE Key 凭证不完整")
	}
	if expectedDeviceID != "" && credential.DeviceID != expectedDeviceID {
		return deviceCredential{}, errors.New("ONE Key 凭证不匹配")
	}
	parsed, err := url.Parse(credential.ServerBaseURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Hostname() != "localhost") {
		return deviceCredential{}, errors.New("ONE 服务地址无效")
	}
	return credential, nil
}

func signNonce(nonce, credentialPath, deviceID string) (string, error) {
	credential, err := loadCredential(credentialPath, deviceID)
	if err != nil {
		return "", err
	}
	privateSeed, err := base64.RawURLEncoding.DecodeString(credential.PrivateKeyRaw)
	if err != nil || len(privateSeed) != ed25519.SeedSize {
		return "", errors.New("ONE Key 私钥格式无效")
	}
	nonceBytes, err := base64.RawURLEncoding.DecodeString(nonce)
	if err != nil {
		return "", errors.New("ONE Key 挑战格式无效")
	}
	signature := ed25519.Sign(ed25519.NewKeyFromSeed(privateSeed), nonceBytes)
	return base64.RawURLEncoding.EncodeToString(signature), nil
}

func connectLauncher(base, credentialPath, deviceID string) (*websocket.Conn, error) {
	endpoint, err := url.Parse(base)
	if err != nil {
		return nil, errors.New("ONE 服务地址无效")
	}
	if endpoint.Scheme == "https" {
		endpoint.Scheme = "wss"
	} else {
		endpoint.Scheme = "ws"
	}
	endpoint.Path = "/api/one-key/launcher"
	query := endpoint.Query()
	query.Set("deviceId", deviceID)
	endpoint.RawQuery = query.Encode()

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	connection, _, err := dialer.Dial(endpoint.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("无法连接 ONE 服务：%w", err)
	}
	connection.SetReadDeadline(time.Now().Add(8 * time.Second))
	var challenge socketMessage
	if err := connection.ReadJSON(&challenge); err != nil || challenge.Type != "auth_challenge" || challenge.ChallengeID == "" || challenge.Nonce == "" {
		connection.Close()
		return nil, errors.New("ONE 在线验证握手失败")
	}
	signature, err := signNonce(challenge.Nonce, credentialPath, deviceID)
	if err != nil {
		connection.Close()
		return nil, err
	}
	if err := connection.WriteJSON(socketResponse{Type: "auth_response", ChallengeID: challenge.ChallengeID, Signature: signature}); err != nil {
		connection.Close()
		return nil, errors.New("ONE 在线验证发送失败")
	}
	var ready socketMessage
	if err := connection.ReadJSON(&ready); err != nil || ready.Type != "ready" || ready.DeviceID != deviceID {
		connection.Close()
		return nil, errors.New("ONE Key 在线验证失败")
	}
	connection.SetReadDeadline(time.Time{})
	return connection, nil
}

func serveProofs(connection *websocket.Conn, credentialPath, deviceID string) error {
	defer connection.Close()
	removed := make(chan struct{})
	stopMonitor := make(chan struct{})
	defer close(stopMonitor)
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopMonitor:
				return
			case <-ticker.C:
				if !fileExists(credentialPath) {
					connection.Close()
					close(removed)
					return
				}
			}
		}
	}()

	for {
		var message socketMessage
		if err := connection.ReadJSON(&message); err != nil {
			select {
			case <-removed:
				return nil
			default:
				return err
			}
		}
		switch message.Type {
		case "request_challenge":
			signature, err := signNonce(message.Nonce, credentialPath, deviceID)
			if err != nil {
				return err
			}
			if err := connection.WriteJSON(socketResponse{Type: "proof_response", ChallengeID: message.ChallengeID, Signature: signature}); err != nil {
				return err
			}
		case "execution_start", "execution_continue":
			_ = connection.WriteJSON(map[string]string{
				"type":   "execution_event",
				"taskId": message.TaskID,
				"kind":   "error",
				"text":   "当前 Windows 测试版暂未包含本机执行组件",
				"status": "failed",
			})
		}
	}
}

func openLoginPage(base, credentialPath, deviceID string) error {
	challengeBody := struct {
		DeviceID string `json:"deviceId"`
	}{deviceID}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
		Nonce       string `json:"nonce"`
	}
	if err := postJSON(base+"/api/one-key/challenge", challengeBody, &challenge); err != nil {
		return err
	}
	signature, err := signNonce(challenge.Nonce, credentialPath, deviceID)
	if err != nil {
		return err
	}
	var verified struct {
		LoginCode string `json:"loginCode"`
	}
	if err := postJSON(base+"/api/one-key/challenge/"+url.PathEscape(challenge.ChallengeID)+"/verify", struct {
		Signature string `json:"signature"`
	}{signature}, &verified); err != nil {
		return err
	}
	if verified.LoginCode == "" {
		return errors.New("ONE 没有返回登录凭证")
	}
	loginURL := base + "/#one-key=" + url.QueryEscape(verified.LoginCode)
	if err := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", loginURL).Start(); err != nil {
		return errors.New("无法打开默认浏览器")
	}
	return nil
}

func postJSON(endpoint string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "ONE-Key-Windows/"+version)
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("ONE 服务暂时不可用：%w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return errors.New("无法读取 ONE 服务响应")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure apiFailure
		if json.Unmarshal(data, &failure) == nil && failure.Error != "" {
			return errors.New(failure.Error)
		}
		return fmt.Errorf("ONE 服务返回错误（%d）", response.StatusCode)
	}
	if err := json.Unmarshal(data, output); err != nil {
		return errors.New("ONE 服务响应格式无效")
	}
	return nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func showError(title, message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	messagePointer, _ := syscall.UTF16PtrFromString(message)
	messageBox.Call(0, uintptr(unsafe.Pointer(messagePointer)), uintptr(unsafe.Pointer(titlePointer)), 0x00000030)
}

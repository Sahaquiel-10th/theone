package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/gorilla/websocket"
)

const version = "0.2.0"

type deviceCredential struct {
	Version       int    `json:"version"`
	DeviceID      string `json:"deviceId"`
	PrivateKeyRaw string `json:"privateKeyRaw"`
	ServerBaseURL string `json:"serverBaseUrl"`
}

type socketMessage struct {
	Type        string         `json:"type"`
	ChallengeID string         `json:"challengeId,omitempty"`
	Nonce       string         `json:"nonce,omitempty"`
	DeviceID    string         `json:"deviceId,omitempty"`
	TaskID      string         `json:"taskId,omitempty"`
	RequestID   string         `json:"requestId,omitempty"`
	Tool        string         `json:"tool,omitempty"`
	Arguments   map[string]any `json:"arguments,omitempty"`
}

type socketResponse struct {
	Type         string   `json:"type"`
	ChallengeID  string   `json:"challengeId"`
	Signature    string   `json:"signature"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type socketWriter struct {
	connection *websocket.Conn
	mutex      sync.Mutex
}

func (writer *socketWriter) json(value any) error {
	writer.mutex.Lock()
	defer writer.mutex.Unlock()
	return writer.connection.WriteJSON(value)
}

type localExecutor struct {
	mutex    sync.Mutex
	root     string
	commands map[string]*exec.Cmd
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
	if err := connection.WriteJSON(socketResponse{Type: "auth_response", ChallengeID: challenge.ChallengeID, Signature: signature, Capabilities: []string{"local_tools_v1"}}); err != nil {
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
	writer := &socketWriter{connection: connection}
	executor := &localExecutor{commands: make(map[string]*exec.Cmd)}
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
			if err := writer.json(socketResponse{Type: "proof_response", ChallengeID: message.ChallengeID, Signature: signature}); err != nil {
				return err
			}
		case "local_prepare":
			root, err := executor.prepare(deviceID)
			if err != nil {
				_ = writer.json(map[string]any{"type": "local_error", "taskId": message.TaskID, "requestId": message.RequestID, "error": err.Error()})
				continue
			}
			_ = writer.json(map[string]any{"type": "local_ready", "taskId": message.TaskID, "requestId": message.RequestID, "targetName": filepath.Base(root)})
		case "tool_request":
			go func(request socketMessage) {
				output, err := executor.execute(request.TaskID, request.Tool, request.Arguments)
				response := map[string]any{"type": "tool_result", "taskId": request.TaskID, "requestId": request.RequestID, "ok": err == nil, "output": output}
				if err != nil {
					response["error"] = err.Error()
				}
				_ = writer.json(response)
			}(message)
		case "execution_cancel":
			executor.cancel(message.TaskID)
		case "execution_start", "execution_continue":
			_ = writer.json(map[string]string{
				"type":   "execution_event",
				"taskId": message.TaskID,
				"kind":   "error",
				"text":   "当前 Windows 测试版暂未包含本机执行组件",
				"status": "failed",
			})
		}
	}
}

func (executor *localExecutor) prepare(deviceID string) (string, error) {
	executor.mutex.Lock()
	defer executor.mutex.Unlock()
	if executor.root != "" && directoryExists(executor.root) {
		return executor.root, nil
	}
	if saved := loadSavedWorkspace(deviceID); saved != "" && directoryExists(saved) {
		executor.root = saved
		return saved, nil
	}
	selected, err := chooseWorkspace()
	if err != nil {
		return "", err
	}
	executor.root = selected
	_ = saveWorkspace(deviceID, selected)
	return selected, nil
}

func (executor *localExecutor) execute(taskID, tool string, arguments map[string]any) (string, error) {
	executor.mutex.Lock()
	root := executor.root
	executor.mutex.Unlock()
	if root == "" || !directoryExists(root) {
		return "", errors.New("尚未选择可操作文件夹")
	}
	switch tool {
	case "list_files":
		return listFiles(root, stringArgument(arguments, "path", "."), intArgument(arguments, "maxDepth", 2, 1, 4))
	case "read_file":
		return readFile(root, stringArgument(arguments, "path", ""), intArgument(arguments, "startLine", 1, 1, 1_000_000), intArgument(arguments, "endLine", 500, 1, 1_000_000))
	case "search_text":
		return searchText(root, stringArgument(arguments, "path", "."), stringArgument(arguments, "query", ""), intArgument(arguments, "maxResults", 80, 1, 200), boolArgument(arguments, "caseSensitive"))
	case "write_file":
		return writeFile(root, stringArgument(arguments, "path", ""), stringArgument(arguments, "content", ""))
	case "replace_in_file":
		return replaceInFile(root, stringArgument(arguments, "path", ""), stringArgument(arguments, "oldText", ""), stringArgument(arguments, "newText", ""))
	case "run_command":
		return executor.runCommand(taskID, root, stringArgument(arguments, "command", ""), intArgument(arguments, "timeoutSeconds", 60, 1, 120))
	default:
		return "", fmt.Errorf("不支持本机工具：%s", tool)
	}
}

func (executor *localExecutor) cancel(taskID string) {
	executor.mutex.Lock()
	command := executor.commands[taskID]
	executor.mutex.Unlock()
	if command != nil && command.Process != nil {
		_ = exec.Command("taskkill.exe", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run()
		_ = command.Process.Kill()
	}
}

func listFiles(root, relative string, maxDepth int) (string, error) {
	target, err := resolveAuthorizedPath(root, relative, true)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return "", errors.New("目标不是文件夹")
	}
	entries := make([]string, 0, 256)
	err = filepath.WalkDir(target, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		relativeToTarget, _ := filepath.Rel(target, path)
		depth := 0
		if relativeToTarget != "." {
			depth = strings.Count(relativeToTarget, string(os.PathSeparator)) + 1
		}
		if entry.IsDir() && depth > 0 && (entry.Name() == ".git" || entry.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if depth > maxDepth {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		workspacePath, _ := filepath.Rel(root, path)
		label := filepath.ToSlash(workspacePath)
		if entry.IsDir() {
			label += "/"
		}
		entries = append(entries, label)
		if len(entries) >= 2000 {
			return errors.New("__ONE_LIST_LIMIT__")
		}
		return nil
	})
	if err != nil && err.Error() != "__ONE_LIST_LIMIT__" {
		return "", err
	}
	sort.Strings(entries)
	if len(entries) == 0 {
		return "（空文件夹）", nil
	}
	return strings.Join(entries, "\n"), nil
}

func readFile(root, relative string, startLine, endLine int) (string, error) {
	if relative == "" {
		return "", errors.New("缺少文件路径")
	}
	target, err := resolveAuthorizedPath(root, relative, true)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		return "", errors.New("目标不是文件")
	}
	if info.Size() > 2*1024*1024 {
		return "", errors.New("首版单次只能读取不超过 2MB 的文本文件")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return "", errors.New("当前只支持 UTF-8 文本文件")
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if startLine > len(lines) {
		return fmt.Sprintf("文件共 %d 行，起始行超出范围", len(lines)), nil
	}
	if endLine < startLine {
		endLine = startLine
	}
	if endLine-startLine > 1999 {
		endLine = startLine + 1999
	}
	if endLine > len(lines) {
		endLine = len(lines)
	}
	result := make([]string, 0, endLine-startLine+1)
	for index := startLine - 1; index < endLine; index++ {
		result = append(result, fmt.Sprintf("%d: %s", index+1, lines[index]))
	}
	return strings.Join(result, "\n"), nil
}

func searchText(root, relative, query string, maxResults int, caseSensitive bool) (string, error) {
	if query == "" {
		return "", errors.New("搜索文字不能为空")
	}
	target, err := resolveAuthorizedPath(root, relative, true)
	if err != nil {
		return "", err
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(needle)
	}
	results := make([]string, 0, maxResults)
	err = filepath.WalkDir(target, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() {
			if path != target && (entry.Name() == ".git" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Size() > 1024*1024 {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return nil
		}
		for lineIndex, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
			haystack := line
			if !caseSensitive {
				haystack = strings.ToLower(haystack)
			}
			if strings.Contains(haystack, needle) {
				relativePath, _ := filepath.Rel(root, path)
				results = append(results, fmt.Sprintf("%s:%d: %s", filepath.ToSlash(relativePath), lineIndex+1, truncate(line, 500)))
				if len(results) >= maxResults {
					return errors.New("__ONE_SEARCH_LIMIT__")
				}
			}
		}
		return nil
	})
	if err != nil && err.Error() != "__ONE_SEARCH_LIMIT__" {
		return "", err
	}
	if len(results) == 0 {
		return "没有找到匹配内容", nil
	}
	return strings.Join(results, "\n"), nil
}

func writeFile(root, relative, content string) (string, error) {
	if relative == "" {
		return "", errors.New("缺少文件路径")
	}
	if len(content) > 2*1024*1024 {
		return "", errors.New("首版单次写入不能超过 2MB")
	}
	target, err := resolveAuthorizedPath(root, relative, false)
	if err != nil {
		return "", err
	}
	if !approve("ONE 请求写入文件", fmt.Sprintf("文件：%s\n大小：%d 字节\n\n允许 ONE 创建或覆盖这个文件吗？", relative, len(content))) {
		return "", errors.New("用户拒绝写入文件")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		return "", err
	}
	return fmt.Sprintf("已写入 %s（%d 字节）", filepath.ToSlash(relative), len(content)), nil
}

func replaceInFile(root, relative, oldText, newText string) (string, error) {
	if relative == "" || oldText == "" {
		return "", errors.New("文件路径和待替换文字不能为空")
	}
	target, err := resolveAuthorizedPath(root, relative, true)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	if len(data) > 2*1024*1024 || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return "", errors.New("当前只支持不超过 2MB 的 UTF-8 文本文件")
	}
	count := strings.Count(string(data), oldText)
	if count == 0 {
		return "", errors.New("没有找到完全一致的待替换文字，请重新读取文件")
	}
	if count > 1 {
		return "", fmt.Errorf("待替换文字出现了 %d 次，请提供更具体的内容", count)
	}
	if !approve("ONE 请求修改文件", fmt.Sprintf("文件：%s\n替换 %d 个字符为 %d 个字符\n\n允许 ONE 修改这个文件吗？", relative, len([]rune(oldText)), len([]rune(newText)))) {
		return "", errors.New("用户拒绝修改文件")
	}
	updated := strings.Replace(string(data), oldText, newText, 1)
	if err := os.WriteFile(target, []byte(updated), 0644); err != nil {
		return "", err
	}
	return fmt.Sprintf("已修改 %s", filepath.ToSlash(relative)), nil
}

func (executor *localExecutor) runCommand(taskID, root, command string, timeoutSeconds int) (string, error) {
	if strings.TrimSpace(command) == "" {
		return "", errors.New("命令不能为空")
	}
	if len(command) > 4000 {
		return "", errors.New("命令过长")
	}
	if !approve("ONE 请求运行命令", fmt.Sprintf("工作目录：%s\n\n%s\n\n命令可能访问授权文件夹以外的内容。确认运行吗？", root, command)) {
		return "", errors.New("用户拒绝运行命令")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command)
	cmd.Dir = root
	buffer := &limitedBuffer{limit: 120_000}
	cmd.Stdout = buffer
	cmd.Stderr = buffer
	executor.mutex.Lock()
	executor.commands[taskID] = cmd
	executor.mutex.Unlock()
	err := cmd.Run()
	executor.mutex.Lock()
	delete(executor.commands, taskID)
	executor.mutex.Unlock()
	output := strings.TrimSpace(buffer.String())
	if ctx.Err() == context.DeadlineExceeded {
		return output, fmt.Errorf("命令超过 %d 秒，已停止", timeoutSeconds)
	}
	if err != nil {
		return output, fmt.Errorf("命令执行失败：%v\n%s", err, output)
	}
	if output == "" {
		output = "命令执行成功（没有输出）"
	}
	return output, nil
}

type limitedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (value *limitedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	remaining := value.limit - value.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = value.buffer.Write(data)
	}
	return original, nil
}
func (value *limitedBuffer) String() string {
	result := value.buffer.String()
	if value.buffer.Len() >= value.limit {
		result += "\n[输出已截断]"
	}
	return result
}

func resolveAuthorizedPath(root, relative string, mustExist bool) (string, error) {
	if strings.ContainsRune(relative, 0) || filepath.IsAbs(relative) || filepath.VolumeName(relative) != "" {
		return "", errors.New("只允许使用授权文件夹内的相对路径")
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", errors.New("授权文件夹已不可用")
	}
	rootReal, _ = filepath.Abs(rootReal)
	candidate, err := filepath.Abs(filepath.Join(rootReal, filepath.Clean(relative)))
	if err != nil {
		return "", errors.New("文件路径无效")
	}
	if err := ensureInside(rootReal, candidate); err != nil {
		return "", err
	}
	if mustExist {
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			return "", errors.New("文件或文件夹不存在")
		}
		if err := ensureInside(rootReal, resolved); err != nil {
			return "", err
		}
		return resolved, nil
	}
	if _, err := os.Lstat(candidate); err == nil {
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			return "", errors.New("目标文件路径不可用")
		}
		if err := ensureInside(rootReal, resolved); err != nil {
			return "", err
		}
		return resolved, nil
	} else if !os.IsNotExist(err) {
		return "", errors.New("目标文件路径不可用")
	}
	parent := filepath.Dir(candidate)
	for !directoryExists(parent) {
		next := filepath.Dir(parent)
		if next == parent {
			return "", errors.New("文件路径无效")
		}
		parent = next
	}
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return "", errors.New("目标文件夹不可用")
	}
	if err := ensureInside(rootReal, resolvedParent); err != nil {
		return "", err
	}
	return candidate, nil
}

func ensureInside(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return errors.New("拒绝访问授权文件夹以外的路径")
	}
	return nil
}

func stringArgument(arguments map[string]any, name, fallback string) string {
	if value, ok := arguments[name].(string); ok {
		return value
	}
	return fallback
}
func intArgument(arguments map[string]any, name string, fallback, minimum, maximum int) int {
	value, ok := arguments[name].(float64)
	if !ok {
		return fallback
	}
	integer := int(value)
	if integer < minimum {
		return minimum
	}
	if integer > maximum {
		return maximum
	}
	return integer
}
func boolArgument(arguments map[string]any, name string) bool {
	value, _ := arguments[name].(bool)
	return value
}
func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
func directoryExists(path string) bool { info, err := os.Stat(path); return err == nil && info.IsDir() }

func workspaceConfigPath(deviceID string) string {
	base, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	safeID := strings.Map(func(value rune) rune {
		if value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '-' || value == '_' {
			return value
		}
		return '_'
	}, deviceID)
	return filepath.Join(base, "ONE", "workspaces", safeID+".txt")
}
func loadSavedWorkspace(deviceID string) string {
	path := workspaceConfigPath(deviceID)
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
func saveWorkspace(deviceID, workspace string) error {
	path := workspaceConfigPath(deviceID)
	if path == "" {
		return errors.New("无法保存授权文件夹")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(workspace), 0600)
}

func chooseWorkspace() (string, error) {
	script := `Add-Type -AssemblyName System.Windows.Forms; $owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.WindowState = 'Minimized'; $owner.Show(); $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择允许 ONE 读取和修改的文件夹'; $dialog.ShowNewFolderButton = $true; $result = $dialog.ShowDialog($owner); $owner.Close(); if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }`
	output, err := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-STA", "-Command", script).Output()
	selected := strings.TrimSpace(string(output))
	if err != nil || selected == "" {
		return "", errors.New("没有选择本地文件夹")
	}
	if !directoryExists(selected) {
		return "", errors.New("选择的本地文件夹不可用")
	}
	return selected, nil
}

func approve(title, message string) bool {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	messagePointer, _ := syscall.UTF16PtrFromString(message)
	result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(messagePointer)), uintptr(unsafe.Pointer(titlePointer)), 0x00050034)
	return result == 6
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
	messageBox.Call(0, uintptr(unsafe.Pointer(messagePointer)), uintptr(unsafe.Pointer(titlePointer)), 0x00050030)
}

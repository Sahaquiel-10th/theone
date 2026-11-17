package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type windowsCodexGateway struct {
	BaseURL string `json:"baseUrl"`
	Token   string `json:"token"`
	Model   string `json:"model"`
}
type windowsCodexTaskBinding struct {
	WorkspaceID      string `json:"workspaceId"`
	UserID           string `json:"userId"`
	DeviceID         string `json:"deviceId"`
	InstallationID   string `json:"installationId"`
	TaskID           string `json:"taskId"`
	TargetName       string `json:"targetName"`
	ProviderThreadID string `json:"providerThreadId,omitempty"`
}
type windowsCodexPendingTool struct {
	identity                 codexReceiptIdentity
	request                  map[string]any
	threadID, turnID, callID string
	result                   chan codexDynamicToolResult
}
type windowsCodexRun struct {
	identity   codexReceiptIdentity
	controller *codexAppServer
	job        *codexProcessJob
	cancelled  bool
	finishing  bool
}
type windowsCodexHost struct {
	mu                       sync.Mutex
	credentialPath, deviceID string
	writer                   *socketWriter
	writerOwner              codexExecutionOwner
	owner                    codexExecutionOwner
	active                   *windowsCodexRun
	tools                    map[string]*windowsCodexPendingTool
	preparing                bool
	journal                  *codexReceiptJournal
	validated                *windowsCodexValidation
}

var windowsCodexHosts = struct {
	sync.Mutex
	hosts map[string]*windowsCodexHost
}{hosts: map[string]*windowsCodexHost{}}

func windowsCodexHostFor(credentialPath, deviceID string) *windowsCodexHost {
	windowsCodexHosts.Lock()
	defer windowsCodexHosts.Unlock()
	if host := windowsCodexHosts.hosts[deviceID]; host != nil {
		return host
	}
	root, _ := os.UserCacheDir()
	host := &windowsCodexHost{credentialPath: credentialPath, deviceID: deviceID, tools: map[string]*windowsCodexPendingTool{}, journal: &codexReceiptJournal{root: filepath.Join(root, "ONE", "execution-receipts", codexHash(deviceID)), replace: replaceRuntimeFile}}
	windowsCodexHosts.hosts[deviceID] = host
	return host
}
func (host *windowsCodexHost) setOwner(owner codexExecutionOwner) {
	if !codexProtocolID.MatchString(owner.WorkspaceID) || !codexProtocolID.MatchString(owner.UserID) {
		return
	}
	host.mu.Lock()
	changed := host.owner.WorkspaceID != "" && host.owner != owner
	host.mu.Unlock()
	if changed {
		host.cancelAll()
	}
	host.mu.Lock()
	host.owner = owner
	host.mu.Unlock()
}
func (host *windowsCodexHost) send(value any) error {
	host.mu.Lock()
	writer := host.writer
	host.mu.Unlock()
	if writer == nil {
		return errors.New("本机连接暂时不可用")
	}
	return writer.json(value)
}
func (host *windowsCodexHost) sendOwned(id codexReceiptIdentity, value any) error {
	host.mu.Lock()
	writer := host.writer
	matches := host.owner.WorkspaceID == id.WorkspaceID && host.owner.UserID == id.UserID && host.writerOwner == host.owner
	host.mu.Unlock()
	if writer == nil || !matches {
		return errors.New("本轮用户的本机连接暂时不可用")
	}
	return writer.json(value)
}
func (host *windowsCodexHost) bind(writer *socketWriter) {
	host.mu.Lock()
	host.writer = writer
	host.writerOwner = host.owner
	requests := make([]*windowsCodexPendingTool, 0, len(host.tools))
	for _, pending := range host.tools {
		if host.active != nil && pending.identity == host.active.identity && pending.identity.WorkspaceID == host.owner.WorkspaceID && pending.identity.UserID == host.owner.UserID {
			requests = append(requests, pending)
		}
	}
	host.mu.Unlock()
	for _, request := range requests {
		_ = host.sendOwned(request.identity, request.request)
	}
	go host.replay()
}
func (host *windowsCodexHost) unbind(writer *socketWriter) {
	host.mu.Lock()
	if host.writer == writer {
		host.writer = nil
	}
	host.mu.Unlock()
}
func (host *windowsCodexHost) busy() bool {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.active != nil || host.preparing
}
func (host *windowsCodexHost) replay() {
	installation, err := installationID()
	if err != nil {
		return
	}
	host.mu.Lock()
	owner := host.owner
	active := map[string]bool{}
	if host.active != nil {
		active[host.active.identity.AttemptID] = true
	}
	if owner.WorkspaceID == "" {
		host.mu.Unlock()
		return
	}
	receipts, err := host.journal.pending(owner, host.deviceID, installation, active)
	host.mu.Unlock()
	if err != nil {
		return
	}
	for _, receipt := range receipts {
		_ = host.sendOwned(receipt.codexReceiptIdentity, receipt)
	}
}
func (host *windowsCodexHost) acknowledge(message socketMessage) {
	id := codexReceiptIdentity{WorkspaceID: message.WorkspaceID, UserID: message.UserID, DeviceID: message.DeviceID, InstallationID: message.InstallationID, TaskID: message.TaskID, AttemptID: message.AttemptID, Round: message.Round}
	_ = host.journal.acknowledge(id, message.ReceiptID, message.ReceiptHash, message.Accepted)
}
func (host *windowsCodexHost) progress(id codexReceiptIdentity, kind, text, status, target, thread string) {
	event := map[string]any{"type": "execution_event", "taskId": id.TaskID, "round": id.Round, "attemptId": id.AttemptID, "kind": kind}
	if text != "" {
		event["text"] = text
	}
	if status != "" {
		event["status"] = status
	}
	if target != "" {
		event["targetName"] = target
	}
	if thread != "" {
		event["providerThreadId"] = thread
	}
	_ = host.sendOwned(id, event)
}
func (host *windowsCodexHost) terminal(id codexReceiptIdentity, outcome, text, code, target, thread string) {
	receipt, err := host.journal.complete(newCodexTerminalReceipt(id, outcome, text, code, target, thread))
	if errors.Is(err, errCodexReceiptAcknowledged) {
		return
	}
	if err != nil {
		_ = host.sendOwned(id, map[string]any{"type": "execution_delivery_error", "workspaceId": id.WorkspaceID, "userId": id.UserID, "deviceId": id.DeviceID, "installationId": id.InstallationID, "taskId": id.TaskID, "round": id.Round, "attemptId": id.AttemptID, "code": "outbox_unavailable", "phase": "result_not_persisted"})
		return
	}
	_ = host.sendOwned(id, receipt)
}
func windowsManagedRoot() (string, error) {
	root, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "ONE", "executors"), nil
}

func (host *windowsCodexHost) prepare(message socketMessage) {
	if message.RequestID == "" {
		return
	}
	response := map[string]any{"type": "local_ready", "taskId": "device_settings", "requestId": message.RequestID, "output": ""}
	err := host.prepareRuntime(message, func(phase string) {
		_ = host.send(map[string]any{"type": "executor_progress", "taskId": "device_settings", "requestId": message.RequestID, "output": phase})
	}, response)
	if err != nil {
		response["type"] = "local_error"
		response["error"] = err.Error()
	}
	_ = host.send(response)
}
func (host *windowsCodexHost) prepareRuntime(message socketMessage, phase func(string), response map[string]any) error {
	host.mu.Lock()
	if host.preparing || message.Type == "executor_prepare" && host.active != nil {
		host.mu.Unlock()
		return errors.New("本机执行工具正在使用，请稍后准备")
	}
	host.preparing = true
	host.mu.Unlock()
	defer func() { host.mu.Lock(); host.preparing = false; host.mu.Unlock() }()
	credential, err := loadCredential(host.credentialPath, host.deviceID)
	if err != nil {
		return err
	}
	root, err := windowsManagedRoot()
	if err != nil {
		return err
	}
	executable, installed, currentErr := host.installedRuntime(root, credential.ServerBaseURL, false)
	if currentErr != nil && message.Type != "executor_prepare" {
		return currentErr
	}
	if message.Type == "executor_prepare" {
		envelope := managedCodexEnvelope{Payload: message.Envelope.Payload, Signature: message.Envelope.Signature}
		release, err := verifyManagedCodex(envelope, updatePublicKeyRaw, credential.ServerBaseURL, "")
		if err != nil {
			return err
		}
		if currentErr != nil || executable == "" || managedVersionCompare(installed, release.Version) < 0 {
			phase("confirming")
			if !approve("准备 Codex 本机执行", fmt.Sprintf("ONE 将安装官方 Codex %s，大小约 %d MB。使用 ONE 提供的模型和电力，无需另行登录 Codex。是否继续？", release.Version, (release.Size+1024*1024-1)/(1024*1024))) {
				return errors.New("已取消准备本机执行工具")
			}
			phase("downloading")
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, release.URL, nil)
			if err != nil {
				return err
			}
			client := &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("工具下载地址发生跳转") }}
			result, err := client.Do(request)
			if err != nil {
				return errors.New("Codex 工具包下载暂时失败，请稍后重新准备")
			}
			defer result.Body.Close()
			if result.StatusCode != http.StatusOK || result.ContentLength > release.Size {
				return errors.New("Codex 工具包下载结果无效")
			}
			archive, err := io.ReadAll(io.LimitReader(result.Body, release.Size+1))
			if err != nil {
				return err
			}
			if _, err := loadCredential(host.credentialPath, host.deviceID); err != nil {
				return err
			}
			phase("verifying")
			executable, err = commitManagedCodex(archive, envelope, release, root, func(path, wanted string) error {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, path, "--version")
				command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
				output, err := command.Output()
				if err != nil || strings.TrimSpace(string(output)) != "codex-cli "+wanted {
					return errors.New("Codex 安装后检查未通过")
				}
				if err := checkWindowsCodexPermissions(path); err != nil {
					return err
				}
				_, err = loadCredential(host.credentialPath, host.deviceID)
				return err
			}, replaceRuntimeFile)
			if err != nil {
				return err
			}
			installed = release.Version
			stamp, err := windowsCodexStatusStamp(root, executable)
			if err != nil {
				return err
			}
			host.mu.Lock()
			host.validated = &windowsCodexValidation{root: root, path: executable, version: installed, stamp: stamp, checkedAt: time.Now()}
			host.mu.Unlock()
		}
	}
	if executable != "" {
		response["targetName"] = "managed"
		response["output"] = installed
	}
	return nil
}

func (host *windowsCodexHost) start(message socketMessage) {
	installation, err := installationID()
	if err != nil || message.Owner == nil {
		return
	}
	id := codexReceiptIdentity{WorkspaceID: message.Owner.WorkspaceID, UserID: message.Owner.UserID, DeviceID: host.deviceID, InstallationID: installation, TaskID: message.TaskID, AttemptID: message.AttemptID, Round: message.Round}
	if !id.valid() || message.Instruction == "" || len(message.Instruction) > 2*1024*1024 {
		return
	}
	root := loadSavedWorkspace(host.deviceID)
	host.mu.Lock()
	if host.owner != *message.Owner {
		host.mu.Unlock()
		return
	}
	if previous, err := host.journal.reserve(id, root); err != nil {
		host.mu.Unlock()
		_ = host.sendOwned(id, map[string]any{"type": "execution_delivery_error", "workspaceId": id.WorkspaceID, "userId": id.UserID, "deviceId": id.DeviceID, "installationId": id.InstallationID, "taskId": id.TaskID, "round": id.Round, "attemptId": id.AttemptID, "code": "outbox_unavailable", "phase": "not_started"})
		return
	} else if previous != nil {
		host.mu.Unlock()
		if previous.Receipt != nil {
			_ = host.sendOwned(id, *previous.Receipt)
		} else if previous.Acknowledged {
			host.recoveryStatus(id, "receipt_acknowledged")
		}
		return
	}
	if host.active != nil || host.preparing {
		host.mu.Unlock()
		host.terminal(id, "failed", "电脑正在处理另一轮任务，请等待本轮结束。", "execution_busy", root, "")
		return
	}
	run := &windowsCodexRun{identity: id}
	host.active = run
	host.mu.Unlock()
	go host.run(message, run)
}
func (host *windowsCodexHost) cancel(message socketMessage) {
	host.mu.Lock()
	run := host.active
	if run == nil || run.finishing || run.identity.TaskID != message.TaskID || run.identity.AttemptID != message.AttemptID || run.identity.Round != message.Round {
		host.mu.Unlock()
		go host.replay()
		return
	}
	run.cancelled = true
	controller := run.controller
	job := run.job
	host.mu.Unlock()
	if controller != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			if !controller.Interrupt(ctx) && job != nil {
				job.stopAndJoin()
			}
		}()
	}
}
func (host *windowsCodexHost) cancelAll() {
	host.mu.Lock()
	run := host.active
	host.mu.Unlock()
	if run != nil {
		host.cancel(socketMessage{TaskID: run.identity.TaskID, AttemptID: run.identity.AttemptID, Round: run.identity.Round})
	}
}
func (host *windowsCodexHost) isCancelled(run *windowsCodexRun) bool {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.active != run || run.cancelled
}

func (host *windowsCodexHost) callTool(ctx context.Context, id codexReceiptIdentity, call codexDynamicToolCall) (codexDynamicToolResult, error) {
	requestID := codexHash(id.key(), call.ThreadID, call.TurnID, call.CallID)
	pending := &windowsCodexPendingTool{identity: id, threadID: call.ThreadID, turnID: call.TurnID, callID: call.CallID, result: make(chan codexDynamicToolResult, 1)}
	pending.request = map[string]any{"type": "executor_tool_call", "taskId": id.TaskID, "round": id.Round, "attemptId": id.AttemptID, "requestId": requestID, "threadId": call.ThreadID, "turnId": call.TurnID, "callId": call.CallID, "tool": call.Tool, "arguments": call.Arguments}
	host.mu.Lock()
	if host.active == nil || host.active.identity != id || host.owner.WorkspaceID != id.WorkspaceID || host.owner.UserID != id.UserID {
		host.mu.Unlock()
		return codexDynamicToolResult{}, errors.New("本轮工具请求的用户或任务绑定已改变")
	}
	host.tools[requestID] = pending
	host.mu.Unlock()
	defer func() { host.mu.Lock(); delete(host.tools, requestID); host.mu.Unlock() }()
	_ = host.sendOwned(id, pending.request)
	timer := time.NewTimer(180 * time.Second)
	defer timer.Stop()
	select {
	case result := <-pending.result:
		return result, nil
	case <-ctx.Done():
		return codexDynamicToolResult{}, ctx.Err()
	case <-timer.C:
		return codexDynamicToolResult{}, errors.New("ONE 工具结果等待超时，原操作已保留")
	}
}
func (host *windowsCodexHost) acceptToolResult(message socketMessage) {
	host.mu.Lock()
	pending := host.tools[message.RequestID]
	ownerMatches := pending != nil && host.active != nil && host.active.identity == pending.identity && host.owner.WorkspaceID == pending.identity.WorkspaceID && host.owner.UserID == pending.identity.UserID
	host.mu.Unlock()
	if !ownerMatches || pending.identity.TaskID != message.TaskID || pending.identity.Round != message.Round || pending.identity.AttemptID != message.AttemptID || pending.threadID != message.ThreadID || pending.turnID != message.TurnID || pending.callID != message.CallID {
		return
	}
	for _, content := range message.ContentItems {
		if content.Type != "inputText" || len(content.Text) > 1024*1024 {
			return
		}
	}
	if len(message.ContentItems) == 0 || len(message.ContentItems) > 32 {
		return
	}
	select {
	case pending.result <- codexDynamicToolResult{Success: message.Success, ContentItems: message.ContentItems}:
	default:
	}
}

func (host *windowsCodexHost) run(message socketMessage, run *windowsCodexRun) {
	id := run.identity
	defer func() {
		host.mu.Lock()
		if host.active == run {
			host.active = nil
		}
		host.mu.Unlock()
	}()
	root := loadSavedWorkspace(host.deviceID)
	credential, err := loadCredential(host.credentialPath, host.deviceID)
	if err != nil {
		host.terminal(id, "failed", "ONE Key 暂时不可用，请恢复连接后继续。", "key_unavailable", root, "")
		return
	}
	if !directoryExists(root) {
		host.terminal(id, "failed", "请先在设置中选择可用的 ONE 工作文件夹。", "work_folder_unavailable", root, "")
		return
	}
	resume := ""
	if binding := message.TaskBinding; binding != nil {
		if binding.WorkspaceID != id.WorkspaceID || binding.UserID != id.UserID || binding.DeviceID != id.DeviceID || binding.InstallationID != id.InstallationID || binding.TaskID != id.TaskID || !strings.EqualFold(filepath.Clean(binding.TargetName), filepath.Clean(root)) {
			host.terminal(id, "failed", "原任务的电脑或工作文件夹与当前授权不一致。", "task_binding_mismatch", root, "")
			return
		}
		resume = binding.ProviderThreadID
	}
	if message.Type == "execution_continue" && resume == "" {
		host.terminal(id, "failed", "原执行会话尚未确认，请先核对原任务。", "thread_binding_missing", root, "")
		return
	}
	managedRoot, err := windowsManagedRoot()
	if err != nil {
		host.terminal(id, "failed", "无法访问本机执行工具目录。", "executor_unavailable", root, resume)
		return
	}
	executable, _, err := installedManagedCodex(managedRoot, updatePublicKeyRaw, credential.ServerBaseURL)
	if err != nil || executable == "" {
		host.terminal(id, "failed", "请在设置中准备 Codex 本机执行工具。", "executor_unavailable", root, resume)
		return
	}
	arguments, environment, _, profile, err := windowsCodexLaunch(message.Gateway, host.deviceID, id.TaskID, root, executable, message.ToolBridge != nil)
	if err != nil {
		host.terminal(id, "failed", err.Error(), "executor_configuration", root, resume)
		return
	}
	if host.isCancelled(run) {
		host.terminal(id, "cancelled", "已停止，本机任务尚未开始。", "", root, resume)
		return
	}
	command := exec.Command(executable, arguments...)
	command.Dir = root
	command.Env = environment
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x200 | 0x4}
	stdin, err := command.StdinPipe()
	if err != nil {
		host.terminal(id, "failed", "无法准备 Codex 输入。", "executor_start", root, resume)
		return
	}
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		stdin.Close()
		host.terminal(id, "failed", "无法准备 Codex 输出。", "executor_start", root, resume)
		return
	}
	defer stdout.Close()
	defer stdoutWriter.Close()
	command.Stdout = stdoutWriter
	stderr, stderrWriter, err := os.Pipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		host.terminal(id, "failed", "无法准备 Codex 诊断。", "executor_start", root, resume)
		return
	}
	defer stderr.Close()
	defer stderrWriter.Close()
	command.Stderr = stderrWriter
	job, err := newCodexProcessJob()
	if err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		host.terminal(id, "failed", "无法建立本轮进程范围。", "executor_process_scope", root, resume)
		return
	}
	defer job.close()
	var inputMu sync.Mutex
	var inputClose sync.Once
	closeInput := func() { inputClose.Do(func() { stdin.Close() }) }
	defer closeInput()
	sendLine := func(line []byte) error {
		done := make(chan error, 1)
		go func() { inputMu.Lock(); defer inputMu.Unlock(); _, err := stdin.Write(line); done <- err }()
		select {
		case err := <-done:
			return err
		case <-time.After(5 * time.Second):
			closeInput()
			return errors.New("执行器输入确认超时")
		}
	}
	var tools []codexToolDefinition
	if message.ToolBridge != nil {
		tools = message.ToolBridge.Tools
	}
	controller, err := newCodexAppServer(codexAppServerConfig{AttemptID: id.AttemptID, CWD: root, ResumeThreadID: resume, ClientVersion: version, PermissionProfile: profile, Tools: tools, SendLine: sendLine, OnToolCall: func(ctx context.Context, call codexDynamicToolCall) (codexDynamicToolResult, error) {
		return host.callTool(ctx, id, call)
	}, OnEvent: func(event map[string]any) { host.event(run, event, root) }})
	if err != nil {
		host.terminal(id, "failed", err.Error(), "executor_configuration", root, resume)
		return
	}
	defer controller.Close()
	if err := command.Start(); err != nil {
		host.terminal(id, "failed", "无法启动已准备的 Codex 工具。", "executor_start", root, resume)
		return
	}
	if err := job.assign(command); err != nil {
		command.Process.Kill()
		command.Wait()
		host.terminal(id, "failed", "无法确认 Codex 子进程范围。", "executor_process_scope", root, resume)
		return
	}
	if err := resumeCodexProcess(command); err != nil {
		job.stopAndJoin()
		command.Wait()
		host.terminal(id, "failed", "Codex 本轮进程未能恢复运行。", "executor_process_scope", root, resume)
		return
	}
	stdoutWriter.Close()
	stderrWriter.Close()
	host.mu.Lock()
	run.controller = controller
	run.job = job
	host.mu.Unlock()
	outputDone := make(chan bool, 1)
	errorDone := make(chan struct{}, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 65536), 2*1024*1024)
		for scanner.Scan() {
			controller.Receive(append([]byte(nil), scanner.Bytes()...))
		}
		outputDone <- scanner.Err() == nil
		controller.Close()
	}()
	go func() { _, _ = io.Copy(io.Discard, stderr); errorDone <- struct{}{} }()
	host.progress(id, "status", "正在使用 Codex 处理要求。", "running", root, resume)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	var runErr error
	if host.isCancelled(run) {
		runErr = errors.New("任务已停止")
	} else {
		_, runErr = controller.Start(ctx, windowsCodexInstruction(message.Instruction))
	}
	if runErr == nil {
		_, runErr = controller.WaitTurnEnd(ctx)
	}
	host.mu.Lock()
	cancelled := run.cancelled
	run.finishing = true
	host.mu.Unlock()
	if cancelled || runErr != nil {
		interruptCtx, interruptCancel := context.WithTimeout(context.Background(), 12*time.Second)
		controller.Interrupt(interruptCtx)
		interruptCancel()
	}
	closeInput()
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	exitCode := -1
	rootExited := false
	select {
	case err := <-exited:
		rootExited = true
		if err == nil {
			exitCode = 0
		} else if command.ProcessState != nil {
			exitCode = command.ProcessState.ExitCode()
		}
	case <-time.After(4 * time.Second):
		job.stopAndJoin()
		select {
		case <-exited:
			rootExited = true
		case <-time.After(3 * time.Second):
		}
	}
	count, countErr := job.activeCount()
	treeClean := countErr == nil && count == 0
	if !treeClean {
		treeClean = job.stopAndJoin()
	}
	outputClean := false
	select {
	case outputClean = <-outputDone:
	case <-time.After(3 * time.Second):
		stdout.Close()
	}
	errorClean := false
	select {
	case <-errorDone:
		errorClean = true
	case <-time.After(3 * time.Second):
		stderr.Close()
	}
	activeProcessesZero := treeClean
	treeClean = treeClean && rootExited && outputClean && errorClean
	snapshot := controller.Snapshot()
	_, response := codexLocalResult(snapshot.FinalResponse)
	if treeClean {
		_ = os.RemoveAll(windowsCodexScratch(environment))
	}
	if cancelled && (!snapshot.TurnStartSent && treeClean || snapshot.CancellationConfirmedForOwnedJob(codexOwnedJobStopProof{RootExited: rootExited, StdoutEOF: outputClean, StderrEOF: errorClean, ActiveProcessesZero: activeProcessesZero})) {
		host.terminal(id, "cancelled", "已停止，已有成果可在原任务查看。", "", root, snapshot.ThreadID)
		return
	}
	if snapshot.CanCompleteNormally(treeClean, exitCode) && runErr == nil {
		host.terminal(id, "completed", response, "", root, snapshot.ThreadID)
		return
	}
	if response == "" {
		response = "这轮执行暂未完成，已有结果和要求已保留。请打开任务查看具体进展。"
	}
	code := "execution_unconfirmed"
	if !treeClean || snapshot.PendingCommands > 0 || snapshot.PendingTools > 0 {
		code = "command_unconfirmed"
	}
	if profile != "" && snapshot.FailureReason != "" {
		response += "\n本机执行器未能完成当前权限配置，请查看本轮工具反馈。"
	}
	host.terminal(id, "failed", response, code, root, snapshot.ThreadID)
}

func (host *windowsCodexHost) recoveryStatus(id codexReceiptIdentity, state string) {
	_ = host.sendOwned(id, map[string]any{"type": "execution_recovery_status", "workspaceId": id.WorkspaceID, "userId": id.UserID, "deviceId": id.DeviceID, "installationId": id.InstallationID, "taskId": id.TaskID, "round": id.Round, "attemptId": id.AttemptID, "state": state})
}

func (host *windowsCodexHost) event(run *windowsCodexRun, event map[string]any, root string) {
	id := run.identity
	kind, _ := event["type"].(string)
	if kind == "thread.started" {
		thread, _ := event["thread_id"].(string)
		if thread != "" {
			if err := host.journal.thread(id, thread); err != nil {
				host.cancel(socketMessage{TaskID: id.TaskID, AttemptID: id.AttemptID, Round: id.Round})
				return
			}
			host.progress(id, "status", "执行会话已连接。", "", root, thread)
		}
		return
	}
	item, _ := event["item"].(map[string]any)
	itemType, _ := item["type"].(string)
	if kind == "item.completed" && itemType == "agent_message" {
		text, _ := item["text"].(string)
		_, text = codexLocalResult(text)
		if text != "" {
			host.progress(id, "message", text, "", root, "")
		}
	}
	if kind == "item.started" && (itemType == "command_execution" || itemType == "dynamic_tool_call") {
		host.progress(id, "status", "正在处理本轮任务步骤。", "", root, "")
	}
	if kind == "item.completed" && itemType == "file_change" {
		host.progress(id, "file_change", "本轮文件变更已返回，正在整理结果。", "", root, "")
	}
}

func windowsCodexLaunch(gateway *windowsCodexGateway, device, task, root, executable string, bridge bool) ([]string, []string, string, string, error) {
	if gateway == nil {
		return nil, nil, "", "", errors.New("ONE 执行模型尚未配置")
	}
	u, err := url.Parse(gateway.BaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasSuffix(u.Path, "/api/executor-gateway/v1") || gateway.Model != "one-executor" || len(gateway.Token) != 43 {
		return nil, nil, "", "", errors.New("ONE 执行授权无效")
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return nil, nil, "", "", err
	}
	home := filepath.Join(cache, "ONE", "codex", codexHash(device, task))
	if err := managedCheckPath(home); err != nil {
		return nil, nil, "", "", err
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		return nil, nil, "", "", err
	}
	scratch, err := os.MkdirTemp(home, "scratch-")
	if err != nil {
		return nil, nil, "", "", err
	}
	if err := managedCheckPath(scratch); err != nil {
		return nil, nil, "", "", err
	}
	environment := []string{}
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		switch strings.ToUpper(name) {
		case "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME", "CODEX_SQLITE_HOME", "ONE_EXECUTOR_TOKEN", "TMP", "TEMP", "TMPDIR":
			continue
		}
		environment = append(environment, value)
	}
	environment = append(environment, "CODEX_HOME="+home, "ONE_EXECUTOR_TOKEN="+gateway.Token, "TMP="+scratch, "TEMP="+scratch, "TMPDIR="+scratch)
	quote := strconv.Quote
	settings := []string{"model=" + quote(gateway.Model), "model_provider=\"one\"", "web_search=\"disabled\"", "model_providers.one.name=\"ONE\"", "model_providers.one.base_url=" + quote(gateway.BaseURL), "model_providers.one.wire_api=\"responses\"", "model_providers.one.env_key=\"ONE_EXECUTOR_TOKEN\"", "model_providers.one.requires_openai_auth=false", "model_providers.one.request_max_retries=0", "model_providers.one.stream_max_retries=0", "windows.sandbox=\"unelevated\""}
	profile := ""
	if bridge {
		profile = "one-workspace-" + codexRandomID()
		runtimeRoot := filepath.Dir(filepath.Dir(executable))
		settings = append(settings, "windows.sandbox=\"mxc\"", "default_permissions="+quote(profile), "permissions."+profile+".extends=\":workspace\"", "permissions."+profile+".filesystem={\":root\"=\"deny\",\":minimal\"=\"read\",\":tmpdir\"=\"write\",\":slash_tmp\"=\"deny\",\":workspace_roots\"={\".\"=\"write\"},"+quote(scratch)+"=\"write\","+quote(runtimeRoot)+"=\"read\"}", "permissions."+profile+".network.enabled=false", "shell_environment_policy.inherit=\"core\"", "shell_environment_policy.ignore_default_excludes=false", "shell_environment_policy.include_only=[\"PATH\",\"PATHEXT\",\"SHELL\",\"COMSPEC\",\"SYSTEMROOT\",\"WINDIR\",\"SYSTEMDRIVE\",\"USERNAME\",\"USERDOMAIN\",\"USERPROFILE\",\"HOMEDRIVE\",\"HOMEPATH\",\"PROGRAMFILES\",\"PROGRAMFILES(X86)\",\"PROGRAMW6432\",\"PROGRAMDATA\",\"LOCALAPPDATA\",\"APPDATA\",\"TEMP\",\"TMP\",\"TMPDIR\",\"POWERSHELL\",\"PWSH\",\"ONE_DOCUMENT_TOOL\",\"ONE_DOCUMENT_ROOT\"]", "features.multi_agent=false", "features.goals=false")
		settings = append(settings, "features.plugins=false", "features.plugin_hooks=false", "features.codex_hooks=false", "features.hooks=false", "features.apps=false")
		for directory := filepath.Clean(root); ; directory = filepath.Dir(directory) {
			settings = append(settings, "projects."+quote(directory)+".trust_level=\"untrusted\"")
			if filepath.Dir(directory) == directory {
				break
			}
		}
	}
	arguments := []string{}
	for _, setting := range settings {
		arguments = append(arguments, "-c", setting)
	}
	arguments = append(arguments, "app-server", "--listen", "stdio://")
	return arguments, environment, home, profile, nil
}

func windowsCodexScratch(environment []string) string {
	for _, value := range environment {
		name, directory, found := strings.Cut(value, "=")
		if found && strings.EqualFold(name, "TMPDIR") {
			return directory
		}
	}
	return ""
}
func windowsCodexInstruction(original string) string {
	return original + "\n\n结束前核对用户要求的成果。最终回复首行使用 ONE_LOCAL_RESULT_V1 VERIFIED（全部必需目标完成）或 ONE_LOCAL_RESULT_V1 INCOMPLETE（还有目标受阻或未完成），下一行起自然说明结果与下一步。该标记仅记录结果声明，实际完成须有相应文件或工具证据。"
}

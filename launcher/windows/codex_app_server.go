package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Pinned Codex 0.160.1 stdio protocol. The Windows runner owns the process,
// authenticated transport, permission configuration and process-tree cleanup.
type codexToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}
type codexToolBridgeConfiguration struct {
	Tools []codexToolDefinition `json:"tools"`
}
type codexToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}
type codexDynamicToolResult struct {
	ContentItems []codexToolContent `json:"contentItems"`
	Success      bool               `json:"success"`
}
type codexDynamicToolCall struct {
	ThreadID  string         `json:"threadId"`
	TurnID    string         `json:"turnId"`
	CallID    string         `json:"callId"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}
type codexTurnIdentity struct{ AttemptID, ThreadID, TurnID string }
type codexAppServerConfig struct {
	AttemptID, CWD, ResumeThreadID, ClientVersion string
	PermissionProfile                             string
	Tools                                         []codexToolDefinition
	SendLine                                      func([]byte) error
	OnToolCall                                    func(context.Context, codexDynamicToolCall) (codexDynamicToolResult, error)
	OnEvent                                       func(map[string]any)
	RequestTimeout                                time.Duration
}
type codexAppServerSnapshot struct {
	AttemptID, ThreadID, TurnID, Status, FinalResponse, ProtocolIssue, FailureReason string
	HasFailedTools, HasSuccessfulTool, HasSuccessfulToolAfterFailure                 bool
	PendingCommands, PendingTools                                                    int
	InterruptRequested, Acknowledged, TurnStartSent, TransportClosed                 bool
}

func (s codexAppServerSnapshot) CancellationConfirmed(treeClean bool) bool {
	return treeClean && s.InterruptRequested && s.Acknowledged && s.Status == "interrupted" && s.ProtocolIssue == "" && s.PendingCommands == 0 && s.PendingTools == 0
}

// A Windows Job Object gives stronger ownership than a disappearing PID or an
// observed descendant list. This proof may settle cancellation without making
// up a missing command exit; it must never establish ordinary completion.
type codexOwnedJobStopProof struct{ RootExited, StdoutEOF, StderrEOF, ActiveProcessesZero bool }

func (s codexAppServerSnapshot) CancellationConfirmedForOwnedJob(proof codexOwnedJobStopProof) bool {
	return proof.RootExited && proof.StdoutEOF && proof.StderrEOF && proof.ActiveProcessesZero && s.InterruptRequested && s.Acknowledged && s.Status == "interrupted" && s.ProtocolIssue == ""
}
func (s codexAppServerSnapshot) CanCompleteNormally(treeClean bool, exitCode int) bool {
	if !treeClean || exitCode != 0 || !s.TurnStartSent || s.Status != "completed" || s.InterruptRequested || s.ProtocolIssue != "" || s.FailureReason != "" || s.PendingCommands != 0 || s.PendingTools != 0 {
		return false
	}
	verified, response := codexLocalResult(s.FinalResponse)
	if response == "" || verified == "INCOMPLETE" {
		return false
	}
	if s.HasFailedTools {
		return s.HasSuccessfulToolAfterFailure && verified == "VERIFIED"
	}
	return verified == "" || s.HasSuccessfulTool
}
func codexLocalResult(text string) (string, string) {
	text = strings.TrimSpace(text)
	first, rest, _ := strings.Cut(text, "\n")
	if strings.TrimSpace(first) == "ONE_LOCAL_RESULT_V1 VERIFIED" {
		return "VERIFIED", strings.TrimSpace(rest)
	}
	if strings.TrimSpace(first) == "ONE_LOCAL_RESULT_V1 INCOMPLETE" {
		return "INCOMPLETE", strings.TrimSpace(rest)
	}
	return "", text
}

type codexRPCReply struct {
	value map[string]any
	err   error
}
type codexCommandState struct{ started, terminal, valid, interruptedCandidate bool }
type codexToolPending struct {
	digest   string
	requests []json.RawMessage
	result   *codexDynamicToolResult
}
type codexAppServer struct {
	mu                  sync.Mutex
	config              codexAppServerConfig
	sequence            int
	pending             map[string]chan codexRPCReply
	state               codexAppServerSnapshot
	started             bool
	early               []json.RawMessage
	earlyBytes          int
	commands            map[string]codexCommandState
	itemTypes           map[string]string
	completed           map[string]bool
	tools               map[string]bool
	toolCalls           map[string]*codexToolPending
	changed             chan struct{}
	toolContext         context.Context
	cancelTools         context.CancelFunc
	interruptRPCStarted bool
}

var codexProtocolID = regexp.MustCompile(`^[a-zA-Z0-9_:.\-/]{1,256}$`)
var codexToolName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var errCodexProtocol = errors.New("本机执行器返回的记录无法对应本轮任务，请查看原任务记录")

func newCodexAppServer(config codexAppServerConfig) (*codexAppServer, error) {
	if !codexProtocolID.MatchString(config.AttemptID) || !filepath.IsAbs(config.CWD) || filepath.Clean(config.CWD) != config.CWD || strings.ContainsRune(config.CWD, 0) || config.SendLine == nil || len(config.Tools) > 32 || config.ResumeThreadID != "" && !codexProtocolID.MatchString(config.ResumeThreadID) {
		return nil, errCodexProtocol
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.PermissionProfile != "" && !codexToolName.MatchString(config.PermissionProfile) {
		return nil, errCodexProtocol
	}
	names := map[string]bool{}
	for _, tool := range config.Tools {
		bytes, err := json.Marshal(tool.InputSchema)
		if !codexToolName.MatchString(tool.Name) || names[tool.Name] || len(tool.Description) == 0 || len(tool.Description) > 8000 || tool.InputSchema == nil || err != nil || len(bytes) > 64*1024 || config.OnToolCall == nil {
			return nil, errCodexProtocol
		}
		names[tool.Name] = true
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &codexAppServer{config: config, pending: map[string]chan codexRPCReply{}, state: codexAppServerSnapshot{AttemptID: config.AttemptID}, commands: map[string]codexCommandState{}, itemTypes: map[string]string{}, completed: map[string]bool{}, tools: map[string]bool{}, toolCalls: map[string]*codexToolPending{}, changed: make(chan struct{}), toolContext: ctx, cancelTools: cancel}, nil
}
func (c *codexAppServer) notifyLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}
func (c *codexAppServer) poisonLocked(reason string) {
	if c.state.ProtocolIssue == "" {
		c.state.ProtocolIssue = reason
	}
	c.notifyLocked()
}
func (c *codexAppServer) emit(event map[string]any) {
	if c.config.OnEvent != nil {
		c.config.OnEvent(event)
	}
}
func (c *codexAppServer) send(value any) error {
	bytes, err := json.Marshal(value)
	if err != nil || len(bytes) > 2*1024*1024 {
		return errCodexProtocol
	}
	return c.config.SendLine(append(bytes, '\n'))
}
func (c *codexAppServer) request(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, c.config.RequestTimeout)
	defer cancel()
	c.mu.Lock()
	if c.state.TransportClosed {
		c.mu.Unlock()
		return nil, errors.New("本机执行连接已结束")
	}
	c.sequence++
	id := fmt.Sprintf("one_request_%d", c.sequence)
	keyBytes, _ := json.Marshal(id)
	key := string(keyBytes)
	reply := make(chan codexRPCReply, 1)
	c.pending[key] = reply
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, key); c.mu.Unlock() }()
	if err := c.send(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case got := <-reply:
		return got.value, got.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (c *codexAppServer) mayStart() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.InterruptRequested || c.state.TransportClosed || c.state.ProtocolIssue != "" {
		return errCodexProtocol
	}
	return nil
}
func (c *codexAppServer) Start(ctx context.Context, instruction string) (codexTurnIdentity, error) {
	c.mu.Lock()
	if c.started {
		c.mu.Unlock()
		return codexTurnIdentity{}, errors.New("这轮任务已经发送，不会重复执行")
	}
	c.started = true
	c.mu.Unlock()
	if err := c.mayStart(); err != nil {
		return codexTurnIdentity{}, err
	}
	_, err := c.request(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "one_launcher", "title": "ONE", "version": c.config.ClientVersion}, "capabilities": map[string]any{"experimentalApi": len(c.config.Tools) > 0}})
	if err != nil {
		return codexTurnIdentity{}, err
	}
	if err = c.mayStart(); err != nil {
		return codexTurnIdentity{}, err
	}
	if err = c.send(map[string]any{"method": "initialized"}); err != nil {
		return codexTurnIdentity{}, err
	}
	method := "thread/start"
	params := map[string]any{"model": "one-executor", "cwd": c.config.CWD, "approvalPolicy": "never", "sandbox": "workspace-write"}
	if c.config.PermissionProfile != "" {
		delete(params, "sandbox")
		params["permissions"] = c.config.PermissionProfile
	}
	if c.config.ResumeThreadID != "" {
		method = "thread/resume"
		params["threadId"] = c.config.ResumeThreadID
		params["excludeTurns"] = true
	} else if len(c.config.Tools) > 0 {
		defs := []map[string]any{}
		for _, t := range c.config.Tools {
			defs = append(defs, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "inputSchema": t.InputSchema})
		}
		params["dynamicTools"] = defs
	}
	if err = c.mayStart(); err != nil {
		return codexTurnIdentity{}, err
	}
	reply, err := c.request(ctx, method, params)
	if err != nil {
		return codexTurnIdentity{}, err
	}
	if c.config.PermissionProfile != "" && codexString(codexMap(reply["activePermissionProfile"])["id"]) != c.config.PermissionProfile {
		c.mu.Lock()
		c.poisonLocked("permission_profile_mismatch")
		c.mu.Unlock()
		return codexTurnIdentity{}, errors.New("本机访问范围尚未被执行器确认，本轮没有开始操作")
	}
	thread := codexMap(reply["thread"])
	id := codexString(thread["id"])
	if !codexProtocolID.MatchString(id) || c.config.ResumeThreadID != "" && id != c.config.ResumeThreadID {
		return codexTurnIdentity{}, errCodexProtocol
	}
	c.mu.Lock()
	c.state.ThreadID = id
	c.mu.Unlock()
	c.emit(map[string]any{"type": "thread.started", "thread_id": id})
	c.mu.Lock()
	// Cancellation and admission of the first model turn are one decision.
	// Otherwise Stop could report "not sent" immediately before this write.
	if c.state.InterruptRequested || c.state.TransportClosed || c.state.ProtocolIssue != "" {
		c.mu.Unlock()
		return codexTurnIdentity{}, errCodexProtocol
	}
	c.state.TurnStartSent = true
	c.mu.Unlock()
	turnParams := map[string]any{"threadId": id, "model": "one-executor", "cwd": c.config.CWD, "approvalPolicy": "never", "input": []any{map[string]any{"type": "text", "text": instruction, "text_elements": []any{}}}, "sandboxPolicy": map[string]any{"type": "workspaceWrite", "writableRoots": []string{c.config.CWD}, "networkAccess": false, "excludeTmpdirEnvVar": true, "excludeSlashTmp": true}}
	if c.config.PermissionProfile != "" {
		delete(turnParams, "sandboxPolicy")
		turnParams["permissions"] = c.config.PermissionProfile
	}
	reply, err = c.request(ctx, "turn/start", turnParams)
	if err != nil {
		return codexTurnIdentity{}, err
	}
	turn := codexMap(reply["turn"])
	turnID := codexString(turn["id"])
	if !codexProtocolID.MatchString(turnID) || codexString(turn["status"]) != "inProgress" {
		return codexTurnIdentity{}, errCodexProtocol
	}
	c.mu.Lock()
	c.state.TurnID = turnID
	c.state.Status = "inProgress"
	c.notifyLocked()
	early := c.early
	c.early = nil
	c.earlyBytes = 0
	c.mu.Unlock()
	for _, frame := range early {
		c.Receive(frame)
	}
	return codexTurnIdentity{c.config.AttemptID, id, turnID}, nil
}
func codexMap(value any) map[string]any { object, _ := value.(map[string]any); return object }
func codexString(value any) string      { text, _ := value.(string); return text }
func (c *codexAppServer) Receive(line []byte) {
	if len(line) > 2*1024*1024 {
		c.mu.Lock()
		c.poisonLocked("oversized_frame")
		c.mu.Unlock()
		return
	}
	var frame struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
		Result map[string]any  `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if json.Unmarshal(line, &frame) != nil {
		c.mu.Lock()
		c.poisonLocked("malformed_frame")
		c.mu.Unlock()
		return
	}
	c.mu.Lock()
	if c.state.TransportClosed {
		c.mu.Unlock()
		return
	}
	if frame.Method == "" && len(frame.ID) > 0 {
		pending := c.pending[string(frame.ID)]
		c.mu.Unlock()
		if pending != nil {
			reply := codexRPCReply{value: frame.Result}
			if len(frame.Error) > 0 && string(frame.Error) != "null" {
				reply.err = errors.New("本机执行器没有接受本轮请求")
			}
			select {
			case pending <- reply:
			default:
			}
		}
		return
	}
	if c.state.TurnStartSent && c.state.TurnID == "" && codexString(frame.Params["threadId"]) == c.state.ThreadID {
		if len(c.early) >= 256 || c.earlyBytes+len(line) > 2*1024*1024 {
			c.poisonLocked("early_frame_limit")
		} else {
			c.early = append(c.early, append([]byte(nil), line...))
			c.earlyBytes += len(line)
		}
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	if len(frame.ID) > 0 && frame.Method != "" {
		if frame.Method == "item/tool/call" {
			c.dynamicTool(frame.ID, frame.Params)
			return
		}
		_ = c.send(map[string]any{"id": json.RawMessage(frame.ID), "error": map[string]any{"code": -32601, "message": "ONE does not grant this request"}})
		c.mu.Lock()
		c.poisonLocked("unsupported_approval_or_tool")
		c.mu.Unlock()
		go c.Interrupt(context.Background())
		return
	}
	c.notification(frame.Method, frame.Params)
}
func (c *codexAppServer) dynamicTool(requestID json.RawMessage, params map[string]any) {
	call := codexDynamicToolCall{ThreadID: codexString(params["threadId"]), TurnID: codexString(params["turnId"]), CallID: codexString(params["callId"]), Tool: codexString(params["tool"]), Arguments: codexMap(params["arguments"])}
	args, err := json.Marshal(call.Arguments)
	sum := sha256.Sum256(append([]byte(call.Tool+"\x00"), args...))
	digest := hex.EncodeToString(sum[:])
	c.mu.Lock()
	valid := c.state.Status == "inProgress" && !c.state.InterruptRequested && c.state.ProtocolIssue == "" && call.ThreadID == c.state.ThreadID && call.TurnID == c.state.TurnID && codexProtocolID.MatchString(call.CallID) && call.Arguments != nil && err == nil && len(args) <= 1024*1024 && (params["namespace"] == nil)
	declared := false
	for _, tool := range c.config.Tools {
		if tool.Name == call.Tool {
			declared = true
		}
	}
	if !valid || !declared {
		c.mu.Unlock()
		_ = c.sendToolResult(requestID, codexToolFailure("这项工具调用无法对应原任务，未执行。"))
		return
	}
	if prior := c.toolCalls[call.CallID]; prior != nil {
		if prior.digest != digest {
			c.poisonLocked("tool_call_changed")
			c.mu.Unlock()
			_ = c.sendToolResult(requestID, codexToolFailure("同一工具调用的参数发生变化，未重复执行。"))
			return
		}
		if prior.result != nil {
			saved := *prior.result
			c.mu.Unlock()
			_ = c.sendToolResult(requestID, saved)
			return
		}
		if len(prior.requests) >= 16 {
			c.poisonLocked("duplicate_tool_limit")
			c.mu.Unlock()
			return
		}
		prior.requests = append(prior.requests, append([]byte(nil), requestID...))
		c.mu.Unlock()
		return
	}
	if len(c.toolCalls) >= 256 {
		c.poisonLocked("tool_call_limit")
		c.mu.Unlock()
		_ = c.sendToolResult(requestID, codexToolFailure("本轮工具调用已达上限。"))
		return
	}
	c.toolCalls[call.CallID] = &codexToolPending{digest: digest, requests: []json.RawMessage{append([]byte(nil), requestID...)}}
	ctx := c.toolContext
	c.mu.Unlock()
	go func() {
		value, err := c.config.OnToolCall(ctx, call)
		if err != nil {
			value = codexToolFailure("工具回执暂时未确认，已有调用保留在原任务中。")
		}
		bytes, encodeErr := json.Marshal(value)
		valid := encodeErr == nil && len(bytes) <= 1536*1024 && len(value.ContentItems) > 0
		for _, item := range value.ContentItems {
			valid = valid && item.Type == "inputText"
		}
		if !valid {
			value = codexToolFailure("工具回执格式无法核对，请查看原任务记录。")
		}
		c.mu.Lock()
		prior := c.toolCalls[call.CallID]
		if prior == nil {
			c.mu.Unlock()
			return
		}
		prior.result = &value
		c.notifyLocked()
		if c.state.TransportClosed || c.state.InterruptRequested || c.state.Status != "inProgress" {
			c.mu.Unlock()
			return
		}
		requests := prior.requests
		prior.requests = nil
		c.mu.Unlock()
		for _, id := range requests {
			if c.sendToolResult(id, value) != nil {
				c.mu.Lock()
				c.poisonLocked("tool_result_delivery_failed")
				c.mu.Unlock()
				return
			}
		}
	}()
}
func codexToolFailure(text string) codexDynamicToolResult {
	return codexDynamicToolResult{ContentItems: []codexToolContent{{Type: "inputText", Text: text}}, Success: false}
}
func (c *codexAppServer) sendToolResult(id json.RawMessage, value codexDynamicToolResult) error {
	return c.send(map[string]any{"id": id, "result": value})
}
func (c *codexAppServer) recordToolLocked(success bool) {
	if success {
		c.state.HasSuccessfulTool = true
		if c.state.HasFailedTools {
			c.state.HasSuccessfulToolAfterFailure = true
		}
	} else {
		c.state.HasFailedTools = true
	}
}
func (c *codexAppServer) itemLocked(item map[string]any, event string) map[string]any {
	id, kind := codexString(item["id"]), codexString(item["type"])
	if !codexProtocolID.MatchString(id) || kind == "" {
		c.poisonLocked("malformed_item")
		return nil
	}
	if prior := c.itemTypes[id]; prior != "" && prior != kind {
		c.poisonLocked("item_type_changed")
		return nil
	}
	c.itemTypes[id] = kind
	if c.completed[id] {
		return nil
	}
	status := codexString(item["status"])
	switch kind {
	case "commandExecution":
		command := c.commands[id]
		if event == "item.started" {
			if status != "inProgress" {
				c.poisonLocked("malformed_command_start")
			} else {
				command.started = true
			}
		}
		if event == "item.completed" {
			command.terminal = true
			exit, hasExit := item["exitCode"].(float64)
			command.valid = command.started && hasExit && exit >= 0 && exit == float64(int(exit)) && (status == "completed" || status == "failed")
			command.interruptedCandidate = command.started && status == "failed" && (item["exitCode"] == nil || hasExit && exit == -1)
			c.recordToolLocked(command.valid && status == "completed" && exit == 0)
		}
		c.commands[id] = command
	case "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall":
		if event == "item.started" {
			c.tools[id] = true
		}
		if event == "item.completed" {
			if status != "completed" && status != "failed" && status != "declined" && status != "interrupted" {
				c.poisonLocked("malformed_tool_terminal")
				return nil
			}
			delete(c.tools, id)
			c.recordToolLocked(status == "completed" && item["success"] != false)
			if status == "declined" || status == "interrupted" {
				c.state.FailureReason = "tool_not_completed"
			}
		}
	case "agentMessage":
		if event == "item.completed" {
			text := codexString(item["text"])
			if len(text) > 480000 {
				c.poisonLocked("oversized_final_response")
				return nil
			}
			c.state.FinalResponse = text
		}
	case "userMessage", "hookPrompt", "functionCallOutput", "plan", "reasoning", "webSearch", "imageView", "enteredReviewMode", "exitedReviewMode", "contextCompaction":
	default:
		c.poisonLocked("unsupported_execution_item")
		return nil
	}
	if event == "item.completed" {
		c.completed[id] = true
	}
	names := map[string]string{"agentMessage": "agent_message", "commandExecution": "command_execution", "fileChange": "file_change", "mcpToolCall": "mcp_tool_call", "dynamicToolCall": "dynamic_tool_call", "reasoning": "reasoning", "webSearch": "web_search"}
	if names[kind] == "" {
		return nil
	}
	adapted := map[string]any{}
	for key, value := range item {
		adapted[key] = value
	}
	adapted["type"] = names[kind]
	if value, ok := adapted["exitCode"]; ok {
		adapted["exit_code"] = value
	}
	if value, ok := adapted["aggregatedOutput"]; ok {
		adapted["aggregated_output"] = value
	}
	return map[string]any{"type": event, "item": adapted}
}
func (c *codexAppServer) notification(method string, params map[string]any) {
	c.mu.Lock()
	if codexString(params["threadId"]) != c.state.ThreadID || c.state.ThreadID == "" {
		c.mu.Unlock()
		return
	}
	turnID := codexString(params["turnId"])
	if method == "turn/started" || method == "turn/completed" {
		turnID = codexString(codexMap(params["turn"])["id"])
	}
	if turnID != c.state.TurnID || turnID == "" {
		c.mu.Unlock()
		return
	}
	if c.state.Status == "interrupted" {
		item := codexMap(params["item"])
		id, kind := codexString(item["id"]), codexString(item["type"])
		if method == "item/completed" && c.itemTypes[id] == kind && (c.tools[id] || kind == "commandExecution" && c.commands[id].started) {
			c.itemLocked(item, "item.completed")
			c.notifyLocked()
		} else if (method == "item/started" || method == "item/completed") && (kind == "commandExecution" || kind == "fileChange" || kind == "dynamicToolCall" || kind == "mcpToolCall") && c.itemTypes[id] == "" {
			c.poisonLocked("uncorrelated_late_tool")
		}
		c.mu.Unlock()
		return
	}
	if c.state.Status != "inProgress" {
		c.mu.Unlock()
		return
	}
	events := []map[string]any{}
	switch method {
	case "turn/completed":
		turn := codexMap(params["turn"])
		status := codexString(turn["status"])
		items, ok := turn["items"].([]any)
		if !ok || (status != "completed" && status != "failed" && status != "interrupted") {
			c.poisonLocked("malformed_turn_terminal")
			break
		}
		for _, item := range items {
			if event := c.itemLocked(codexMap(item), "item.completed"); event != nil {
				events = append(events, event)
			}
		}
		c.state.Status = status
		if status == "failed" {
			c.recordToolLocked(false)
			events = append(events, map[string]any{"type": "turn.failed", "error": map[string]any{"message": "本轮执行没有完成，请查看已保留的工具记录。"}})
		}
		c.notifyLocked()
	case "item/started", "item/completed", "item/updated":
		if event := c.itemLocked(codexMap(params["item"]), strings.ReplaceAll(method, "/", ".")); event != nil {
			events = append(events, event)
		}
	case "item/commandExecution/outputDelta":
		id := codexString(params["itemId"])
		if !c.commands[id].started {
			c.poisonLocked("uncorrelated_command_output")
			break
		}
		text := codexString(params["delta"])
		if len(text) > 6000 {
			text = text[len(text)-6000:]
		}
		events = append(events, map[string]any{"type": "item.updated", "item": map[string]any{"id": id, "type": "command_execution", "status": "in_progress", "aggregated_output": text}})
	case "error":
		c.recordToolLocked(false)
		events = append(events, map[string]any{"type": "error", "message": "本机执行器返回错误，原任务和已有成果保留。"})
	}
	c.mu.Unlock()
	for _, event := range events {
		c.emit(event)
	}
}
func (c *codexAppServer) Snapshot() codexAppServerSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshotLocked()
}
func (c *codexAppServer) snapshotLocked() codexAppServerSnapshot {
	snapshot := c.state
	for _, command := range c.commands {
		resolvedByInterrupt := command.interruptedCandidate && snapshot.InterruptRequested && snapshot.Acknowledged && snapshot.Status == "interrupted"
		if !command.terminal || !command.valid && !resolvedByInterrupt {
			snapshot.PendingCommands++
		}
	}
	snapshot.PendingTools = len(c.tools)
	for _, call := range c.toolCalls {
		if call.result == nil {
			snapshot.PendingTools++
		}
	}
	return snapshot
}
func (c *codexAppServer) waitState() (codexAppServerSnapshot, <-chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshotLocked(), c.changed
}
func (c *codexAppServer) WaitTurnEnd(ctx context.Context) (string, error) {
	for {
		snapshot, changed := c.waitState()
		if snapshot.Status == "completed" || snapshot.Status == "failed" || snapshot.Status == "interrupted" {
			return snapshot.Status, nil
		}
		if snapshot.TransportClosed {
			return "", errors.New("本机执行连接已结束，原轮次结果待核对")
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-changed:
		}
	}
}
func (c *codexAppServer) Interrupt(ctx context.Context) bool {
	if _, bounded := ctx.Deadline(); !bounded {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
	}
	c.mu.Lock()
	c.state.InterruptRequested = true
	c.cancelTools()
	c.mu.Unlock()
	var thread, turn string
	for {
		c.mu.Lock()
		if !c.state.TurnStartSent {
			c.mu.Unlock()
			return true
		}
		if c.state.TransportClosed {
			c.mu.Unlock()
			return false
		}
		if c.interruptRPCStarted {
			c.mu.Unlock()
			return c.waitInterrupted(ctx)
		}
		thread, turn = c.state.ThreadID, c.state.TurnID
		if thread != "" && turn != "" {
			c.interruptRPCStarted = true
			c.mu.Unlock()
			break
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return false
		case <-changed:
		}
	}
	_, err := c.request(ctx, "turn/interrupt", map[string]any{"threadId": thread, "turnId": turn})
	if err != nil {
		// An interrupt is safe to repeat for the same immutable thread/turn.
		// A missing acknowledgement must not permanently disable Stop.
		c.mu.Lock()
		c.interruptRPCStarted = false
		c.notifyLocked()
		c.mu.Unlock()
		return false
	}
	c.mu.Lock()
	c.state.Acknowledged = true
	c.notifyLocked()
	c.mu.Unlock()
	return c.waitInterrupted(ctx)
}
func (c *codexAppServer) waitInterrupted(ctx context.Context) bool {
	for {
		snapshot, changed := c.waitState()
		if snapshot.Status == "interrupted" && snapshot.Acknowledged && snapshot.PendingCommands == 0 && snapshot.PendingTools == 0 {
			return snapshot.ProtocolIssue == ""
		}
		if snapshot.TransportClosed {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-changed:
		}
	}
}
func (c *codexAppServer) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.TransportClosed {
		return
	}
	c.state.TransportClosed = true
	c.cancelTools()
	for _, pending := range c.pending {
		select {
		case pending <- codexRPCReply{err: errors.New("本机执行连接已结束")}:
		default:
		}
	}
	c.notifyLocked()
}

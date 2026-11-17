package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func windowsCodexTestEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
}
func windowsCodexTestGateway() *windowsCodexGateway {
	return &windowsCodexGateway{BaseURL: "https://one.example/api/executor-gateway/v1", Token: strings.Repeat("A", 43), Model: "one-executor"}
}
func TestWindowsCodexLaunchKeepsPrivateHomeAndFreshBoundedScratch(t *testing.T) {
	windowsCodexTestEnvironment(t)
	t.Setenv("ONE_EXECUTOR_TOKEN", "stale-token")
	t.Setenv("OPENAI_API_KEY", "personal-key")
	t.Setenv("CODEX_HOME", "personal-home")
	t.Setenv("TMPDIR", "unrelated-temp")
	project := t.TempDir()
	executable := filepath.Join(t.TempDir(), "bin", "codex.exe")
	args, environment, home, profile, err := windowsCodexLaunch(windowsCodexTestGateway(), "device-a", "task-a", project, executable, true)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	scratch := windowsCodexScratch(environment)
	if scratch == "" || filepath.Dir(scratch) != home || !strings.HasPrefix(filepath.Base(scratch), "scratch-") {
		t.Fatal("scratch escaped private task home")
	}
	for _, pair := range environment {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		switch strings.ToUpper(key) {
		case "OPENAI_API_KEY":
			t.Fatal("personal model key inherited")
		case "CODEX_HOME":
			if value != home {
				t.Fatal("personal Codex home inherited")
			}
		case "TMP", "TEMP", "TMPDIR":
			if value != scratch {
				t.Fatal("temporary aliases disagree")
			}
		case "ONE_EXECUTOR_TOKEN":
			if value != windowsCodexTestGateway().Token {
				t.Fatal("old gateway token inherited")
			}
		}
	}
	all := strings.Join(args, "\n")
	for _, required := range []string{"windows.sandbox=\"mxc\"", "\":workspace_roots\"={\".\"=\"write\"}", "\":root\"=\"deny\"", "shell_environment_policy.include_only=", "features.multi_agent=false", "features.goals=false"} {
		if !strings.Contains(all, required) {
			t.Fatal("missing strict setting", required)
		}
	}
	for _, feature := range []string{"plugins", "plugin_hooks", "codex_hooks", "hooks", "apps"} {
		if !strings.Contains(all, "features."+feature+"=false") {
			t.Fatal("host extension remained enabled", feature)
		}
	}
	for directory := filepath.Clean(project); ; directory = filepath.Dir(directory) {
		if !strings.Contains(all, "projects."+strconv.Quote(directory)+".trust_level=\"untrusted\"") {
			t.Fatal("project ancestor could retain trusted startup configuration", directory)
		}
		if filepath.Dir(directory) == directory {
			break
		}
	}
	if !strings.HasPrefix(profile, "one-workspace-") {
		t.Fatal("permission profile was not generated")
	}
	_, secondEnvironment, secondHome, secondProfile, err := windowsCodexLaunch(windowsCodexTestGateway(), "device-a", "task-a", project, executable, true)
	if err != nil {
		t.Fatal(err)
	}
	if home != secondHome || scratch == windowsCodexScratch(secondEnvironment) || profile == secondProfile {
		t.Fatal("resume did not keep home with fresh process scope")
	}
	whitelist := ""
	for _, arg := range args {
		if strings.HasPrefix(arg, "shell_environment_policy.include_only=") {
			whitelist = arg
		}
	}
	if strings.Contains(whitelist, "ONE_EXECUTOR_TOKEN") || strings.Contains(whitelist, "API_KEY") {
		t.Fatal("model credential allowed in child shell")
	}
}
func TestWindowsCodexLaunchRejectsInvalidGatewayBeforeCreatingState(t *testing.T) {
	windowsCodexTestEnvironment(t)
	for _, change := range []func(*windowsCodexGateway){func(g *windowsCodexGateway) { g.BaseURL = "http://one.example/api/executor-gateway/v1" }, func(g *windowsCodexGateway) { g.Model = "other" }, func(g *windowsCodexGateway) { g.Token = "short" }, func(g *windowsCodexGateway) { g.BaseURL += "?token=untrusted" }} {
		gateway := windowsCodexTestGateway()
		change(gateway)
		if _, _, _, _, err := windowsCodexLaunch(gateway, "device", "task", t.TempDir(), "codex.exe", true); err == nil {
			t.Fatal("invalid gateway accepted")
		}
	}
}
func TestWindowsCodexAdmissionCannotReplaceAuthenticatedOwner(t *testing.T) {
	windowsCodexTestEnvironment(t)
	owner := codexExecutionOwner{WorkspaceID: "workspace-a", UserID: "user-a"}
	other := codexExecutionOwner{WorkspaceID: "workspace-b", UserID: "user-b"}
	journal := &codexReceiptJournal{root: filepath.Join(t.TempDir(), "uncreated"), replace: os.Rename}
	host := &windowsCodexHost{owner: owner, deviceID: "device-a", journal: journal}
	host.start(socketMessage{Type: "execution_start", Owner: &other, TaskID: "task-a", AttemptID: "attempt-a", Round: 1, Instruction: "synthetic"})
	if host.owner != owner || host.active != nil {
		t.Fatal("untrusted task changed local execution identity")
	}
	if _, err := os.Stat(journal.root); !os.IsNotExist(err) {
		t.Fatal("mismatched owner reserved an execution", err)
	}
}
func TestWindowsCodexToolReplyRequiresEveryExecutionAndCallIdentity(t *testing.T) {
	id := receiptTestID()
	pending := &windowsCodexPendingTool{identity: id, threadID: "thread-a", turnID: "turn-a", callID: "call-a", result: make(chan codexDynamicToolResult, 1)}
	host := &windowsCodexHost{owner: codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}, active: &windowsCodexRun{identity: id}, tools: map[string]*windowsCodexPendingTool{"request-a": pending}}
	original := socketMessage{TaskID: id.TaskID, Round: id.Round, AttemptID: id.AttemptID, RequestID: "request-a", ThreadID: "thread-a", TurnID: "turn-a", CallID: "call-a", Success: true, ContentItems: []codexToolContent{{Type: "inputText", Text: "synthetic result"}}}
	for _, change := range []func(*socketMessage){func(m *socketMessage) { m.TaskID = "other" }, func(m *socketMessage) { m.Round++ }, func(m *socketMessage) { m.AttemptID = "other" }, func(m *socketMessage) { m.RequestID = "other" }, func(m *socketMessage) { m.ThreadID = "other" }, func(m *socketMessage) { m.TurnID = "other" }, func(m *socketMessage) { m.CallID = "other" }, func(m *socketMessage) { m.ContentItems = []codexToolContent{{Type: "inputImage", Text: "bad"}} }} {
		invalid := original
		change(&invalid)
		host.acceptToolResult(invalid)
		select {
		case <-pending.result:
			t.Fatal("mismatched result reached active tool")
		default:
		}
	}
	host.acceptToolResult(original)
	select {
	case result := <-pending.result:
		if !result.Success || result.ContentItems[0].Text != "synthetic result" {
			t.Fatal("tool result changed")
		}
	default:
		t.Fatal("valid tool result was rejected")
	}
	host.owner = codexExecutionOwner{WorkspaceID: "workspace-b", UserID: "user-b"}
	host.acceptToolResult(original)
	select {
	case <-pending.result:
		t.Fatal("old owner result reached a new authenticated owner")
	default:
	}
	if _, err := host.callTool(context.Background(), id, codexDynamicToolCall{ThreadID: "thread-a", TurnID: "turn-a", CallID: "call-b", Tool: "one_read", Arguments: map[string]any{}}); err == nil {
		t.Fatal("old owner callback started on the new connection")
	}
}

func TestWindowsCodexDeliveryCannotUseAnotherOwnersSocket(t *testing.T) {
	id := receiptTestID()
	owner := codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}
	other := codexExecutionOwner{WorkspaceID: "workspace-b", UserID: "user-b"}
	// An unbound writer must never be touched by either rejected delivery.
	host := &windowsCodexHost{owner: owner, writerOwner: other, writer: &socketWriter{}}
	if err := host.sendOwned(id, map[string]any{"private": "synthetic"}); err == nil {
		t.Fatal("new owner used the previous owner's connection")
	}
	host.writerOwner = owner
	host.owner = other
	if err := host.sendOwned(id, map[string]any{"private": "synthetic"}); err == nil {
		t.Fatal("old owner delivered through the new owner's connection")
	}
}

func TestWindowsCodexPermissionProbeSelectsExactProfileAndManagedPolicy(t *testing.T) {
	windowsCodexTestEnvironment(t)
	inside := t.TempDir()
	command, home, err := windowsCodexPermissionCommand("codex.exe", inside, filepath.Join(filepath.Dir(inside), "outside.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	for i, arg := range command.Args {
		if arg != "sandbox" {
			continue
		}
		if len(command.Args) < i+7 || command.Args[i+1] != "--permission-profile" || !strings.HasPrefix(command.Args[i+2], "one-workspace-") || command.Args[i+3] != "--include-managed-config" || command.Args[i+4] != "--" || command.Args[i+5] != "powershell.exe" {
			t.Fatal("probe did not select the native strict permission profile")
		}
		return
	}
	t.Fatal("permission probe did not invoke Codex sandbox")
}

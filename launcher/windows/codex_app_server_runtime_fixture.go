//go:build one_protocol_fixture

package main

// Compile explicitly with codex_app_server.go for opt-in real-runtime protocol
// verification. The normal launcher and go test never include this entry point.
import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

func main() {
	if err := realCodexProtocolFixture(); err != nil {
		fmt.Fprintln(os.Stderr, "real protocol fixture:", err)
		os.Exit(1)
	}
}
func realCodexProtocolFixture() error {
	args := os.Args
	if len(args) != 6 && len(args) != 7 {
		return errors.New("expected executable endpoint project home marker [thread]")
	}
	executable, endpoint, project, home, marker := args[1], args[2], args[3], args[4], args[5]
	resume := ""
	if len(args) == 7 {
		resume = args[6]
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") || !filepath.IsAbs(project) || !strings.HasPrefix(filepath.Base(filepath.Dir(project)), "one-tool-bridge-") {
		return errors.New("isolated loopback fixture required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	settings := []string{`model="one-executor"`, `model_provider="one_fixture"`, `web_search="disabled"`, `model_providers.one_fixture.name="ONE fixture"`, `model_providers.one_fixture.base_url="` + endpoint + `"`, `model_providers.one_fixture.wire_api="responses"`, `model_providers.one_fixture.requires_openai_auth=false`, `model_providers.one_fixture.request_max_retries=0`, `model_providers.one_fixture.stream_max_retries=0`}
	if runtime.GOOS == "windows" {
		backend := os.Getenv("ONE_CODEX_WINDOWS_SANDBOX")
		if backend == "" {
			backend = "unelevated"
		}
		if backend != "unelevated" && backend != "mxc" {
			return errors.New("unsupported fixture sandbox backend")
		}
		settings = append(settings, `windows.sandbox="`+backend+`"`)
	}
	profile := os.Getenv("ONE_CODEX_PERMISSION_PROFILE")
	if profile != "" {
		if profile != "one-workspace" {
			return errors.New("unsupported fixture permission profile")
		}
		settings = append(settings, `default_permissions="one-workspace"`, `permissions.one-workspace.extends=":workspace"`,
			`permissions.one-workspace.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="write",":tmpdir"="deny",":slash_tmp"="deny"}`,
			`permissions.one-workspace.network.enabled=false`)
	}
	settings = append(settings, `features.multi_agent=false`, `features.goals=false`)
	commandArgs := []string{}
	for _, value := range settings {
		commandArgs = append(commandArgs, "-c", value)
	}
	commandArgs = append(commandArgs, "app-server", "--listen", "stdio://")
	command := exec.CommandContext(ctx, executable, commandArgs...)
	command.Dir = project
	command.Env = append(os.Environ(), "CODEX_HOME="+home)
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	errorOutput, err := command.StderrPipe()
	if err != nil {
		return err
	}
	var toolsMu, writeMu sync.Mutex
	calls := []string{}
	writes := 0
	schema := map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}
	saveSchema := map[string]any{"type": "object", "properties": map[string]any{"content": map[string]any{"type": "string"}}, "required": []string{"content"}, "additionalProperties": false}
	controller, err := newCodexAppServer(codexAppServerConfig{AttemptID: "attempt-go-fixture", CWD: project, ResumeThreadID: resume, PermissionProfile: profile, ClientVersion: "fixture", RequestTimeout: 10 * time.Second,
		Tools: []codexToolDefinition{{Name: "one_fixture_read", Description: "Read synthetic source", InputSchema: schema}, {Name: "one_fixture_save", Description: "Save synthetic result", InputSchema: saveSchema}},
		SendLine: func(line []byte) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			_, err := input.Write(line)
			return err
		},
		OnToolCall: func(_ context.Context, call codexDynamicToolCall) (codexDynamicToolResult, error) {
			toolsMu.Lock()
			defer toolsMu.Unlock()
			calls = append(calls, call.Tool)
			var result map[string]any
			switch call.Tool {
			case "one_fixture_read":
				result = map[string]any{"source": "synthetic", "content": marker}
			case "one_fixture_save":
				if call.Arguments["content"] != marker {
					return codexDynamicToolResult{}, errors.New("wrong marker")
				}
				file, err := os.OpenFile(filepath.Join(project, "result.txt"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err != nil {
					return codexDynamicToolResult{}, err
				}
				_, err = file.WriteString(marker)
				file.Close()
				if err != nil {
					return codexDynamicToolResult{}, err
				}
				writes++
				result = map[string]any{"saved": true, "artifactRef": "fixture_artifact", "deliveryId": "fixture_delivery"}
			default:
				return codexDynamicToolResult{}, errors.New("unknown tool")
			}
			bytes, _ := json.Marshal(result)
			return codexDynamicToolResult{ContentItems: []codexToolContent{{Type: "inputText", Text: string(bytes)}}, Success: true}, nil
		}})
	if err != nil {
		return err
	}
	defer controller.Close()
	if err = command.Start(); err != nil {
		return err
	}
	defer func() {
		input.Close()
		if command.ProcessState == nil {
			command.Process.Kill()
		}
	}()
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
		for scanner.Scan() {
			controller.Receive(scanner.Bytes())
		}
		controller.Close()
	}()
	go func() { defer readers.Done(); _, _ = io.Copy(io.Discard, errorOutput) }()
	identity, err := controller.Start(ctx, "Read the synthetic source, save it using the provided tools, then report completion.")
	if err != nil {
		return err
	}
	status, err := controller.WaitTurnEnd(ctx)
	if err != nil || status != "completed" {
		return fmt.Errorf("turn status=%s: %w", status, err)
	}
	input.Close()
	readers.Wait()
	if err = command.Wait(); err != nil {
		return err
	}
	snapshot := controller.Snapshot()
	if !snapshot.CanCompleteNormally(true, 0) || !strings.Contains(snapshot.FinalResponse, marker) {
		return fmt.Errorf("controller rejected actual runtime terminal: %+v", snapshot)
	}
	expected := []string{"one_fixture_read", "one_fixture_save"}
	expectedWrites := 1
	if resume != "" {
		expected = []string{"one_fixture_read"}
		expectedWrites = 0
	}
	toolsMu.Lock()
	defer toolsMu.Unlock()
	if strings.Join(calls, ",") != strings.Join(expected, ",") || writes != expectedWrites || resume != "" && identity.ThreadID != resume {
		return errors.New("callback/write/thread mismatch")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"passed": true, "controller": "production Go", "writes": writes, "toolCallbacks": calls, "threadId": identity.ThreadID, "turnId": identity.TurnID, "canCompleteNormally": true, "processExitCode": 0})
}

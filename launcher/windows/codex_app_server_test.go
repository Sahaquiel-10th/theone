package main

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

type codexProtocolFixture struct {
	c                  *codexAppServer
	sent               chan map[string]any
	beforeTurn         func()
	beforeThread       func()
	skipInterruptReply func() bool
}

func newCodexProtocolFixture(t *testing.T, callback func(context.Context, codexDynamicToolCall) (codexDynamicToolResult, error)) *codexProtocolFixture {
	t.Helper()
	f := &codexProtocolFixture{sent: make(chan map[string]any, 128)}
	tools := []codexToolDefinition{}
	if callback != nil {
		tools = append(tools, codexToolDefinition{Name: "one_fixture", Description: "Synthetic fixture", InputSchema: map[string]any{"type": "object", "properties": map[string]any{}}})
	}
	controller, err := newCodexAppServer(codexAppServerConfig{AttemptID: "attempt-fixture", CWD: t.TempDir(), ClientVersion: "fixture", Tools: tools, RequestTimeout: time.Second, OnToolCall: callback, SendLine: func(line []byte) error {
		var frame map[string]any
		if err := json.Unmarshal(line, &frame); err != nil {
			return err
		}
		f.sent <- frame
		method := codexString(frame["method"])
		var reply map[string]any
		switch method {
		case "initialize":
			reply = map[string]any{}
		case "thread/start", "thread/resume":
			if f.beforeThread != nil {
				f.beforeThread()
			}
			reply = map[string]any{"thread": map[string]any{"id": "thread-fixture"}}
		case "turn/start":
			if f.beforeTurn != nil {
				f.beforeTurn()
			}
			reply = map[string]any{"turn": map[string]any{"id": "turn-fixture", "status": "inProgress"}}
		case "turn/interrupt":
			if f.skipInterruptReply != nil && f.skipInterruptReply() {
				return nil
			}
			reply = map[string]any{}
		default:
			return nil
		}
		f.receive(map[string]any{"id": frame["id"], "result": reply})
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	f.c = controller
	t.Cleanup(controller.Close)
	return f
}
func (f *codexProtocolFixture) receive(frame map[string]any) {
	bytes, _ := json.Marshal(frame)
	f.c.Receive(bytes)
}
func (f *codexProtocolFixture) start(t *testing.T) {
	t.Helper()
	identity, err := f.c.Start(context.Background(), "Synthetic full instruction; do not truncate.")
	if err != nil || identity.ThreadID != "thread-fixture" || identity.TurnID != "turn-fixture" {
		t.Fatalf("start: %+v %v", identity, err)
	}
}
func (f *codexProtocolFixture) call(id, call string, args map[string]any) {
	f.receive(map[string]any{"id": id, "method": "item/tool/call", "params": map[string]any{"threadId": "thread-fixture", "turnId": "turn-fixture", "callId": call, "tool": "one_fixture", "arguments": args}})
}
func (f *codexProtocolFixture) item(event string, item map[string]any) {
	f.receive(map[string]any{"method": event, "params": map[string]any{"threadId": "thread-fixture", "turnId": "turn-fixture", "item": item}})
}
func (f *codexProtocolFixture) terminal(status string) {
	f.receive(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "thread-fixture", "turn": map[string]any{"id": "turn-fixture", "status": status, "items": []any{}}}})
}
func (f *codexProtocolFixture) reply(t *testing.T, id string) map[string]any {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case frame := <-f.sent:
			if frame["id"] == id && frame["method"] == nil {
				return codexMap(frame["result"])
			}
		case <-deadline.C:
			t.Fatalf("no reply for %s", id)
			return nil
		}
	}
}
func waitCodex(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("bounded fixture wait expired")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCodexDynamicToolEarlyAndDuplicateCallbacks(t *testing.T) {
	var invocations atomic.Int32
	gate := make(chan struct{})
	f := newCodexProtocolFixture(t, func(ctx context.Context, call codexDynamicToolCall) (codexDynamicToolResult, error) {
		invocations.Add(1)
		select {
		case <-gate:
		case <-ctx.Done():
			return codexDynamicToolResult{}, ctx.Err()
		}
		return codexDynamicToolResult{ContentItems: []codexToolContent{{Type: "inputText", Text: "persisted receipt"}}, Success: true}, nil
	})
	f.beforeTurn = func() {
		f.item("item/started", map[string]any{"id": "item-one", "type": "dynamicToolCall", "status": "inProgress"})
		f.call("rpc-a", "call-one", map[string]any{"b": 2, "a": 1})
	}
	f.start(t)
	waitCodex(t, func() bool { return invocations.Load() == 1 })
	f.call("rpc-b", "call-one", map[string]any{"a": 1, "b": 2})
	close(gate)
	if f.reply(t, "rpc-a")["success"] != true || f.reply(t, "rpc-b")["success"] != true {
		t.Fatal("same pending result not returned")
	}
	f.call("rpc-c", "call-one", map[string]any{"b": 2, "a": 1})
	if f.reply(t, "rpc-c")["success"] != true || invocations.Load() != 1 {
		t.Fatal("duplicate re-executed")
	}
	f.item("item/completed", map[string]any{"id": "item-one", "type": "dynamicToolCall", "status": "completed", "success": true})
	f.item("item/completed", map[string]any{"id": "answer", "type": "agentMessage", "text": "ONE_LOCAL_RESULT_V1 VERIFIED\nFixture done"})
	f.terminal("completed")
	if !f.c.Snapshot().CanCompleteNormally(true, 0) {
		t.Fatalf("completed tool rejected: %+v", f.c.Snapshot())
	}
}
func TestCodexToolForeignUnknownChangedAndMalformedInputs(t *testing.T) {
	var calls atomic.Int32
	f := newCodexProtocolFixture(t, func(context.Context, codexDynamicToolCall) (codexDynamicToolResult, error) {
		calls.Add(1)
		return codexDynamicToolResult{ContentItems: []codexToolContent{{Type: "inputText", Text: "saved"}}, Success: true}, nil
	})
	f.start(t)
	for _, change := range []map[string]any{{"threadId": "foreign"}, {"turnId": "foreign"}, {"tool": "unknown"}, {"namespace": "foreign"}, {"arguments": nil}} {
		params := map[string]any{"threadId": "thread-fixture", "turnId": "turn-fixture", "callId": "invalid-call", "tool": "one_fixture", "arguments": map[string]any{}}
		for k, v := range change {
			params[k] = v
		}
		f.receive(map[string]any{"id": "invalid-rpc", "method": "item/tool/call", "params": params})
		if f.reply(t, "invalid-rpc")["success"] != false {
			t.Fatal("foreign/unknown tool accepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("rejected calls invoked handler")
	}
	f.call("good-rpc", "good-call", map[string]any{"a": 1})
	f.reply(t, "good-rpc")
	f.call("changed-rpc", "good-call", map[string]any{"a": 2})
	if f.reply(t, "changed-rpc")["success"] != false || calls.Load() != 1 || f.c.Snapshot().ProtocolIssue != "tool_call_changed" {
		t.Fatal("changed call replay accepted")
	}
}
func TestCodexFailedToolRequiresRealRecoveryAndExplicitGoalVerification(t *testing.T) {
	for _, verified := range []bool{false, true} {
		f := newCodexProtocolFixture(t, nil)
		f.start(t)
		f.item("item/started", map[string]any{"id": "failed-tool", "type": "dynamicToolCall", "status": "inProgress"})
		f.item("item/completed", map[string]any{"id": "failed-tool", "type": "dynamicToolCall", "status": "completed", "success": false})
		f.item("item/started", map[string]any{"id": "recovered", "type": "fileChange", "status": "inProgress"})
		f.item("item/completed", map[string]any{"id": "recovered", "type": "fileChange", "status": "completed"})
		answer := "Fixture done"
		if verified {
			answer = "ONE_LOCAL_RESULT_V1 VERIFIED\n" + answer
		}
		f.item("item/completed", map[string]any{"id": "answer", "type": "agentMessage", "text": answer})
		f.terminal("completed")
		if f.c.Snapshot().CanCompleteNormally(true, 0) != verified {
			t.Fatalf("recovery ignored explicit verification: %+v", f.c.Snapshot())
		}
	}
}
func TestCodexCancellationWaitsForLateKnownToolAndBroadcastsAllWaiters(t *testing.T) {
	f := newCodexProtocolFixture(t, nil)
	f.start(t)
	f.item("item/started", map[string]any{"id": "pending", "type": "dynamicToolCall", "status": "inProgress"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	stopped := make(chan bool, 1)
	go func() { stopped <- f.c.Interrupt(ctx) }()
	waitCodex(t, func() bool { return f.c.Snapshot().Acknowledged })
	ended := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() { _, err := f.c.WaitTurnEnd(ctx); ended <- err }()
	}
	f.terminal("interrupted")
	for i := 0; i < 3; i++ {
		select {
		case err := <-ended:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("waiter missed terminal broadcast")
		}
	}
	select {
	case <-stopped:
		t.Fatal("cancel settled before pending tool terminal")
	default:
	}
	f.item("item/completed", map[string]any{"id": "pending", "type": "dynamicToolCall", "status": "interrupted", "success": false})
	if !<-stopped || !f.c.Snapshot().CancellationConfirmed(true) || f.c.Snapshot().CancellationConfirmed(false) {
		t.Fatalf("cancellation proof wrong: %+v", f.c.Snapshot())
	}
	f.item("item/started", map[string]any{"id": "unseen-late-command", "type": "commandExecution", "status": "inProgress"})
	if f.c.Snapshot().CancellationConfirmed(true) {
		t.Fatal("unknown late command trusted")
	}
}
func TestCodexUnknownCommandExitCannotBecomeNormalSuccess(t *testing.T) {
	for _, exit := range []any{nil, -1, 0} {
		f := newCodexProtocolFixture(t, nil)
		f.start(t)
		f.item("item/started", map[string]any{"id": "command", "type": "commandExecution", "status": "inProgress"})
		f.item("item/completed", map[string]any{"id": "command", "type": "commandExecution", "status": "completed", "exitCode": exit})
		f.item("item/completed", map[string]any{"id": "answer", "type": "agentMessage", "text": "ONE_LOCAL_RESULT_V1 VERIFIED\nDone"})
		f.terminal("completed")
		if f.c.Snapshot().CanCompleteNormally(true, 0) != (exit == 0) {
			t.Fatalf("unknown command exit accepted: %+v", f.c.Snapshot())
		}
	}
}
func TestCodexInterruptedUnknownExitNeedsOfficialTurnAckAndCleanup(t *testing.T) {
	f := newCodexProtocolFixture(t, nil)
	f.start(t)
	f.item("item/started", map[string]any{"id": "command", "type": "commandExecution", "status": "inProgress"})
	f.item("item/completed", map[string]any{"id": "command", "type": "commandExecution", "status": "failed", "exitCode": nil})
	if f.c.Snapshot().PendingCommands != 1 {
		t.Fatal("unknown command exit prematurely resolved")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan bool, 1)
	go func() { done <- f.c.Interrupt(ctx) }()
	waitCodex(t, func() bool { return f.c.Snapshot().Acknowledged })
	f.terminal("interrupted")
	if !<-done || !f.c.Snapshot().CancellationConfirmed(true) || f.c.Snapshot().CanCompleteNormally(true, 0) {
		t.Fatal("interrupted candidate became success or failed to settle")
	}
}
func TestCodexCloseAndTimeoutNeverConfirmCompletion(t *testing.T) {
	f := newCodexProtocolFixture(t, nil)
	f.start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := f.c.WaitTurnEnd(ctx); err == nil {
		t.Fatal("missing terminal did not timeout")
	}
	f.c.Close()
	if f.c.Snapshot().CanCompleteNormally(true, 0) || f.c.Snapshot().CancellationConfirmed(true) {
		t.Fatal("EOF alone confirmed execution")
	}
}

func TestCodexStopBeforeTurnAdmissionPreventsModelTurn(t *testing.T) {
	f := newCodexProtocolFixture(t, nil)
	f.beforeThread = func() {
		if !f.c.Interrupt(context.Background()) {
			t.Error("prepared-only stop not accepted")
		}
	}
	if _, err := f.c.Start(context.Background(), "must not be sent"); err == nil {
		t.Fatal("cancelled start accepted")
	}
	if f.c.Snapshot().TurnStartSent {
		t.Fatal("turn admitted after prepared-only Stop")
	}
	for len(f.sent) > 0 {
		if codexString((<-f.sent)["method"]) == "turn/start" {
			t.Fatal("turn sent after Stop")
		}
	}
}

func TestCodexLostInterruptAckCanBeRequestedAgainForSameTurn(t *testing.T) {
	f := newCodexProtocolFixture(t, nil)
	f.start(t)
	f.c.config.RequestTimeout = 10 * time.Millisecond
	var attempts atomic.Int32
	f.skipInterruptReply = func() bool { return attempts.Add(1) == 1 }
	if f.c.Interrupt(context.Background()) {
		t.Fatal("lost ACK confirmed cancellation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan bool, 1)
	go func() { done <- f.c.Interrupt(ctx) }()
	waitCodex(t, func() bool { return f.c.Snapshot().Acknowledged })
	f.terminal("interrupted")
	if !<-done || attempts.Load() != 2 || !f.c.Snapshot().CancellationConfirmed(true) {
		t.Fatal("same-turn Stop could not recover missing ACK")
	}
}

func TestCodexOwnedJobProofCanSettleOnlyCancellationWithMissingCommandTerminal(t *testing.T) {
	s := codexAppServerSnapshot{TurnStartSent: true, Status: "interrupted", InterruptRequested: true, Acknowledged: true, PendingCommands: 1, PendingTools: 1}
	proof := codexOwnedJobStopProof{RootExited: true, StdoutEOF: true, StderrEOF: true, ActiveProcessesZero: true}
	if !s.CancellationConfirmedForOwnedJob(proof) || s.CanCompleteNormally(true, 0) {
		t.Fatal("strong owned-job proof should settle only cancellation")
	}
	for i := 0; i < 4; i++ {
		p := proof
		switch i {
		case 0:
			p.RootExited = false
		case 1:
			p.StdoutEOF = false
		case 2:
			p.StderrEOF = false
		case 3:
			p.ActiveProcessesZero = false
		}
		if s.CancellationConfirmedForOwnedJob(p) {
			t.Fatal("partial native proof accepted")
		}
	}
	s.Acknowledged = false
	if s.CancellationConfirmedForOwnedJob(proof) {
		t.Fatal("native cleanup replaced missing official ACK")
	}
	s.Acknowledged = true
	s.ProtocolIssue = "uncorrelated_late_tool"
	if s.CancellationConfirmedForOwnedJob(proof) {
		t.Fatal("protocol conflict bypassed")
	}
}

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func receiptTestID() codexReceiptIdentity {
	return codexReceiptIdentity{WorkspaceID: "workspace-a", UserID: "user-a", DeviceID: "device-a", InstallationID: "installation-a", AttemptID: "attempt-a", TaskID: "task-a", Round: 2}
}
func receiptTestJournal(t *testing.T) *codexReceiptJournal {
	t.Helper()
	return &codexReceiptJournal{root: filepath.Join(managedTestRoot(t), "receipts"), replace: os.Rename}
}
func receiptTestReserve(t *testing.T, journal *codexReceiptJournal, id codexReceiptIdentity) {
	t.Helper()
	existing, err := journal.reserve(id, "synthetic-output.xlsx")
	if err != nil || existing != nil {
		t.Fatal("first reservation failed", existing, err)
	}
}

func TestCodexReceiptExactIdentitySeparatesEveryOwnerAndExecutionField(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	identities := []codexReceiptIdentity{id}
	for _, change := range []func(*codexReceiptIdentity){func(i *codexReceiptIdentity) { i.WorkspaceID = "workspace-b" }, func(i *codexReceiptIdentity) { i.UserID = "user-b" }, func(i *codexReceiptIdentity) { i.DeviceID = "device-b" }, func(i *codexReceiptIdentity) { i.InstallationID = "installation-b" }, func(i *codexReceiptIdentity) { i.AttemptID = "attempt-b" }, func(i *codexReceiptIdentity) { i.TaskID = "task-b" }, func(i *codexReceiptIdentity) { i.Round++ }} {
		other := id
		change(&other)
		identities = append(identities, other)
	}
	keys := map[string]bool{}
	for _, identity := range identities {
		if keys[identity.key()] {
			t.Fatal("identity collision", identity)
		}
		keys[identity.key()] = true
		receiptTestReserve(t, journal, identity)
		receipt := newCodexTerminalReceipt(identity, "completed", "synthetic result", "", "synthetic-output.xlsx", "thread-a")
		if _, err := journal.complete(receipt); err != nil {
			t.Fatal(err)
		}
	}
	owner := codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}
	pending, err := journal.pending(owner, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(pending) != 4 {
		t.Fatal("owner filtering lost exact attempt/task/round records", len(pending), err)
	}
	for _, receipt := range pending {
		if receipt.WorkspaceID != id.WorkspaceID || receipt.UserID != id.UserID || receipt.DeviceID != id.DeviceID || receipt.InstallationID != id.InstallationID {
			t.Fatal("another owner receipt leaked", receipt)
		}
	}
	other := id
	other.Round = -1
	if _, err := journal.reserve(other, ""); err == nil {
		t.Fatal("invalid negative round accepted")
	}
	other = id
	other.TaskID = "bad\x00task"
	if _, err := journal.reserve(other, ""); err == nil {
		t.Fatal("invalid identifier accepted")
	}
}

func TestCodexReceiptLostACKAndRestartReplaySameHashWithoutRerunning(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	runs := 0
	entry, err := journal.reserve(id, "output.xlsx")
	if err != nil || entry != nil {
		t.Fatal(entry, err)
	}
	runs++
	if err := journal.thread(id, "thread-original"); err != nil {
		t.Fatal(err)
	}
	receipt := newCodexTerminalReceipt(id, "completed", "完整成果已经保留", "", "output.xlsx", "thread-original")
	saved, err := journal.complete(receipt)
	if err != nil {
		t.Fatal(err)
	}
	owner := codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}
	for restart := 0; restart < 3; restart++ {
		journal = &codexReceiptJournal{root: journal.root, replace: os.Rename}
		entry, err = journal.reserve(id, "output.xlsx")
		if err != nil || entry == nil || entry.Receipt == nil {
			t.Fatal("restart forgot completed execution", entry, err)
		}
		if entry == nil {
			runs++
		}
		pending, err := journal.pending(owner, id.DeviceID, id.InstallationID, nil)
		if err != nil || len(pending) != 1 || pending[0].ReceiptHash != saved.ReceiptHash || pending[0].ReceiptID != saved.ReceiptID {
			t.Fatal("ACK loss changed original receipt", pending, err)
		}
	}
	if runs != 1 {
		t.Fatal("original execution reran", runs)
	}
	for _, ack := range []struct {
		id, hash string
		accepted bool
	}{{"wrong", saved.ReceiptHash, true}, {saved.ReceiptID, "wrong", true}, {saved.ReceiptID, saved.ReceiptHash, false}} {
		if err := journal.acknowledge(id, ack.id, ack.hash, ack.accepted); err == nil {
			t.Fatal("unmatched ACK accepted")
		}
	}
	wrong := id
	wrong.Round++
	if err := journal.acknowledge(wrong, saved.ReceiptID, saved.ReceiptHash, true); err == nil {
		t.Fatal("different round ACK accepted")
	}
	if err := journal.acknowledge(id, saved.ReceiptID, saved.ReceiptHash, true); err != nil {
		t.Fatal(err)
	}
	pending, err := journal.pending(owner, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(pending) != 0 {
		t.Fatal("acknowledged receipt replayed", pending, err)
	}
	existing, err := journal.reserve(id, "output.xlsx")
	if err != nil || existing == nil || !existing.Acknowledged {
		t.Fatal("ACK cleanup allowed execution to rerun", existing, err)
	}
}

func TestCodexReceiptAnInterruptedReservationReturnsStableFailureAndOriginalThread(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	receiptTestReserve(t, journal, id)
	if err := journal.thread(id, "thread-before-exit"); err != nil {
		t.Fatal(err)
	}
	owner := codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}
	pending, err := journal.pending(owner, id.DeviceID, id.InstallationID, map[string]bool{id.AttemptID: true})
	if err != nil || len(pending) != 0 {
		t.Fatal("running attempt declared interrupted", pending, err)
	}
	journal = &codexReceiptJournal{root: journal.root, replace: os.Rename}
	pending, err = journal.pending(owner, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(pending) != 1 || pending[0].Outcome != "failed" || pending[0].Error != "launcher_interrupted" || pending[0].ProviderThreadID != "thread-before-exit" {
		t.Fatal("interrupted original identity lost", pending, err)
	}
	again, err := journal.pending(owner, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(again) != 1 || again[0].ReceiptHash != pending[0].ReceiptHash {
		t.Fatal("interruption receipt regenerated", again, err)
	}
	existing, err := journal.reserve(id, "output.xlsx")
	if err != nil || existing == nil || existing.Receipt == nil {
		t.Fatal("uncertain original became a new execution", existing, err)
	}
}

func TestCodexReceiptFirstTerminalResultWinsAndTamperingIsRejected(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	receiptTestReserve(t, journal, id)
	first := newCodexTerminalReceipt(id, "completed", "first result", "", "output.xlsx", "thread-a")
	if _, err := journal.complete(first); err != nil {
		t.Fatal(err)
	}
	later := newCodexTerminalReceipt(id, "failed", "late failure", "late", "output.xlsx", "thread-a")
	actual, err := journal.complete(later)
	if err != nil || actual.ReceiptHash != first.ReceiptHash || actual.Outcome != "completed" {
		t.Fatal("late terminal event replaced original result", actual, err)
	}
	data, err := os.ReadFile(journal.filename(id))
	if err != nil {
		t.Fatal(err)
	}
	var entry codexReceiptEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		t.Fatal(err)
	}
	entry.Receipt.FinalResponse = "tampered result"
	data, _ = json.Marshal(entry)
	if err := os.WriteFile(journal.filename(id), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.read(id); err == nil {
		t.Fatal("altered result accepted without original hash")
	}
	if _, err := journal.pending(codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}, id.DeviceID, id.InstallationID, nil); err == nil {
		t.Fatal("corrupted result replayed")
	}
}

func TestCodexReceiptConcurrentReservationsAdmitOneExecution(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	var mutex sync.Mutex
	started := 0
	var wait sync.WaitGroup
	for i := 0; i < 12; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			entry, err := journal.reserve(id, "output.xlsx")
			if err != nil {
				t.Error(err)
				return
			}
			if entry == nil {
				mutex.Lock()
				started++
				mutex.Unlock()
			}
		}()
	}
	wait.Wait()
	if started != 1 {
		t.Fatal("duplicate accepted executions", started)
	}
}

func TestCodexReceiptFailedACKPersistenceRetainsPendingOriginal(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	receiptTestReserve(t, journal, id)
	receipt := newCodexTerminalReceipt(id, "completed", "saved result", "", "output.xlsx", "thread-a")
	if _, err := journal.complete(receipt); err != nil {
		t.Fatal(err)
	}
	journal.replace = func(string, string) error { return errors.New("simulated locked journal") }
	if err := journal.acknowledge(id, receipt.ReceiptID, receipt.ReceiptHash, true); err == nil {
		t.Fatal("failed ACK persistence accepted")
	}
	journal = &codexReceiptJournal{root: journal.root, replace: os.Rename}
	pending, err := journal.pending(codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(pending) != 1 || pending[0].ReceiptHash != receipt.ReceiptHash {
		t.Fatal("failed ACK persistence lost original", pending, err)
	}
}

func TestCodexReceiptAcknowledgedTombstoneRejectsLateTerminalResults(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	receiptTestReserve(t, journal, id)
	first := newCodexTerminalReceipt(id, "completed", "first private original", "", "output.xlsx", "thread-a")
	if _, err := journal.complete(first); err != nil {
		t.Fatal(err)
	}
	if err := journal.acknowledge(id, first.ReceiptID, first.ReceiptHash, true); err != nil {
		t.Fatal(err)
	}
	journal = &codexReceiptJournal{root: journal.root, replace: os.Rename}
	late := newCodexTerminalReceipt(id, "failed", "late conflicting result", "late", "output.xlsx", "thread-a")
	if _, err := journal.complete(late); err == nil {
		t.Fatal("acknowledged identity accepted another terminal result")
	}
	entry, err := journal.read(id)
	if err != nil || entry == nil || !entry.Acknowledged || entry.Receipt != nil {
		t.Fatal("acknowledged tombstone acquired another terminal body", entry, err)
	}
	data, err := os.ReadFile(journal.filename(id))
	if err != nil || strings.Contains(string(data), first.FinalResponse) || strings.Contains(string(data), late.FinalResponse) {
		t.Fatal("acknowledged tombstone retained a terminal body", err)
	}
	existing, err := journal.reserve(id, "output.xlsx")
	if err != nil || existing == nil || !existing.Acknowledged {
		t.Fatal("acknowledged original became executable again", existing, err)
	}
	pending, err := journal.pending(codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(pending) != 0 {
		t.Fatal("acknowledged tombstone replayed a result", pending, err)
	}
}

func TestCodexReceiptHTMLHeavyOriginalSurvivesPersistenceAndRestart(t *testing.T) {
	journal := receiptTestJournal(t)
	id := receiptTestID()
	receiptTestReserve(t, journal, id)
	body := strings.Repeat("<", 200_000)
	receipt := newCodexTerminalReceipt(id, "completed", body, "", "output.html", "thread-a")
	if _, err := journal.complete(receipt); err != nil {
		t.Fatal("HTML-heavy original was expanded beyond the receipt limit", err)
	}
	data, err := os.ReadFile(journal.filename(id))
	if err != nil || len(data) > 512*1024 {
		t.Fatal("persisted receipt exceeded the transport limit", len(data), err)
	}
	journal = &codexReceiptJournal{root: journal.root, replace: os.Rename}
	pending, err := journal.pending(codexExecutionOwner{WorkspaceID: id.WorkspaceID, UserID: id.UserID}, id.DeviceID, id.InstallationID, nil)
	if err != nil || len(pending) != 1 || pending[0].FinalResponse != body || pending[0].ReceiptHash != receipt.ReceiptHash {
		t.Fatal("restart changed the original body or its receipt hash", err)
	}
}

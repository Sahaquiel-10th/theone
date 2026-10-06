package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestMachineResidentChild(t *testing.T) {
	if os.Getenv("ONE_MACHINE_TEST_CHILD") != "1" {
		return
	}
	control, err := newMachineControl()
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	fmt.Println("READY")
	<-control.done
}

func TestMachineSwitchStopsOnlyInstalledResident(t *testing.T) {
	directory, other := t.TempDir(), t.TempDir()
	start := func(folder string) *exec.Cmd {
		source, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(folder, "ONEPresence-99.0.0.exe")
		if err := os.WriteFile(target, data, 0700); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(target, "-test.run=^TestMachineResidentChild$")
		cmd.Env = append(os.Environ(), "ONE_MACHINE_TEST_CHILD=1")
		out, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err = cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill() })
		scanner := bufio.NewScanner(out)
		ready := make(chan bool, 1)
		go func() { ready <- scanner.Scan() && scanner.Text() == "READY" }()
		select {
		case ok := <-ready:
			if !ok {
				t.Fatal("child not ready")
			}
		case <-time.After(5 * time.Second):
			t.Fatal("child timeout")
		}
		return cmd
	}
	old, untouched := start(directory), start(other)
	if err := stopMachineResidents(directory); err != nil {
		t.Fatal(err)
	}
	if err := old.Wait(); err != nil {
		t.Fatal("cooperative exit failed", err)
	}
	handle, err := syscall.OpenProcess(0x00100000, false, uint32(untouched.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	wait, _, _ := kernel.NewProc("WaitForSingleObject").Call(uintptr(handle), 0)
	if wait != 258 {
		t.Fatal("unrelated directory was stopped")
	}
	_ = untouched.Process.Kill()
	_ = untouched.Wait()
}

func TestMachineResidentPathIsolation(t *testing.T) {
	directory := `C:\Users\alice\AppData\Local\ONE`
	for _, candidate := range []string{filepath.Join(directory, "ONEPresence-0.4.8.exe"), filepath.Join(directory, "ONEPresence-0.3.13.exe")} {
		if !machineResidentPath(candidate, directory) {
			t.Fatal("installed resident excluded", candidate)
		}
	}
	for _, candidate := range []string{`C:\Users\bob\AppData\Local\ONE\ONEPresence-0.4.8.exe`, filepath.Join(directory, "other.exe"), filepath.Join(directory, "nested", "ONEPresence-0.4.8.exe"), filepath.Join(directory, "ONEPresence-malformed.exe")} {
		if machineResidentPath(candidate, directory) {
			t.Fatal("unrelated executable included", candidate)
		}
	}
}

func TestMachineLeaseRejectsConcurrentKeyAndReleases(t *testing.T) {
	name, err := machineMutexName("isolated-test")
	if err != nil {
		t.Fatal(err)
	}
	first, ok, err := acquireNamedResidentLock(name)
	if err != nil || !ok {
		t.Fatal("first lock", err)
	}
	defer first.close()
	_, ok, err = acquireNamedResidentLock(name)
	if err != nil || ok {
		t.Fatal("second key admitted", err)
	}
	first.close()
	next, ok, err := acquireNamedResidentLock(name)
	if err != nil || !ok {
		t.Fatal("released lock unavailable", err)
	}
	next.close()
}

func TestResidentStopsCooperatively(t *testing.T) {
	control, err := newMachineControl()
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	name, _ := syscall.UTF16PtrFromString(stopEventName(uint32(syscall.Getpid())))
	event, _, err := kernel.NewProc("OpenEventW").Call(2, 0, uintptr(unsafe.Pointer(name)))
	if event == 0 {
		t.Fatal(err)
	}
	kernel.NewProc("SetEvent").Call(event)
	syscall.CloseHandle(syscall.Handle(event))
	select {
	case <-control.done:
	case <-time.After(time.Second):
		t.Fatal("stop signal was ignored")
	}
	if control.bind(nil) {
		t.Fatal("stopped resident reconnects")
	}
}

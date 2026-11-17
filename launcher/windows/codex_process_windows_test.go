package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The child runs only synthetic helpers within this test executable. It never
// opens a user workspace or model connection.
func TestCodexWindowsProcessHelper(t *testing.T) {
	mode := os.Getenv("ONE_CODEX_JOB_TEST_MODE")
	if mode == "" {
		return
	}
	switch mode {
	case "write":
		if err := os.WriteFile(os.Getenv("ONE_CODEX_JOB_TEST_PATH"), []byte("resumed"), 0600); err != nil {
			os.Exit(3)
		}
	case "parent":
		child := exec.Command(os.Args[0], "-test.run=^TestCodexWindowsProcessHelper$")
		child.Env = append(os.Environ(), "ONE_CODEX_JOB_TEST_MODE=child")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(4)
		}
		if err := os.WriteFile(os.Getenv("ONE_CODEX_JOB_TEST_PATH"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
			os.Exit(5)
		}
	case "child":
		for {
			time.Sleep(time.Second)
		}
	default:
		os.Exit(6)
	}
	os.Exit(0)
}

func codexWindowsTestProcess(t *testing.T, mode, target string) (*exec.Cmd, *codexProcessJob) {
	t.Helper()
	job, err := newCodexProcessJob()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { job.stopAndJoin(); job.close() })
	command := exec.Command(os.Args[0], "-test.run=^TestCodexWindowsProcessHelper$")
	command.Env = append(os.Environ(), "ONE_CODEX_JOB_TEST_MODE="+mode, "ONE_CODEX_JOB_TEST_PATH="+target)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x200 | 0x4}
	return command, job
}

func TestCodexWindowsJobOwnsSuspendedProcessBeforeItRuns(t *testing.T) {
	target := filepath.Join(t.TempDir(), "started.txt")
	command, job := codexWindowsTestProcess(t, "write", target)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	if err := job.assign(command); err != nil {
		command.Process.Kill()
		command.Wait()
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("suspended process executed before assignment", err)
	}
	if count, err := job.activeCount(); err != nil || count != 1 {
		t.Fatal("job did not own the root", count, err)
	}
	if err := resumeCodexProcess(command); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("resumed helper never exited")
	}
	actual, err := os.ReadFile(target)
	if err != nil || string(actual) != "resumed" {
		t.Fatal("helper did not execute", err)
	}
}

func TestCodexWindowsJobStopsChildAfterRootExitsAndDrainsPipes(t *testing.T) {
	target := filepath.Join(t.TempDir(), "child.pid")
	command, job := codexWindowsTestProcess(t, "parent", target)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	command.Stdout, command.Stderr = writer, writer
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	if err := job.assign(command); err != nil {
		command.Process.Kill()
		command.Wait()
		t.Fatal(err)
	}
	if err := resumeCodexProcess(command); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	rootDone := make(chan error, 1)
	go func() { rootDone <- command.Wait() }()
	select {
	case err := <-rootDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("root helper did not exit")
	}
	pid, err := os.ReadFile(target)
	if err != nil || strings.TrimSpace(string(pid)) == "" {
		t.Fatal("child did not start", err)
	}
	if count, err := job.activeCount(); err != nil || count == 0 {
		t.Fatal("job forgot the surviving child", count, err)
	}
	eof := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, reader); eof <- err }()
	if !job.stopAndJoin() {
		t.Fatal("surviving child did not stop")
	}
	select {
	case err := <-eof:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("owned child output never reached EOF")
	}
	if count, err := job.activeCount(); err != nil || count != 0 {
		t.Fatal(fmt.Sprint("nonempty stopped job ", count, " ", err))
	}
}

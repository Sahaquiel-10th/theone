package main

import (
	"encoding/binary"
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// The job owns only the freshly spawned Codex root and descendants. Closing it
// terminates that exact tree, including children that outlive the root.
type codexProcessJob struct {
	mu sync.Mutex
	handle syscall.Handle
}

type codexJobBasicLimits struct {
	ProcessTime, JobTime int64
	LimitFlags uint32
	MinimumWorkingSet, MaximumWorkingSet uintptr
	ActiveProcessLimit uint32
	Affinity uintptr
	PriorityClass, SchedulingClass uint32
}
type codexJobExtendedLimits struct {
	Basic codexJobBasicLimits
	IOCounters [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

func newCodexProcessJob() (*codexProcessJob, error) {
	handle, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if handle == 0 { return nil, err }
	job := &codexProcessJob{handle: syscall.Handle(handle)}
	limits := codexJobExtendedLimits{}
	limits.Basic.LimitFlags = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	ok, _, err := kernel.NewProc("SetInformationJobObject").Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 { syscall.CloseHandle(job.handle); return nil, err }
	return job, nil
}

func (job *codexProcessJob) assign(command *exec.Cmd) error {
	if command.Process == nil { return errors.New("Codex 尚未启动") }
	process, err := syscall.OpenProcess(0x0100|0x0001, false, uint32(command.Process.Pid))
	if err != nil { return err }
	defer syscall.CloseHandle(process)
	ok, _, err := kernel.NewProc("AssignProcessToJobObject").Call(uintptr(job.handle), uintptr(process))
	if ok == 0 { return err }
	return nil
}

func (job *codexProcessJob) activeCount() (uint32, error) {
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.handle == 0 { return 0, errors.New("Codex 进程范围已关闭") }
	var accounting [48]byte
	ok, _, err := kernel.NewProc("QueryInformationJobObject").Call(uintptr(job.handle), 1, uintptr(unsafe.Pointer(&accounting[0])), uintptr(len(accounting)), 0)
	if ok == 0 { return 0, err }
	return binary.LittleEndian.Uint32(accounting[40:44]), nil
}

func (job *codexProcessJob) stopAndJoin() bool {
	job.mu.Lock()
	if job.handle == 0 { job.mu.Unlock(); return false }
	ok, _, _ := kernel.NewProc("TerminateJobObject").Call(uintptr(job.handle), 1)
	job.mu.Unlock()
	if ok == 0 { return false }
	deadline := time.Now().Add(5*time.Second)
	for time.Now().Before(deadline) {
		count, err := job.activeCount()
		if err == nil && count == 0 { return true }
		time.Sleep(25*time.Millisecond)
	}
	return false
}

func (job *codexProcessJob) close() {
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.handle != 0 { syscall.CloseHandle(job.handle); job.handle = 0 }
}

func windowsManagedPathCheck(target string) error {
	attributes, err := syscall.GetFileAttributes(syscall.StringToUTF16Ptr(target))
	if err != nil { return err }
	if attributes&0x400 != 0 { return errors.New("ONE 执行工具目录包含重解析位置，请恢复原目录") }
	return nil
}

func init() { managedNativePathCheck = windowsManagedPathCheck }

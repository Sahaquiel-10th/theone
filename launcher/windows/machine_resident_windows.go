package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var installedResidentName = regexp.MustCompile(`^ONEPresence-[0-9]+\.[0-9]+\.[0-9]+\.exe$`)

func machineMutexName(phase string) (string, error) {
	id, err := installationID()
	if err != nil {
		return "", err
	}
	return residentMutexName("machine-v1:" + phase + ":" + id), nil
}

// Both the exact installed path and Windows account are checked on the same
// process handle used for shutdown. No process-name-only termination.
func machineResidentPath(path, directory string) bool {
	return strings.EqualFold(filepath.Dir(path), directory) && installedResidentName.MatchString(filepath.Base(path))
}

func processPath(handle syscall.Handle) (string, error) {
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	ok, _, err := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return "", err
	}
	return syscall.UTF16ToString(buffer[:size]), nil
}

func processSID(handle syscall.Handle) (string, error) {
	var token syscall.Token
	if err := syscall.OpenProcessToken(handle, syscall.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String()
}

func stopEventName(pid uint32) string { return fmt.Sprintf("Local\\ONEPresence-stop-v1-%d", pid) }

func stopMachineResidents(directory string) error {
	self, err := syscall.OpenProcess(0x1000, false, uint32(os.Getpid()))
	if err != nil {
		return err
	}
	sid, err := processSID(self)
	syscall.CloseHandle(self)
	if err != nil {
		return err
	}
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(snapshot)
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		if entry.ProcessID == uint32(os.Getpid()) || !installedResidentName.MatchString(syscall.UTF16ToString(entry.ExeFile[:])) {
			continue
		}
		handle, openErr := syscall.OpenProcess(0x1000|0x00100000|0x0001, false, entry.ProcessID)
		if openErr != nil {
			return errors.New("旧 ONE 驻留程序无法关闭，请退出旧版后重试")
		}
		path, pathErr := processPath(handle)
		owner, ownerErr := processSID(handle)
		if pathErr != nil || ownerErr != nil || owner != sid || !machineResidentPath(path, directory) {
			syscall.CloseHandle(handle)
			continue
		}
		name, _ := syscall.UTF16PtrFromString(stopEventName(entry.ProcessID))
		event, _, _ := kernel.NewProc("OpenEventW").Call(2, 0, uintptr(unsafe.Pointer(name)))
		if event != 0 {
			kernel.NewProc("SetEvent").Call(event)
			syscall.CloseHandle(syscall.Handle(event))
		} else {
			// Legacy versions have no cooperative stop protocol. Only this exact
			// current-user installed executable is eligible for one-time migration.
			if err := syscall.TerminateProcess(handle, 0); err != nil {
				syscall.CloseHandle(handle)
				return err
			}
		}
		wait, _, _ := kernel.NewProc("WaitForSingleObject").Call(uintptr(handle), 6000)
		syscall.CloseHandle(handle)
		if wait != 0 {
			return errors.New("旧 ONE 正在退出，请稍后重新打开；不会同时启动两枚 Key")
		}
	}
	if err != syscall.ERROR_NO_MORE_FILES {
		return err
	}
	return nil
}

type machineControl struct {
	mu         sync.Mutex
	stopped    bool
	connection *websocket.Conn
	event      syscall.Handle
	done       chan struct{}
}

func newMachineControl() (*machineControl, error) {
	name, _ := syscall.UTF16PtrFromString(stopEventName(uint32(os.Getpid())))
	event, _, err := kernel.NewProc("CreateEventW").Call(0, 1, 0, uintptr(unsafe.Pointer(name)))
	if event == 0 {
		return nil, err
	}
	control := &machineControl{event: syscall.Handle(event), done: make(chan struct{})}
	go func() {
		defer close(control.done)
		kernel.NewProc("WaitForSingleObject").Call(event, 0xffffffff)
		control.mu.Lock()
		defer control.mu.Unlock()
		control.stopped = true
		if control.connection != nil {
			control.connection.Close()
		}
	}()
	return control, nil
}

func (c *machineControl) bind(connection *websocket.Conn) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.connection = connection
	if c.stopped && connection != nil {
		connection.Close()
	}
	return !c.stopped
}
func (c *machineControl) close() {
	kernel.NewProc("SetEvent").Call(uintptr(c.event))
	<-c.done
	syscall.CloseHandle(c.event)
}
func (c *machineControl) pause(duration time.Duration) {
	select {
	case <-c.done:
	case <-time.After(duration):
	}
}

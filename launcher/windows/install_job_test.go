package main

import (
	"errors"
	"testing"
	"time"
)

func TestInstallDoesNotBlockReaderAndJoinsCommit(t *testing.T) {
	release := make(chan struct{})
	woke := make(chan struct{})
	committed := errors.New("installed target")
	job := startInstallJob(func() error { <-release; return committed }, func() { close(woke) })
	select {
	case <-job.done:
		t.Fatal("returned before commit")
	default:
	}
	close(release)
	select {
	case <-woke:
	case <-time.After(time.Second):
		t.Fatal("reader not woken")
	}
	if job.wait() != committed {
		t.Fatal("lost installed target")
	}
	if job.wait() != committed {
		t.Fatal("repeat join changed outcome")
	}
}
func TestInstallFailureIsNotCompletion(t *testing.T) {
	failure := errors.New("verification failed")
	job := startInstallJob(func() error { return failure }, func() {})
	if job.wait() != failure {
		t.Fatal("lost failure")
	}
}

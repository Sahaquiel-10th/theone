package main

import (
	"errors"
	"strings"
	"testing"
)

func TestResidentLockNamespaceDoesNotDependOnLegacyOwnerOrReleaseVersion(t *testing.T) {
	name := residentMutexName("test-key")
	if !strings.HasPrefix(name, "Local\\ONEPresence-v2-") || name != residentMutexName("test-key") || name == residentMutexName("admin-key") {
		t.Fatal("invalid per-Key stable recovery namespace")
	}
}

func TestResidentTakeoverWaitsForLockWithoutForcingOwner(t *testing.T) {
	calls, pauses := 0, 0
	lock, acquired, err := awaitResidentTakeover(func() (string, bool, error) {
		calls++
		return "new-owner", calls == 3, nil
	}, func() { pauses++ })
	if err != nil || !acquired || lock != "new-owner" || calls != 3 || pauses != 2 {
		t.Fatal("lock handoff did not wait for old owner")
	}
	_, acquired, err = awaitResidentTakeover(func() (string, bool, error) { return "", false, nil }, func() {})
	if acquired || err != nil {
		t.Fatal("a lock that stays held must not be claimed")
	}
	wanted := errors.New("lock failure")
	_, acquired, err = awaitResidentTakeover(func() (string, bool, error) { return "", false, wanted }, func() { t.Fatal("must not retry a lock failure") })
	if acquired || !errors.Is(err, wanted) {
		t.Fatal("lock failure must propagate")
	}
}

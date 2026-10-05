package main

import (
	"crypto/sha256"
	"encoding/hex"
)

// Stable protocol namespace, shared by every repaired release. An offline
// legacy process cannot release its mutex through a server notification.
// Server authentication still arbitrates between legacy and repaired owners.
func residentMutexName(deviceID string) string {
	digest := sha256.Sum256([]byte(deviceID))
	return "Local\\ONEPresence-v2-" + hex.EncodeToString(digest[:])
}

// Only the authenticated server negotiation may ask the old owner to exit.
// Locally we wait for its lock; we never force-kill a process or delete a lock.
func awaitResidentTakeover[T any](acquire func() (T, bool, error), pause func()) (T, bool, error) {
	var empty T
	for attempt := 0; attempt < 30; attempt++ {
		lock, acquired, err := acquire()
		if err != nil || acquired {
			return lock, acquired, err
		}
		pause()
	}
	return empty, false, nil
}

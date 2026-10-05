import Foundation
import Darwin

@main
struct KeyDiscoveryTests {
    static func main() {
        let original = URL(fileURLWithPath: "/Volumes/TESTONLYONE/.one/credential.json")
        let renamed = URL(fileURLWithPath: "/Volumes/TESTONLYONE 1/.one/credential.json")
        let portable = URL(fileURLWithPath: "/Library/ONE/.one/credential.json")
        precondition(keyCredentialCandidates(current: nil, original: original, portable: portable) == [original, portable], "remount must retain original fast path")
        precondition(keyCredentialCandidates(current: renamed, original: original, portable: portable) == [renamed, original, portable])
        precondition(keyCredentialCandidates(current: original, original: original, portable: portable) == [original, portable], "paths are unique")
        precondition(!mayScanOtherKeyVolumes(expectedDeviceId: nil, preferred: original), "unresolved test launch cannot adopt admin Key")
        precondition(mayScanOtherKeyVolumes(expectedDeviceId: "test-device", preferred: original), "known identity can recover a renamed mount")
        precondition(residentLockFilename(digest: "test") == "presence-test-v2.lock", "offline legacy owner must not block repaired launch")
        precondition(residentLockFilename(digest: "test") != residentLockFilename(digest: "admin"), "each Key keeps its own lock")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let legacy = open(directory.appendingPathComponent("presence-test.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        let repaired = open(directory.appendingPathComponent(residentLockFilename(digest: "test")).path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        let duplicate = open(directory.appendingPathComponent(residentLockFilename(digest: "test")).path, O_RDWR)
        defer { close(legacy); close(repaired); close(duplicate) }
        precondition(flock(legacy, LOCK_EX | LOCK_NB) == 0)
        precondition(flock(repaired, LOCK_EX | LOCK_NB) == 0, "offline legacy lock must not block repaired resident")
        precondition(flock(duplicate, LOCK_EX | LOCK_NB) != 0, "two repaired residents cannot own the same Key")
        print("Key discovery isolation tests passed")
    }
}

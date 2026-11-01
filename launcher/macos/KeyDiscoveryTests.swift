import Foundation
import Darwin

@main
struct KeyDiscoveryTests {
    static func main() {
        precondition(isCredentialPermissionDenied(NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)))
        precondition(isCredentialPermissionDenied(NSError(domain: NSPOSIXErrorDomain, code: 13)))
        precondition(isCredentialPermissionDenied(NSError(domain: NSCocoaErrorDomain, code: 256, userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: 1)])))
        precondition(!isCredentialPermissionDenied(NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoSuchFileError)), "unplug remains recoverable, not a permission failure")
        precondition(!isCredentialPermissionDenied(NSError(domain: NSURLErrorDomain, code: -1009)), "network loss remains recoverable")
        let original = URL(fileURLWithPath: "/Volumes/TESTONLYONE/.one/credential.json")
        let renamed = URL(fileURLWithPath: "/Volumes/TESTONLYONE 1/.one/credential.json")
        let portable = URL(fileURLWithPath: "/Library/ONE/.one/credential.json")
        precondition(keyCredentialCandidates(current: nil, original: original, portable: portable) == [original, portable], "remount must retain original fast path")
        precondition(keyCredentialCandidates(current: renamed, original: original, portable: portable) == [renamed, original, portable])
        precondition(keyCredentialCandidates(current: original, original: original, portable: portable) == [original, portable], "paths are unique")
        precondition(!mayScanOtherKeyVolumes(expectedDeviceId: nil, preferred: original), "unresolved test launch cannot adopt admin Key")
        precondition(!mayScanOtherKeyVolumes(expectedDeviceId: "test-device", preferred: original), "single-Key recovery must not read other volumes")
        let identity = KeyCredentialIdentity(deviceId: "test-device", publicKey: "public-test-only", serverBaseUrl: "https://one.example")
        let pin = KeyMountIdentity(volumeUUID: "volume-a", credential: identity)
        let oldVolume = original.deletingLastPathComponent().deletingLastPathComponent()
        let newVolume = renamed.deletingLastPathComponent().deletingLastPathComponent()
        var reads = [URL]()
        let inspect: (URL) throws -> KeyCredentialIdentity = { reads.append($0); return identity }
        precondition(matchingPinnedKeyCredential(pin, volumes: [KeyMountedVolume(url: oldVolume, uuid: "other-volume")], readIdentity: inspect) == nil)
        precondition(reads.isEmpty, "different volumes are metadata-only, never credential reads")
        let recovered = matchingPinnedKeyCredential(pin, volumes: [KeyMountedVolume(url: oldVolume, uuid: "other-volume"), KeyMountedVolume(url: newVolume, uuid: "VOLUME-A")], readIdentity: inspect)
        precondition(recovered == renamed && reads == [renamed], "renamed mount restores only exact pinned volume and public credential identity")
        for wrong in [KeyCredentialIdentity(deviceId: "other-device", publicKey: identity.publicKey, serverBaseUrl: identity.serverBaseUrl), KeyCredentialIdentity(deviceId: identity.deviceId, publicKey: "other-public-key", serverBaseUrl: identity.serverBaseUrl), KeyCredentialIdentity(deviceId: identity.deviceId, publicKey: identity.publicKey, serverBaseUrl: "https://other.example")] {
            precondition(matchingPinnedKeyCredential(pin, volumes: [KeyMountedVolume(url: newVolume, uuid: "volume-a")], readIdentity: { _ in wrong }) == nil)
        }
        reads.removeAll()
        precondition(matchingPinnedKeyCredential(pin, volumes: [KeyMountedVolume(url: oldVolume, uuid: "volume-a"), KeyMountedVolume(url: newVolume, uuid: "volume-a")], readIdentity: inspect) == nil)
        precondition(reads.isEmpty, "ambiguous cloned UUIDs fail closed before opening either credential")
        let pinSuite = "one-key-pin-test-\(UUID().uuidString)", pinDefaults = UserDefaults(suiteName: pinSuite)!
        defer { pinDefaults.removePersistentDomain(forName: pinSuite); pinDefaults.synchronize() }
        saveKeyMountIdentity(pin, defaults: pinDefaults, installationId: "machine-a")
        let relaunchedDefaults = UserDefaults(suiteName: pinSuite)!
        let restoredPin = savedKeyMountIdentity(defaults: relaunchedDefaults, deviceId: identity.deviceId, installationId: "machine-a")!
        precondition(restoredPin.volumeUUID == pin.volumeUUID && restoredPin.credential == identity, "process restart keeps public identity but never stores a private credential")
        precondition(savedKeyMountIdentity(defaults: relaunchedDefaults, deviceId: "other-device", installationId: "machine-a") == nil)
        precondition(savedKeyMountIdentity(defaults: relaunchedDefaults, deviceId: identity.deviceId, installationId: "machine-b") == nil)
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

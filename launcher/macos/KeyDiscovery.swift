import Foundation

// Permission denial must not look like an unplugged Key: polling a denied
// credential can repeatedly re-open macOS privacy prompts.
func isCredentialPermissionDenied(_ error: Error) -> Bool {
    var current = error as NSError
    for _ in 0..<8 {
        if current.domain == NSCocoaErrorDomain && current.code == NSFileReadNoPermissionError { return true }
        if current.domain == NSPOSIXErrorDomain && (current.code == 13 || current.code == 1) { return true }
        guard let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError else { return false }
        current = underlying
    }
    return false
}

func residentLockFilename(digest: String) -> String { "presence-\(digest)-v2.lock" }

// A resident knows the original launch location even after an unmount clears
// its current location. Try both before asking macOS for the volume inventory.
func keyCredentialCandidates(current: URL?, original: URL?, portable: URL) -> [URL] {
    var seen = Set<String>()
    return [current, original, portable].compactMap { $0 }.filter {
        seen.insert($0.standardizedFileURL.path).inserted
    }
}

func mayScanOtherKeyVolumes(expectedDeviceId: String?, preferred: URL?) -> Bool {
    // An explicitly opened Key stays bound to that mount. Never probe a second
    // volume merely because permission/mount recovery on the first failed.
    preferred == nil && expectedDeviceId == nil
}

/// A mount path is not Key identity. Only metadata for the pinned volume UUID
/// may lead to a credential read; a matching device ID alone is insufficient.
struct KeyCredentialIdentity: Codable, Equatable {
    let deviceId: String
    let publicKey: String
    let serverBaseUrl: String
}
struct KeyMountIdentity: Codable {
    let volumeUUID: String
    let credential: KeyCredentialIdentity
}
struct KeyMountedVolume {
    let url: URL
    let uuid: String?
}
func matchingPinnedKeyCredential(_ pin: KeyMountIdentity, volumes: [KeyMountedVolume],
                                readIdentity: (URL) throws -> KeyCredentialIdentity) -> URL? {
    let candidates = volumes.filter { $0.uuid?.caseInsensitiveCompare(pin.volumeUUID) == .orderedSame }
    // Duplicate UUIDs may be cloned media. Never pick one arbitrarily.
    guard !pin.volumeUUID.isEmpty, candidates.count == 1 else { return nil }
    let candidate = candidates[0].url.appendingPathComponent(".one/credential.json")
    guard let found = try? readIdentity(candidate), found == pin.credential else { return nil }
    return candidate
}
func mountedKeyVolume(_ url: URL) -> KeyMountedVolume {
    KeyMountedVolume(url: url, uuid: (try? url.resourceValues(forKeys: [.volumeUUIDStringKey]))?.volumeUUIDString)
}
private func keyMountIdentityStorageKey(deviceId: String, installationId: String) -> String {
    "one.key.mount-identity.\(installationId).\(deviceId)"
}
func savedKeyMountIdentity(defaults: UserDefaults, deviceId: String, installationId: String) -> KeyMountIdentity? {
    guard let data = defaults.data(forKey: keyMountIdentityStorageKey(deviceId: deviceId, installationId: installationId)),
          data.count <= 16_384, let pin = try? JSONDecoder().decode(KeyMountIdentity.self, from: data),
          pin.credential.deviceId == deviceId, !pin.volumeUUID.isEmpty,
          !pin.credential.publicKey.isEmpty, !pin.credential.serverBaseUrl.isEmpty else { return nil }
    return pin
}
func saveKeyMountIdentity(_ pin: KeyMountIdentity, defaults: UserDefaults, installationId: String) {
    guard let data = try? JSONEncoder().encode(pin), data.count <= 16_384 else { return }
    defaults.set(data, forKey: keyMountIdentityStorageKey(deviceId: pin.credential.deviceId, installationId: installationId))
    defaults.synchronize()
}

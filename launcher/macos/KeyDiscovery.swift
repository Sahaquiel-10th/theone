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

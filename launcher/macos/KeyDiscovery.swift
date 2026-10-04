import Foundation

// A resident knows the original launch location even after an unmount clears
// its current location. Try both before asking macOS for the volume inventory.
func keyCredentialCandidates(current: URL?, original: URL?, portable: URL) -> [URL] {
    var seen = Set<String>()
    return [current, original, portable].compactMap { $0 }.filter {
        seen.insert($0.standardizedFileURL.path).inserted
    }
}

func mayScanOtherKeyVolumes(expectedDeviceId: String?, preferred: URL?) -> Bool {
    // Before resolving an identity, a launch from A must never adopt B simply
    // because A is temporarily unreadable. After resolving, scans match ID.
    expectedDeviceId != nil || preferred == nil
}

import Foundation

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
        print("Key discovery isolation tests passed")
    }
}

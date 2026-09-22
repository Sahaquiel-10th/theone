// The file commit and the progress notification are different operations.
// A notification failure must not undo or prevent the committed hand-off.
func committedRuntimeInstallation<T>(install: () async throws -> T, reportCompletion: () async throws -> Void) async throws -> T {
    let installed = try await install()
    try? await reportCompletion()
    return installed
}

import Foundation

enum FATSafeFileOperations {
    static func copyTree(from source: URL, to destination: URL) throws {
        let manager = FileManager.default
        let attributes = try manager.attributesOfItem(atPath: source.path)
        let type = attributes[.type] as? FileAttributeType

        if type == .typeDirectory {
            try manager.createDirectory(at: destination, withIntermediateDirectories: false)
            for child in try manager.contentsOfDirectory(
                at: source,
                includingPropertiesForKeys: nil,
                options: []
            ) where !child.lastPathComponent.hasPrefix("._") {
                try copyTree(from: child, to: destination.appendingPathComponent(child.lastPathComponent))
            }
            return
        }

        // copyItem preserves the executable bit and symbolic links for bundle
        // files, while each directory above is created under its real FAT32
        // parent instead of inheriting a stale `..` entry from another tree.
        try manager.copyItem(at: source, to: destination)
    }
}

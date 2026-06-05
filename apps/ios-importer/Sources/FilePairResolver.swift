import Foundation

enum FilePairResolver {
  static func resolve(from urls: [URL]) throws -> ImportPair {
    let localURLs = try copySecurityScopedFiles(urls)
    guard
      let photoURL = localURLs.first(where: { isPhotoExtension($0.pathExtension) }),
      let videoURL = localURLs.first(where: { isVideoExtension($0.pathExtension) })
    else {
      throw ImportError.missingPair
    }

    return ImportPair(photoURL: photoURL, videoURL: videoURL)
  }

  private static func copySecurityScopedFiles(_ urls: [URL]) throws -> [URL] {
    let fileManager = FileManager.default
    let importDirectory = fileManager.temporaryDirectory
      .appendingPathComponent("VidLiveImporter", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)

    try fileManager.createDirectory(at: importDirectory, withIntermediateDirectories: true)

    return try urls.map { sourceURL in
      let didAccess = sourceURL.startAccessingSecurityScopedResource()
      defer {
        if didAccess {
          sourceURL.stopAccessingSecurityScopedResource()
        }
      }

      let destinationURL = importDirectory.appendingPathComponent(sourceURL.lastPathComponent)

      if fileManager.fileExists(atPath: destinationURL.path) {
        try fileManager.removeItem(at: destinationURL)
      }

      try fileManager.copyItem(at: sourceURL, to: destinationURL)
      return destinationURL
    }
  }

  private static func isPhotoExtension(_ value: String) -> Bool {
    ["jpg", "jpeg", "heic"].contains(value.lowercased())
  }

  private static func isVideoExtension(_ value: String) -> Bool {
    ["mov"].contains(value.lowercased())
  }
}

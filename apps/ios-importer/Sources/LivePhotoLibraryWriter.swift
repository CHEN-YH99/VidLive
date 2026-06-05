import Foundation
import Photos

enum LivePhotoLibraryWriter {
  static func save(pair: ImportPair) async throws {
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)

    guard status == .authorized || status == .limited else {
      throw ImportError.photoLibraryDenied
    }

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      PHPhotoLibrary.shared().performChanges {
        let request = PHAssetCreationRequest.forAsset()

        let photoOptions = PHAssetResourceCreationOptions()
        photoOptions.shouldMoveFile = false
        request.addResource(with: .photo, fileURL: pair.photoURL, options: photoOptions)

        let videoOptions = PHAssetResourceCreationOptions()
        videoOptions.shouldMoveFile = false
        request.addResource(with: .pairedVideo, fileURL: pair.videoURL, options: videoOptions)
      } completionHandler: { success, error in
        if let error {
          continuation.resume(throwing: error)
          return
        }

        if success {
          continuation.resume()
        } else {
          continuation.resume(throwing: ImportError.saveFailed)
        }
      }
    }
  }
}

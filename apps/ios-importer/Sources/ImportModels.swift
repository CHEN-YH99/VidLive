import Foundation

struct ImportPair {
  let photoURL: URL
  let videoURL: URL
}

enum ImportError: LocalizedError {
  case missingPair
  case photoLibraryDenied
  case saveFailed

  var errorDescription: String? {
    switch self {
    case .missingPair:
      return "请选择同一个 VidLive 导出包里的 photo.jpg 和 video.mov。"
    case .photoLibraryDenied:
      return "没有照片库写入权限。请到系统设置里允许 VidLive Importer 访问照片。"
    case .saveFailed:
      return "照片库写入失败，但系统没有返回具体错误。"
    }
  }
}

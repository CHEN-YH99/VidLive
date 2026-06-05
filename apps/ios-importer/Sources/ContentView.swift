import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
  @State private var isImporterPresented = false
  @State private var isImporting = false
  @State private var statusTitle = "等待选择素材"
  @State private var statusDetail = "先在文件 App 解压 VidLive ZIP，然后同时选择 photo.jpg 和 video.mov。"

  private var supportedTypes: [UTType] {
    [
      .jpeg,
      .quickTimeMovie,
      UTType(filenameExtension: "jpg"),
      UTType(filenameExtension: "mov"),
      UTType(filenameExtension: "heic"),
    ].compactMap { $0 }
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 20) {
        VStack(alignment: .leading, spacing: 8) {
          Text("VidLive Importer")
            .font(.largeTitle.bold())
          Text("把 VidLive 生成的 JPG/MOV 配对素材写入照片库，验证 iOS 是否识别为 Live Photo。")
            .foregroundStyle(.secondary)
        }

        VStack(alignment: .leading, spacing: 10) {
          Label("先解压 ZIP", systemImage: "archivebox")
          Label("同时选择 photo.jpg 和 video.mov", systemImage: "doc.on.doc")
          Label("授权写入照片库", systemImage: "photo.badge.plus")
          Label("到照片 App 检查 LIVE 标识", systemImage: "livephoto")
        }
        .font(.headline)

        Divider()

        VStack(alignment: .leading, spacing: 8) {
          Text(statusTitle)
            .font(.headline)
          Text(statusDetail)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))

        Spacer()

        Button {
          isImporterPresented = true
        } label: {
          HStack {
            if isImporting {
              ProgressView()
            } else {
              Image(systemName: "square.and.arrow.down")
            }
            Text(isImporting ? "导入中" : "选择配对文件")
          }
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(isImporting)
      }
      .padding()
      .navigationTitle("导入 Live Photo")
      .fileImporter(
        isPresented: $isImporterPresented,
        allowedContentTypes: supportedTypes,
        allowsMultipleSelection: true
      ) { result in
        Task {
          await importFiles(result)
        }
      }
    }
  }

  @MainActor
  private func importFiles(_ result: Result<[URL], Error>) async {
    isImporting = true
    statusTitle = "正在准备素材"
    statusDetail = "复制文件到 App 临时目录，准备调用 PhotoKit。"

    do {
      let urls = try result.get()
      let pair = try FilePairResolver.resolve(from: urls)
      statusTitle = "正在写入照片库"
      statusDetail = "\(pair.photoURL.lastPathComponent) + \(pair.videoURL.lastPathComponent)"
      try await LivePhotoLibraryWriter.save(pair: pair)
      statusTitle = "导入完成"
      statusDetail = "请打开照片 App，检查是否出现带 LIVE 标识的照片，并长按验证动态效果。"
    } catch {
      statusTitle = "导入失败"
      statusDetail = error.localizedDescription
    }

    isImporting = false
  }
}

#Preview {
  ContentView()
}

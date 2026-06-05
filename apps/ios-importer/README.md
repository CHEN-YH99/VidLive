# VidLive Importer

VidLive Importer 是一个最小 iOS PhotoKit 验证 App，用来把 VidLive 生成的 `photo.jpg + video.mov` 写入系统照片库，并验证 iOS 是否识别为 Live Photo。

它不负责转码，也不负责修元数据。前置条件是 ZIP 里的 `manifest.json` 已经显示：

```json
"metadataInjected": true
```

## 使用流程

1. 在 iPhone Safari 下载 VidLive 云端 ZIP。
2. 在文件 App 里解压 ZIP。
3. 用 Xcode 安装 VidLive Importer 到 iPhone。
4. 打开 App，点“选择配对文件”。
5. 同时选择同一个导出包里的 `photo.jpg` 和 `video.mov`。
6. 授权写入照片库。
7. 打开照片 App，检查是否出现 `LIVE` 标识，长按是否播放。

## 生成 Xcode 工程

这个目录使用 XcodeGen 管理工程文件，避免手写庞大的 `.xcodeproj`。

```bash
brew install xcodegen
cd apps/ios-importer
xcodegen generate
open VidLiveImporter.xcodeproj
```

打开 Xcode 后：

1. 选择 `VidLiveImporter` target。
2. 修改 `Signing & Capabilities` 里的 Team。
3. 连接 iPhone。
4. 选择真机运行。

## 验收标准

通过标准：

- 照片 App 中出现一张 Live Photo。
- 左上角或信息页能看到 `LIVE` 标识。
- 长按照片可以播放。
- 设置为锁屏壁纸后，系统认可它是动态照片素材。

失败标准：

- 导入后仍是一张普通照片和一个普通视频。
- App 报 PhotoKit 写入失败。
- 照片 App 有资产但没有 `LIVE` 标识。

如果失败，下一步检查生成 ZIP 里的 `photo.jpg` 和 `video.mov` 是否仍然有相同的 `ContentIdentifier`。

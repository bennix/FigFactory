# FigFactory · 形体工坊

一个基于 Electron 的 AI 图像创作工作台。支持 1–5 个人偶形态参考、人脸与服饰参考、ZenMux 生图、文字 AI 流式优化、涂鸦修图、本地历史和分层 PSD 导出。

- [介绍与下载](https://bennix.github.io/FigFactory/)
- [安装包](https://github.com/bennix/FigFactory/releases)
- [模型与接口调研](docs/zenmux-research.md)

## 开发

需要 Node.js 22+。

```sh
npm ci
npm start
npm test
npm run test:desktop
```

在应用设置中输入 ZenMux API Key。Key 使用操作系统加密保存在本机，不写入仓库。AI 请求会发送提示词及选中的参考图至 ZenMux；图像保真度和拆层效果取决于服务。PSD 中的文字为栅格图层。

## 构建

```sh
npm run build:win
npm run build:linux
APPLE_KEYCHAIN_PROFILE=FigFactory-notary npm run build:mac
```

macOS 本机构建需要 Developer ID Application 签名证书，并通过 `xcrun notarytool store-credentials` 将 Apple 公证认证存入钥匙串；不要把密码或证书提交到 Git。支持 Apple Silicon 与 Intel DMG。打包阶段公证并装订 `.app`；发布前另外公证、装订并验证 DMG。

Windows 为 x64 NSIS 安装包，当前未进行 Windows 代码签名。Linux 提供 x64 DEB/RPM；系统须满足 Electron 的桌面运行要求。受限 Linux 钥匙串不可用时，应用不会明文保存 API Key。

GitHub Actions 在 `v*` 标签推送时构建 Windows 与 Linux 并上传到对应 Release。先创建 Release 再推送版本标签。macOS 公证 DMG 由本机上传。Landing Page 使用 GitHub Pages Actions 部署 `site/`，下载入口自动读取最新 Release 的实际资产。

## 图标

`src/assets/app-icon.png` 为透明 1024px 图标；`app-icon.icns` 包含 macOS 多尺寸图标。Electron Dock 和打包配置均使用该图标。

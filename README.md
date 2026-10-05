# FigFactory · 形体工坊

一个基于 Electron 的 AI 图像创作工作台。支持 1–5 个人偶形态参考、人脸与服饰参考、ZenMux 与本地 Qwen-Image-2.1 生图、文字 AI 流式优化、涂鸦修图、本地历史和分层 PSD 导出。

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

在应用设置中输入 ZenMux API Key。Key 使用操作系统加密保存在本机，不写入仓库。生图服务可选择 ZenMux 或本地引擎；提示词优化独立使用 ZenMux，点击优化会发送文字及所选参考图至平台。本地生图请求只交给本机引擎，不自动触发云端预检或优化。图像保真度和拆层效果取决于服务。PSD 中的文字为栅格图层。

## 本地生成

选择“本地 Qwen-Image-2.1 Turbo · 4 步”，在 AI 设置中选择并下载所需整套权重（主模型、文本编码器、需要时的 GGUF 视觉投影、Viggle 4 步 Turbo LoRA 和 VAE），首次安装引擎后启动。文本编码器默认推荐 Heretic W4A8；Apple Silicon 上已实际验证 Q4_K_M 主模型与 W4A8 编码器组合可进行文生图和参考图编辑。引擎在生成时按需启动，空闲两分钟后自动关闭，也可在工作区立即手动关闭；界面会显示引擎状态。可选择 HF 镜像和清华 PyPI 镜像，下载支持断点续传、取消和 SHA-256 校验。Q4_K_M 全 GGUF 组合约 11.00 GiB，不包含引擎依赖。仅提供 Turbo 模式，固定 4 步、CFG 1、Euler、Simple、空负面提示词。参考输入节点最多接收 16 张；Turbo 多图效果需实测；编辑画幅跟随首张参考图。可使用当前人偶姿态、权威脸图、服饰、场景与涂鸦，并复用历史、复制和导出。

安装包不携带模型权重。用户在 AI 设置中下载主模型、Heretic W4A8 编码器、Turbo LoRA 和 VAE；本地引擎首次安装后由应用管理。工作区和设置中均提供“本地 AI 生图服务”开关，可以开启或关闭服务，状态自动同步；生成请求会按需启动，空闲两分钟后自动关闭。

Apple Silicon 上已实际通过 Q4_K_M + W4A8 的 1024×1024 文生图与参考图编辑。`npm run test:local-lifecycle` 会通过应用开关测试真实服务启动、手动关闭、重启和空闲关闭；`npm run test:local-smoke` 用于真实生图测试。

## 构建

```sh
npm run build:win
npm run build:linux
APPLE_KEYCHAIN_PROFILE=FigFactory-notary npm run build:mac
```

macOS 本机构建需要 Developer ID Application 签名证书，并通过 `xcrun notarytool store-credentials` 将 Apple 公证认证存入钥匙串；不要把密码或证书提交到 Git。支持 Apple Silicon 与 Intel DMG。构建钩子自动公证并装订 `.app`，随后公证、装订并通过 Gatekeeper 验证最终 DMG。认证仅从指定钥匙串 profile 读取。

Windows 为 x64 NSIS 安装包，当前未进行 Windows 代码签名。Linux 提供 x64 DEB/RPM；系统须满足 Electron 的桌面运行要求。受限 Linux 钥匙串不可用时，应用不会明文保存 API Key。

GitHub Actions 在 `v*` 标签推送时构建 Windows 与 Linux 并上传到对应 Release。先创建 Release 再推送版本标签。macOS 公证 DMG 由本机上传。Landing Page 使用 GitHub Pages Actions 部署 `site/`，下载入口自动读取最新 Release 的实际资产。

## 图标

`src/assets/app-icon.png` 为透明 1024px 图标；`app-icon.icns` 包含 macOS 多尺寸图标。Electron Dock 和打包配置均使用该图标。

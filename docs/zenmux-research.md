# ZenMux 接口调研与接入说明

核实日期：2026-10-04。依据 ZenMux 官方文档和公开 `GET https://zenmux.ai/api/v1/models` 模型目录。

## 官方来源

- [图片生成协议说明](https://zenmux.ai/docs/guide/advanced/image-generation.html)
- [OpenAI Images 接入](https://zenmux.ai/docs/guide/advanced/openai-image-generation.html)
- [图像编辑 API](https://zenmux.ai/docs/api/openai/create-image-edit.html)
- [Vertex 图像生成和编辑](https://zenmux.ai/docs/api/vertexai/generate-images.html)
- [公开模型目录](https://zenmux.ai/api/v1/models)

## 各模型

| 模型 | 公开目录 | 输入能力 | 本应用默认接口 |
| --- | --- | --- | --- |
| inclusionai/ming-image-0.1-design | 已收录 | text；不支持图片参考 | Images `/images/generations`，仅文生图 |
| openai/gpt-image-2.5-flare | 已收录 | text、image | OpenAI Images，参考图使用 `/images/edits` |
| openai/gpt-image-2.5-sunburst | 已收录 | text、image | OpenAI Images，参考图使用 `/images/edits` |
| klingai/kling-v3 | 未收录该精确名称 | 待确认；Kling 通用编辑文档限制一张参考图 | Vertex `:predict`；占位配置，需实测 |
| qwen/qwen-image-3.0 | 未收录该精确名称 | 待确认 | Vertex `:predict`；默认关闭图片参考 |
| qwen/qwen-image-3.0-pro | 未收录该精确名称 | 待确认 | Vertex `:predict`；默认关闭图片参考 |
| openai/gpt-6.1-sol | 已收录 | text、image、file → text | Chat Completions |
| anthropic/claude-sonnet-5.5 | 已收录 | text、image、file → text | Chat Completions |
| google/gemini-3.8-flash | 已收录 | 多模态 → text | Chat Completions |

用户列表中重复的 Sunburst 已去重。目录中的 `klingai/kling-3.0`、`klingai/kling-3.0-omni`、`klingai/kling-3.0-turbo` 输出为视频，不能作为上述精确名称的生图替代。

## 请求差异

- OpenAI 文生图：`https://zenmux.ai/api/v1/images/generations`，JSON。
- OpenAI 参考生图/修图：`https://zenmux.ai/api/v1/images/edits`，JSON 的 `images: [{image_url: dataURL}]`。官方同时支持 multipart，字段为 `image[]`。使用 `input_fidelity: high`，上限按模型配置。
- 已配置为 Vertex 且经平台确认支持的模型：`https://zenmux.ai/api/vertex-ai/v1/publishers/{provider}/models/{model}:predict`，JSON `instances` 和 `parameters`，参考图使用 `referenceImages`、`REFERENCE_TYPE_RAW`、base64 图片。
- Google Gemini 生图（可新增）：同一 Vertex 基址下 `:generateContent`，输入 `contents.parts.inlineData`，输出模态为 `TEXT, IMAGE`。提示词优化的 Gemini Flash 输出文字，使用 Chat Completions。
- 每种协议分别解析 `data[].b64_json/url`、`predictions[].bytesBase64Encoded`、`candidates[].content.parts.inlineData`。

参考图不兼容或数量超限时会阻止请求，不会自动丢弃图片或自动切换其他付费模型。模型名称、接口、参考图能力和上限均可在设置页修改。

## PSD 和分层输出核实

新增核实来源：[Ming Design](https://zenmux.ai/inclusionai/ming-image-0.1-design)、[Ming Design Layer](https://zenmux.ai/inclusionai/ming-image-0.1-design-layer)。

| 模型 | 原生 PSD | 透明分层结果 |
| --- | --- | --- |
| Ming Image 0.1 Design | 官方未注明；输出 PNG/JPEG/WebP | 普通版本为单图生成，不承担拆层 |
| Ming Image 0.1 Design Layer | 官方未注明；输出 PNG/WebP | 官方明确支持：一张输入图，按说明返回每层一张 RGBA 图 |
| GPT Image 2.5 Flare / Sunburst | Images 接口仅注明 PNG/JPEG/WebP，没有 PSD | 未找到明确的独立图层输出能力；不能将多张普通输出当成 PSD 层 |
| Kling V3、Qwen Image 3.0 / Pro | 公开目录未核实精确名称，无法确认 | 未确认，不默认开启拆层 |

Ming 普通模型尺寸由模型决定；Layer 模型尺寸跟随输入图，**都拒绝显式指定尺寸和比例**。请求适配器已省略这类字段。Layer 必须恰好一张图片。

本应用的 PSD 路径是“文字/视觉模型分析并制定拆层方案 → 专用 Layer 模型拆成 RGBA → 用户检查并调整层名、顺序 → 本地 ag-psd 写入 PSD”。层数为 2–12，中文英文说明都可输入。方案按最上到最下排列：文字、文字底板、主体、背景；垫色色块、卡片、横幅单独一层并放在相应文字下面。可用一个文字模型分析，或 Sol → Sonnet → Gemini 三模型讨论。

层图沿用原尺寸，保留 alpha；尺寸不一致会报错。若返回层数与要求不同，会显示实际层数供用户检查，不伪造缺失图层。PSD 是独立像素图层，文字仍是像素，不能保证可编辑字体或矢量。图层和方案随原图一起存入本地历史。图层返回次序以请求说明约束，导出前应核对并可手动上下移动。

## 存储与图像工作流

Electron 主进程使用 `safeStorage` 加密 API Key，并保存于应用 userData 目录的 `zenmux-settings.json`。渲染进程只能读取保存状态，不回显 Key。设置中的输入框为 password。模型设置与 Key 跨重启保留。操作系统加密服务不可用时拒绝保存新 Key。

设置页支持亮色和暗色主题，切换立即生效，本地保存并跨重启恢复。人偶默认使用浅粉色/浅蓝色区分女性/男性，可关闭颜色提示。

生成图和修图记录保存在 IndexedDB，支持查看、多选删除和跨重启保留。打开图像可以缩放、平移、涂鸦、复制到系统剪贴板、另存为 PNG。涂鸦修图发送涂鸦后的图片；支持多参考图的模型还会收到未涂鸦原图，以帮助保留身份。该流程为参考图编辑，不等同于严格蒙版局部编辑。

面部身份保真通过图片参考和明确指令约束；不能保证模型像素级或绝对身份一致性。真实模型响应与逐模型参考图支持尚需用户 Key 实测，接口测试及桌面流程测试使用模拟响应，不产生 API 费用。

## AI 工作台布局

默认首页以 AI 创作为中心：左侧输入提示词、参考图和可选形态参考，中间常驻生成结果，右侧常驻本地历史。生成按钮始终显示在输入栏底部。生成后直接显示在中间画布；支持缩放、平移、复制、另存为，并可打开涂鸦修图或 PSD 拆层。

人偶编辑通过“形态参考 → 编辑人偶”进入，完成后返回 AI 工作台并启用形态参考。没有开启形态参考时，不强制生成人偶数量或姿态，可单独文生图。历史缩略图选择会显示在中间画布；批量删除从“历史图片 → 管理”进入。

## 启动与验证

```sh
npm start
npm test
./node_modules/.bin/electron tests/desktop.cjs
```

网页预览仍可编辑/导出人偶；AI、加密 Key 保存和系统剪贴板使用 Electron 桌面入口。

## API Key 验证与失败诊断

设置中的“验证 API Key（文字＋生图）”分别实际调用默认 `openai/gpt-6.1-sol` 和 `openai/gpt-image-2.5-flare`。输入框留空时使用本机加密保存的 Key；输入新 Key 时只测试，不自动保存。生图测试为无参考图的简单蓝色圆形，产生正常调用费用；结果单独显示，并预览测试图，不加入创作历史。

HTTP 500 不等同于 Key 无效。文字通过、生图失败时需要继续检查生图服务。无参考图验证通过而形态参考失败时，应检查 Images edits 路径及上游参考图支持。失败显示模型、接口、参考图数量和请求编号，本机 `zenmux-last-error.json` 仅保存诊断信息，不保存 Key、提示词或图片。不会自动重试或切换模型。真实平台是否恢复需实际调用确认，模拟测试无法证明真实服务可用。

## 参考图编辑上传兼容性调整

无参考图成功而有参考图 HTTP 500 时，两者分别调用 `/images/generations` 和 `/images/edits`，普通生图通过不能证明编辑接口可用。参考图编辑已改为官方示例的 `multipart/form-data` 二进制文件上传：按顺序上传 `image[]`，由 fetch 生成 boundary，保留模型、提示词、尺寸与高输入保真参数。文字及无参考图生图继续使用 JSON。

来源：https://zenmux.ai/docs/api/openai/create-image-edit.html 。文档同时支持 JSON 的 data URL，故此次调整是规避潜在转发兼容性问题，并非已证明 JSON 格式错误。不会在失败后自动重复请求。真实 500 是否解决仍需使用同一模型、同一参考图重新调用确认。请求详情记录提交方式，不包含图片或凭据。

## Ming 接口纠正

此前将 Ming 系列配置为 Vertex `:predict` 是错误的。2026-10-04 核对官方模型页的供应商元数据：Design Layer 的 `suitable_api` 为 `images`，`api_protocols` 仅包含 `images`；普通 Design 同样使用 Images API。

Design Layer 改用 `/api/v1/images/edits`，上传恰好一个文件，传入拆层提示词及 `output_format=png`，不发送 size、n 或 input_fidelity。普通 Design 使用 `/api/v1/images/generations`。应用加载旧设置时会纠正这两个模型的 Vertex 配置，请求适配器也按精确模型 ID 使用正确接口。无需删除 Key 或重建模型列表。模拟测试覆盖多层返回与 PSD 导出；实际平台调用还需确认。

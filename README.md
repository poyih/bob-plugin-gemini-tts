# Bob Plugin - Gemini TTS

使用 Google Gemini TTS API 为 [Bob](https://bobtranslate.com/) 提供语音合成功能。

支持 Gemini 3.1 Flash TTS、Gemini 2.5 Pro TTS 和 Gemini 2.5 Flash TTS 模型，提供 30 种预置声音。

支持直接在文本中使用 Gemini `audio tags` 控制语气、停顿和情绪。

> 需要 Bob ≥ 1.20.0。

## 安装

1. 下载最新的 `gemini-tts.bobplugin` 文件
2. 双击文件安装到 Bob

## 配置

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| API Key | 是 | Gemini API Key，在 [Google AI Studio](https://aistudio.google.com/apikey) 获取 |
| 自定义 API 地址 | 否 | 默认 `https://generativelanguage.googleapis.com`，支持自定义代理地址 |
| 模型 | 否 | 默认 `gemini-3.1-flash-tts-preview`，可选 2.5 Pro / 2.5 Flash |
| 声音 | 否 | 默认 `Kore`，可选 30 种预置声音 |
| 语音指令 | 否 | 用于控制语音风格和语气，如"用欢快的语气朗读" |

### 模型选择

| 模型 | 模型 ID | 特点 |
| --- | --- | --- |
| Gemini 3.1 Flash TTS | `gemini-3.1-flash-tts-preview` | 最新，表现力与可控性更佳（默认） |
| Gemini 2.5 Pro TTS | `gemini-2.5-pro-preview-tts` | 偏高质量 |
| Gemini 2.5 Flash TTS | `gemini-2.5-flash-preview-tts` | 偏低延迟 |

### 预置声音

Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat

### 自定义 API 地址说明

- 填入完整地址（含路径）将直接使用
- 仅填域名将自动拼接 `/v1beta/models/{model}:generateContent`

## Audio Tags

Gemini TTS 支持在正文中直接插入 `audio tags`。插件会将文本原样发送给 Gemini，因此这类标签无需额外开关。

示例：

```text
[whispers] 你好。[short pause] 我们开始吧。
```

建议：

- 将全局风格放在“语音指令”里，例如“用轻松自然的语气朗读”
- 将局部效果放在正文里，例如 `[short pause]`、`[whispers]`
- `audio tags` 属于提示词能力，不是严格 SSML，实际效果会随模型和声音略有波动

## 支持语言

中文（简体/繁体）、英语、日语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语、俄语、阿拉伯语、泰语、越南语、印尼语、马来语、土耳其语、波兰语、荷兰语、瑞典语、丹麦语、挪威语、芬兰语、希腊语、捷克语、罗马尼亚语、匈牙利语、斯洛伐克语、乌克兰语、保加利亚语、克罗地亚语、印地语、孟加拉语、泰米尔语、泰卢固语、马拉雅拉姆语、希伯来语、菲律宾语

## 开发

构建插件：

```bash
zip -j gemini-tts.bobplugin info.json main.js
```

## License

MIT

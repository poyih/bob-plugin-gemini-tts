# Bob Plugin - Gemini TTS

使用 Google Gemini TTS API 为 [Bob](https://bobtranslate.com/) 提供语音合成功能。

支持 Gemini 3.1 Flash TTS Preview 和 Gemini 2.5 Flash TTS Preview 模型，提供 30 种预置声音。

## 安装

1. 下载最新的 `gemini-tts.bobplugin` 文件
2. 双击文件安装到 Bob

## 配置

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| API Key | 是 | Gemini API Key，在 [Google AI Studio](https://aistudio.google.com/apikey) 获取 |
| 自定义 API 地址 | 否 | 默认 `https://generativelanguage.googleapis.com`，支持自定义代理地址 |
| 模型 | 否 | 默认 `gemini-3.1-flash-tts-preview` |
| 声音 | 否 | 默认 `Kore`，可选 30 种预置声音 |
| 语音指令 | 否 | 用于控制语音风格和语气，如"用欢快的语气朗读" |

### 预置声音

Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat

### 自定义 API 地址说明

- 填入完整地址（含路径）将直接使用
- 仅填域名将自动拼接 `/v1beta/models/{model}:generateContent`

## 支持语言

中文（简体/繁体）、英语、日语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语、俄语、阿拉伯语、泰语、越南语、印尼语、马来语、土耳其语、波兰语、荷兰语、瑞典语、丹麦语、挪威语、芬兰语、希腊语、捷克语、罗马尼亚语、匈牙利语、斯洛伐克语、乌克兰语、保加利亚语、克罗地亚语、印地语、孟加拉语、泰米尔语、泰卢固语、马拉雅拉姆语、希伯来语、菲律宾语

## 开发

构建插件：

```bash
zip -j gemini-tts.bobplugin info.json main.js
```

## License

MIT

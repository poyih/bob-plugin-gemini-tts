# Bob Plugin - OpenAI TTS

[Bob](https://bobtranslate.com/) 的 OpenAI TTS 语音合成插件，支持 `tts-1`、`tts-1-hd` 和 `gpt-4o-mini-tts` 模型。

## 安装

1. 下载最新版本的 [openai-tts.bobplugin](https://github.com/poyih/bob-plugin-openai-tts/releases/latest)
2. 双击文件即可安装到 Bob

## 配置

在 Bob 的插件设置中填写以下信息：

| 选项 | 说明 |
| --- | --- |
| **OpenAI API Key** | 你的 OpenAI API 密钥 |
| **Model** | TTS 模型：`tts-1`、`tts-1-hd`、`gpt-4o-mini-tts` |
| **Voice (tts-1 / tts-1-hd)** | 音色：alloy、echo、fable、onyx、nova、shimmer |
| **Voice (gpt-4o-mini-tts)** | 音色：alloy、ash、ballad、cedar、coral、echo、fable、marin、onyx、nova、sage、shimmer、verse |
| **Speed** | 语速：0.5x ~ 2.0x |
| **Instructions** | 控制语音风格、语气、情感（仅 `gpt-4o-mini-tts` 支持） |

## 支持的语言

中文（简/繁/粤）、英语、日语、韩语、法语、德语、西班牙语、意大利语、俄语、葡萄牙语、荷兰语、波兰语、阿拉伯语、印地语、土耳其语、越南语、泰语、印尼语、马来语、乌克兰语、捷克语、丹麦语、芬兰语、希腊语、希伯来语、匈牙利语、挪威语、罗马尼亚语、斯洛伐克语、瑞典语、泰米尔语

## 开发

插件由两个核心文件组成：

- `info.json` — 插件元信息与配置项定义
- `main.js` — TTS 调用逻辑

构建 `.bobplugin` 文件：

```bash
zip -j openai-tts.bobplugin info.json main.js
```

## License

MIT

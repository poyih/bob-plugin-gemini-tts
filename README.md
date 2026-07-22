# Bob Plugin - Gemini TTS

使用 Google Gemini TTS API 为 [Bob](https://bobtranslate.com/) 提供语音合成功能。

支持 Gemini 3.1 Flash TTS、Gemini 2.5 Pro TTS 和 Gemini 2.5 Flash TTS 模型，提供 30 种预置声音。

支持直接在文本中使用 Gemini `audio tags` 控制语气、停顿和情绪。

> 需要 Bob ≥ 1.20.0。

## 安装

1. 从当前最新发布的 [v1.2.3 Release](https://github.com/poyih/bob-plugin-gemini-tts/releases/tag/v1.2.3) 下载 `gemini-tts-1.2.3.bobplugin`
2. 双击文件安装到 Bob

## 配置

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| API Key | 是 | Gemini API Key，在 [Google AI Studio](https://aistudio.google.com/apikey) 获取 |
| 自定义 API 地址 | 否 | 默认 `https://generativelanguage.googleapis.com`，地址规则及隐私风险见下文 |
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

- 仅主机根地址会自动拼接 `/v1beta/models/{model}:generateContent`，例如 `https://proxy.example.com`
- 以 `/v1beta`、`/v1beta/models` 结尾的地址会补齐缺少的模型路径；已包含 `/v1/models/{model}` 或 `/v1beta/models/{model}` 的地址只会补上 `:generateContent`
- 其他带非根路径的地址均视为完整代理 endpoint 并原样使用，查询参数也会保留；例如 `https://proxy.example.com/custom/tts`
- 地址不得包含用户名、密码或 URL fragment（`#...`）
- 必须使用 HTTPS；仅 `localhost`、`127.0.0.1` 和 `[::1]` 本机地址允许 HTTP

> 使用第三方代理时，代理服务会收到 Gemini API Key 和完整朗读正文。请只使用可信且受你控制的服务，并确认其日志与数据保留策略。

### 请求行为、长文本与重试

- 插件会自动加入“仅生成语音并准确朗读”的 TTS 前导，并将“语音指令”和朗读正文置于明确、彼此分离的边界中；语音指令用于描述风格，不会作为正文直接拼接
- 正文（包括 `audio tags`）会完整放入 transcript 边界；Gemini 的提示词执行具有概率性，无法保证每次都严格呈现所有风格效果
- 每次朗读是一次 Gemini 请求，插件不会自动切分或拼接长文章；正文最多 4000、语音指令最多 1000 个 UTF-16 字符单元，解码后的 PCM 音频最多 12 MiB，超限会直接报错。多数中英文字符占 1 个单元，部分 emoji 等字符占 2 个
- HTTP 500 会自动重试一次，初次请求和重试共享 115 秒总预算；其他状态不会自动重试，重试后仍失败也会返回错误
- 截断、被过滤或格式异常的响应不会播放，也不会写入缓存

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

中文（简体/繁体）、英语、日语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语（含 pt-BR 变体）、俄语、阿拉伯语、泰语、越南语、印尼语、马来语、土耳其语、波兰语、荷兰语、瑞典语、丹麦语、挪威语、芬兰语、希腊语、捷克语、罗马尼亚语、匈牙利语、斯洛伐克语、乌克兰语、保加利亚语、克罗地亚语、印地语、孟加拉语、泰米尔语、泰卢固语、马拉雅拉姆语、希伯来语、菲律宾语

> 另支持 `auto` 自动语种识别。

## 开发

运行零依赖回归测试（需要 Node.js 18+）：

```bash
node --test tests/regression.test.js
```

构建插件：

```bash
./scripts/package.sh
```

脚本会从 `info.json` 读取版本号，并在项目根目录生成 `gemini-tts-<version>.bobplugin`。

`info.json` 中的 `bob-plugin-gemini-tts` 是已经发布并用于升级匹配的 legacy identifier。尽管其中的连字符不符合 Bob 当前推荐格式，在 Bob 提供官方迁移机制前仍必须保留；请勿直接重命名，否则现有用户将无法沿原升级链更新。

## License

MIT

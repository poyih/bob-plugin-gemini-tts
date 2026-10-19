# Bob Plugin - Gemini TTS

使用 Google Gemini TTS API 为 [Bob](https://bobtranslate.com/) 提供语音合成功能。

支持 Gemini 3.8 Flash TTS、Gemini 3.8 Flash-Lite TTS（正式版），提供 30 种预置声音。

Gemini 3.1 Flash TTS、Gemini 2.5 Pro TTS 和 Gemini 2.5 Flash TTS 最早于 2026-11-17 关闭。设置或标准模型路径里如果仍是这三个 ID，插件会自动改用 `gemini-3.8-flash-tts`。

支持通过「语音指令」和正文中的 Gemini 音频标签控制语气、停顿和情绪。

> 需要 Bob ≥ 1.20.0。

## 安装

1. 从 [最新 Release](https://github.com/poyih/bob-plugin-gemini-tts/releases/latest) 下载对应版本的 `gemini-tts-<version>.bobplugin`
2. 双击文件安装到 Bob

## 配置

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| API Key | 是 | Gemini API Key，在 [Google AI Studio](https://aistudio.google.com/apikey) 获取 |
| 自定义 API 地址 | 否 | 默认 `https://generativelanguage.googleapis.com`，地址规则及隐私风险见下文 |
| 模型 | 否 | 默认 `gemini-3.8-flash-tts`，可选 3.8 Flash-Lite。三个旧预览 ID 会自动改发到 3.8 Flash |
| 请求格式 | 否 | 默认按已知模型自动选择；未知模型或代理别名需明确选择「3.8 格式」或「旧版格式」 |
| 声音 | 否 | 默认 `Kore`，可选 30 种预置声音 |
| 语音指令 | 否 | 用于控制语音风格和语气，如"用欢快的语气朗读"，不会被朗读出来 |

### 模型选择

| 模型 | 模型 ID | 状态 | 特点 |
| --- | --- | --- | --- |
| Gemini 3.8 Flash TTS | `gemini-3.8-flash-tts` | 正式版 | 表现力最强，官方支持 130 多种语言（默认） |
| Gemini 3.8 Flash-Lite TTS | `gemini-3.8-flash-lite-tts` | 正式版 | 更快、更省，官方支持 100 多种语言，Google 推荐用它替代 3.1 Flash TTS |
| Gemini 3.1 Flash TTS | `gemini-3.1-flash-tts-preview` | 2026-11-17 起最早可关闭 | 不再直接请求，自动改用 `gemini-3.8-flash-tts` |
| Gemini 2.5 Pro TTS | `gemini-2.5-pro-preview-tts` | 2026-11-17 起最早可关闭 | 同上 |
| Gemini 2.5 Flash TTS | `gemini-2.5-flash-preview-tts` | 2026-11-17 起最早可关闭 | 同上 |

插件按模型能力表选择请求格式，不用版本号猜测协议。自定义地址里的 `/v1/models/{model}` 或 `/v1beta/models/{model}` 优先于菜单；如果这段路径是上面三个旧 ID，路径和请求都会改成 `gemini-3.8-flash-tts`。其他非标准路径保持原样，但菜单里的旧 ID 仍会让自动格式按 3.8 生成请求体。未知模型和代理别名请在「请求格式」中指定兼容格式；已知的 3.8 模型保留「自动」即可。

手动选择「旧版格式」时，即使模型 ID 已被替换，正文仍使用旧版提示词。3.8 会逐字朗读这些提示，所以只有代理确实要求旧协议时才这样设置。

| | Gemini 3.8 系列 | 旧版格式（手动选择） |
| --- | --- | --- |
| 正文 | 原样发送、逐字朗读，不加任何前导提示 | 包裹在"仅生成语音"前导与 transcript 边界标记中 |
| 语音指令 | 通过 `speechMetadata.style` 随正文发送，不会被朗读 | 作为提示词中的 PERFORMANCE INSTRUCTIONS 段发送 |
| 声音 | `speechConfig.voiceConfig.voice` | `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` |
| 返回音频 | 默认为带 RIFF 头的 `audio/wav`，插件校验后重新封装 | 裸 PCM `audio/L16;rate=24000`，插件补上 WAV 头 |

> 3.8 模型会逐字朗读正文，写在正文里的指令（例如"用欢快的语气说："）也会被念出来，请把这类要求放到「语音指令」中。

### 预置声音

Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat

### 自定义 API 地址说明

- 仅主机根地址会自动拼接 `/v1beta/models/{model}:generateContent`，例如 `https://proxy.example.com`
- 以 `/v1beta`、`/v1beta/models` 结尾的地址会补齐缺少的模型路径；已包含 `/v1/models/{model}` 或 `/v1beta/models/{model}` 的地址只会补上 `:generateContent`
- 上述标准模型路径如果使用三个旧预览 ID，会改写成 `gemini-3.8-flash-tts`，查询参数保留
- 其他带非根路径的地址均视为完整代理 endpoint 并原样使用，查询参数也会保留；例如 `https://proxy.example.com/custom/tts`
- 地址不得包含用户名、密码或 URL fragment（`#...`）
- 必须使用 HTTPS；仅 `localhost`、`127.0.0.1` 和 `[::1]` 本机地址允许 HTTP

> 使用第三方代理时，代理服务会收到 Gemini API Key 和完整朗读正文。请只使用可信且受你控制的服务，并确认其日志与数据保留策略。

### 请求行为、长文本与重试

- 3.8 系列：正文原样发送并逐字朗读；「语音指令」通过 `speechMetadata.style` 传给模型，用于描述整段的语气、角色、口音和语速
- 旧版格式：仅在「请求格式」设为「旧版格式」时使用。插件会加入"仅生成语音并准确朗读"的 TTS 前导，并将"语音指令"和朗读正文置于明确、彼此分离的边界中；语音指令用于描述风格，不会作为正文直接拼接
- Gemini 的提示词执行具有概率性，无法保证每次都严格呈现所有风格效果
- 每次朗读是一次 Gemini 请求，插件不会自动切分或拼接长文章；正文最多 4000、语音指令最多 1000 个 UTF-16 字符单元，解码后的 PCM 音频最多 12 MiB，超限会直接报错。多数中英文字符占 1 个单元，部分 emoji 等字符占 2 个
- 返回的音频可以是裸 PCM（`audio/L16`、`audio/pcm` 等）或带 RIFF 头的 WAV（`audio/wav`）；两者都只接受 16-bit 单声道 PCM，WAV 会在校验采样率与数据块后重新封装为标准 44 字节头
- HTTP 500 会自动重试一次，初次请求和重试共享 115 秒总预算；其他状态不会自动重试，重试后仍失败也会返回错误
- 截断、被过滤或格式异常的响应不会播放，也不会写入缓存
- WAV 的有限 RIFF 长度必须与完整文件一致，有限 data 长度不得超过实际内容；仅 `0` 和 `0xFFFFFFFF` 作为流式长度占位值兼容，不会把其他超大声明当作占位值
- 同一正文、语言、地址、模型、声音、指令、凭据和请求格式的在途朗读会共享请求与重试；成功后缓存 10 分钟。失败会清理共享状态，后续调用可以重新请求

## 语音指令与音频标签

插件会将正文原样发送给 Gemini，不会改写其中的标签，因此音频标签无需额外开关。3.8 与手动选择的旧版格式写法不同：

| | Gemini 3.8 系列 | 旧版格式（手动选择） |
| --- | --- | --- |
| 整段风格 | 填在「语音指令」中，例如"轻声、语速放慢" | 同左 |
| 局部效果 | 正文中使用尖括号标签，如 `<short pause>`、`<laugh>`、`<sigh>`、`<breath>` | 正文中使用方括号标签，如 `[short pause]`、`[whispers]` |

示例（3.8 系列，也是旧模型自动改发后的写法）：

```text
你好。<short pause> 我们开始吧。<laugh>
```

示例（仅旧版格式）：

```text
[whispers] 你好。[short pause] 我们开始吧。
```

- 音频标签属于提示词能力，不是严格 SSML，实际效果会随模型和声音略有波动
- 3.8 模型会逐字朗读正文，请不要在正文中写入方括号指令或"用……语气说"之类的提示，改用「语音指令」

## 支持语言

插件按实际请求的模型向 Bob 声明支持语言：自定义地址中的标准模型路径优先于菜单选择，三个旧预览 ID 自动改用 3.8 Flash 后，也按 Flash 的能力声明。已知模型会在朗读前再次检查 Bob 提供的语种；未列入当前模型声明范围的语种会直接返回 Bob 的「不支持的语言」（`unsupportedLanguage`）错误，模型以 `finishReason: LANGUAGE` 拒绝时也一样。

声明范围以 [Google 官方语言表](https://ai.google.dev/gemini-api/docs/speech-generation#supported-languages) 为准，只包含能与官方条目一一对应的 [Bob 语言代码](https://bobtranslate.com/plugin/addition/language.html)。官方表中 Bob 没有对应代码的语言（如巴厘语、阿瓦德语、米佐语），以及只列出某种书写系统、而 Bob 代码不区分书写系统的条目（如阿拉伯字母的亚齐语），不在声明范围内。

两款 3.8 模型共同声明的 86 种语言：中文（简体/繁体）、粤语、英语、日语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语（含 pt-PT、pt-BR 变体）、俄语、阿拉伯语、越南语、印尼语、马来语、土耳其语、波兰语、荷兰语、丹麦语、挪威语（`nb`、`no`）、希腊语、捷克语、罗马尼亚语、匈牙利语、斯洛伐克语、保加利亚语、克罗地亚语、印地语、孟加拉语、泰米尔语、泰卢固语、马拉雅拉姆语、希伯来语、菲律宾语（`fil`、`tl`）、南非语、阿肯语、阿姆哈拉语、阿萨姆语、阿塞拜疆语、南阿塞拜疆语、白俄罗斯语、博杰普尔语、波斯尼亚语、加泰罗尼亚语、宿务语、中库尔德语、爱沙尼亚语、巴斯克语、波斯语、尼日利亚富拉语、加利西亚语、古吉拉特语、豪萨语、海地克里奥尔语、亚美尼亚语、伊洛卡诺语、冰岛语、爪哇语（`jv`、`jw`）、格鲁吉亚语、刚果语、基库尤语、哈萨克语、高棉语、卡纳达语、克什米尔语、柯尔克孜语、卢干达语、林加拉语、老挝语、拉脱维亚语、迈蒂利语、马其顿语、蒙古语、曼尼普尔语、马拉地语、马耳他语、尼泊尔语、北索托语、齐切瓦语、奥里亚语、旁遮普语、普什图语、卢旺达语、僧伽罗语、塞尔维亚语（含西里尔、拉丁字母）、乌兹别克语。

3.8 Flash 另声明 27 种语言：泰语、瑞典语、芬兰语、巴什基尔语、本巴语、克里米亚鞑靼语、迪尤拉语、宗喀语、瓜拉尼语、伊博语、卡拜尔语、卢森堡语、立陶宛语、拉特加莱语、缅甸语、奥克语、邦阿西楠语、信德语、斯洛文尼亚语、索马里语、阿尔巴尼亚语、史瓦帝语、塞索托语、斯瓦希里语、塔吉克语、提格雷尼亚语、维吾尔语。3.8 Flash-Lite 的官方支持列表未包含这些语言。两款模型的官方列表均未包含乌克兰语和乌尔都语，因此插件不声明支持。

未知模型或代理别名在 Bob 中保留上述 Flash 语言列表，并交由代理确认实际语种能力，插件不对未知模型执行严格的语种拦截。另支持 `auto` 自动语种识别，但这不保证模型支持声明列表之外的语言；官方未列出的语言也不代表每次请求都会失败。

## 开发

开发检查需要 Node.js 22+ 和 Python 3.8+，均只使用标准库，无需安装第三方依赖。运行插件与发布工具测试：

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

构建插件：

```bash
./scripts/package.sh
```

脚本会从 `info.json` 读取版本号，在 `dist/` 中生成 `gemini-tts-<version>.bobplugin` 和同名 `.sha256` 校验文件。包内包含 `main.js` 以及 `lib/models.js`、`lib/request.js`；打包前会检查模块依赖是否全部纳入清单。ZIP 时间戳和权限固定，相同源码可重复构建出相同字节。

生成并核对候选更新清单：

```bash
python3 scripts/release.py check
python3 scripts/release.py prepare
python3 scripts/release.py verify --appcast dist/appcast.json
```

`info.json` 是版本号和最低 Bob 版本的来源，`release-notes.txt` 是待发布版本的更新说明。`prepare` 自动计算构建包 SHA-256、下载地址和候选时间戳，将新版本与历史记录合并到 `dist/appcast.json`；候选清单用于检查，不应在上传 Release 前提交为正式更新源。

`prepare` 和 `finalize` 可用 `--artifact <path>` 指定已有构建包；显式指定的文件必须存在，缺失时会直接报错。不传 `--artifact` 时，工具使用默认构建包路径，并在文件不存在时自动构建。

上传同一个构建包到对应版本的 GitHub Release 后，执行：

```bash
python3 scripts/release.py finalize
python3 scripts/release.py verify --appcast appcast.json --github
```

`finalize` 会检查 Release 标签、状态、文件名、长度和 SHA-256，并下载已上传的文件再次比对。全部一致后才更新项目根目录的 `appcast.json`，时间戳使用 GitHub 实际发布时间；任何验证失败都会保留原更新源。工具不创建或上传 Release，现有已发布版本不能替换为不同的包。

CI 在 push 和 pull request 时使用 macOS、Node.js 22/24 执行语法检查、所有测试、元数据检查、构建及候选清单校验，并提供经过验证的构建产物。

`info.json` 中的 `bob-plugin-gemini-tts` 是已经发布并用于升级匹配的 legacy identifier。尽管其中的连字符不符合 Bob 当前推荐格式，在 Bob 提供官方迁移机制前仍必须保留；请勿直接重命名，否则现有用户将无法沿原升级链更新。

## License

MIT

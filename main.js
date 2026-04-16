// Bob TTS Plugin - Google Gemini TTS
// 使用 Gemini 3.1 Flash TTS API 进行语音合成

var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Decode(base64) {
    // Remove padding
    var str = base64.replace(/=+$/, '');
    var len = str.length;
    var byteLen = (len * 3) >> 2;
    var bytes = new Uint8Array(byteLen);
    var p = 0;

    for (var i = 0; i < len; i += 4) {
        var a = BASE64_CHARS.indexOf(str.charAt(i));
        var b = BASE64_CHARS.indexOf(str.charAt(i + 1));
        var c = BASE64_CHARS.indexOf(str.charAt(i + 2));
        var d = BASE64_CHARS.indexOf(str.charAt(i + 3));

        bytes[p++] = (a << 2) | (b >> 4);
        if (c !== -1) bytes[p++] = ((b & 0x0f) << 4) | (c >> 2);
        if (d !== -1) bytes[p++] = ((c & 0x03) << 6) | d;
    }

    return bytes;
}

function base64Encode(bytes) {
    var len = bytes.length;
    var result = '';

    for (var i = 0; i < len; i += 3) {
        var a = bytes[i];
        var b = i + 1 < len ? bytes[i + 1] : 0;
        var c = i + 2 < len ? bytes[i + 2] : 0;

        result += BASE64_CHARS.charAt(a >> 2);
        result += BASE64_CHARS.charAt(((a & 0x03) << 4) | (b >> 4));
        result += i + 1 < len ? BASE64_CHARS.charAt(((b & 0x0f) << 2) | (c >> 6)) : '=';
        result += i + 2 < len ? BASE64_CHARS.charAt(c & 0x3f) : '=';
    }

    return result;
}

function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

function pcmToWav(pcmBase64) {
    var pcmData = base64Decode(pcmBase64);
    var pcmLen = pcmData.length;

    var sampleRate = 24000;
    var numChannels = 1;
    var bitsPerSample = 16;
    var byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    var blockAlign = numChannels * (bitsPerSample / 8);

    // 44-byte WAV header + PCM data
    var wavLen = 44 + pcmLen;
    var buffer = new ArrayBuffer(wavLen);
    var view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, wavLen - 8, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // sub-chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcmLen, true);

    // Copy PCM data
    var wavBytes = new Uint8Array(buffer);
    wavBytes.set(pcmData, 44);

    return base64Encode(wavBytes);
}

// ---- Bob Plugin Interface ----

function supportLanguages() {
    return [
        'auto', 'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko',
        'fr', 'de', 'es', 'it', 'pt', 'pt-BR', 'ru',
        'ar', 'th', 'vi', 'id', 'ms', 'tr', 'pl',
        'nl', 'sv', 'da', 'nb', 'fi', 'el', 'cs',
        'ro', 'hu', 'sk', 'uk', 'bg', 'hr', 'hi',
        'bn', 'ta', 'te', 'ml', 'he', 'fil'
    ];
}

function readOption(name) {
    var value = $option[name];
    return value == null ? '' : String(value).trim();
}

function getModel() {
    return readOption('model') || 'gemini-3.1-flash-tts-preview';
}

function getVoice() {
    return readOption('voice') || 'Kore';
}

function getApiUrl() {
    var base = readOption('apiUrl') || 'https://generativelanguage.googleapis.com';
    base = base.replace(/\/+$/, '');

    var model = getModel();

    // If URL already contains :generateContent, use as-is
    if (base.indexOf(':generateContent') !== -1) {
        return base;
    }

    // If URL contains /v1beta/models/, append :generateContent
    if (base.indexOf('/v1beta/models/') !== -1) {
        return base + ':generateContent';
    }

    // Otherwise append full path
    return base + '/v1beta/models/' + model + ':generateContent';
}

function validateOptions() {
    if (!readOption('apiKey')) {
        return { type: 'param', message: '请在插件配置中填写 API Key', addition: '在 Google AI Studio (aistudio.google.com) 获取 API Key' };
    }
    if (!getModel()) {
        return { type: 'param', message: '请在插件配置中选择模型' };
    }
    if (!getVoice()) {
        return { type: 'param', message: '请在插件配置中选择声音' };
    }
    return null;
}

function pluginValidate(completion) {
    var error = validateOptions();
    if (error) {
        completion({ error: error });
        return;
    }

    // Send a real TTS request to verify the API Key
    var apiKey = readOption('apiKey');
    var voice = getVoice();
    var apiUrl = getApiUrl();

    $http.request({
        method: 'POST',
        url: apiUrl,
        header: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
        },
        body: {
            contents: [{ parts: [{ text: 'Hi' }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voice }
                    }
                }
            }
        },
        timeout: 30,
        handler: function (resp) {
            if (resp.error) {
                completion({ error: toServiceError(resp.error) });
                return;
            }
            var statusCode = resp.response ? resp.response.statusCode : 0;
            if (statusCode !== 200) {
                completion({ error: parseHttpError(resp) });
                return;
            }
            completion({ result: true });
        }
    });
}

function parseHttpError(resp) {
    var statusCode = resp.response ? resp.response.statusCode : 0;
    var data = resp.data;
    var message = '';

    if (data && data.error) {
        message = data.error.message || JSON.stringify(data.error);
    }

    if (statusCode === 400) {
        return { type: 'api', message: message || '请求参数错误', addition: '状态码: 400' };
    }
    if (statusCode === 401 || statusCode === 403) {
        return { type: 'api', message: 'API Key 无效或无权限', addition: message || '状态码: ' + statusCode };
    }
    if (statusCode === 429) {
        return { type: 'api', message: '请求过于频繁，请稍后再试', addition: message || '状态码: 429' };
    }
    if (statusCode >= 500) {
        return { type: 'api', message: 'Gemini 服务暂时不可用，请稍后再试', addition: message || '状态码: ' + statusCode };
    }
    if (message) {
        return { type: 'api', message: message, addition: '状态码: ' + statusCode };
    }

    return { type: 'api', message: '请求失败，状态码: ' + statusCode };
}

function toServiceError(error) {
    return { type: 'network', message: '网络请求异常', addition: error.message || JSON.stringify(error) };
}

function tts(query, completion) {
    var error = validateOptions();
    if (error) {
        completion({ error: error });
        return;
    }

    var text = query.text;
    if (!text || !text.trim()) {
        completion({ error: { type: 'param', message: '文本不能为空' } });
        return;
    }
    text = text.trim();

    var apiKey = readOption('apiKey');
    var model = getModel();
    var voice = getVoice();
    var instructions = readOption('instructions');

    // Prepend instructions to text if provided
    var inputText = text;
    if (instructions) {
        inputText = instructions + ': ' + text;
    }

    var requestBody = {
        contents: [
            {
                parts: [{ text: inputText }]
            }
        ],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: voice
                    }
                }
            }
        }
    };

    var apiUrl = getApiUrl();

    $http.request({
        method: 'POST',
        url: apiUrl,
        header: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
        },
        body: requestBody,
        timeout: 60,
        handler: function (resp) {
            if (resp.error) {
                completion({ error: toServiceError(resp.error) });
                return;
            }

            var statusCode = resp.response ? resp.response.statusCode : 0;
            if (statusCode !== 200) {
                completion({ error: parseHttpError(resp) });
                return;
            }

            try {
                var data = resp.data;
                if (!data || !data.candidates || !data.candidates[0]) {
                    completion({ error: { type: 'api', message: 'API 返回数据异常', addition: '未找到有效的候选结果' } });
                    return;
                }

                var candidate = data.candidates[0];
                if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                    completion({ error: { type: 'api', message: 'API 返回数据异常', addition: '候选结果中无内容' } });
                    return;
                }

                var part = candidate.content.parts[0];
                if (!part.inlineData || !part.inlineData.data) {
                    completion({ error: { type: 'api', message: 'API 返回数据异常', addition: '未找到音频数据' } });
                    return;
                }

                var pcmBase64 = part.inlineData.data;
                var wavBase64 = pcmToWav(pcmBase64);

                completion({
                    result: {
                        type: 'base64',
                        value: wavBase64,
                        raw: {
                            model: model,
                            voice: voice
                        }
                    }
                });
            } catch (e) {
                completion({ error: { type: 'api', message: '音频处理失败', addition: e.message || String(e) } });
            }
        }
    });
}

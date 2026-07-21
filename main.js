// Bob TTS Plugin - Google Gemini TTS
// 使用 Google Gemini TTS API 进行语音合成（支持 Gemini 3.1 Flash / 2.5 Pro / 2.5 Flash TTS）

var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var LOG_PREFIX = '[bob-plugin-gemini-tts]';
var REQUEST_COUNTER = 0;
var PLUGIN_TIMEOUT_INTERVAL = 120;
var TTS_REQUEST_TIMEOUT_INTERVAL = 100;
var CACHE_MAX_ENTRIES = 10;
var CACHE_MAX_VALUE_CHARS = 3 * 1024 * 1024;
var AUDIO_CACHE = {};
var AUDIO_CACHE_ORDER = [];

function nowMs() {
    return new Date().getTime();
}

function nextRequestId() {
    REQUEST_COUNTER += 1;
    return REQUEST_COUNTER;
}

function sanitizeLogValue(value) {
    var str = value == null ? '' : String(value);
    str = str.replace(/\s+/g, ' ').trim();
    if (str.length > 200) {
        return str.substring(0, 197) + '...';
    }
    return str;
}

function logInfo(message) {
    $log.info(LOG_PREFIX + ' ' + message);
}

function logError(message) {
    $log.error(LOG_PREFIX + ' ' + message);
}

function logTtsInfo(requestId, stage, message) {
    logInfo('[tts#' + requestId + '] ' + stage + ' ' + message);
}

function logTtsError(requestId, stage, message) {
    logError('[tts#' + requestId + '] ' + stage + ' ' + message);
}

function makeCacheKey(text, lang, apiUrl, model, voice, instructions) {
    return [
        apiUrl,
        model,
        voice,
        instructions,
        lang || '',
        text || ''
    ].join('\u0001');
}

function touchCacheKey(key) {
    var index = AUDIO_CACHE_ORDER.indexOf(key);
    if (index !== -1) {
        AUDIO_CACHE_ORDER.splice(index, 1);
    }
    AUDIO_CACHE_ORDER.push(key);
}

function deleteCacheKey(key) {
    delete AUDIO_CACHE[key];
    var index = AUDIO_CACHE_ORDER.indexOf(key);
    if (index !== -1) {
        AUDIO_CACHE_ORDER.splice(index, 1);
    }
}

function trimAudioCache() {
    while (AUDIO_CACHE_ORDER.length > CACHE_MAX_ENTRIES) {
        deleteCacheKey(AUDIO_CACHE_ORDER[0]);
    }
}

function getCachedAudioResult(key) {
    var entry = AUDIO_CACHE[key];
    if (!entry) {
        return null;
    }
    touchCacheKey(key);
    return entry;
}

function setCachedAudioResult(key, result) {
    if (!result || !result.value || result.value.length > CACHE_MAX_VALUE_CHARS) {
        return false;
    }

    AUDIO_CACHE[key] = {
        result: result,
        storedAt: nowMs()
    };
    touchCacheKey(key);
    trimAudioCache();
    return true;
}

function createTtsResult(wavBase64, model, voice, cacheStatus) {
    return {
        type: 'base64',
        value: wavBase64,
        raw: {
            model: model,
            voice: voice,
            cache: cacheStatus
        }
    };
}

function base64Decode(base64) {
    // Strip whitespace (incl. MIME-style line breaks every 76 chars) and map URL-safe chars
    var str = String(base64).replace(/\s+/g, '');
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    // Reject stray bytes outside the base64 alphabet (padding allowed)
    if (!/^[A-Za-z0-9+/]*=*$/.test(str)) {
        throw new Error('invalid base64 payload');
    }
    // Remove padding
    str = str.replace(/=+$/, '');
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

function parsePcmFormat(mimeType) {
    var type = String(mimeType || '').toLowerCase();

    // Containered/encoded formats cannot be wrapped as raw PCM WAV
    if (type && (type.indexOf('wav') !== -1 || type.indexOf('mpeg') !== -1 ||
                 type.indexOf('mp3') !== -1 || type.indexOf('ogg') !== -1 ||
                 type.indexOf('opus') !== -1 || type.indexOf('webm') !== -1)) {
        throw new Error('unsupported audio mimeType: ' + type +
            ' (expected raw PCM such as audio/L16;rate=24000)');
    }

    var sampleRate = 24000;
    var rateMatch = type.match(/rate=(\d+)/);
    if (rateMatch) {
        sampleRate = parseInt(rateMatch[1], 10);
    }

    return { sampleRate: sampleRate, numChannels: 1, bitsPerSample: 16 };
}

function pcmToWav(pcmBase64, mimeType) {
    var pcmData = base64Decode(pcmBase64);
    var pcmLen = pcmData.length;

    var fmt = parsePcmFormat(mimeType);
    var sampleRate = fmt.sampleRate;
    var numChannels = fmt.numChannels;
    var bitsPerSample = fmt.bitsPerSample;
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

function pluginTimeoutInterval() {
    return PLUGIN_TIMEOUT_INTERVAL;
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

function endsWith(str, suffix) {
    return str.length >= suffix.length &&
        str.substring(str.length - suffix.length) === suffix;
}

function getApiUrl() {
    var base = readOption('apiUrl') || 'https://generativelanguage.googleapis.com';
    base = base.replace(/\/+$/, '');

    var model = getModel();

    // If URL already contains :generateContent, use as-is
    if (base.indexOf(':generateContent') !== -1) {
        return base;
    }

    // If URL already points at a specific model, append :generateContent
    if (base.indexOf('/v1beta/models/') !== -1) {
        return base + ':generateContent';
    }

    // If URL ends at the bare models directory, append the model segment
    if (endsWith(base, '/v1beta/models')) {
        return base + '/' + model + ':generateContent';
    }

    // If URL ends at /v1beta, append the models path
    if (endsWith(base, '/v1beta')) {
        return base + '/models/' + model + ':generateContent';
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

function buildSpeechRequestBody(text, voice) {
    return {
        contents: [{ parts: [{ text: text }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice }
                }
            }
        }
    };
}

function buildValidationPrompt(mode) {
    if (mode === 'retry') {
        return 'TTS task. Generate speech audio only and do not generate text. Read aloud exactly this transcript with no extra words: "Hi".';
    }

    return 'Generate audio only. Read aloud exactly the following text transcript and do not add any extra words or text: "Hi".';
}

function getApiErrorMessage(resp) {
    var data = resp && resp.data;
    if (data && data.error) {
        return data.error.message || JSON.stringify(data.error);
    }
    // Non-JSON error body (e.g. an HTML gateway page from a proxy)
    if (data && typeof data === 'string' && data.trim()) {
        return sanitizeLogValue(data);
    }
    return '';
}

function isTtsValidationPromptError(resp) {
    var statusCode = resp && resp.response ? resp.response.statusCode : 0;
    var message = getApiErrorMessage(resp);

    return statusCode === 400 &&
        message.indexOf('should only be used for TTS') !== -1;
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

    function sendValidationRequest(mode, allowRetry) {
        $http.request({
            method: 'POST',
            url: apiUrl,
            header: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: buildSpeechRequestBody(buildValidationPrompt(mode), voice),
            timeout: 30,
            handler: function (resp) {
                if (resp.error) {
                    completion({ error: toServiceError(resp.error) });
                    return;
                }

                var statusCode = resp.response ? resp.response.statusCode : 0;
                if (statusCode !== 200) {
                    if (allowRetry && isTtsValidationPromptError(resp)) {
                        sendValidationRequest('retry', false);
                        return;
                    }

                    completion({ error: parseHttpError(resp) });
                    return;
                }

                completion({ result: true });
            }
        });
    }

    sendValidationRequest('initial', true);
}

function parseHttpError(resp) {
    var statusCode = resp.response ? resp.response.statusCode : 0;
    var message = getApiErrorMessage(resp);

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
    var done = false;
    function finish(result) {
        if (done) return;
        done = true;
        completion(result);
    }

    var error = validateOptions();
    if (error) {
        finish({ error: error });
        return;
    }

    var text = query.text;
    if (!text || !text.trim()) {
        finish({ error: { type: 'param', message: '文本不能为空' } });
        return;
    }
    text = text.trim();

    var apiKey = readOption('apiKey');
    var model = getModel();
    var voice = getVoice();
    var instructions = readOption('instructions');
    var requestId = nextRequestId();
    var requestStartedAt = nowMs();
    var apiUrl = getApiUrl();

    // Prepend instructions to text if provided
    var inputText = text;
    if (instructions) {
        inputText = instructions + ': ' + text;
    }

    logTtsInfo(
        requestId,
        'start',
        'chars=' + text.length +
        ' payload_chars=' + inputText.length +
        ' instructions=' + (instructions ? 'on' : 'off') +
        ' model=' + model +
        ' voice=' + voice
    );

    var cacheKey = makeCacheKey(text, query.lang, apiUrl, model, voice, instructions);
    var cachedEntry = getCachedAudioResult(cacheKey);
    if (cachedEntry) {
        var cachedResult = createTtsResult(cachedEntry.result.value, model, voice, 'hit');
        logTtsInfo(
            requestId,
            'cache_hit',
            'total_ms=' + (nowMs() - requestStartedAt) +
            ' age_ms=' + (nowMs() - cachedEntry.storedAt) +
            ' wav_base64_chars=' + cachedEntry.result.value.length
        );
        finish({ result: cachedResult });
        return;
    }

    var requestBody = buildSpeechRequestBody(inputText, voice);

    try {
        $http.request({
            method: 'POST',
            url: apiUrl,
            header: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: requestBody,
            timeout: TTS_REQUEST_TIMEOUT_INTERVAL,
            handler: function (resp) {
                var requestElapsedMs = nowMs() - requestStartedAt;

                if (resp.error) {
                    logTtsError(
                        requestId,
                        'network_error',
                        'request_ms=' + requestElapsedMs +
                        ' message=' + sanitizeLogValue(resp.error.message || resp.error)
                    );
                    finish({ error: toServiceError(resp.error) });
                    return;
                }

                var statusCode = resp.response ? resp.response.statusCode : 0;
                if (statusCode !== 200) {
                    var httpError = parseHttpError(resp);
                    logTtsError(
                        requestId,
                        'http_error',
                        'request_ms=' + requestElapsedMs +
                        ' status=' + statusCode +
                        ' message=' + sanitizeLogValue(httpError.message + ' ' + (httpError.addition || ''))
                    );
                    finish({ error: httpError });
                    return;
                }

                try {
                    var data = resp.data;
                    if (!data || !data.candidates || !data.candidates[0]) {
                        logTtsError(requestId, 'invalid_response', 'request_ms=' + requestElapsedMs + ' reason=missing_candidate');
                        finish({ error: { type: 'api', message: 'API 返回数据异常', addition: '未找到有效的候选结果' } });
                        return;
                    }

                    var candidate = data.candidates[0];
                    var finishReason = candidate.finishReason;
                    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
                        logTtsError(requestId, 'filtered', 'request_ms=' + requestElapsedMs + ' finishReason=' + finishReason);
                        finish({ error: { type: 'api', message: '内容被安全过滤，无法生成音频', addition: 'finishReason: ' + finishReason } });
                        return;
                    }
                    if (finishReason === 'MAX_TOKENS') {
                        logTtsInfo(requestId, 'partial', 'request_ms=' + requestElapsedMs + ' finishReason=MAX_TOKENS (audio may be truncated)');
                    }

                    if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                        logTtsError(requestId, 'invalid_response', 'request_ms=' + requestElapsedMs + ' reason=missing_content_part');
                        finish({ error: { type: 'api', message: 'API 返回数据异常', addition: '候选结果中无内容' } });
                        return;
                    }

                    var part = candidate.content.parts[0];
                    if (!part.inlineData || !part.inlineData.data) {
                        logTtsError(requestId, 'invalid_response', 'request_ms=' + requestElapsedMs + ' reason=missing_audio_data');
                        finish({ error: { type: 'api', message: 'API 返回数据异常', addition: '未找到音频数据' } });
                        return;
                    }

                    var pcmBase64 = part.inlineData.data;
                    var mimeType = part.inlineData.mimeType;
                    var convertStartedAt = nowMs();
                    var wavBase64 = pcmToWav(pcmBase64, mimeType);
                    var convertElapsedMs = nowMs() - convertStartedAt;
                    var totalElapsedMs = nowMs() - requestStartedAt;
                    var result = createTtsResult(wavBase64, model, voice, 'miss');
                    var cacheStored = setCachedAudioResult(cacheKey, result);

                    logTtsInfo(
                        requestId,
                        'success',
                        'status=' + statusCode +
                        ' request_ms=' + requestElapsedMs +
                        ' convert_ms=' + convertElapsedMs +
                        ' total_ms=' + totalElapsedMs +
                        ' cache_store=' + (cacheStored ? 'yes' : 'no') +
                        ' mime=' + (mimeType || 'unknown') +
                        ' pcm_base64_chars=' + pcmBase64.length +
                        ' wav_base64_chars=' + wavBase64.length
                    );

                    finish({ result: result });
                } catch (e) {
                    logTtsError(
                        requestId,
                        'processing_error',
                        'request_ms=' + requestElapsedMs +
                        ' total_ms=' + (nowMs() - requestStartedAt) +
                        ' message=' + sanitizeLogValue(e.message || e)
                    );
                    finish({ error: { type: 'api', message: '音频处理失败', addition: e.message || String(e) } });
                }
            }
        });
    } catch (e) {
        logTtsError(
            requestId,
            'request_setup_error',
            'message=' + sanitizeLogValue(e.message || e)
        );
        finish({ error: { type: 'network', message: '请求发送失败', addition: e.message || String(e) } });
    }
}

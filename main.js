var OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

var supportedLanguageCodes = [
    'zh-Hans', 'zh-Hant', 'yue', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it',
    'ru', 'pt', 'pt-pt', 'pt-br', 'nl', 'pl', 'ar', 'hi', 'tr', 'vi',
    'th', 'id', 'ms', 'uk', 'cs', 'da', 'fi', 'el', 'he', 'hu',
    'no', 'ro', 'sk', 'sv', 'ta'
];

function supportLanguages() {
    return supportedLanguageCodes.slice();
}

function pluginValidate(completion) {
    var apiKey = readOption('apiKey');
    var model = readOption('model');
    var voice = model === 'gpt-4o-mini-tts' ? readOption('voiceMini') : readOption('voice');

    if (!apiKey) {
        completion({ error: { type: 'param', message: 'OpenAI API Key 不能为空。' } });
        return;
    }
    if (!model) {
        completion({ error: { type: 'param', message: '请填写 TTS 模型 ID。' } });
        return;
    }
    if (!voice) {
        completion({ error: { type: 'param', message: '音色不能为空。' } });
        return;
    }

    completion({ result: true });
}

function tts(query, completion) {
    var validationError = validateOptions();
    if (validationError) {
        completion({ error: validationError });
        return;
    }

    if (!query || !query.text || !String(query.text).trim()) {
        completion({ error: { type: 'param', message: '待合成文本不能为空。' } });
        return;
    }

    var model = readOption('model');
    var voice = model === 'gpt-4o-mini-tts' ? readOption('voiceMini') : readOption('voice');
    var speed = parseFloat(readOption('speed')) || 1.0;
    var instructions = readOption('instructions');

    if (!voice) {
        completion({ error: { type: 'param', message: '请先在插件设置中选择音色。' } });
        return;
    }

    var body = {
        model: model,
        input: String(query.text),
        voice: voice,
        response_format: 'mp3',
        speed: speed
    };
    if (instructions && model === 'gpt-4o-mini-tts') {
        body.instructions = instructions;
    }

    $http.request({
        method: 'POST',
        url: OPENAI_TTS_URL,
        header: {
            Authorization: 'Bearer ' + readOption('apiKey'),
            'Content-Type': 'application/json'
        },
        body: body,
        timeout: 60,
        handler: function(resp) {
            if (resp.error) {
                completion({ error: toServiceError(resp.error) });
                return;
            }

            if (resp.response && resp.response.statusCode >= 400) {
                completion({ error: parseHttpError(resp) });
                return;
            }

            if (!resp.rawData) {
                completion({ error: { type: 'api', message: 'OpenAI 没有返回音频数据。' } });
                return;
            }

            var audioBase64 = resp.rawData.toBase64();
            if (!audioBase64) {
                completion({ error: { type: 'api', message: '音频数据转换失败。' } });
                return;
            }

            completion({
                result: {
                    type: 'base64',
                    value: audioBase64,
                    raw: {
                        model: model,
                        voice: voice,
                        format: 'mp3'
                    }
                }
            });
        }
    });
}

function readOption(name) {
    var value = $option[name];
    return value == null ? '' : String(value).trim();
}

function validateOptions() {
    if (!readOption('apiKey')) {
        return { type: 'param', message: '请先在插件设置中填写 OpenAI API Key。' };
    }
    if (!readOption('model')) {
        return { type: 'param', message: '请先填写 TTS 模型 ID。' };
    }
    return null;
}

function parseHttpError(resp) {
    var statusCode = resp.response ? resp.response.statusCode : 0;
    var message = 'OpenAI 请求失败（HTTP ' + statusCode + '）';

    try {
        var body = resp.data;
        if (body && body.error && body.error.message) {
            message = body.error.message;
        }
    } catch (e) {}

    return { type: 'api', message: message };
}

function toServiceError(error) {
    var message = '请求失败';
    if (error) {
        if (typeof error === 'string') {
            message = error;
        } else if (error.localizedDescription) {
            message = error.localizedDescription;
        } else if (error.message) {
            message = error.message;
        }
    }
    return { type: 'network', message: message };
}

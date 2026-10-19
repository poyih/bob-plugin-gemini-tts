'use strict';

// Bob language codes covered by both built-in models. A code is listed only when it
// names an entry of the official table; entries without a Bob code (such as Balinese)
// or limited to a script that the Bob code does not specify (such as Acehnese in
// Arabic script) are left out.
// https://ai.google.dev/gemini-api/docs/speech-generation#supported-languages
var COMMON_LANGUAGES = [
    'auto', 'zh-Hans', 'zh-Hant', 'yue', 'en', 'ja', 'ko',
    'fr', 'de', 'es', 'it', 'pt', 'pt-pt', 'pt-br', 'ru',
    'ar', 'vi', 'id', 'ms', 'tr', 'pl',
    'nl', 'da', 'nb', 'no', 'el', 'cs',
    'ro', 'hu', 'sk', 'bg', 'hr', 'hi',
    'bn', 'ta', 'te', 'ml', 'he', 'fil', 'tl',
    'af', 'ak', 'am', 'as', 'az', 'azb', 'be', 'bho', 'bs', 'ca',
    'ceb', 'ckb', 'et', 'eu', 'fa', 'fuv', 'gl', 'gu', 'ha', 'ht',
    'hy', 'ilo', 'is', 'jv', 'jw', 'ka', 'kg', 'ki', 'kk', 'km',
    'kn', 'ks', 'ky', 'lg', 'ln', 'lo', 'lv', 'mai', 'mk', 'mn',
    'mni', 'mr', 'mt', 'ne', 'nso', 'ny', 'or', 'pa', 'ps', 'rw',
    'si', 'sr', 'sr-Cyrl', 'sr-Latn', 'uz'
];

// Request schemas are capabilities of a particular model, not its version number.
var MODEL_CAPABILITIES = {
    'gemini-3.8-flash-tts': {
        requestFormat: 'verbatim',
        // Supported by Flash but not by Flash-Lite in the official table.
        additionalLanguages: [
            'th', 'sv', 'fi', 'ba', 'bem', 'crh', 'dyu', 'dz', 'gn', 'ig',
            'kab', 'lb', 'lt', 'ltg', 'my', 'oc', 'pag', 'sd', 'sl', 'so',
            'sq', 'ss', 'st', 'sw', 'tg', 'ti', 'ug'
        ]
    },
    'gemini-3.8-flash-lite-tts': { requestFormat: 'verbatim' }
};

// Google's earliest shutdown date for these preview TTS models is 2026-11-17.
// Saved menu values and standard model paths keep working by calling the replacement.
var RETIRED_MODELS = {
    'gemini-3.1-flash-tts-preview': 'gemini-3.8-flash-tts',
    'gemini-2.5-pro-preview-tts': 'gemini-3.8-flash-tts',
    'gemini-2.5-flash-preview-tts': 'gemini-3.8-flash-tts'
};

function routeSpeechModel(model) {
    var original = String(model == null ? '' : model).trim();
    var key = original.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(RETIRED_MODELS, key)) {
        return {
            model: RETIRED_MODELS[key],
            retiredFrom: key
        };
    }
    return { model: original, retiredFrom: '' };
}

function resolveRequestFormat(model, override) {
    var format = String(override || 'auto').trim();
    if (format === 'legacy' || format === 'verbatim') {
        return format;
    }
    var error;
    if (format !== 'auto') {
        error = new Error('语音请求格式无效');
        error.pluginError = { type: 'param', message: error.message,
            addition: '请从插件设置中的请求格式列表重新选择' };
        throw error;
    }

    var name = routeSpeechModel(model).model.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES, name)) {
        return MODEL_CAPABILITIES[name].requestFormat;
    }
    error = new Error('无法自动识别模型的语音请求格式');
    error.pluginError = { type: 'param', message: error.message,
        addition: '未知模型或代理别名请在“请求格式”中明确选择 3.8 格式或旧版格式' };
    throw error;
}

function getSupportedLanguages(model) {
    var name = routeSpeechModel(model).model.toLowerCase();
    var additional = Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES, name) ?
        MODEL_CAPABILITIES[name].additionalLanguages || [] :
        MODEL_CAPABILITIES['gemini-3.8-flash-tts'].additionalLanguages;
    // Unknown aliases may map to Flash. Keep those languages available in Bob;
    // only known models have an authoritative coverage limit for preflight.
    // Return a new array so host callers cannot mutate the capability table.
    return COMMON_LANGUAGES.concat(additional);
}

function isKnownModel(model) {
    return Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES,
        routeSpeechModel(model).model.toLowerCase());
}

module.exports = {
    capabilities: MODEL_CAPABILITIES,
    retiredModels: RETIRED_MODELS,
    routeSpeechModel: routeSpeechModel,
    resolveRequestFormat: resolveRequestFormat,
    getSupportedLanguages: getSupportedLanguages,
    isKnownModel: isKnownModel
};

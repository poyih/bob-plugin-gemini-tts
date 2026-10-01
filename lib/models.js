'use strict';

// Request schemas are capabilities of a particular model, not its version number.
var MODEL_CAPABILITIES = {
    'gemini-3.8-flash-tts': { requestFormat: 'verbatim' },
    'gemini-3.8-flash-lite-tts': { requestFormat: 'verbatim' },
    'gemini-3.1-flash-tts-preview': { requestFormat: 'legacy' },
    'gemini-2.5-pro-preview-tts': { requestFormat: 'legacy' },
    'gemini-2.5-flash-preview-tts': { requestFormat: 'legacy' }
};

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

    var name = String(model || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES, name)) {
        return MODEL_CAPABILITIES[name].requestFormat;
    }
    error = new Error('无法自动识别模型的语音请求格式');
    error.pluginError = { type: 'param', message: error.message,
        addition: '未知模型或代理别名请在“请求格式”中明确选择 3.8 格式或旧版格式' };
    throw error;
}

module.exports = {
    capabilities: MODEL_CAPABILITIES,
    resolveRequestFormat: resolveRequestFormat
};

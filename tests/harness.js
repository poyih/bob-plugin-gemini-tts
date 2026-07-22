'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN_PATH = path.resolve(__dirname, '..', 'main.js');
const MAIN_SOURCE = fs.readFileSync(MAIN_PATH, 'utf8');

function defaultOptions(overrides) {
    return Object.assign({
        apiKey: 'test-api-key',
        apiUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-3.1-flash-tts-preview',
        voice: 'Kore',
        instructions: ''
    }, overrides || {});
}

function createHarness(config) {
    config = config || {};

    let currentTime = config.now == null ? 1_700_000_000_000 : config.now;
    const requests = [];
    const logs = [];
    const responses = Array.from(config.responses || []);

    class FakeDate extends Date {
        constructor() {
            if (arguments.length === 0) {
                super(currentTime);
            } else {
                super(...arguments);
            }
        }

        static now() {
            return currentTime;
        }
    }

    const context = {
        $option: defaultOptions(config.options),
        $log: {
            info(message) {
                logs.push({ level: 'info', message: String(message) });
            },
            error(message) {
                logs.push({ level: 'error', message: String(message) });
            }
        },
        $http: {
            request(request) {
                requests.push(request);

                if (responses.length === 0) {
                    throw new Error('Unexpected HTTP request #' + requests.length);
                }

                const queued = responses.shift();
                if (typeof queued === 'function') {
                    return queued(request, requests.length);
                }

                request.handler(queued);
            }
        },
        Date: FakeDate,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        ArrayBuffer,
        DataView,
        Uint8Array
    };

    vm.createContext(context);
    new vm.Script(MAIN_SOURCE, { filename: MAIN_PATH }).runInContext(context);

    return {
        context,
        requests,
        logs,
        remainingResponses: responses,
        setNow(value) {
            currentTime = value;
        },
        advanceTime(deltaMs) {
            currentTime += deltaMs;
        },
        evaluate(expression) {
            return vm.runInContext(expression, context);
        }
    };
}

function waitForCompletion(invoke, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let completionCalls = 0;
        let firstValue;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error((label || 'plugin operation') + ' did not call completion'));
            }
        }, 1_000);

        try {
            invoke((value) => {
                completionCalls += 1;
                if (completionCalls > 1) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error((label || 'plugin operation') + ' called completion more than once'));
                    return;
                }
                firstValue = value;

                // Resolve on the next turn so a same-turn duplicate completion is
                // observable instead of being silently ignored by Promise semantics.
                setImmediate(() => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve(firstValue);
                    }
                });
            });
        } catch (error) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        }
    });
}

function callTts(harness, text, lang) {
    return waitForCompletion(
        (completion) => harness.context.tts({ text, lang: lang || 'en' }, completion),
        'tts'
    );
}

function callValidate(harness) {
    return waitForCompletion(
        (completion) => harness.context.pluginValidate(completion),
        'pluginValidate'
    );
}

function successResponse(options) {
    options = options || {};
    return {
        response: { statusCode: 200 },
        data: {
            candidates: [{
                finishReason: options.finishReason == null ? 'STOP' : options.finishReason,
                content: {
                    parts: [{
                        inlineData: {
                            // Two bytes: the smallest valid mono, 16-bit PCM frame.
                            data: options.pcmBase64 || 'AAA=',
                            mimeType: options.mimeType || 'audio/L16;rate=24000'
                        }
                    }]
                }
            }]
        }
    };
}

function httpErrorResponse(statusCode, message) {
    return {
        response: { statusCode },
        data: { error: { message: message || 'request failed' } }
    };
}

module.exports = {
    MAIN_PATH,
    createHarness,
    callTts,
    callValidate,
    successResponse,
    httpErrorResponse
};

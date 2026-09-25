'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createHarness,
    callTts,
    callValidate,
    successResponse,
    httpErrorResponse
} = require('./harness');

function promptFrom(request) {
    return request.body.contents[0].parts[0].text;
}

// Objects built inside the plugin's vm context carry that realm's prototypes,
// so strict deep equality needs a plain-JSON copy first.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
const VERBATIM_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
const LEGACY_MODELS = [
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-flash-preview-tts'
];
const LEGACY_MODEL = LEGACY_MODELS[0];

test('legacy TTS requests use an explicit audio-only prompt and transcript boundary', async () => {
    for (const instructions of ['', 'Speak in a calm, reassuring voice']) {
        const harness = createHarness({
            options: { model: LEGACY_MODEL, instructions },
            responses: [successResponse()]
        });

        const output = await callTts(harness, 'Hello from the transcript.');
        assert.ok(output.result, 'the mocked STOP response should succeed');
        assert.equal(harness.requests.length, 1);

        const prompt = promptFrom(harness.requests[0]);
        assert.notEqual(prompt, 'Hello from the transcript.');
        assert.match(prompt, /(?:TTS|text[- ]to[- ]speech)/i);
        assert.match(prompt, /audio/i);
        assert.match(prompt, /transcript/i);

        if (instructions) {
            assert.ok(
                prompt.indexOf(instructions) < prompt.indexOf('Hello from the transcript.'),
                'style instructions must be kept separate from and before the transcript'
            );
        }
    }
});

for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'PROHIBITED_CONTENT']) {
    test(`${finishReason} audio is rejected and never cached`, async () => {
        const harness = createHarness({
            responses: [
                successResponse({ finishReason }),
                successResponse({ finishReason })
            ]
        });

        const first = await callTts(harness, 'Do not cache partial audio.');
        const second = await callTts(harness, 'Do not cache partial audio.');

        assert.ok(first.error, `${finishReason} must be surfaced as an error`);
        assert.ok(second.error, `${finishReason} must still be an error on repeat`);
        assert.equal(
            harness.requests.length,
            2,
            'the second call must reach the API instead of hitting cache'
        );
    });
}

test('TTS retries one transient 500 and returns the successful retry', async () => {
    const harness = createHarness({
        responses: [
            httpErrorResponse(500, 'transient model error'),
            successResponse()
        ]
    });

    const output = await callTts(harness, 'Retry this once.');
    assert.ok(output.result);
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(
        JSON.parse(JSON.stringify(harness.requests[0].body)),
        JSON.parse(JSON.stringify(harness.requests[1].body)),
        'retry must preserve the request payload'
    );
});

test('TTS performs at most one retry for repeated 500 responses', async () => {
    const harness = createHarness({
        responses: [
            httpErrorResponse(500, 'first failure'),
            httpErrorResponse(500, 'second failure')
        ]
    });

    const output = await callTts(harness, 'Fail after one retry.');
    assert.ok(output.error);
    assert.equal(harness.requests.length, 2);
});

test('validation also retries one transient 500', async () => {
    const harness = createHarness({
        responses: [httpErrorResponse(500), successResponse()]
    });

    const output = await callValidate(harness);
    assert.equal(output.result, true);
    assert.equal(harness.requests.length, 2);
});

for (const malformedData of [
    '<html><body>proxy login page</body></html>',
    { ok: true },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not audio' }] } }] }
]) {
    test('validation rejects an HTTP 200 response without Gemini audio', async () => {
        const harness = createHarness({
            responses: [{ response: { statusCode: 200 }, data: malformedData }]
        });

        const output = await callValidate(harness);
        assert.equal(output.result, false);
        assert.ok(output.error);
        assert.equal(harness.requests.length, 1);
    });
}

test('custom API URL parsing distinguishes origins from complete paths and preserves query strings', () => {
    const model = 'gemini-3.1-flash-tts-preview';
    const cases = [
        [
            'https://proxy.example',
            `https://proxy.example/v1beta/models/${model}:generateContent`
        ],
        [
            'https://proxy.example/?token=a%2Fb',
            `https://proxy.example/v1beta/models/${model}:generateContent?token=a%2Fb`
        ],
        [
            'https://proxy.example/v1beta',
            `https://proxy.example/v1beta/models/${model}:generateContent`
        ],
        [
            'https://proxy.example/v1beta/models',
            `https://proxy.example/v1beta/models/${model}:generateContent`
        ],
        [
            'https://proxy.example/custom/tts',
            'https://proxy.example/custom/tts'
        ],
        [
            'https://proxy.example/custom/tts?token=a%2Fb&mode=1',
            'https://proxy.example/custom/tts?token=a%2Fb&mode=1'
        ],
        [
            'https://proxy.example/v1beta/models/gemini-2.5-pro-preview-tts?alt=json',
            'https://proxy.example/v1beta/models/gemini-2.5-pro-preview-tts:generateContent?alt=json'
        ],
        [
            'https://proxy.example/custom:generateContent?token=abc',
            'https://proxy.example/custom:generateContent?token=abc'
        ]
    ];

    for (const [apiUrl, expected] of cases) {
        const harness = createHarness({ options: { apiUrl, model } });
        assert.equal(harness.context.getApiUrl(), expected, apiUrl);
    }
});

test('a fixed-model endpoint reports the model that is actually called', async () => {
    const harness = createHarness({
        options: {
            apiUrl: 'https://proxy.example/v1beta/models/gemini-2.5-pro-preview-tts',
            model: 'gemini-3.1-flash-tts-preview'
        },
        responses: [successResponse()]
    });

    const output = await callTts(harness, 'Use the endpoint model.');
    assert.equal(
        output.result.raw.model,
        'gemini-2.5-pro-preview-tts',
        'metadata must not claim the menu model when the endpoint fixes another model'
    );
});

for (const apiUrl of [
    'http://example.com',
    'http://proxy.example/custom/tts',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example'
]) {
    test(`plain HTTP is rejected for non-loopback URL: ${apiUrl}`, async () => {
        const harness = createHarness({ options: { apiUrl } });
        const output = await callValidate(harness);

        assert.equal(output.result, false);
        assert.equal(harness.requests.length, 0, 'the API key must never be sent over plain HTTP');
        assert.ok(output.error);
    });
}

for (const apiUrl of [
    'https://user:password@proxy.example/custom/tts',
    'https://proxy.example/custom/tts#fragment',
    'https://proxy.example/v1beta/models/model%0AFORGED',
    'https://%zz',
    'https://.',
    'https://-',
    'https://[not-ipv6]'
]) {
    test(`ambiguous or unsafe API URL is rejected: ${apiUrl}`, async () => {
        const harness = createHarness({ options: { apiUrl } });
        const output = await callValidate(harness);
        assert.equal(output.result, false);
        assert.equal(harness.requests.length, 0);
    });
}

for (const apiUrl of [
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://[::1]:8787'
]) {
    test(`plain HTTP remains available for loopback development: ${apiUrl}`, () => {
        const harness = createHarness({ options: { apiUrl } });
        assert.equal(harness.context.validateOptions(), null);
    });
}

test('base64 decoder accepts canonical standard and URL-safe payloads', () => {
    const harness = createHarness();

    assert.deepEqual(Array.from(harness.context.base64Decode('AQIDBA==')), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(harness.context.base64Decode('-_8=')), [251, 255]);
    assert.deepEqual(Array.from(harness.context.base64Decode('AQID\nBA==')), [1, 2, 3, 4]);
});

test('base64 decoder rejects empty, malformed, over-padded, and non-canonical payloads', () => {
    const harness = createHarness();
    const invalidPayloads = [
        '',
        '=',
        '====',
        'A',
        'AA=',
        'AAA==',
        'AA===',
        'AA=A',
        'AA$=',
        'AB==',
        'AAF='
    ];

    for (const payload of invalidPayloads) {
        assert.throws(
            () => harness.context.base64Decode(payload),
            JSON.stringify(payload)
        );
    }
});

test('PCM conversion accepts aligned L16 data and writes the declared sample rate', () => {
    const harness = createHarness();
    const wavBase64 = harness.context.pcmToWav('AAECAw==', 'audio/L16;rate=22050');
    const wav = Buffer.from(wavBase64, 'base64');

    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 22050);
    assert.equal(wav.readUInt32LE(40), 4);
});

test('PCM sample-rate parsing does not mistake bitrate for rate', () => {
    const harness = createHarness();
    const wavBase64 = harness.context.pcmToWav('AAE=', 'audio/L16;bitrate=128000');
    const wav = Buffer.from(wavBase64, 'base64');

    assert.equal(wav.readUInt32LE(24), 24000);
});

test('PCM conversion rejects empty or frame-misaligned data and non-PCM MIME types', () => {
    const invalidInputs = [
        ['', 'audio/L16;rate=24000'],
        ['AA==', 'audio/L16;rate=24000'],
        ['AAE=', undefined],
        ['AAE=', ''],
        ['AAE=', 'audio/flac'],
        ['AAE=', 'audio/wav'],
        ['AAE=', 'text/plain']
    ];

    for (const [payload, mimeType] of invalidInputs) {
        const harness = createHarness();
        assert.throws(
            () => harness.context.pcmToWav(payload, mimeType),
            `${JSON.stringify(payload)}, ${JSON.stringify(mimeType)}`
        );
    }
});

test('successful STOP audio is cached immediately and expires after its TTL', async () => {
    const harness = createHarness({
        responses: [
            successResponse({ pcmBase64: 'AAE=' }),
            successResponse({ pcmBase64: 'AgM=' })
        ]
    });

    const first = await callTts(harness, 'Cache this successful audio.');
    const immediate = await callTts(harness, 'Cache this successful audio.');

    assert.equal(first.result.raw.cache, 'miss');
    assert.equal(immediate.result.raw.cache, 'hit');
    assert.equal(immediate.result.value, first.result.value);
    assert.equal(harness.requests.length, 1);

    // A cache for generated speech should never survive a full day. Advancing by
    // this much avoids coupling the regression test to a particular short TTL.
    harness.advanceTime(24 * 60 * 60 * 1_000);
    const expired = await callTts(harness, 'Cache this successful audio.');

    assert.equal(expired.result.raw.cache, 'miss');
    assert.notEqual(expired.result.value, first.result.value);
    assert.equal(harness.requests.length, 2);
});

test('prompt boundary selection also avoids markers embedded in style instructions', async () => {
    const harness = createHarness({
        options: {
            model: LEGACY_MODEL,
            instructions: 'Use this literal token as data: <<<BOB_TTS_TRANSCRIPT_BEGIN>>>'
        },
        responses: [successResponse()]
    });

    const output = await callTts(harness, 'The actual transcript.');
    assert.ok(output.result);
    const prompt = promptFrom(harness.requests[0]);
    assert.match(prompt, /<<<BOB_TTS_TRANSCRIPT_1_BEGIN>>>/);
    assert.match(prompt, /<<<BOB_TTS_TRANSCRIPT_1_END>>>/);
});

test('prompt feedback blocks and missing finish reasons are rejected without caching', async () => {
    const blocked = {
        response: { statusCode: 200 },
        data: { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'blocked' } }
    };
    const missingFinishReason = successResponse();
    delete missingFinishReason.data.candidates[0].finishReason;
    const harness = createHarness({
        responses: [blocked, blocked, missingFinishReason, missingFinishReason]
    });

    assert.ok((await callTts(harness, 'Blocked prompt.')).error);
    assert.ok((await callTts(harness, 'Blocked prompt.')).error);
    assert.ok((await callTts(harness, 'Missing reason.')).error);
    assert.ok((await callTts(harness, 'Missing reason.')).error);
    assert.equal(harness.requests.length, 4);
});

test('audio can appear after non-audio parts but multiple audio parts are rejected', async () => {
    const laterAudio = {
        response: { statusCode: 200 },
        data: {
            candidates: [{
                finishReason: 'STOP',
                content: {
                    parts: [
                        { inlineData: { data: 'iVBORw==', mimeType: 'image/png' } },
                        { text: 'metadata' },
                        { inlineData: { data: 'AAE=', mimeType: 'audio/L16;rate=24000' } }
                    ]
                }
            }]
        }
    };
    const multipleAudio = {
        response: { statusCode: 200 },
        data: {
            candidates: [{
                finishReason: 'STOP',
                content: {
                    parts: [
                        { inlineData: { data: 'AAE=', mimeType: 'audio/L16;rate=24000' } },
                        { inlineData: { data: 'AgM=', mimeType: 'audio/L16;rate=24000' } }
                    ]
                }
            }]
        }
    };
    const successHarness = createHarness({ responses: [laterAudio] });
    const rejectionHarness = createHarness({ responses: [multipleAudio, multipleAudio] });

    assert.ok((await callTts(successHarness, 'Find the audio part.')).result);
    assert.ok((await callTts(rejectionHarness, 'Reject ambiguous audio.')).error);
    assert.ok((await callTts(rejectionHarness, 'Reject ambiguous audio.')).error);
    assert.equal(rejectionHarness.requests.length, 2);
});

test('oversized MIME metadata is rejected before audio processing', async () => {
    const harness = createHarness({
        responses: [successResponse({ mimeType: 'audio/' + ' '.repeat(10_000) })]
    });
    const output = await callTts(harness, 'Reject oversized MIME metadata.');
    assert.ok(output.error);
});

test('an HTTP 200 Gemini error envelope cannot be masked by a candidate', async () => {
    const data = successResponse().data;
    data.error = { message: 'must fail' };
    const harness = createHarness({
        responses: [
            { response: { statusCode: 200 }, data },
            { response: { statusCode: 200 }, data }
        ]
    });

    assert.ok((await callTts(harness, 'Do not accept mixed envelopes.')).error);
    assert.ok((await callTts(harness, 'Do not accept mixed envelopes.')).error);
    assert.equal(harness.requests.length, 2);
});

test('API keys echoed by upstream errors are redacted from results and logs', async () => {
    const apiKey = 'AIza-DEMO-SECRET';
    const harness = createHarness({
        options: { apiKey },
        responses: [httpErrorResponse(400, `invalid API key ${apiKey}`)]
    });

    const output = await callTts(harness, 'Redact credentials.');
    assert.ok(output.error);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(apiKey));
    assert.doesNotMatch(JSON.stringify(harness.logs), new RegExp(apiKey));
    assert.match(JSON.stringify(output), /REDACTED/);
});

test('object and oversized upstream error messages are normalized and capped', async () => {
    const objectHarness = createHarness({
        responses: [{
            response: { statusCode: '400' },
            data: { error: { message: { secret: 'nested' } } }
        }]
    });
    const longHarness = createHarness({
        responses: [httpErrorResponse(400, 'x'.repeat(10_000))]
    });

    const objectOutput = await callTts(objectHarness, 'Normalize errors.');
    const longOutput = await callTts(longHarness, 'Cap errors.');
    assert.equal(typeof objectOutput.error.message, 'string');
    assert.match(objectOutput.error.message, /secret=nested/);
    assert.ok(longOutput.error.message.length <= 500);
});

test('only HTTP 500 is retried and retry attempts share the original time budget', async () => {
    const noRetryHarness = createHarness({ responses: [httpErrorResponse(502)] });
    assert.ok((await callTts(noRetryHarness, 'Do not retry 502.')).error);
    assert.equal(noRetryHarness.requests.length, 1);

    let budgetHarness;
    budgetHarness = createHarness({
        responses: [
            (request) => {
                budgetHarness.advanceTime(20_000);
                request.handler(httpErrorResponse(500));
            },
            successResponse()
        ]
    });
    assert.ok((await callTts(budgetHarness, 'Share the retry budget.')).result);
    assert.equal(budgetHarness.requests[0].timeout, 115);
    assert.equal(budgetHarness.requests[1].timeout, 95);
});

test('input limits reject oversized text and instructions before any network request', async () => {
    const textHarness = createHarness();
    const instructionHarness = createHarness({
        options: { instructions: 'i'.repeat(1001) }
    });

    assert.ok((await callTts(textHarness, 'x'.repeat(4001))).error);
    assert.equal(textHarness.requests.length, 0);
    const validation = await callValidate(instructionHarness);
    assert.equal(validation.result, false);
    assert.equal(instructionHarness.requests.length, 0);

    const credentialHarness = createHarness({ options: { apiKey: 'key\nInjected: value' } });
    const credentialValidation = await callValidate(credentialHarness);
    assert.equal(credentialValidation.result, false);
    assert.equal(credentialHarness.requests.length, 0);
});

test('cache entries are isolated when the API credential changes', async () => {
    const harness = createHarness({
        responses: [
            successResponse({ pcmBase64: 'AAE=' }),
            successResponse({ pcmBase64: 'AgM=' })
        ]
    });

    const first = await callTts(harness, 'Credential-specific cache.');
    harness.context.$option.apiKey = 'second-api-key';
    const second = await callTts(harness, 'Credential-specific cache.');
    assert.equal(harness.requests.length, 2);
    assert.notEqual(first.result.value, second.result.value);
});

test('PCM parameter parsing rejects ambiguous declarations and wrong sample formats', () => {
    const harness = createHarness();
    for (const mimeType of [
        'audio/L16;rate="24000',
        'audio/L16;rate=24000"',
        'audio/L16;rate"=8000',
        'audio/L16;rate=24000;rate=22050',
        'audio/L16;codec=pcm;codec=pcm',
        'audio/pcm;bits=8',
        'audio/raw;bitdepth=32',
        'audio/L16;endianness=big',
        'audio/L16;note=unknown'
    ]) {
        assert.throws(() => harness.context.pcmToWav('AAE=', mimeType), /(?:PCM|audio|mimeType|duplicate)/i);
    }

    const quoted = Buffer.from(
        harness.context.pcmToWav('AAE=', 'audio/L16;codec="pcm";rate="24000"'),
        'base64'
    );
    assert.equal(quoted.readUInt32LE(24), 24000);
});

test('decoded PCM size is capped before WAV allocation', () => {
    const harness = createHarness();
    harness.evaluate('MAX_PCM_BYTES = 2');
    assert.throws(
        () => harness.context.pcmToWav('AAECAw==', 'audio/L16;rate=24000'),
        /12 MiB|limit|exceed/i
    );
});

function nativeDataApi(appendReturnsNewObject, onDecode, exposesLength) {
    function wrap(buffer) {
        const data = {
            _buffer: buffer,
            appendData(other) {
                const combined = Buffer.concat([this._buffer, other._buffer]);
                if (appendReturnsNewObject) {
                    return wrap(combined);
                }
                this._buffer = combined;
                return undefined;
            },
            toBase64() {
                return this._buffer.toString('base64');
            }
        };
        if (exposesLength !== false) {
            Object.defineProperty(data, 'length', {
                get() {
                    return this._buffer.length;
                }
            });
        }
        return data;
    }

    return {
        fromBase64(value) {
            if (onDecode) onDecode();
            return wrap(Buffer.from(value, 'base64'));
        },
        fromByteArray(value) {
            return wrap(Buffer.from(value));
        }
    };
}

for (const appendReturnsNewObject of [false, true]) {
    test(`Bob $data WAV path supports appendData ${appendReturnsNewObject ? 'returning a new object' : 'mutating in place'}`, () => {
        const harness = createHarness();
        harness.context.$data = nativeDataApi(appendReturnsNewObject);
        const wav = Buffer.from(
            harness.context.pcmToWav('AAECAw==', 'audio/L16;codec=pcm;rate=24000'),
            'base64'
        );

        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.readUInt32LE(40), 4);
        assert.deepEqual(Array.from(wav.subarray(44)), [0, 1, 2, 3]);
    });
}

test('Bob 1.20 $data WAV path works when native data has no length property', () => {
    const harness = createHarness();
    harness.context.$data = nativeDataApi(false, null, false);
    const wav = Buffer.from(
        harness.context.pcmToWav('AAECAw==', 'audio/L16;codec=pcm;rate=24000'),
        'base64'
    );

    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), 4);
    assert.deepEqual(Array.from(wav.subarray(44)), [0, 1, 2, 3]);
});

test('audio that crosses the total deadline during conversion is not cached', async () => {
    let firstDecode = true;
    const harness = createHarness({
        responses: [successResponse(), successResponse({ pcmBase64: 'AgM=' })]
    });
    harness.context.$data = nativeDataApi(false, () => {
        if (firstDecode) {
            firstDecode = false;
            harness.advanceTime(116_000);
        }
    });

    const timedOut = await callTts(harness, 'Deadline-safe cache.');
    const retried = await callTts(harness, 'Deadline-safe cache.');
    assert.ok(timedOut.error);
    assert.ok(retried.result);
    assert.equal(harness.requests.length, 2);
});

test('test harness detects duplicate same-turn completion callbacks', async () => {
    const harness = createHarness();
    harness.context.tts = function (_query, completion) {
        completion({ result: { value: 'first' } });
        completion({ result: { value: 'second' } });
    };

    await assert.rejects(() => callTts(harness, 'duplicate'), /more than once/);
});

// ---- Gemini 3.8 request format ----

test('the default model is Gemini 3.8 Flash TTS', () => {
    const harness = createHarness({ options: { model: '' } });
    assert.equal(harness.context.getModel(), DEFAULT_MODEL);
    assert.equal(
        harness.context.getApiUrl(),
        `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`
    );
});

for (const model of VERBATIM_MODELS) {
    test(`${model} requests send the transcript verbatim and carry style in speech_metadata`, async () => {
        const text = 'Say cheerfully: [whispers] read every word of this line.';
        for (const instructions of ['', 'Whisper slowly, as if sharing a secret']) {
            const harness = createHarness({
                options: { model, instructions },
                responses: [successResponse()]
            });

            const output = await callTts(harness, text);
            assert.ok(output.result, 'the mocked STOP response should succeed');
            assert.equal(output.result.raw.model, model);

            const body = harness.requests[0].body;
            assert.equal(body.contents.length, 1);
            assert.equal(body.contents[0].parts.length, 1);
            const part = body.contents[0].parts[0];
            assert.equal(part.text, text, 'no wrapper prompt may be spoken by a verbatim model');
            if (instructions) {
                assert.deepEqual(plain(part.speech_metadata), { style: instructions });
            } else {
                assert.equal('speech_metadata' in part, false);
            }
            assert.deepEqual(plain(body.generationConfig.responseModalities), ['AUDIO']);
            assert.deepEqual(plain(body.generationConfig.speechConfig), { voiceConfig: { voice: 'Kore' } });
            assert.match(JSON.stringify(harness.logs), /request=verbatim/);
        }
    });
}

for (const model of LEGACY_MODELS) {
    test(`${model} keeps the marker prompt and prebuiltVoiceConfig`, async () => {
        const harness = createHarness({
            options: { model, instructions: 'Calm and even' },
            responses: [successResponse()]
        });

        const output = await callTts(harness, 'Legacy transcript.');
        assert.ok(output.result);

        const body = harness.requests[0].body;
        const part = body.contents[0].parts[0];
        assert.match(part.text, /<<<BOB_TTS_TRANSCRIPT_BEGIN>>>/);
        assert.match(part.text, /Calm and even/);
        assert.equal('speech_metadata' in part, false);
        assert.deepEqual(
            plain(body.generationConfig.speechConfig),
            { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        );
        assert.match(JSON.stringify(harness.logs), /request=legacy-prompt/);
    });
}

test('the request format follows the endpoint model rather than the menu model', async () => {
    const legacyEndpoint = createHarness({
        options: {
            model: DEFAULT_MODEL,
            apiUrl: `https://proxy.example/v1beta/models/${LEGACY_MODEL}`
        },
        responses: [successResponse()]
    });
    const verbatimEndpoint = createHarness({
        options: {
            model: LEGACY_MODEL,
            apiUrl: 'https://proxy.example/v1beta/models/gemini-3.8-flash-lite-tts'
        },
        responses: [successResponse()]
    });

    assert.ok((await callTts(legacyEndpoint, 'Route by endpoint.')).result);
    assert.ok((await callTts(verbatimEndpoint, 'Route by endpoint.')).result);

    const legacyBody = legacyEndpoint.requests[0].body;
    assert.match(promptFrom(legacyEndpoint.requests[0]), /transcript/i);
    assert.equal(legacyBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');

    const verbatimBody = verbatimEndpoint.requests[0].body;
    assert.equal(promptFrom(verbatimEndpoint.requests[0]), 'Route by endpoint.');
    assert.equal(verbatimBody.generationConfig.speechConfig.voiceConfig.voice, 'Kore');
});

test('model family detection treats 2.x and 3.0-3.7 as legacy and everything newer as verbatim', () => {
    const harness = createHarness();
    for (const model of [
        ...LEGACY_MODELS,
        'gemini-2.0-flash',
        'gemini-3.0-flash-tts',
        'gemini-3.7-pro-tts',
        ' GEMINI-3.1-FLASH-TTS-PREVIEW '
    ]) {
        assert.equal(harness.context.usesLegacySpeechPrompt(model), true, model);
    }
    for (const model of [
        ...VERBATIM_MODELS,
        'gemini-3.8-flash-tts-preview-10-2026',
        'gemini-3.10-flash-tts',
        'gemini-4-flash-tts',
        'custom-proxy-tts',
        '',
        undefined
    ]) {
        assert.equal(harness.context.usesLegacySpeechPrompt(model), false, String(model));
    }
});

test('validation sends the same request shape as playback, including configured instructions', async () => {
    const verbatim = createHarness({
        options: { instructions: 'Warm and slow' },
        responses: [successResponse()]
    });
    assert.equal((await callValidate(verbatim)).result, true);
    const part = verbatim.requests[0].body.contents[0].parts[0];
    assert.equal(part.text, 'Hi');
    assert.deepEqual(plain(part.speech_metadata), { style: 'Warm and slow' });
    assert.equal(verbatim.requests[0].body.generationConfig.speechConfig.voiceConfig.voice, 'Kore');

    const bare = createHarness({ responses: [successResponse()] });
    assert.equal((await callValidate(bare)).result, true);
    assert.equal('speech_metadata' in bare.requests[0].body.contents[0].parts[0], false);

    const legacy = createHarness({
        options: { model: LEGACY_MODEL, instructions: 'Warm and slow' },
        responses: [successResponse()]
    });
    assert.equal((await callValidate(legacy)).result, true);
    const legacyPrompt = promptFrom(legacy.requests[0]);
    assert.match(legacyPrompt, /Warm and slow/);
    assert.match(legacyPrompt, /<<<BOB_TTS_TRANSCRIPT_BEGIN>>>\nHi\n<<<BOB_TTS_TRANSCRIPT_END>>>/);
    assert.equal(legacy.requests[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
});

// ---- WAV responses (Gemini 3.8 default output) ----

function fmtChunk(options) {
    options = options || {};
    const channels = options.channels == null ? 1 : options.channels;
    const bits = options.bits == null ? 16 : options.bits;
    const sampleRate = options.sampleRate == null ? 24000 : options.sampleRate;
    const blockAlign = options.blockAlign == null ? channels * bits / 8 : options.blockAlign;
    const size = options.size == null ? 16 : options.size;
    const chunk = Buffer.alloc(8 + size + (size % 2));
    chunk.write('fmt ', 0, 'ascii');
    chunk.writeUInt32LE(size, 4);
    if (size >= 16) {
        chunk.writeUInt16LE(options.audioFormat == null ? 1 : options.audioFormat, 8);
        chunk.writeUInt16LE(channels, 10);
        chunk.writeUInt32LE(sampleRate, 12);
        chunk.writeUInt32LE(sampleRate * blockAlign, 16);
        chunk.writeUInt16LE(blockAlign, 20);
        chunk.writeUInt16LE(bits, 22);
    }
    if (size >= 40 && options.subFormat != null) {
        chunk.writeUInt16LE(options.cbSize == null ? 22 : options.cbSize, 24);
        chunk.writeUInt16LE(options.validBits == null ? bits : options.validBits, 26);
        chunk.writeUInt32LE(4, 28);
        const guidTail = options.guidTail || [0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71];
        Buffer.from([options.subFormat & 255, options.subFormat >> 8, 0, 0, 0, 0, 0x10, 0, ...guidTail]).copy(chunk, 32);
    }
    return chunk;
}

function dataChunk(pcm, declaredSize) {
    const payload = Buffer.from(pcm);
    const chunk = Buffer.alloc(8 + payload.length);
    chunk.write('data', 0, 'ascii');
    chunk.writeUInt32LE(declaredSize == null ? payload.length : declaredSize, 4);
    payload.copy(chunk, 8);
    return chunk;
}

function junkChunk(size) {
    const chunk = Buffer.alloc(8 + size + (size % 2), 0x4a);
    chunk.write('JUNK', 0, 'ascii');
    chunk.writeUInt32LE(size, 4);
    return chunk;
}

function wrapRiff(chunks, riffId, waveId) {
    const body = Buffer.concat([Buffer.from(waveId || 'WAVE', 'ascii'), ...chunks]);
    const header = Buffer.alloc(8);
    header.write(riffId || 'RIFF', 0, 'ascii');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
}

function sequentialPcm(length) {
    return Array.from({ length }, (_, index) => (index * 37 + 11) & 255);
}

function convertWav(harness, wav, mimeType) {
    return Buffer.from(harness.context.audioToWav(wav.toString('base64'), mimeType || 'audio/wav'), 'base64');
}

test('WAV responses are validated and re-wrapped with the plugin WAV header', () => {
    const harness = createHarness();
    const pcm = [0, 1, 2, 3, 4, 5];
    const out = convertWav(harness, wrapRiff([fmtChunk({ sampleRate: 22050 }), dataChunk(pcm)]));

    assert.equal(out.length, 44 + pcm.length);
    assert.equal(out.toString('ascii', 0, 4), 'RIFF');
    assert.equal(out.readUInt32LE(4), 36 + pcm.length);
    assert.equal(out.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.equal(out.readUInt16LE(20), 1);
    assert.equal(out.readUInt16LE(22), 1);
    assert.equal(out.readUInt32LE(24), 22050);
    assert.equal(out.readUInt16LE(34), 16);
    assert.equal(out.toString('ascii', 36, 40), 'data');
    assert.equal(out.readUInt32LE(40), pcm.length);
    assert.deepEqual(Array.from(out.subarray(44)), pcm);
});

test('WAV media type variants and parameters are accepted while PCM types keep the raw path', () => {
    const harness = createHarness();
    const wav = wrapRiff([fmtChunk(), dataChunk([1, 2, 3, 4])]);
    for (const mimeType of [
        'audio/wav',
        'audio/x-wav',
        'audio/wave',
        'audio/vnd.wave',
        'AUDIO/WAV; codec=pcm',
        'audio/wav;rate=24000'
    ]) {
        assert.deepEqual(Array.from(convertWav(harness, wav, mimeType).subarray(44)), [1, 2, 3, 4], mimeType);
    }

    const raw = Buffer.from(harness.context.audioToWav('AAECAw==', 'audio/L16;rate=24000'), 'base64');
    assert.equal(raw.length, 48);
    assert.deepEqual(Array.from(raw.subarray(44)), [0, 1, 2, 3]);
    assert.throws(() => harness.context.audioToWav('AAECAw==', 'audio/flac'), /unsupported audio mimeType/);
    assert.throws(() => harness.context.audioToWav('AAECAw==', 'audio/wav'), /WAV/);
});

test('WAV placeholder data sizes use the whole payload and smaller sizes drop trailing chunks', () => {
    const harness = createHarness();
    const pcm = [5, 6, 7, 8, 9, 10];
    for (const declaredSize of [0, 0xFFFFFFFF, 1_000_000]) {
        const out = convertWav(harness, wrapRiff([fmtChunk(), dataChunk(pcm, declaredSize)]));
        assert.deepEqual(Array.from(out.subarray(44)), pcm, String(declaredSize));
        assert.equal(out.readUInt32LE(40), pcm.length);
    }

    const trailing = wrapRiff([fmtChunk(), dataChunk(pcm, 4), junkChunk(3)]);
    const out = convertWav(harness, trailing);
    assert.deepEqual(Array.from(out.subarray(44)), [5, 6, 7, 8]);
});

test('WAV chunks before the data chunk are skipped and extensible PCM headers are accepted', () => {
    const harness = createHarness();
    const pcm = [1, 2, 3, 4];
    for (const size of [0, 1, 2, 3, 4, 5, 100]) {
        const out = convertWav(harness, wrapRiff([fmtChunk(), junkChunk(size), dataChunk(pcm)]));
        assert.deepEqual(Array.from(out.subarray(44)), pcm, `junk size ${size}`);
    }

    const extensible = wrapRiff([fmtChunk({ audioFormat: 0xFFFE, size: 40, subFormat: 1 }), dataChunk(pcm)]);
    assert.deepEqual(Array.from(convertWav(harness, extensible).subarray(44)), pcm);
    const extensibleUnspecifiedBits = wrapRiff([fmtChunk({ audioFormat: 0xFFFE, size: 40, subFormat: 1, validBits: 0 }), dataChunk(pcm)]);
    assert.deepEqual(Array.from(convertWav(harness, extensibleUnspecifiedBits).subarray(44)), pcm);

    const rejected = [
        ['float sub-format', { subFormat: 3 }, /sub-format/],
        ['PCM-looking GUID with a foreign tail', { subFormat: 1, guidTail: [0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x72] }, /sub-format/],
        ['extension size too small', { subFormat: 1, cbSize: 0 }, /extension size/],
        ['valid bits mismatch', { subFormat: 1, validBits: 24 }, /valid bits/],
        ['extensible tag without extension', { subFormat: 1, size: 16 }, /truncated/]
    ];
    for (const [label, overrides, pattern] of rejected) {
        const wav = wrapRiff([fmtChunk(Object.assign({ audioFormat: 0xFFFE, size: 40 }, overrides)), dataChunk(pcm)]);
        assert.throws(() => convertWav(harness, wav), pattern, label);
    }
});

test('malformed or unsupported WAV payloads are rejected', () => {
    const harness = createHarness();
    const pcm = [1, 2, 3, 4];
    const cases = [
        ['too short', Buffer.from([0, 1])],
        ['RIFX signature', wrapRiff([fmtChunk(), dataChunk(pcm)], 'RIFX')],
        ['not WAVE', wrapRiff([fmtChunk(), dataChunk(pcm)], 'RIFF', 'AVI ')],
        ['stereo', wrapRiff([fmtChunk({ channels: 2 }), dataChunk(pcm)])],
        ['8-bit', wrapRiff([fmtChunk({ bits: 8 }), dataChunk(pcm)])],
        ['float', wrapRiff([fmtChunk({ audioFormat: 3 }), dataChunk(pcm)])],
        ['low sample rate', wrapRiff([fmtChunk({ sampleRate: 4000 }), dataChunk(pcm)])],
        ['bad block align', wrapRiff([fmtChunk({ blockAlign: 4 }), dataChunk(pcm)])],
        ['short fmt', wrapRiff([fmtChunk({ size: 8 }), dataChunk(pcm)])],
        ['data before fmt', wrapRiff([dataChunk(pcm), fmtChunk()])],
        ['missing data', wrapRiff([fmtChunk(), junkChunk(4)])],
        ['missing fmt', wrapRiff([dataChunk(pcm)])],
        ['empty data', wrapRiff([fmtChunk(), dataChunk([])])],
        ['odd frame', wrapRiff([fmtChunk(), dataChunk([1, 2, 3])])],
        ['odd declared frame', wrapRiff([fmtChunk(), dataChunk([1, 2, 3, 4], 3)])],
        ['data beyond scan limit', wrapRiff([fmtChunk(), junkChunk(5000), dataChunk(pcm)])]
    ];

    for (const [label, wav] of cases) {
        assert.throws(() => convertWav(harness, wav), /WAV|PCM/, label);
    }
});

test('decoded WAV PCM size is capped before allocation', () => {
    const harness = createHarness();
    harness.evaluate('MAX_PCM_BYTES = 2');
    assert.throws(
        () => convertWav(harness, wrapRiff([fmtChunk(), dataChunk([1, 2, 3, 4])])),
        /12 MiB|limit|exceed/i
    );
});

for (const appendReturnsNewObject of [false, true]) {
    for (const exposesLength of [true, false]) {
        test(`Bob $data WAV path re-wraps PCM at every base64 alignment (appendData ${appendReturnsNewObject ? 'returns new' : 'mutates'}, length ${exposesLength ? 'exposed' : 'hidden'})`, () => {
            const harness = createHarness();
            harness.context.$data = nativeDataApi(appendReturnsNewObject, null, exposesLength);

            for (const junkSize of [null, 0, 2, 4, 7]) {
                for (const pcmLength of [2, 4, 6, 8, 10, 12, 14]) {
                    for (const trailer of [0, 1, 5]) {
                        const pcm = sequentialPcm(pcmLength);
                        const chunks = [fmtChunk({ sampleRate: 16000 })];
                        if (junkSize != null) {
                            chunks.push(junkChunk(junkSize));
                        }
                        chunks.push(dataChunk(pcm));
                        if (trailer) {
                            chunks.push(Buffer.alloc(trailer, 0xee));
                        }
                        const label = `junk=${junkSize} pcm=${pcmLength} trailer=${trailer}`;
                        const out = convertWav(harness, wrapRiff(chunks));

                        assert.equal(out.length, 44 + pcmLength, label);
                        assert.equal(out.toString('ascii', 0, 4), 'RIFF', label);
                        assert.equal(out.readUInt32LE(24), 16000, label);
                        assert.equal(out.readUInt32LE(40), pcmLength, label);
                        assert.deepEqual(Array.from(out.subarray(44)), pcm, label);
                    }
                }
            }
        });
    }
}

test('Bob $data WAV path rejects a native decode whose length disagrees with the base64 text', () => {
    const harness = createHarness();
    const api = nativeDataApi(false);
    const realFromBase64 = api.fromBase64;
    api.fromBase64 = (value) => {
        const data = realFromBase64(value);
        data._buffer = Buffer.concat([data._buffer, Buffer.from([0])]);
        return data;
    };
    harness.context.$data = api;

    assert.throws(
        () => convertWav(harness, wrapRiff([fmtChunk(), dataChunk(sequentialPcm(12))])),
        /invalid base64 PCM payload/
    );
});

test('a Gemini 3.8 audio/wav response plays, is logged as wav, and is cached', async () => {
    const wav = wrapRiff([fmtChunk(), dataChunk([9, 8, 7, 6])]).toString('base64');
    const harness = createHarness({
        responses: [successResponse({ mimeType: 'audio/wav', pcmBase64: wav })]
    });

    const first = await callTts(harness, 'WAV end to end.');
    assert.ok(first.result, JSON.stringify(first));
    const out = Buffer.from(first.result.value, 'base64');
    assert.equal(out.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(Array.from(out.subarray(44)), [9, 8, 7, 6]);
    assert.match(JSON.stringify(harness.logs), /format=wav/);

    const second = await callTts(harness, 'WAV end to end.');
    assert.equal(second.result.raw.cache, 'hit');
    assert.equal(harness.requests.length, 1);
});

test('a malformed audio/wav response is an error and is never cached', async () => {
    const broken = wrapRiff([fmtChunk({ channels: 2 }), dataChunk([1, 2, 3, 4])]).toString('base64');
    const harness = createHarness({
        responses: [
            successResponse({ mimeType: 'audio/wav', pcmBase64: broken }),
            successResponse({ mimeType: 'audio/wav', pcmBase64: broken })
        ]
    });

    const first = await callTts(harness, 'Broken WAV.');
    const second = await callTts(harness, 'Broken WAV.');
    assert.ok(first.error);
    assert.match(first.error.addition || '', /channel/);
    assert.ok(second.error);
    assert.equal(harness.requests.length, 2);
});

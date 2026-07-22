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

test('production TTS requests use an explicit audio-only prompt and transcript boundary', async () => {
    for (const instructions of ['', 'Speak in a calm, reassuring voice']) {
        const harness = createHarness({
            options: { instructions },
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

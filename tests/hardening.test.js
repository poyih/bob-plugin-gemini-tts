'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createHarness, callTts, callValidate, successResponse, httpErrorResponse } = require('./harness');

function wavPayload(declaredLength, pcm) {
    const harness = createHarness();
    const header = harness.context.buildWavHeader(declaredLength, {
        sampleRate: 24000, numChannels: 1, bitsPerSample: 16
    });
    return Buffer.concat([Buffer.from(header), Buffer.from(pcm)]);
}

function wavResponse(wav) {
    return successResponse({ mimeType: 'audio/wav', pcmBase64: wav.toString('base64') });
}

test('truncated RIFF and finite data declarations fail validation/playback and are never cached', async () => {
    const truncatedRiff = wavPayload(8, [1, 2, 3, 4]);
    const truncatedData = Buffer.from(truncatedRiff);
    truncatedData.writeUInt32LE(truncatedData.length - 8, 4);
    for (const wav of [truncatedRiff, truncatedData]) {
        const harness = createHarness({ responses: [wavResponse(wav), wavResponse(wav), wavResponse(wav)] });
        assert.ok((await callTts(harness, 'Truncated audio.')).error);
        assert.ok((await callTts(harness, 'Truncated audio.')).error);
        assert.equal((await callValidate(harness)).result, false);
        assert.equal(harness.requests.length, 3);
    }
});

test('finite RIFF boundaries must match the payload; only explicit streaming sentinels bypass them', () => {
    const harness = createHarness();
    const wav = wavPayload(4, [1, 2, 3, 4]);
    for (const riffSize of [wav.length - 10, wav.length - 6]) {
        const malformed = Buffer.from(wav);
        malformed.writeUInt32LE(riffSize, 4);
        assert.throws(() => harness.context.audioToWav(malformed.toString('base64'), 'audio/wav'), /RIFF length/);
    }
    for (const riffSize of [0, 0xFFFFFFFF]) {
        for (const dataSize of [0, 0xFFFFFFFF]) {
            const streamed = Buffer.from(wav);
            streamed.writeUInt32LE(riffSize, 4);
            streamed.writeUInt32LE(dataSize, 40);
            const output = Buffer.from(harness.context.audioToWav(streamed.toString('base64'), 'audio/wav'), 'base64');
            assert.deepEqual(output.subarray(44), Buffer.from([1, 2, 3, 4]));
        }
    }
});

test('an ordinary oversized data size is not treated as a streaming placeholder', () => {
    const harness = createHarness();
    const wav = wavPayload(4, [1, 2, 3, 4]);
    wav.writeUInt32LE(1_000_000, 40);
    assert.throws(() => harness.context.audioToWav(wav.toString('base64'), 'audio/wav'), /data chunk is truncated/);
});

test('missing, empty, or malformed additional audio parts cannot mask an incomplete response', async () => {
    for (const blob of [
        { mimeType: 'audio/L16;rate=24000', data: '' },
        { mimeType: 'audio/wav' },
        { mimeType: 'audio/wav', data: 1 },
        { mimeType: 'audio/' + 'x'.repeat(513), data: 'AAA=' },
        { data: 'AAA=' }
    ]) {
        const response = successResponse();
        response.data.candidates[0].content.parts.push({ inlineData: blob });
        const harness = createHarness({ responses: [response, response, response] });
        assert.ok((await callTts(harness, 'Incomplete segments.')).error);
        assert.ok((await callTts(harness, 'Incomplete segments.')).error);
        assert.equal((await callValidate(harness)).result, false);
        assert.equal(harness.requests.length, 3);
    }
});

test('object error values and keys are redacted before any truncation', async () => {
    const apiKey = 'AIza-DEMO-' + 'S'.repeat(30);
    const keyPrefix = apiKey.substring(0, 17);
    for (const message of [
        { detail: 'x'.repeat(180) + apiKey },
        { ['x'.repeat(180) + apiKey]: 'bad credential' },
        apiKey.repeat(60) + ' invalid'
    ]) {
        const harness = createHarness({ options: { apiKey }, responses: [httpErrorResponse(400, message)] });
        const output = await callTts(harness, 'Redact structured errors.');
        assert.ok(output.error);
        assert.ok(!JSON.stringify(output).includes(keyPrefix));
        assert.ok(!JSON.stringify(harness.logs).includes(keyPrefix));
        assert.match(JSON.stringify(output), /REDACTED/);
        assert.ok(output.error.message.length <= 500);
    }
});

test('identical pending requests share one HTTP request and get independent result objects', async () => {
    let pending;
    const harness = createHarness({ responses: [(request) => { pending = request; }] });
    const first = callTts(harness, 'Shared request.');
    const second = callTts(harness, 'Shared request.');
    assert.equal(harness.requests.length, 1);
    pending.handler(successResponse());
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.result.raw.cache, 'miss');
    assert.equal(b.result.raw.cache, 'coalesced');
    assert.equal(a.result.value, b.result.value);
    assert.notEqual(a.result, b.result);
    assert.notEqual(a.result.raw, b.result.raw);
    assert.equal((await callTts(harness, 'Shared request.')).result.raw.cache, 'hit');
});

test('shared failures reach all waiters, clean up state, and allow a fresh attempt', async () => {
    let pending;
    const harness = createHarness({ responses: [
        (request) => { pending = request; }, successResponse()
    ] });
    const first = callTts(harness, 'Shared failure.');
    const second = callTts(harness, 'Shared failure.');
    pending.handler(httpErrorResponse(403));
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a.error);
    assert.ok(b.error);
    assert.notEqual(a.error, b.error);
    assert.ok((await callTts(harness, 'Shared failure.')).result);
    assert.equal(harness.requests.length, 2);
});

test('joined requests share retries and ignore late duplicate callbacks from an earlier attempt', async () => {
    const pending = [];
    const harness = createHarness({ responses: [
        (request) => pending.push(request), (request) => pending.push(request)
    ] });
    const first = callTts(harness, 'Shared retry.');
    const second = callTts(harness, 'Shared retry.');
    harness.advanceTime(20_000);
    pending[0].handler(httpErrorResponse(500));
    assert.equal(harness.requests.length, 2);
    assert.equal(pending[1].timeout, 95);
    await new Promise(setImmediate);
    pending[0].handler(httpErrorResponse(500));
    pending[0].handler(successResponse({ pcmBase64: 'AgM=' }));
    assert.equal(harness.requests.length, 2);
    pending[1].handler(successResponse());
    const outputs = await Promise.all([first, second]);
    assert.ok(outputs.every((value) => value.result));
    assert.equal(outputs[0].result.value, outputs[1].result.value);
});

test('a stale completion cannot remove a newer in-flight request for the same key', async () => {
    const pending = [];
    const harness = createHarness({ responses: [
        (request) => pending.push(request), (request) => pending.push(request)
    ] });
    const expired = callTts(harness, 'Stale request.');
    harness.advanceTime(116_000);
    const fresh = callTts(harness, 'Stale request.');
    pending[0].handler(successResponse());
    assert.ok((await expired).error);
    const joined = callTts(harness, 'Stale request.');
    assert.equal(harness.requests.length, 2);
    pending[1].handler(successResponse());
    assert.ok((await fresh).result);
    assert.equal((await joined).result.raw.cache, 'coalesced');
});

test('changing credentials or request format does not merge different pending requests', async () => {
    for (const option of ['apiKey', 'requestFormat']) {
        const pending = [];
        const harness = createHarness({ responses: [
            (request) => pending.push(request), (request) => pending.push(request)
        ] });
        const first = callTts(harness, 'Isolated request.');
        harness.context.$option[option] = option === 'apiKey' ? 'different-key' : 'legacy';
        const second = callTts(harness, 'Isolated request.');
        assert.equal(harness.requests.length, 2);
        pending.forEach((request) => request.handler(successResponse()));
        assert.ok((await first).result);
        assert.equal((await second).result.raw.cache, 'miss');
    }
});

test('one throwing host completion does not prevent other joined callers from completing', async () => {
    let pending;
    const harness = createHarness({ responses: [(request) => { pending = request; }] });
    harness.context.tts({ text: 'Host callback.', lang: 'en' }, () => { throw new Error('host callback failed'); });
    const second = callTts(harness, 'Host callback.');
    pending.handler(successResponse());
    assert.ok((await second).result);
    assert.match(JSON.stringify(harness.logs), /completion_error/);
    assert.equal((await callTts(harness, 'Host callback.')).result.raw.cache, 'hit');
});

test('validation and playback both ignore delayed duplicate HTTP callbacks', async () => {
    for (const validate of [false, true]) {
        let pending;
        const harness = createHarness({ responses: [(request) => { pending = request; }] });
        const calls = [];
        if (validate) harness.context.pluginValidate((value) => calls.push(value));
        else harness.context.tts({ text: 'Once.', lang: 'en' }, (value) => calls.push(value));
        pending.handler(successResponse());
        await new Promise(setImmediate);
        pending.handler(httpErrorResponse(500));
        pending.handler(successResponse());
        assert.equal(calls.length, 1);
        assert.equal(harness.requests.length, 1);
    }
});

test('validation retains its 30 second attempt cap and 60 second total budget after a retry', async () => {
    let harness;
    harness = createHarness({ responses: [
        (request) => {
            assert.equal(request.timeout, 30);
            harness.advanceTime(31_000);
            request.handler(httpErrorResponse(500));
        },
        (request) => {
            assert.equal(request.timeout, 29);
            harness.advanceTime(29_000);
            request.handler(successResponse());
        },
        successResponse()
    ] });
    const timedOut = await callValidate(harness);
    assert.equal(timedOut.result, false);
    assert.match(timedOut.error.message, /超时/);
    assert.equal((await callValidate(harness)).result, true);
    assert.equal(harness.requests.length, 3);
});

test('all joined callers fail at the source deadline and a later call can start fresh', async () => {
    let pending;
    const harness = createHarness({ responses: [(request) => { pending = request; }, successResponse()] });
    const first = callTts(harness, 'Shared deadline.');
    harness.advanceTime(114_000);
    const joined = callTts(harness, 'Shared deadline.');
    harness.advanceTime(1_000);
    pending.handler(successResponse());
    const outcomes = await Promise.all([first, joined]);
    assert.ok(outcomes.every((outcome) => outcome.error && /超时/.test(outcome.error.message)));
    assert.equal((await callTts(harness, 'Shared deadline.')).result.raw.cache, 'miss');
    assert.equal(harness.requests.length, 2);
});

test('a synchronous transport error is redacted and clears the pending request', async () => {
    const harness = createHarness({ responses: [
        () => { throw new Error('transport setup failed: test-api-key'); }, successResponse()
    ] });
    const failed = await callTts(harness, 'Transport setup.');
    assert.equal(failed.error.type, 'network');
    assert.ok(!JSON.stringify(failed).includes('test-api-key'));
    assert.ok(!JSON.stringify(harness.logs).includes('test-api-key'));
    assert.ok((await callTts(harness, 'Transport setup.')).result);
    assert.equal(harness.requests.length, 2);
});

test('unknown endpoint models require an explicit format for both validation and playback', async () => {
    const apiUrl = 'https://proxy.example/v1beta/models/custom-tts';
    const auto = createHarness({ options: { apiUrl } });
    assert.ok((await callTts(auto, 'Unknown format.')).error);
    assert.equal((await callValidate(auto)).result, false);
    assert.equal(auto.requests.length, 0);
    for (const requestFormat of ['verbatim', 'legacy']) {
        const harness = createHarness({ options: { apiUrl, requestFormat, instructions: 'Calm' },
            responses: [successResponse(), successResponse()] });
        assert.ok((await callTts(harness, 'Explicit format.')).result);
        assert.equal((await callValidate(harness)).result, true);
        const part = harness.requests[0].body.contents[0].parts[0];
        if (requestFormat === 'legacy') assert.match(part.text, /BOB_TTS_TRANSCRIPT/);
        else {
            assert.equal(part.text, 'Explicit format.');
            assert.equal(part.speechMetadata.style, 'Calm');
        }
    }
    const invalid = createHarness({ options: { requestFormat: 'unsupported' } });
    assert.equal((await callValidate(invalid)).result, false);
    assert.equal(invalid.requests.length, 0);
});

test('each model offered in info.json has an explicit capability and the default agrees with runtime', () => {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'info.json'), 'utf8'));
    const menu = info.options.find((option) => option.identifier === 'model');
    const models = require('../lib/models');
    for (const item of menu.menuValues) {
        assert.ok(
            Object.hasOwn(models.capabilities, item.value) || Object.hasOwn(models.retiredModels, item.value),
            item.value
        );
    }
    const harness = createHarness({ options: { model: '' } });
    assert.equal(harness.context.getModel(), menu.defaultValue);
});

test('cache expiry occurs at the TTL boundary and a backward clock invalidates entries', async () => {
    const harness = createHarness({ responses: [successResponse(), successResponse(), successResponse()] });
    await callTts(harness, 'TTL boundary.');
    harness.advanceTime(599_999);
    assert.equal((await callTts(harness, 'TTL boundary.')).result.raw.cache, 'hit');
    harness.advanceTime(1);
    assert.equal((await callTts(harness, 'TTL boundary.')).result.raw.cache, 'miss');
    harness.advanceTime(-1);
    assert.equal((await callTts(harness, 'TTL boundary.')).result.raw.cache, 'miss');
    assert.equal(harness.requests.length, 3);
});

test('cache capacity evicts the least recently used entry rather than a recently touched one', async () => {
    const harness = createHarness({ responses: Array.from({ length: 12 }, () => successResponse()) });
    for (let index = 0; index < 10; index++) await callTts(harness, 'LRU ' + index);
    assert.equal((await callTts(harness, 'LRU 0')).result.raw.cache, 'hit');
    await callTts(harness, 'LRU 10');
    assert.equal((await callTts(harness, 'LRU 0')).result.raw.cache, 'hit');
    assert.equal((await callTts(harness, 'LRU 1')).result.raw.cache, 'miss');
    assert.equal(harness.requests.length, 12);
});

test('total cache size and individual value limits are enforced without blocking playback', async () => {
    const harness = createHarness({ responses: Array.from({ length: 4 }, () => successResponse()) });
    harness.evaluate('CACHE_MAX_TOTAL_VALUE_CHARS = 160');
    for (const text of ['Size A', 'Size B', 'Size C']) await callTts(harness, text);
    assert.equal((await callTts(harness, 'Size B')).result.raw.cache, 'hit');
    assert.equal((await callTts(harness, 'Size A')).result.raw.cache, 'miss');

    const boundary = createHarness({ responses: [
        successResponse({ pcmBase64: Buffer.alloc(30).toString('base64') }),
        successResponse({ pcmBase64: Buffer.alloc(32).toString('base64') }),
        successResponse({ pcmBase64: Buffer.alloc(32).toString('base64') })
    ] });
    boundary.evaluate('CACHE_MAX_VALUE_CHARS = 100');
    assert.equal((await callTts(boundary, 'Exactly at limit.')).result.value.length, 100);
    assert.equal((await callTts(boundary, 'Exactly at limit.')).result.raw.cache, 'hit');
    assert.ok((await callTts(boundary, 'Over value limit.')).result);
    assert.equal((await callTts(boundary, 'Over value limit.')).result.raw.cache, 'miss');
    assert.equal(boundary.requests.length, 3);
});

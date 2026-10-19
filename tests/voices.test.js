'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createHarness, callTts, callValidate, successResponse, httpErrorResponse } = require('./harness');

// Only the voicekey_ prefix is documented, so the stand-in is long and URL-safe.
const VOICE_KEY = 'voicekey_' + 'Ab9-_'.repeat(400);
const LONGEST_VOICE = 'voicekey_' + 'a'.repeat(16384 - 'voicekey_'.length);

function voiceOf(request) {
    return request.body.generationConfig.speechConfig.voiceConfig.voice;
}

test('info.json exposes the custom voice option that the runtime reads', () => {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'info.json'), 'utf8'));
    const option = info.options.find((item) => item.identifier === 'customVoice');
    assert.equal(option.type, 'text');
    assert.equal(option.defaultValue, '');
});

test('a custom voice ID overrides the menu in playback and validation requests', async () => {
    for (const customVoice of ['voice_abc123', VOICE_KEY, LONGEST_VOICE, 'en-US.Narrator_1']) {
        const harness = createHarness({
            options: { voice: 'Puck', customVoice: '  ' + customVoice + '\n' },
            responses: [successResponse(), successResponse()]
        });
        assert.ok((await callTts(harness, 'Custom voice.')).result);
        assert.equal((await callValidate(harness)).result, true);
        assert.deepEqual(harness.requests.map(voiceOf), [customVoice, customVoice]);
    }
});

test('an empty custom voice keeps the menu voice', async () => {
    for (const customVoice of ['', '   ', undefined]) {
        const harness = createHarness({ options: { voice: 'Puck', customVoice }, responses: [successResponse()] });
        assert.ok((await callTts(harness, 'Menu voice.')).result);
        assert.equal(voiceOf(harness.requests[0]), 'Puck');
    }
});

test('malformed custom voice IDs are rejected before any request', async () => {
    for (const customVoice of ['voice abc', 'voice_a\tb', 'voice_声音', LONGEST_VOICE + 'a']) {
        const harness = createHarness({ options: { customVoice } });
        const validation = await callValidate(harness);
        assert.equal(validation.result, false);
        assert.equal(validation.error.type, 'param');
        assert.match(validation.error.message, /自定义声音/);
        assert.ok((await callTts(harness, 'Rejected voice.')).error);
        assert.equal(harness.requests.length, 0);
    }
});

test('custom voice IDs require the 3.8 request format', async () => {
    const legacy = createHarness({ options: { customVoice: 'voice_abc123', requestFormat: 'legacy' } });
    const validation = await callValidate(legacy);
    assert.equal(validation.result, false);
    assert.match(validation.error.message, /3\.8/);
    assert.ok((await callTts(legacy, 'Legacy request.')).error);
    assert.equal(legacy.requests.length, 0);

    for (const options of [
        { model: 'gemini-3.1-flash-tts-preview' },
        { requestFormat: 'verbatim', apiUrl: 'https://proxy.example/v1beta/models/proxy-tts' }
    ]) {
        const harness = createHarness({
            options: Object.assign({ customVoice: 'voice_abc123' }, options),
            responses: [successResponse()]
        });
        assert.ok((await callTts(harness, 'Verbatim request.')).result);
        assert.equal(voiceOf(harness.requests[0]), 'voice_abc123');
    }
});

test('replication keys stay out of logs and result metadata while other IDs remain visible', async () => {
    const keyHarness = createHarness({ options: { customVoice: VOICE_KEY }, responses: [successResponse()] });
    const keyBody = VOICE_KEY.substring('voicekey_'.length, 40);
    for (const cache of ['miss', 'hit']) {
        const output = await callTts(keyHarness, 'Private voice.');
        assert.equal(output.result.raw.cache, cache);
        assert.equal(output.result.raw.voice, 'voicekey_[REDACTED]');
        assert.ok(!JSON.stringify(output).includes(keyBody));
    }
    assert.ok(!JSON.stringify(keyHarness.logs).includes(keyBody));
    assert.match(JSON.stringify(keyHarness.logs), /voice=voicekey_\[REDACTED\]/);

    // Upstream errors that echo the key are redacted before they are truncated.
    const echo = httpErrorResponse(400, 'Voice ' + VOICE_KEY + ' is not available');
    const echoHarness = createHarness({ options: { customVoice: VOICE_KEY }, responses: [echo, echo] });
    const playback = await callTts(echoHarness, 'Echoed voice.');
    const validation = await callValidate(echoHarness);
    for (const error of [playback.error, validation.error]) {
        assert.equal(error.message, 'Voice [REDACTED] is not available');
    }
    assert.ok(!JSON.stringify(echoHarness.logs).includes(keyBody));

    const idHarness = createHarness({ options: { customVoice: 'voice_abc123' }, responses: [successResponse()] });
    assert.equal((await callTts(idHarness, 'Stored voice.')).result.raw.voice, 'voice_abc123');
    assert.match(JSON.stringify(idHarness.logs), /voice=voice_abc123/);
});

test('changing the custom voice does not reuse audio cached for another voice', async () => {
    const harness = createHarness({ responses: [successResponse(), successResponse()] });
    await callTts(harness, 'Same text.');
    harness.context.$option.customVoice = 'voice_abc123';
    assert.equal((await callTts(harness, 'Same text.')).result.raw.cache, 'miss');
    harness.context.$option.customVoice = '';
    assert.equal((await callTts(harness, 'Same text.')).result.raw.cache, 'hit');
    assert.deepEqual(harness.requests.map(voiceOf), ['Kore', 'voice_abc123']);
});

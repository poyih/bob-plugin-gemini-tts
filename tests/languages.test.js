'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHarness, callTts, successResponse } = require('./harness');

const FLASH = 'gemini-3.8-flash-tts';
const LITE = 'gemini-3.8-flash-lite-tts';
const FLASH_ONLY = ['th', 'sv', 'fi'];
const RETIRED = [
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-flash-preview-tts'
];

test('language discovery follows the selected model and reflects option changes', () => {
    const harness = createHarness();
    for (const model of [FLASH, LITE, FLASH]) {
        harness.context.$option.model = model;
        const languages = Array.from(harness.context.supportLanguages());
        for (const lang of ['auto', 'en', 'zh-Hans', 'zh-Hant', 'pt-br', 'ja']) {
            assert.ok(languages.includes(lang), model + ': ' + lang);
        }
        for (const lang of FLASH_ONLY) {
            assert.equal(languages.includes(lang), model === FLASH, model + ': ' + lang);
        }
        assert.ok(!languages.includes('uk'), 'Ukrainian is not in either official language list');
        assert.equal(new Set(languages).size, languages.length);
    }
    assert.equal(harness.requests.length, 0);
});

test('a fixed endpoint model determines language coverage instead of the menu', () => {
    for (const [menu, endpoint] of [[FLASH, LITE], [LITE, FLASH]]) {
        const harness = createHarness({ options: {
            model: menu,
            apiUrl: 'https://proxy.example/v1beta/models/' + endpoint + ':generateContent'
        } });
        for (const lang of FLASH_ONLY) {
            assert.equal(harness.context.supportLanguages().includes(lang), endpoint === FLASH);
        }
    }
});

test('retired menu values and encoded endpoint models inherit replacement language coverage', () => {
    for (const model of RETIRED) {
        const menu = createHarness({ options: { model } });
        const path = createHarness({ options: {
            model: LITE,
            apiUrl: 'https://proxy.example/v1/models/' + model.toUpperCase().replace('G', '%47')
        } });
        for (const harness of [menu, path]) {
            for (const lang of FLASH_ONLY) {
                assert.ok(harness.context.supportLanguages().includes(lang));
            }
            assert.ok(!harness.context.supportLanguages().includes('uk'));
        }
    }
});

test('language discovery needs no credentials and tolerates incomplete endpoint settings', () => {
    const harness = createHarness({ options: { apiKey: '', apiUrl: 'https://[', model: LITE } });
    const languages = harness.context.supportLanguages();
    assert.ok(languages.includes('en'));
    assert.ok(!languages.includes('th'));
    assert.equal(harness.requests.length, 0);
});

test('unknown aliases retain Flash languages and callers cannot mutate future discovery', () => {
    const harness = createHarness({ options: { model: 'proxy-tts', requestFormat: 'legacy' } });
    const languages = harness.context.supportLanguages();
    assert.ok(languages.includes('en'));
    for (const lang of FLASH_ONLY) assert.ok(languages.includes(lang));
    assert.ok(!languages.includes('uk'));
    languages.push('uk');
    languages.splice(languages.indexOf('en'), 1);
    assert.ok(!harness.context.supportLanguages().includes('uk'));
    assert.ok(harness.context.supportLanguages().includes('en'));
});

test('explicit-format proxy aliases can synthesize languages outside known coverage', async () => {
    for (const requestFormat of ['verbatim', 'legacy']) {
        const harness = createHarness({ options: {
            model: 'flash-alias', requestFormat,
            apiUrl: 'https://proxy.example/custom/tts'
        }, responses: [successResponse(), successResponse()] });
        for (const lang of ['th', 'uk']) {
            assert.ok((await callTts(harness, 'Proxy-supported speech.', lang)).result);
        }
        assert.equal(harness.requests.length, 2);
    }
});

test('unsupported languages fail before transport even when another model cached the transcript', async () => {
    const harness = createHarness({ responses: [successResponse()] });
    assert.ok((await callTts(harness, 'สวัสดี', 'th')).result);
    harness.context.$option.model = LITE;
    for (const lang of FLASH_ONLY.concat('uk')) {
        const output = await callTts(harness, 'สวัสดี', lang);
        assert.equal(output.error.type, 'param');
        assert.match(output.error.message, /语言/);
    }
    harness.context.$option.model = FLASH;
    assert.ok((await callTts(harness, 'Ukrainian.', 'uk')).error);
    assert.equal(harness.requests.length, 1);
});

test('playback checks the endpoint model and retains Flash-only languages after retirement routing', async () => {
    const lite = createHarness({ options: {
        model: FLASH,
        apiUrl: 'https://proxy.example/v1beta/models/' + LITE
    } });
    assert.ok((await callTts(lite, 'สวัสดี', 'th')).error);
    assert.equal(lite.requests.length, 0);

    for (const options of [
        { model: LITE },
        { model: RETIRED[0] },
        { model: LITE, apiUrl: 'https://proxy.example/v1/models/' + FLASH }
    ]) {
        const harness = createHarness({ options, responses: [successResponse()] });
        const lang = options.model === LITE && !options.apiUrl ? 'en' : 'th';
        assert.ok((await callTts(harness, 'Supported speech.', lang)).result);
        assert.equal(harness.requests.length, 1);
    }
});

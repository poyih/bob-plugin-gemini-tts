'use strict';

// Shared playback/validation transport. Dependencies are injected so the same
// code runs in Bob and in the VM tests, with separate budgets and logging.
function requestAudio(options, completion) {
    var done = false;

    function emit(stage, details) {
        if (options.onEvent) {
            options.onEvent(stage, details);
        }
    }

    function finish(value) {
        if (done) {
            return;
        }
        done = true;
        completion(value);
    }

    function elapsedMs() {
        return options.now() - options.startedAt;
    }

    function remainingMs() {
        return options.totalBudgetMs - elapsedMs();
    }

    function timedOut(attempt) {
        emit('timeout', { attempt: attempt, totalElapsedMs: elapsedMs() });
        finish({ error: options.timeoutError });
    }

    function sendAttempt(attempt) {
        var remaining = remainingMs();
        if (remaining <= 0) {
            timedOut(attempt + 1);
            return;
        }
        var timeout = Math.max(1, Math.ceil(remaining / 1000));
        if (options.attemptTimeoutSeconds) {
            timeout = Math.min(timeout, options.attemptTimeoutSeconds);
        }
        // An old attempt must never retry twice or supersede a newer response.
        var handled = false;
        try {
            options.http.request({
                method: 'POST',
                url: options.url,
                header: {
                    'x-goog-api-key': options.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: options.body,
                timeout: timeout,
                handler: function (resp) {
                    if (done || handled) {
                        return;
                    }
                    handled = true;
                    var metrics = { attempt: attempt + 1, requestElapsedMs: elapsedMs() };
                    if (remainingMs() <= 0) {
                        timedOut(attempt + 1);
                        return;
                    }
                    if (!resp || resp.error) {
                        metrics.error = options.toServiceError(resp && resp.error, options.apiKey);
                        emit('network_error', metrics);
                        finish({ error: metrics.error });
                        return;
                    }
                    metrics.statusCode = resp.response ? Number(resp.response.statusCode) : 0;
                    if (metrics.statusCode === 500 && attempt === 0 && remainingMs() > 1000) {
                        emit('retry', metrics);
                        sendAttempt(1);
                        return;
                    }
                    if (metrics.statusCode !== 200) {
                        metrics.error = options.parseHttpError(resp, options.apiKey);
                        emit('http_error', metrics);
                        finish({ error: metrics.error });
                        return;
                    }

                    var audio;
                    try {
                        var convertStartedAt = options.now();
                        audio = options.inspectAudioResponse(resp.data, options.apiKey);
                        metrics.convertElapsedMs = options.now() - convertStartedAt;
                        metrics.totalElapsedMs = elapsedMs();
                    } catch (e) {
                        metrics.error = e.pluginError || options.makeApiError(
                            '音频处理失败', options.normalizeErrorMessage(e.message || e, options.apiKey)
                        );
                        metrics.totalElapsedMs = elapsedMs();
                        emit('processing_error', metrics);
                        finish({ error: metrics.error });
                        return;
                    }
                    if (remainingMs() <= 0) {
                        timedOut(attempt + 1);
                        return;
                    }
                    finish({ audio: audio, metrics: metrics });
                }
            });
        } catch (e) {
            if (done || handled) {
                return;
            }
            handled = true;
            var error = options.toServiceError(e, options.apiKey);
            emit('request_setup_error', { attempt: attempt + 1, error: error });
            finish({ error: error });
        }
    }

    sendAttempt(0);
}

module.exports = { requestAudio: requestAudio };

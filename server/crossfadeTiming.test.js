import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeCrossfadeVolumes,
    shouldAllowBackgroundCrossfade,
    startCrossfadeTicker,
} from '../src/utils/crossfadeTiming.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('computeCrossfadeVolumes computes equal-power start, mid, end, muted, and clamped bounds', () => {
    const start = computeCrossfadeVolumes(0, 3000, 80);
    assert.equal(start.progress, 0);
    assert.equal(start.outVolume, 80);
    assert.equal(start.inVolume, 0);
    assert.equal(start.done, false);

    const mid = computeCrossfadeVolumes(1500, 3000, 80);
    assert.equal(mid.progress, 0.5);
    assert.ok(mid.outVolume > 0 && mid.outVolume < 80);
    assert.ok(mid.inVolume > 0 && mid.inVolume <= 80);
    assert.equal(mid.done, false);

    const end = computeCrossfadeVolumes(3500, 3000, 80);
    assert.equal(end.progress, 1);
    assert.ok(end.outVolume < 1e-12);
    assert.equal(end.inVolume, 80);
    assert.equal(end.done, true);

    const muted = computeCrossfadeVolumes(1500, 3000, 0);
    assert.equal(muted.outVolume, 0);
    assert.equal(muted.inVolume, 0);

    const zeroTotal = computeCrossfadeVolumes(10, 0, 50);
    assert.equal(zeroTotal.progress, 1);
    assert.equal(zeroTotal.inVolume, 50);
    assert.equal(zeroTotal.done, true);
});

test('shouldAllowBackgroundCrossfade allows all visible ramps and audio+audio when hidden', () => {
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'audio', incomingMode: 'audio', isHidden: false }), true);
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'youtube', incomingMode: 'audio', isHidden: false }), true);
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'audio', incomingMode: 'youtube', isHidden: false }), true);
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'youtube', incomingMode: 'youtube', isHidden: false }), true);

    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'audio', incomingMode: 'audio', isHidden: true }), true);
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'youtube', incomingMode: 'audio', isHidden: true }), false);
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'audio', incomingMode: 'youtube', isHidden: true }), false);
    assert.equal(shouldAllowBackgroundCrossfade({ activeMode: 'youtube', incomingMode: 'youtube', isHidden: true }), false);
});

test('startCrossfadeTicker ticks and stops cleanly in fallback setInterval mode', async () => {
    let ticks = 0;
    const stop = startCrossfadeTicker(() => {
        ticks += 1;
    }, 16);

    await delay(75);
    assert.ok(ticks >= 2, `expected >= 2 ticks, got ${ticks}`);

    stop();
    const countAtStop = ticks;
    await delay(50);
    assert.equal(ticks, countAtStop);

    // Calling stop again is a safe no-op
    stop();
});

test('startCrossfadeTicker prefers Worker when available and cleans up Blob URL and worker on stop', () => {
    const origWorker = globalThis.Worker;
    const origBlob = globalThis.Blob;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;

    let createdBlob = null;
    let revokedUrls = [];
    let postedMessages = [];
    let terminated = false;
    let instance = null;

    class MockWorker {
        constructor(url) {
            this.url = url;
            this.onmessage = null;
            this.onerror = null;
            instance = this;
        }
        postMessage(msg) {
            postedMessages.push(msg);
        }
        terminate() {
            terminated = true;
        }
    }

    class MockBlob {
        constructor(parts, opts) {
            this.parts = parts;
            this.opts = opts;
        }
    }

    try {
        globalThis.Worker = MockWorker;
        globalThis.Blob = MockBlob;
        URL.createObjectURL = (b) => {
            createdBlob = b;
            return 'blob:mock-crossfade-worker';
        };
        URL.revokeObjectURL = (u) => {
            revokedUrls.push(u);
        };

        let ticks = 0;
        const stop = startCrossfadeTicker(() => {
            ticks += 1;
        }, 25);

        assert.ok(instance);
        assert.equal(instance.url, 'blob:mock-crossfade-worker');
        assert.equal(createdBlob.opts.type, 'application/javascript');
        assert.match(createdBlob.parts[0], /setInterval/);

        instance.onmessage();
        instance.onmessage();
        assert.equal(ticks, 2);

        stop();
        // Extra late message after stop must be ignored
        instance.onmessage();
        assert.equal(ticks, 2);
        assert.equal(terminated, true);
        assert.deepEqual(postedMessages, ['stop']);
        assert.deepEqual(revokedUrls, ['blob:mock-crossfade-worker']);
    } finally {
        globalThis.Worker = origWorker;
        globalThis.Blob = origBlob;
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
    }
});

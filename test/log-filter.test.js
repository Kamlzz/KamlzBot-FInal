import assert from 'node:assert/strict';
import { isSignalSessionBookkeepingNoise, installConsoleNoiseFilter } from '../lib/log-filter.js';

assert.equal(isSignalSessionBookkeepingNoise(['Closing session:', { _chains: {} }]), true);
assert.equal(isSignalSessionBookkeepingNoise(['Closing session: SessionEntry {']), true);
assert.equal(isSignalSessionBookkeepingNoise(['Closing open session in favor of incoming prekey bundle']), true);
assert.equal(isSignalSessionBookkeepingNoise(['Closing stale open session for new outgoing prekey bundle']), true);
assert.equal(isSignalSessionBookkeepingNoise(['Removing old closed session: SessionEntry']), true);
assert.equal(isSignalSessionBookkeepingNoise(['[COMMAND] ,ls']), false);

const called = [];
const fakeConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map((method) => [method, (...args) => called.push([method, ...args])]));
const restore = installConsoleNoiseFilter(fakeConsole);
fakeConsole.log('Closing session:', { _chains: {} });
fakeConsole.log('Closing open session in favor of incoming prekey bundle');
fakeConsole.log('[COMMAND] ,ls');
fakeConsole.error('An actual command failure');
restore();
assert.equal(called.length, 2, 'only command output and real error should remain visible');
assert.equal(called[0][1], '[COMMAND] ,ls');
assert.equal(called[1][1], 'An actual command failure');
console.log('PASS: quiet logger filters Signal session bookkeeping noise');

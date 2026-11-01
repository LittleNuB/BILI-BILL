import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonitorSender } from '../src/content/player-monitor/monitor-sender.ts';

const message = { action: 'PLAYER_HEARTBEAT', payload: { bvid: 'BV1ShellMock9', cid: 1, currentTime: 0, duration: 60, playbackRate: 1 } } as const;

for (const asynchronous of [false, true]) {
  test(`invalidated monitor stops after ${asynchronous ? 'rejected promise' : 'synchronous throw'}`, async () => {
    let calls = 0, stopped = 0;
    const send = createMonitorSender(() => {
      calls++;
      const error = new Error('Extension context invalidated.');
      if (asynchronous) return Promise.reject(error);
      throw error;
    }, () => { stopped++; });
    assert.doesNotThrow(() => send(message));
    await Promise.resolve();
    send(message);
    assert.equal(calls, 1);
    assert.equal(stopped, 1);
  });
}

test('temporary worker failure does not disable later messages', async () => {
  let calls = 0, stopped = 0;
  const send = createMonitorSender(async () => {
    if (++calls === 1) throw new Error('Could not establish connection.');
  }, () => { stopped++; });
  send(message);
  await Promise.resolve();
  send(message);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(stopped, 0);
});

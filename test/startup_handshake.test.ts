import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startup_handshake } from '../webview/startup_handshake';

function fake_clock() {
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  let next_id = 0;
  return {
    scheduled,
    schedule(callback: () => void, delay: number) {
      const id = next_id++;
      scheduled.set(id, { callback, delay });
      return () => { scheduled.delete(id); };
    },
    tick() {
      const next = scheduled.entries().next().value;
      assert.ok(next, 'expected a pending retry');
      scheduled.delete(next[0]);
      next[1].callback();
      return next[1].delay;
    },
  };
}

test('a dropped ready message retries with bounded backoff until host state arrives', () => {
  const clock = fake_clock();
  let sent = 0;
  const handshake = new startup_handshake(() => { sent++; }, clock.schedule);
  handshake.request();
  assert.equal(sent, 1);
  assert.deepEqual(Array.from({ length: 6 }, () => clock.tick()), [250, 500, 1000, 2000, 2000, 2000]);
  assert.equal(sent, 7);
  assert.equal(clock.scheduled.size, 1);
  handshake.acknowledge();
  assert.equal(clock.scheduled.size, 0);
  handshake.request();
  assert.equal(sent, 7, 'focus and visibility no longer send ready after state is received');
});

test('focus retries early without accumulating timers and unloading cancels all retries', () => {
  const clock = fake_clock();
  let sent = 0;
  const handshake = new startup_handshake(() => { sent++; }, clock.schedule);
  handshake.request();
  handshake.request();
  assert.equal(sent, 2);
  assert.equal(clock.scheduled.size, 1);
  handshake.dispose();
  assert.equal(clock.scheduled.size, 0);
  handshake.request();
  assert.equal(sent, 2);
});

test('synchronous host state acknowledgement does not leave a retry scheduled', () => {
  const clock = fake_clock();
  const handshake = new startup_handshake(() => handshake.acknowledge(), clock.schedule);
  handshake.request();
  assert.equal(clock.scheduled.size, 0);
});

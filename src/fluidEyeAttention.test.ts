import test from 'node:test';
import assert from 'node:assert/strict';
import { createEyeAttention, EYE_ATTENTION_DURATION_MS } from './fluid/attention';
import type { EyeOwner } from './fluid/types';

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const scheduled = new Map<number, { due: number; callback: () => void }>();
  const history = new Map<number, () => void>();
  return {
    schedule(callback: () => void, delay: number) {
      const id = ++nextId;
      scheduled.set(id, { due: now + delay, callback });
      history.set(id, callback);
      return id;
    },
    cancel(timer: unknown) {
      assert.equal(typeof timer, 'number');
      scheduled.delete(timer as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...scheduled.entries()].filter(([, task]) => task.due <= end)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].due;
        scheduled.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    queuedCallback(id: number) {
      const callback = history.get(id);
      assert.ok(callback, `Timer ${id} was never scheduled`);
      return callback;
    },
    get activeCount() { return scheduled.size; },
  };
}

function setup() {
  const clock = fakeClock();
  const changes: EyeOwner[] = [];
  const eye = createEyeAttention({ schedule: clock.schedule, cancel: clock.cancel,
    onChange: ({ owner }) => changes.push(owner) });
  return { clock, changes, eye };
}

test('fluid eye returns exactly after a 20 second visit without changing panel state', () => {
  const { clock, changes, eye } = setup();
  assert.equal(EYE_ATTENTION_DURATION_MS, 20_000);
  assert.deepEqual(eye.snapshot(), { owner: 'main' });
  eye.activate('activity');
  clock.advance(19_999);
  assert.equal(eye.snapshot().owner, 'activity');
  clock.advance(1);
  assert.equal(eye.snapshot().owner, 'main');
  assert.deepEqual(changes, ['activity', 'main']);
  assert.equal(clock.activeCount, 0);
});

test('renewing the same eye owner extends its visit without replaying a handoff', () => {
  const { clock, changes, eye } = setup();
  eye.activate('activity');
  clock.advance(15_000);
  eye.activate('activity');
  assert.equal(clock.activeCount, 1);
  assert.deepEqual(changes, ['activity']);
  clock.advance(19_999);
  assert.equal(eye.snapshot().owner, 'activity');
  clock.advance(1);
  assert.deepEqual(changes, ['activity', 'main']);
});

test('an already queued old callback cannot steal attention from a newer owner', () => {
  const { clock, changes, eye } = setup();
  eye.activate('activity');
  const staleCallback = clock.queuedCallback(1);
  clock.advance(500);
  eye.activate('local');
  staleCallback();
  assert.equal(eye.snapshot().owner, 'local');
  assert.deepEqual(changes, ['activity', 'local']);
  assert.equal(clock.activeCount, 1);
  clock.advance(20_000);
  assert.equal(eye.snapshot().owner, 'main');
});

test('closing a different panel keeps the current eye visit and its remaining time', () => {
  const { clock, changes, eye } = setup();
  eye.activate('local');
  clock.advance(12_000);
  eye.release('activity');
  assert.equal(eye.snapshot().owner, 'local');
  assert.equal(clock.activeCount, 1);
  clock.advance(7_999);
  assert.equal(eye.snapshot().owner, 'local');
  clock.advance(1);
  assert.deepEqual(changes, ['local', 'main']);
});

test('closing the current owner returns once; cleanup also invalidates queued callbacks', () => {
  const { clock, changes, eye } = setup();
  eye.activate('activity');
  const staleAfterClose = clock.queuedCallback(1);
  eye.release('activity');
  staleAfterClose();
  assert.equal(clock.activeCount, 0);
  assert.deepEqual(changes, ['activity', 'main']);
  eye.activate('local');
  const staleAfterDispose = clock.queuedCallback(2);
  eye.dispose();
  eye.dispose();
  staleAfterDispose();
  eye.activate('activity');
  eye.release('local');
  assert.equal(clock.activeCount, 0);
  assert.equal(eye.snapshot().owner, 'local');
  assert.deepEqual(changes, ['activity', 'main', 'local']);
});

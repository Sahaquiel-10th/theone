import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelLifetime, FLUID_PANEL_IDLE_MS } from './fluid/panelLifetime';
import type { FluidPanelInputs, FluidPanelKind } from './fluid/panelLifetime';

class FakeClock {
  now = 0;
  nextId = 0;
  jobs = new Map<number, { at: number; callback: () => void }>();
  cancelled: Array<() => void> = [];

  schedule = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.now + delay, callback });
    return id;
  };

  cancel = (handle: unknown) => {
    const id = handle as number;
    const job = this.jobs.get(id);
    if (job) this.cancelled.push(job.callback);
    this.jobs.delete(id);
  };

  advance(ms: number) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

function fixture(overrides: Partial<FluidPanelInputs> = {}) {
  const clock = new FakeClock();
  const attention: Array<{ kind: FluidPanelKind; signal?: string }> = [];
  const collapsed: FluidPanelKind[] = [];
  const changes: Array<{ activityOpen: boolean; localOpen: boolean }> = [];
  const controller = createPanelLifetime({
    schedule: clock.schedule,
    cancel: clock.cancel,
    onAttention: (kind, signal) => attention.push({ kind, signal }),
    onAutoCollapse: (kind) => collapsed.push(kind),
    onChange: (snapshot) => changes.push(snapshot),
  });
  let inputs: FluidPanelInputs = {
    enabled: true,
    activitySignal: '', localSignal: '',
    activityProtected: false, localProtected: false,
    ...overrides,
  };
  controller.setInputs(inputs);
  const update = (next: Partial<FluidPanelInputs>) => {
    inputs = { ...inputs, ...next };
    controller.setInputs(inputs);
  };
  return { clock, controller, attention, collapsed, changes, update };
}

test('initial nonempty signal reveals once; unchanged inputs neither steal attention nor postpone the deadline', () => {
  const f = fixture({ activitySignal: 'task-1:running' });
  assert.deepEqual(f.controller.snapshot(), { activityOpen: true, localOpen: false });
  assert.deepEqual(f.attention, [{ kind: 'activity', signal: 'task-1:running' }]);
  f.clock.advance(FLUID_PANEL_IDLE_MS - 1);
  f.update({});
  assert.equal(f.controller.snapshot().activityOpen, true);
  f.clock.advance(1);
  assert.equal(f.controller.snapshot().activityOpen, false);
  assert.deepEqual(f.collapsed, ['activity']);
  assert.equal(f.attention.length, 1);
});

test('manual collapse of running work persists until a genuinely new signal', () => {
  const f = fixture({ activitySignal: 'task-1:running', activityProtected: true });
  f.controller.toggle('activity');
  f.update({});
  f.clock.advance(FLUID_PANEL_IDLE_MS * 2);
  assert.equal(f.controller.snapshot().activityOpen, false);
  assert.equal(f.attention.length, 1);
  f.update({ activitySignal: 'task-1:completed', activityProtected: false });
  assert.equal(f.controller.snapshot().activityOpen, true);
  assert.equal(f.attention.length, 2);
  assert.deepEqual(f.collapsed, []);
});

test('empty signal does not immediately remove a visible result and allows the next nonempty event', () => {
  const f = fixture({ activitySignal: 'task-1:completed' });
  f.update({ activitySignal: '' });
  assert.equal(f.controller.snapshot().activityOpen, true);
  f.controller.toggle('activity');
  f.update({ activitySignal: 'task-1:completed' });
  assert.equal(f.controller.snapshot().activityOpen, true);
  assert.equal(f.attention.length, 2);
});

test('real interactions renew only their own panel and do not move eye attention', () => {
  const f = fixture({ activitySignal: 'task-1', localSignal: 'local-1' });
  f.clock.advance(FLUID_PANEL_IDLE_MS - 100);
  f.controller.interact('activity');
  f.clock.advance(100);
  assert.deepEqual(f.controller.snapshot(), { activityOpen: true, localOpen: false });
  assert.deepEqual(f.collapsed, ['local']);
  f.clock.advance(FLUID_PANEL_IDLE_MS - 101);
  assert.equal(f.controller.snapshot().activityOpen, true);
  f.clock.advance(1);
  assert.equal(f.controller.snapshot().activityOpen, false);
  assert.equal(f.attention.length, 2);
});

test('active protection suspends auto-collapse and release grants a full fresh three minutes', () => {
  const f = fixture({ activitySignal: 'task-1' });
  f.clock.advance(FLUID_PANEL_IDLE_MS - 1);
  f.update({ activityProtected: true });
  f.clock.advance(FLUID_PANEL_IDLE_MS * 3);
  assert.equal(f.controller.snapshot().activityOpen, true);
  assert.equal(f.clock.jobs.size, 0);
  f.update({ activityProtected: false });
  f.clock.advance(FLUID_PANEL_IDLE_MS - 1);
  assert.equal(f.controller.snapshot().activityOpen, true);
  f.clock.advance(1);
  assert.equal(f.controller.snapshot().activityOpen, false);
});

test('editing and active-work protections are independent; the last release starts the idle deadline', () => {
  const f = fixture({ localSignal: 'local-1', localProtected: true });
  f.controller.protectEditing('local', true);
  f.update({ localProtected: false });
  f.clock.advance(FLUID_PANEL_IDLE_MS * 2);
  assert.equal(f.controller.snapshot().localOpen, true);
  assert.equal(f.clock.jobs.size, 0);
  f.controller.protectEditing('local', false);
  f.clock.advance(FLUID_PANEL_IDLE_MS - 1);
  assert.equal(f.controller.snapshot().localOpen, true);
  f.clock.advance(1);
  assert.equal(f.controller.snapshot().localOpen, false);
});

test('manual close clears stale editing protection; explicit reopen announces and starts a new idle window', () => {
  const f = fixture({ activitySignal: 'task-1' });
  f.controller.protectEditing('activity', true);
  f.controller.toggle('activity');
  f.controller.open('activity');
  assert.deepEqual(f.attention[1], { kind: 'activity', signal: undefined });
  f.clock.advance(FLUID_PANEL_IDLE_MS);
  assert.equal(f.controller.snapshot().activityOpen, false);
});

test('disable closes both panels and cancels all deadlines; re-enable may reveal the current signals', () => {
  const f = fixture({ activitySignal: 'task-1', localSignal: 'local-1' });
  f.update({ enabled: false });
  assert.deepEqual(f.controller.snapshot(), { activityOpen: false, localOpen: false });
  assert.equal(f.clock.jobs.size, 0);
  f.controller.open('activity');
  f.controller.toggle('local');
  f.controller.interact('activity');
  f.clock.cancelled.forEach((callback) => callback());
  assert.deepEqual(f.controller.snapshot(), { activityOpen: false, localOpen: false });
  assert.deepEqual(f.collapsed, []);
  f.update({ enabled: true });
  assert.deepEqual(f.controller.snapshot(), { activityOpen: true, localOpen: true });
  assert.equal(f.attention.length, 4);
});

test('a canceled deadline that was already queued cannot close a freshly interacted panel', () => {
  const f = fixture({ activitySignal: 'task-1' });
  f.clock.advance(50);
  f.controller.interact('activity');
  assert.equal(f.clock.cancelled.length, 1);
  f.clock.cancelled[0]();
  assert.equal(f.controller.snapshot().activityOpen, true);
  assert.deepEqual(f.collapsed, []);
  f.clock.advance(FLUID_PANEL_IDLE_MS);
  assert.equal(f.controller.snapshot().activityOpen, false);
});

test('dispose makes pending callbacks and future commands inert', () => {
  const f = fixture({ activitySignal: 'task-1' });
  const pending = [...f.clock.jobs.values()].map((job) => job.callback);
  const before = { attention: f.attention.length, changes: f.changes.length };
  f.controller.dispose();
  f.controller.dispose();
  pending.forEach((callback) => callback());
  f.controller.open('local');
  f.controller.toggle('activity');
  f.controller.interact('activity');
  f.controller.protectEditing('activity', true);
  f.update({ localSignal: 'local-2' });
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.attention.length, before.attention);
  assert.equal(f.changes.length, before.changes);
  assert.deepEqual(f.collapsed, []);
});

test('auto-collapse callback runs before hiding so focused controls can return to their trigger', () => {
  const clock = new FakeClock();
  let wasOpenAtCallback = false;
  const controller = createPanelLifetime({
    schedule: clock.schedule, cancel: clock.cancel,
    onAutoCollapse: () => { wasOpenAtCallback = controller.snapshot().activityOpen; },
  });
  controller.setInputs({ enabled: true, activitySignal: 'task-1', localSignal: '', activityProtected: false, localProtected: false });
  clock.advance(FLUID_PANEL_IDLE_MS);
  assert.equal(wasOpenAtCallback, true);
  assert.equal(controller.snapshot().activityOpen, false);
});

test('new activity during the collapse callback prevents its now-stale deadline from hiding the panel', () => {
  const clock = new FakeClock();
  let renewed = false;
  const controller = createPanelLifetime({
    schedule: clock.schedule, cancel: clock.cancel,
    onAutoCollapse: (kind) => {
      if (!renewed) {
        renewed = true;
        controller.interact(kind);
      }
    },
  });
  controller.setInputs({ enabled: true, activitySignal: 'task-1', localSignal: '', activityProtected: false, localProtected: false });
  clock.advance(FLUID_PANEL_IDLE_MS);
  assert.equal(controller.snapshot().activityOpen, true);
  clock.advance(FLUID_PANEL_IDLE_MS);
  assert.equal(controller.snapshot().activityOpen, false);
});

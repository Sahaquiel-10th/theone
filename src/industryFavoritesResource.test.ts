import test from 'node:test';
import assert from 'node:assert/strict';
import type { api as Api } from './oneApi';
import { industryFavoritesResource, parseIndustryFavorites } from './industryFavoritesResource';
import { industryFavoriteIds } from './industryFavoriteIds';
import { industryWorkspaces } from './industryWorkspaceState';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let owner = { userId: 'owner', workspaceId: 'one', revision: 1 };
  const calls: { path: string; method: string; body?: Record<string, unknown>; response: ReturnType<typeof deferred<unknown>> }[] = [];
  const request: typeof Api = <T>(path: string, init?: RequestInit) => { const response = deferred<unknown>(); calls.push({ path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, response }); return response.promise as Promise<T>; };
  const resource = industryFavoritesResource(request, { identity: () => owner });
  const load = async (ids: string[] = []) => { const pending = resource.refresh(); calls.at(-1)!.response.resolve({ favoriteIds: ids }); await pending; };
  return { calls, resource, load, switchIdentity: (patch: Partial<typeof owner>) => { owner = { ...owner, ...patch }; } };
}

test('favorite IDs exactly match current catalog; DTO parsing refuses URLs, duplicate IDs and private metadata', () => {
  assert.deepEqual([...industryFavoriteIds].sort(), industryWorkspaces.map(item => item.id).sort());
  assert.deepEqual(parseIndustryFavorites({ favoriteIds: ['review_reply', 'teaching'] }), ['teaching', 'review_reply']);
  for (const value of [null, [], { favoriteIds: ['unknown'] }, { favoriteIds: ['https://example.invalid'] }, { favoriteIds: ['teaching', 'teaching'] }, { favoriteIds: [], userId: 'foreign' }, { favoriteIds: 'teaching' }]) assert.throws(() => parseIndustryFavorites(value));
});

test('initial load comes from server; an unconfirmed initial read cannot accidentally overwrite an existing favorite', async () => {
  const f = fixture();
  await f.resource.setFavorite('teaching', true); assert.equal(f.calls.length, 0); assert.match(f.resource.getSnapshot().error, /读取/);
  const read = f.resource.refresh(); assert.equal(f.resource.getSnapshot().loading, true); f.calls[0].response.reject(Error('offline')); await read;
  assert.equal(f.resource.getSnapshot().loading, false); assert.match(f.resource.getSnapshot().error, /重试/);
  const retry = f.resource.retry(); f.calls[1].response.resolve({ favoriteIds: ['review_reply'] }); await retry;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, ['review_reply']); assert.equal(f.resource.getSnapshot().error, '');
});

test('concurrent card PUT responses update only their own ID and cannot erase a newer favorite', async () => {
  const f = fixture(); await f.load(['teaching']);
  const image = f.resource.setFavorite('image_edit', true), review = f.resource.setFavorite('review_reply', true); await tick();
  assert.deepEqual(f.resource.getSnapshot().savingIds, ['image_edit', 'review_reply']);
  f.calls[2].response.resolve({ favoriteIds: ['teaching', 'image_edit', 'review_reply'] }); await review;
  f.calls[1].response.resolve({ favoriteIds: ['teaching', 'image_edit'] }); await image;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, ['teaching', 'image_edit', 'review_reply']); assert.deepEqual(f.resource.getSnapshot().savingIds, []);
  assert.deepEqual(f.calls[1].body, { favorite: true }); assert.equal(f.calls[1].method, 'PUT');
});

test('a stale GET before or during a write cannot undo its later confirmed result', async () => {
  for (const duringWrite of [false, true]) {
    const f = fixture(); await f.load();
    let read: Promise<void>, write: Promise<void>;
    if (duringWrite) { write = f.resource.setFavorite('image_edit', true); await tick(); read = f.resource.refresh(); }
    else { read = f.resource.refresh(); write = f.resource.setFavorite('image_edit', true); await tick(); }
    const put = f.calls.find(call => call.method === 'PUT')!, get = f.calls.filter(call => call.method === 'GET').at(-1)!;
    put.response.resolve({ favoriteIds: ['image_edit'] }); await write;
    get.response.resolve({ favoriteIds: [] }); await read;
    assert.deepEqual(f.resource.getSnapshot().favoriteIds, ['image_edit']);
  }
});

test('overlapping cross-device refreshes keep the newest response and learn server changes', async () => {
  const f = fixture(); await f.load(['teaching']);
  const old = f.resource.refresh(), latest = f.resource.refresh();
  f.calls[2].response.resolve({ favoriteIds: ['review_reply'] }); await latest;
  f.calls[1].response.resolve({ favoriteIds: ['teaching'] }); await old;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, ['review_reply']);
  const otherDevice = fixture(); await otherDevice.load(['review_reply']); assert.deepEqual(otherDevice.resource.getSnapshot().favoriteIds, ['review_reply']);
});

test('one card serializes opposite desired states and deduplicates an in-flight duplicate', async () => {
  const f = fixture(); await f.load();
  const one = f.resource.setFavorite('image_edit', true), duplicate = f.resource.setFavorite('image_edit', true), opposite = f.resource.setFavorite('image_edit', false);
  assert.equal(one, duplicate); await tick(); assert.equal(f.calls.length, 2);
  f.calls[1].response.resolve({ favoriteIds: ['image_edit'] }); await one; await tick(); assert.equal(f.calls.length, 3); assert.deepEqual(f.calls[2].body, { favorite: false });
  f.calls[2].response.resolve({ favoriteIds: [] }); await opposite;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, []); assert.deepEqual(f.resource.getSnapshot().savingIds, []);
});

test('lost PUT response keeps the last confirmed state; retry repeats the absolute desired state after server applied it', async () => {
  const f = fixture(); await f.load(['teaching']);
  const remove = f.resource.setFavorite('teaching', false); await tick();
  // Simulate server committed false, but the response was lost.
  f.calls[1].response.reject(Error('receipt lost')); await remove;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, ['teaching']); assert.match(f.resource.getSnapshot().error, /保存未确认/);
  const retry = f.resource.retry(); await tick(); assert.deepEqual(f.calls[2].body, { favorite: false });
  f.calls[2].response.resolve({ favoriteIds: [] }); await tick(); f.calls[3].response.resolve({ favoriteIds: [] }); await retry;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, []); assert.equal(f.resource.getSnapshot().error, '');
});

test('fresh GET can reconcile an applied write with a lost response without keeping a false save error', async () => {
  const f = fixture(); await f.load();
  const add = f.resource.setFavorite('teaching', true); await tick(); f.calls[1].response.reject(Error('lost')); await add;
  await f.load(['teaching']); assert.deepEqual(f.resource.getSnapshot().favoriteIds, ['teaching']); assert.equal(f.resource.getSnapshot().error, '');
  const retry = f.resource.retry(); await tick(); f.calls.at(-1)!.response.resolve({ favoriteIds: ['teaching'] }); await retry;
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('account, workspace and identity-generation switches discard late responses and queued writes', async () => {
  for (const patch of [{ userId: 'other' }, { workspaceId: 'other-workspace' }, { revision: 2 }]) {
    const f = fixture(); await f.load(['teaching']);
    const write = f.resource.setFavorite('image_edit', true), queued = f.resource.setFavorite('image_edit', false); await tick();
    f.switchIdentity(patch); f.calls[1].response.resolve({ favoriteIds: ['teaching', 'image_edit'] }); await write; await queued;
    assert.deepEqual(f.resource.getSnapshot().favoriteIds, []); assert.deepEqual(f.resource.getSnapshot().savingIds, []); assert.equal(f.calls.length, 2);
    await f.resource.refresh(); await f.resource.setFavorite('review_reply', true); assert.equal(f.calls.length, 2);
  }
  const f = fixture(), read = f.resource.refresh(); f.switchIdentity({ revision: 2 }); f.calls[0].response.resolve({ favoriteIds: ['teaching'] }); await read;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, []);
});

test('invalid/mismatched write DTOs never make the star appear saved', async () => {
  const f = fixture(); await f.load();
  const write = f.resource.setFavorite('teaching', true); await tick(); f.calls[1].response.resolve({ favoriteIds: [] }); await write;
  assert.deepEqual(f.resource.getSnapshot().favoriteIds, []); assert.match(f.resource.getSnapshot().error, /保存未确认/); assert.deepEqual(f.resource.getSnapshot().savingIds, []);
});

test('global retry cannot resurrect an older failed intent while a newer explicit state is saving', async () => {
  const f = fixture(); await f.load();
  const failed = f.resource.setFavorite('teaching', true); await tick(); f.calls[1].response.reject(Error('lost')); await failed;
  const latest = f.resource.setFavorite('teaching', false); await tick(); const retry = f.resource.retry(); await tick();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 2); assert.deepEqual(f.calls[2].body, { favorite: false });
  f.calls[2].response.resolve({ favoriteIds: [] }); await latest;
  const read = f.calls.filter(call => call.method === 'GET').at(-1)!; read.response.resolve({ favoriteIds: [] }); await retry;
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 2); assert.deepEqual(f.resource.getSnapshot().favoriteIds, []);
});

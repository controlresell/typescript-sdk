import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConflictError, ControlResell, IDEMPOTENCY_KEY_HEADER, NotFoundError, RateLimitError, ServerError, VERSION,
} from '../src/index.js';

const KEY = 'cr_test_secret';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const envelope = (code: string) => ({ error: { code, message: 'm', params: {}, requestId: 'req-1' } });
const item = (id: number, sex = 'WOMEN') => ({
  id, name: 'n', sku: null, description: null, photos: [], categoryId: null, brandId: null, sizeId: null, colorIds: [],
  state: null, sex, labels: [], sold: false, estimatedPrice: { amount: '12.50', currency: 'EUR' }, purchasePrice: null,
  purchaseDate: null, sellingPrice: null, sellingDate: null, createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z', unknownField: 1,
});

function client(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch = (async (input: Request) => { requests.push(input); return handler(input); }) as typeof globalThis.fetch;
  return { requests, sdk: new ControlResell({ apiKey: KEY, baseUrl: 'https://api.test', fetch, retry: { baseDelayMs: 1, maxDelayMs: 5 } }) };
}

test('a call sends the key and the User-Agent', async () => {
  const { requests, sdk } = client(() => json({ id: 1, username: 'seller', currency: 'EUR', unknownField: true }));
  const me = await sdk.me.getMe();
  assert.equal(me.username, 'seller');
  assert.equal(requests[0].headers.get('Authorization'), `Bearer ${KEY}`);
  assert.equal(requests[0].headers.get('User-Agent'), `controlresell-typescript/${VERSION}`);
});

test('an error is typed by its status, with its code and requestId', async () => {
  const { sdk } = client(() => json(envelope('item_not_found'), 404));
  await assert.rejects(sdk.items.getItem(1), (e: unknown) => {
    assert.ok(e instanceof NotFoundError);
    assert.equal(e.code, 'item_not_found');
    assert.equal(e.requestId, 'req-1');
    assert.ok(!e.message.includes(KEY), 'the key never appears in an error');
    return true;
  });
});

test('a rate limit is retried after Retry-After, then succeeds', async () => {
  let calls = 0;
  const { sdk } = client(() => (++calls === 1 ? json(envelope('rate_limited'), 429, { 'Retry-After': '0' }) : json({ data: [], nextCursor: null })));
  await sdk.accounts.listAccounts();
  assert.equal(calls, 2);
});

test('a rate limit after the retries is a RateLimitError', async () => {
  let calls = 0;
  const { sdk } = client(() => { calls++; return json(envelope('rate_limited'), 429, { 'Retry-After': '0' }); });
  await assert.rejects(sdk.accounts.listAccounts(), (e: unknown) => e instanceof RateLimitError && e.retryAfter === 0);
  assert.equal(calls, 3, 'the first attempt and two retries');
});

test('a POST keeps the same Idempotency-Key across retries', async () => {
  const keys: Array<string | null> = [];
  const { sdk } = client((request) => {
    keys.push(request.headers.get(IDEMPOTENCY_KEY_HEADER));
    return keys.length < 3 ? json(envelope('idempotency_unavailable'), 503) : json({}, 201);
  });
  const { response } = await sdk.client.post({ url: '/api/public/v1/anything', body: { a: 1 } });
  assert.equal(response?.status, 201);
  assert.equal(keys.length, 3);
  assert.ok(keys[0] && keys.every((k) => k === keys[0]), String(keys));
});

test('only the 409 idempotency_in_progress is retried', async () => {
  let calls = 0;
  const { sdk } = client(() => { calls++; return json(envelope('idempotency_key_reused'), 409); });
  await assert.rejects(sdk.items.getItem(1), ConflictError);
  assert.equal(calls, 1, 'another 409 is not retried');
  calls = 0;
  const other = client(() => (++calls === 1 ? json(envelope('idempotency_in_progress'), 409) : json({ id: 1, username: 'u', currency: 'EUR' })));
  await other.sdk.me.getMe();
  assert.equal(calls, 2, 'idempotency_in_progress is retried once');
});

test('a 500 of a POST is not retried', async () => {
  let calls = 0;
  const { sdk } = client(() => { calls++; return json(envelope('internal_error'), 500); });
  const { response } = await sdk.client.post({ url: '/x', body: {} });
  assert.equal(response?.status, 500);
  assert.equal(calls, 1);
});

test('a 5xx through a route is a ServerError', async () => {
  const { sdk } = client(() => json(envelope('internal_error'), 500));
  await assert.rejects(sdk.me.getMe(), ServerError);
});

test('listAll reads every page with the same filters', async () => {
  const seen: Array<[string | null, string | null]> = [];
  const { sdk } = client((request) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    seen.push([cursor, url.searchParams.get('sold')]);
    return json(cursor === null ? { data: [item(1)], nextCursor: 'c2' } : { data: [item(2)], nextCursor: null });
  });
  const ids: number[] = [];
  for await (const it of sdk.items.listAll({ sold: false })) ids.push(it.id);
  assert.deepEqual(ids, [1, 2]);
  assert.deepEqual(seen, [[null, 'false'], ['c2', 'false']]);
});

test('an item keeps its amount as a decimal string and tolerates unknown values', async () => {
  const { sdk } = client(() => json(item(7, 'A_NEW_VALUE')));
  const it = await sdk.items.getItem(7);
  assert.equal(it.estimatedPrice?.amount, '12.50');
  assert.equal(it.sex, 'A_NEW_VALUE');
  assert.equal(it.purchasePrice, null);
});

test('publishItem posts the accounts with an Idempotency-Key and reads the scheduled action', async () => {
  const { requests, sdk } = client(() => json({ itemId: 7, action: 'PUBLISH', accountIds: ['a1'], scheduledAt: '2026-10-21T10:00:00Z' }, 202));
  const action = await sdk.items.publishItem(7, { accountIds: ['a1'] });
  assert.equal(action.action, 'PUBLISH');
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/items/7/publish');
  assert.deepEqual(await requests[0].clone().json(), { accountIds: ['a1'] });
  assert.ok(requests[0].headers.get(IDEMPOTENCY_KEY_HEADER));
});

test('a write uses the Idempotency-Key it is given', async () => {
  const { requests, sdk } = client(() => json({ itemId: 7, action: 'REPUBLISH', accountIds: [], scheduledAt: '2026-10-21T10:00:00Z' }, 202));
  await sdk.items.republishItem(7, {}, { idempotencyKey: 'my-key' });
  assert.equal(requests[0].headers.get(IDEMPOTENCY_KEY_HEADER), 'my-key');
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/items/7/republish');
});

test('dropItemPrice posts the drop to the price-drop route', async () => {
  const { requests, sdk } = client(() => json({ itemId: 7, action: 'PRICE_DROP', accountIds: [], scheduledAt: '2026-10-21T10:00:00Z' }, 202));
  await sdk.items.dropItemPrice(7, { type: 'PERCENT', value: '10' });
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/items/7/price-drop');
  assert.deepEqual(await requests[0].clone().json(), { type: 'PERCENT', value: '10' });
});

test('deleteItem resolves on 204 and throws a typed error on 409', async () => {
  const ok = client(() => new Response(null, { status: 204 }));
  await ok.sdk.items.deleteItem(7);
  assert.equal(ok.requests[0].method, 'DELETE');
  const refused = client(() => json(envelope('item_still_listed'), 409));
  await assert.rejects(refused.sdk.items.deleteItem(7), (e: unknown) => e instanceof ConflictError && e.code === 'item_still_listed');
});

test('sendMessage and sendOffer post to the conversation', async () => {
  const message = { id: 'm1', text: 'hi' };
  const { requests, sdk } = client(() => json(message, 201));
  await sdk.conversations.sendMessage('c1', { text: 'hi' });
  await sdk.conversations.sendOffer('c1', { price: { amount: '12.50', currency: 'EUR' } });
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), ['/api/public/v1/conversations/c1/messages', '/api/public/v1/conversations/c1/offers']);
  assert.deepEqual(await requests[1].clone().json(), { price: { amount: '12.50', currency: 'EUR' } });
});

test('a write keeps the same Idempotency-Key across its retries', async () => {
  const keys: Array<string | null> = [];
  const { sdk } = client((request) => {
    keys.push(request.headers.get(IDEMPOTENCY_KEY_HEADER));
    return keys.length < 2
      ? json(envelope('idempotency_unavailable'), 503)
      : json({ id: 'm1', conversationId: 'c1', author: 'SELLER', type: 'TEXT', status: 'SENT', createdAt: '2026-10-21T10:00:00Z' }, 201);
  });
  await sdk.conversations.sendMessage('c1', { text: 'hi' });
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[0] === keys[1], String(keys));
});

test('createItem posts the item with an Idempotency-Key and updateItem patches it without one', async () => {
  const { requests, sdk } = client((request) => json(item(7), request.method === 'POST' ? 201 : 200));
  const created = await sdk.items.createItem({ name: 'n' }, { idempotencyKey: 'k1' });
  const updated = await sdk.items.updateItem(7, { name: 'm' });
  assert.equal(created.id, 7);
  assert.equal(updated.id, 7);
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/items');
  assert.equal(requests[0].headers.get(IDEMPOTENCY_KEY_HEADER), 'k1');
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(new URL(requests[1].url).pathname, '/api/public/v1/items/7');
  assert.deepEqual(await requests[1].clone().json(), { name: 'm' });
  assert.equal(requests[1].headers.get(IDEMPOTENCY_KEY_HEADER), null);
});

test('getOrder and listOrderLabels read the order and its labels', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const { requests, sdk } = client((request) =>
    request.url.endsWith('/labels') ? json({ data: [], nextCursor: null }) : json({ id }));
  const order = await sdk.orders.getOrder(id);
  const labels = await sdk.orders.listOrderLabels(id);
  assert.equal(order.id, id);
  assert.deepEqual(labels.data, []);
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), [`/api/public/v1/orders/${id}`, `/api/public/v1/orders/${id}/labels`]);
});

test('orders.listAll follows the cursor with the same filters', async () => {
  const urls: URL[] = [];
  const { sdk } = client((request) => {
    const url = new URL(request.url);
    urls.push(url);
    return url.searchParams.get('cursor') ? json({ data: [{ id: 'b' }], nextCursor: null }) : json({ data: [{ id: 'a' }], nextCursor: 'c2' });
  });
  const ids: string[] = [];
  for await (const o of sdk.orders.listAll({ bucket: 'to_send', platform: 'VINTED', limit: 1 })) ids.push(o.id);
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(urls[0].pathname, '/api/public/v1/orders');
  assert.deepEqual(urls.map((u) => u.searchParams.get('bucket')), ['to_send', 'to_send']);
  assert.equal(urls[1].searchParams.get('cursor'), 'c2');
});

test('orders.listAllLabelsToShip follows the cursor on /orders/labels', async () => {
  const urls: URL[] = [];
  const { sdk } = client((request) => {
    const url = new URL(request.url);
    urls.push(url);
    return url.searchParams.get('cursor')
      ? json({ data: [{ id: 'l2', orderId: 'o2' }], nextCursor: null })
      : json({ data: [{ id: 'l1', orderId: 'o1' }], nextCursor: 'c2' });
  });
  const orders: string[] = [];
  for await (const label of sdk.orders.listAllLabelsToShip({ limit: 1 })) orders.push(label.orderId);
  assert.deepEqual(orders, ['o1', 'o2']);
  assert.equal(urls[0].pathname, '/api/public/v1/orders/labels');
  assert.equal(urls[1].searchParams.get('cursor'), 'c2');
});

test('customers.listAll follows the cursor with the same filters', async () => {
  const urls: URL[] = [];
  const { sdk } = client((request) => {
    const url = new URL(request.url);
    urls.push(url);
    return url.searchParams.get('cursor') ? json({ data: [{ id: 'b' }], nextCursor: null }) : json({ data: [{ id: 'a' }], nextCursor: 'c2' });
  });
  const ids: string[] = [];
  for await (const c of sdk.customers.listAll({ from: '2026-10-01T00:00:00Z', accountId: 'acc', limit: 1 })) ids.push(c.id);
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(urls[0].pathname, '/api/public/v1/customers');
  assert.deepEqual(urls.map((u) => u.searchParams.get('from')), ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z']);
  assert.deepEqual(urls.map((u) => u.searchParams.get('accountId')), ['acc', 'acc']);
  assert.equal(urls[1].searchParams.get('cursor'), 'c2');
});

test('customers.getCustomer reads one customer', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const { requests, sdk } = client(() => json({ id }));
  assert.equal((await sdk.customers.getCustomer(id)).id, id);
  assert.equal(new URL(requests[0].url).pathname, `/api/public/v1/customers/${id}`);
});

test('conversations.listConversationMessages sends the from and to window', async () => {
  const { requests, sdk } = client(() => json({ data: [], nextCursor: null }));
  await sdk.conversations.listConversationMessages('c1', { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' });
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('from'), '2026-10-01T00:00:00Z');
  assert.equal(url.searchParams.get('to'), '2026-10-02T00:00:00Z');
});

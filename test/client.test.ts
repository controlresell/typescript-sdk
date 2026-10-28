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

test('publishItem, dropItemPrice and republishItem send scheduledAt', async () => {
  const at = '2026-11-02T10:00:00Z';
  const { requests, sdk } = client(() => json({ itemId: 7, action: 'PUBLISH', accountIds: [], scheduledAt: at }, 202));
  await sdk.items.publishItem(7, { accountIds: ['a1'], scheduledAt: at });
  await sdk.items.dropItemPrice(7, { type: 'PERCENT', value: '10', scheduledAt: at });
  await sdk.items.republishItem(7, { scheduledAt: at });
  for (const request of requests) assert.equal((await request.clone().json()).scheduledAt, at);
  assert.equal(requests.length, 3);
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

test('favorites.listAll follows the cursor with the same filters', async () => {
  const urls: URL[] = [];
  const { sdk } = client((request) => {
    const url = new URL(request.url);
    urls.push(url);
    return url.searchParams.get('cursor') ? json({ data: [{ id: 'b', buyerId: 'b2', item: null }], nextCursor: null }) : json({ data: [{ id: 'a', buyerId: 'b1', item: { id: 42, name: 'Jacket' } }], nextCursor: 'c2' });
  });
  const buyers: string[] = [];
  for await (const f of sdk.favorites.listAll({ from: '2026-10-01T00:00:00Z', itemId: 42, accountId: 'acc', limit: 1 })) buyers.push(f.buyerId);
  assert.deepEqual(buyers, ['b1', 'b2']);
  assert.equal(urls[0].pathname, '/api/public/v1/favorites');
  assert.deepEqual(urls.map((u) => u.searchParams.get('itemId')), ['42', '42']);
  assert.deepEqual(urls.map((u) => u.searchParams.get('accountId')), ['acc', 'acc']);
  assert.deepEqual(urls.map((u) => u.searchParams.get('from')), ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z']);
  assert.equal(urls[1].searchParams.get('cursor'), 'c2');
});

test('favorites.listAllItemFavorites reads the favorites of one item', async () => {
  const { requests, sdk } = client(() => json({ data: [{ id: 'a', buyerId: 'b1', item: null }], nextCursor: null }));
  const buyers: string[] = [];
  for await (const f of sdk.favorites.listAllItemFavorites(42, { to: '2026-10-02T00:00:00Z' })) buyers.push(f.buyerId);
  assert.deepEqual(buyers, ['b1']);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/public/v1/items/42/favorites');
  assert.equal(url.searchParams.get('to'), '2026-10-02T00:00:00Z');
});

test('conversations.listConversations sends the buyer, item and offer status filters', async () => {
  const { requests, sdk } = client(() => json({ data: [], nextCursor: null }));
  await sdk.conversations.listConversations({ buyerId: 'b-1', itemId: 42, offerStatus: 'PENDING' });
  const params = new URL(requests[0].url).searchParams;
  assert.equal(params.get('buyerId'), 'b-1');
  assert.equal(params.get('itemId'), '42');
  assert.equal(params.get('offerStatus'), 'PENDING');
});

test('catalogs.listAllBrands follows the cursor with the same query', async () => {
  const urls: URL[] = [];
  const { sdk } = client((request) => {
    const url = new URL(request.url);
    urls.push(url);
    return url.searchParams.get('cursor')
      ? json({ data: [{ id: 2, name: 'Nikon', custom: true }], nextCursor: null })
      : json({ data: [{ id: 1, name: 'Nike', custom: false }], nextCursor: 'c2' });
  });
  const names: string[] = [];
  for await (const b of sdk.catalogs.listAllBrands({ q: 'nik' })) names.push(b.name);
  assert.deepEqual(names, ['Nike', 'Nikon']);
  assert.equal(urls[0].pathname, '/api/public/v1/catalogs/brands');
  assert.deepEqual(urls.map((u) => u.searchParams.get('q')), ['nik', 'nik']);
  assert.equal(urls[1].searchParams.get('cursor'), 'c2');
});

test('catalogs.listCatalogColors sends the category and reads the values', async () => {
  const { requests, sdk } = client(() => json({ data: [{ id: 3, key: 'red', title: 'Red' }], nextCursor: null }));
  const page = await sdk.catalogs.listCatalogColors({ categoryId: 12 });
  assert.equal(page.data[0].title, 'Red');
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/public/v1/catalogs/colors');
  assert.equal(url.searchParams.get('categoryId'), '12');
});

test('catalogs.getCatalogCategoryFields reads the fields of one category', async () => {
  const { requests, sdk } = client(() => json({ categoryId: 12, sizeGroupIds: [1], enumFields: [], textFields: [], measurements: [] }));
  assert.equal((await sdk.catalogs.getCatalogCategoryFields(12)).categoryId, 12);
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/catalogs/categories/12/fields');
});

test('conversations.listConversationMessages sends the from and to window', async () => {
  const { requests, sdk } = client(() => json({ data: [], nextCursor: null }));
  await sdk.conversations.listConversationMessages('c1', { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' });
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('from'), '2026-10-01T00:00:00Z');
  assert.equal(url.searchParams.get('to'), '2026-10-02T00:00:00Z');
});

const ENDPOINT = {
  id: '0b6f3c1e-8d43-4a4c-9a55-7f1f2c3d4e5f', url: 'https://example.com/hook', description: null, eventTypes: ['item.sold'],
  payloadMode: 'light', status: 'enabled', apiVersion: 'v1', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
};

test('webhooks.createWebhookEndpoint posts with an Idempotency-Key and returns the secret', async () => {
  const { requests, sdk } = client(() => json({ endpoint: ENDPOINT, secret: 'whsec_abc' }, 201));
  const created = await sdk.webhooks.createWebhookEndpoint({ url: 'https://example.com/hook', eventTypes: ['item.sold'] });
  assert.equal(created.secret, 'whsec_abc');
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/webhook-endpoints');
  assert.ok(requests[0].headers.get(IDEMPOTENCY_KEY_HEADER));
  assert.deepEqual((await requests[0].json()).eventTypes, ['item.sold']);
});

test('webhooks.updateWebhookEndpoint sends an explicit null to clear the description', async () => {
  const { requests, sdk } = client(() => json(ENDPOINT));
  await sdk.webhooks.updateWebhookEndpoint(ENDPOINT.id, { description: null });
  assert.equal(requests[0].method, 'PATCH');
  assert.deepEqual(await requests[0].json(), { description: null });
});

test('webhooks.listAllEvents follows the cursor with the same types and reads any data', async () => {
  const { requests, sdk } = client((request) => new URL(request.url).searchParams.has('cursor')
    ? json({ data: [{ id: 'e2', type: 'order.created', createdAt: '2026-10-24T00:01:00Z', apiVersion: 'v1', sellerId: 7, data: { orderId: 'o1', items: [1, 2] } }], nextCursor: null })
    : json({ data: [{ id: 'e1', type: 'item.sold', createdAt: '2026-10-24T00:00:00Z', apiVersion: 'v1', sellerId: 7, data: { itemId: 42, object: null } }], nextCursor: 'c2' }));
  const events = [];
  for await (const event of sdk.webhooks.listAllEvents({ type: 'item.sold,order.created' })) events.push(event);
  assert.deepEqual(events.map((e) => e.type), ['item.sold', 'order.created']);
  assert.equal(events[0].data.itemId, 42);
  assert.deepEqual(requests.map((r) => new URL(r.url).searchParams.get('type')), ['item.sold,order.created', 'item.sold,order.created']);
  assert.equal(new URL(requests[1].url).searchParams.get('cursor'), 'c2');
});

test('webhooks deliveries send their filters, retry posts to the delivery and delete resolves on 204', async () => {
  const delivery = { id: 'd1', eventId: 'e1', eventType: 'item.sold', status: 'failed', attempt: 3, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
  const { requests, sdk } = client((request) => request.method === 'DELETE' ? new Response(null, { status: 204 })
    : request.method === 'GET' ? json({ data: [delivery], nextCursor: null }) : json(delivery, 202));
  const page = await sdk.webhooks.listWebhookDeliveries(ENDPOINT.id, { status: 'failed' });
  assert.equal(page.data[0].attempt, 3);
  await sdk.webhooks.retryWebhookDelivery(ENDPOINT.id, 'd1');
  await sdk.webhooks.deleteWebhookEndpoint(ENDPOINT.id);
  assert.equal(new URL(requests[0].url).searchParams.get('status'), 'failed');
  assert.equal(new URL(requests[1].url).pathname, `/api/public/v1/webhook-endpoints/${ENDPOINT.id}/deliveries/d1/retry`);
  assert.ok(requests[1].headers.get(IDEMPOTENCY_KEY_HEADER));
  assert.equal(requests[2].method, 'DELETE');
});

test('webhooks.testWebhookEndpoint is never replayed after a 5xx or a network error, only after a 429', async () => {
  const path = `/api/public/v1/webhook-endpoints/${ENDPOINT.id}/test`;
  for (const status of [500, 502, 503, 504]) {
    const { requests, sdk } = client(() => json(envelope('unavailable'), status));
    await assert.rejects(sdk.webhooks.testWebhookEndpoint(ENDPOINT.id));
    assert.equal(requests.length, 1, `status ${status} is not replayed`);
    assert.equal(new URL(requests[0].url).pathname, path);
  }
  let calls = 0;
  const failing = client(() => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(failing.sdk.webhooks.testWebhookEndpoint(ENDPOINT.id));
  assert.equal(calls, 1, 'a network error is not replayed');
  calls = 0;
  const busy = client(() => (++calls === 1 ? json(envelope('webhook_endpoint_busy'), 429, { 'Retry-After': '0' }) : json({ status: 200, durationMs: 12 })));
  await busy.sdk.webhooks.testWebhookEndpoint(ENDPOINT.id);
  assert.equal(calls, 2, 'a 429 is answered before the event leaves, so it is retried');
  calls = 0;
  const other = client(() => (++calls === 1 ? json(envelope('unavailable'), 503) : json({ ...ENDPOINT })));
  await other.sdk.webhooks.getWebhookEndpoint(ENDPOINT.id);
  assert.equal(calls, 2, 'other calls keep the retry on 503');
});

test('uploadFile registers a file with an Idempotency-Key and getFile reads it', async () => {
  const { requests, sdk } = client((request) => request.method === 'POST'
    ? json({ id: 'f1', uploadUrl: 'https://s3.test/put' }, 201)
    : json({ id: 'f1', status: 'CONFIRMED', url: 'https://s3.test/get', createdAt: '2026-10-28T10:00:00Z' }));
  const upload = await sdk.files.uploadFile({ filename: 'a.jpg', contentType: 'image/jpeg', size: 3 });
  assert.equal(upload.uploadUrl, 'https://s3.test/put');
  assert.equal(new URL(requests[0].url).pathname, '/api/public/v1/files');
  assert.deepEqual(await requests[0].clone().json(), { filename: 'a.jpg', contentType: 'image/jpeg', size: 3 });
  assert.ok(requests[0].headers.get(IDEMPOTENCY_KEY_HEADER));
  const file = await sdk.files.getFile('f1');
  assert.equal(file.status, 'CONFIRMED');
  assert.equal(new URL(requests[1].url).pathname, '/api/public/v1/files/f1');
});

test('upload registers the file then PUTs the bytes without the API key', async () => {
  const puts: Array<{ url: string; init?: RequestInit }> = [];
  const requests: Request[] = [];
  const fetch = (async (input: Request | string, init?: RequestInit) => {
    if (typeof input === 'string') { puts.push({ url: input, init }); return new Response(null, { status: 200 }); }
    requests.push(input);
    return json({ id: 'f1', uploadUrl: 'https://s3.test/put' }, 201);
  }) as typeof globalThis.fetch;
  const sdk = new ControlResell({ apiKey: KEY, baseUrl: 'https://api.test', fetch });
  const upload = await sdk.files.upload(new Uint8Array([1, 2, 3]), { filename: 'a.jpg', contentType: 'image/jpeg' });
  assert.equal(upload.id, 'f1');
  assert.deepEqual(await requests[0].clone().json(), { filename: 'a.jpg', contentType: 'image/jpeg', size: 3 });
  assert.equal(puts[0].url, 'https://s3.test/put');
  assert.equal(puts[0].init?.method, 'PUT');
  assert.deepEqual(puts[0].init?.headers, { 'Content-Type': 'image/jpeg' });
});

test('upload throws when the PUT is refused', async () => {
  const fetch = (async (input: Request | string) =>
    typeof input === 'string' ? new Response(null, { status: 403 }) : json({ id: 'f1', uploadUrl: 'https://s3.test/put' }, 201)) as typeof globalThis.fetch;
  const sdk = new ControlResell({ apiKey: KEY, baseUrl: 'https://api.test', fetch });
  await assert.rejects(sdk.files.upload(new Uint8Array([1]), { filename: 'a.jpg', contentType: 'image/jpeg' }), /HTTP 403/);
});

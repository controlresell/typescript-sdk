# ControlResell TypeScript SDK

TypeScript client for the [ControlResell](https://controlresell.com) public API (Node 20+, any runtime with `fetch`).

## Install

From the 1.0.0 release, on [npm](https://www.npmjs.com/package/controlresell-sdk):

```sh
npm install controlresell-sdk
```


```ts
import { ControlResell } from 'controlresell-sdk';

const client = new ControlResell({ apiKey: 'cr_live_...' }); // or set CONTROLRESELL_API_KEY
const me = await client.me.getMe();
for await (const item of client.items.listAll({ sold: false })) console.log(item.name);
for await (const order of client.orders.listAll({ bucket: 'to_send' })) console.log(order.id); // needs the orders:read scope; also client.orders.getOrder(id), listOrderLabels(id)
for await (const brand of client.catalogs.listAllBrands({ q: 'nik' })) console.log(brand.id, brand.name); // the identifiers an item is written with (items:read): getCatalogCategory, getCatalogCategoryFields, listAllCategories, listAllBrands, listAllSizes, listAllColors, listAllConditions, listAllPackageSizes, listAllMaterials (one page: listCatalog…)

for await (const favorite of client.favorites.listAll({ itemId: 42 })) console.log(favorite.buyerId); // the buyers who favorited a listing (items:read); also listAllItemFavorites(42), listFavorites, listItemFavorites
await client.conversations.listConversations({ buyerId: 'BUYER_ID', offerStatus: 'PENDING' }); // buyerId, itemId and offerStatus filter the conversations

// Writes (API key with `items:write` / `conversations:write`); pass `{ idempotencyKey }` to choose the key.
await client.items.publishItem(42, { accountIds: ['<account id>'] });
await client.items.publishItem(42, { accountIds: ['<account id>'], scheduledAt: '2026-11-02T10:00:00Z' }); // publishItem, dropItemPrice and republishItem take an optional scheduledAt (ISO 8601, at most 30 days ahead); without it they run now
await client.items.createItem({ name: 'Jacket' }); // PATCH: client.items.updateItem(42, { name: 'Jacket XL' })
await client.conversations.sendMessage('<conversation id>', { text: 'Hello!' });

// Photos (`items:write`): `upload` registers the file and sends its bytes (an HTTP PUT to the returned address); put its id in `photoIds`.
// `files.uploadFile` only registers it (you PUT the bytes yourself), `files.getFile(id)` reads it (`status` is PENDING until its bytes are stored).
const photo = await client.files.upload(await readFile('jacket.jpg'), { filename: 'jacket.jpg', contentType: 'image/jpeg' });
await client.items.createItem({ name: 'Jacket', photoIds: [photo.id] });

// Webhooks (`webhooks:read` / `webhooks:write`): list, get, create, update, delete an endpoint, read or rotate its secret,
// test it, list and retry its deliveries, recover the failed ones; listAllEvents catches up the last 7 days.
const { endpoint, secret } = await client.webhooks.createWebhookEndpoint({ url: 'https://example.com/hooks', eventTypes: ['item.sold'] });
for await (const event of client.webhooks.listAllEvents({ type: 'item.sold' })) console.log(event.type, event.data.itemId);
```

Retries (rate limits, 502/503/504, network errors), `Idempotency-Key` on every `POST`, cursor pagination with `for await` and typed errors (`NotFoundError`, `RateLimitError`…) are built in. The client is generated from the API's OpenAPI document (`npm run generate`, code in `src/generated`).

Licensed under the Apache License 2.0.

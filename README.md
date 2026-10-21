# ControlResell TypeScript SDK

TypeScript client for the [ControlResell](https://controlresell.com) public API (Node 20+, any runtime with `fetch`).

```ts
import { ControlResell } from 'controlresell';

const client = new ControlResell({ apiKey: 'cr_live_...' }); // or set CONTROLRESELL_API_KEY
const me = await client.me.getMe();
for await (const item of client.items.listAll({ sold: false })) console.log(item.name);
for await (const order of client.orders.listAll({ bucket: 'to_send' })) console.log(order.id); // needs the orders:read scope; also client.orders.getOrder(id), listOrderLabels(id), listAllLabelsToShip()
for await (const message of client.conversations.listAllMessages('<conversation id>', { from: '2026-10-01T00:00:00Z' })) console.log(message.text); // `from` inclusive, `to` exclusive, ISO-8601 with an offset

// Writes (API key with `items:write` / `conversations:write`); pass `{ idempotencyKey }` to choose the key.
await client.items.publishItem(42, { accountIds: ['<account id>'] });
await client.items.createItem({ name: 'Jacket' }); // PATCH: client.items.updateItem(42, { name: 'Jacket XL' })
await client.conversations.sendMessage('<conversation id>', { text: 'Hello!' });
```

Retries (rate limits, 502/503/504, network errors), `Idempotency-Key` on every `POST`, cursor pagination with `for await` and typed errors (`NotFoundError`, `RateLimitError`…) are built in. The client is generated from the API's OpenAPI document (`npm run generate`, code in `src/generated`).

Not published yet. Licensed under the Apache License 2.0.

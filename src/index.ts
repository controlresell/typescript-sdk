import { type Client, createClient } from './generated/client/index.js';
import { Accounts, Conversations, Items, Me, Orders } from './generated/sdk.gen.js';
import type {
  CreateItemData, DropItemPriceData, ListAccountsData, ListConversationMessagesData, ListConversationsData, ListItemsData,
  ListOrdersData, PublishItemData, RepublishItemData, SendMessageData, SendOfferData, UpdateItemData,
} from './generated/types.gen.js';
import { ConnectionError, errorOf } from './errors.js';
import { retryingFetch, type RetryPolicy } from './fetch.js';
import { paginate } from './pagination.js';

export * from './errors.js';
export { IDEMPOTENCY_KEY_HEADER, type RetryPolicy } from './fetch.js';
export { paginate, type Page } from './pagination.js';
export type * from './generated/types.gen.js';

/** The version of this SDK. */
export const VERSION = '0.1.0';

/** The production address of the API. */
export const DEFAULT_BASE_URL = 'https://api.controlresell.com';

/** The environment variable read when no API key is given. */
export const API_KEY_VARIABLE = 'CONTROLRESELL_API_KEY';

export interface ControlResellOptions {
  /** The API key; absent, the `CONTROLRESELL_API_KEY` environment variable. */
  apiKey?: string;
  /** The API's address. */
  baseUrl?: string;
  /** How calls are retried. */
  retry?: RetryPolicy;
  /** The `fetch` to call (the global one by default). */
  fetch?: typeof fetch;
}

type Query<T extends { query?: unknown }> = NonNullable<T['query']>;

/** The options of a write: the `Idempotency-Key` to use (a random one by default, kept across the retries). */
export interface WriteOptions {
  idempotencyKey?: string;
}

const idempotency = (options?: WriteOptions) => ({
  'Idempotency-Key': options?.idempotencyKey ?? globalThis.crypto.randomUUID(),
});

/**
 * A client of the ControlResell public API, for one API key.
 *
 * ```ts
 * const client = new ControlResell({ apiKey: 'cr_live_...' });
 * const me = await client.me.getMe();
 * for await (const item of client.items.listAll({ sold: false })) console.log(item.name);
 * ```
 *
 * Calls are retried on a rate limit (after `Retry-After`), on a gateway or availability error (502, 503, 504) and on a
 * network error; a `POST` always carries the same `Idempotency-Key` across its retries. Any other error is thrown as a
 * {@link ControlResellError}. The client holds no global state: create one per API key.
 */
export class ControlResell {
  /** The underlying generated client, configured with the retries and the key. */
  readonly client: Client;

  constructor(options: ControlResellOptions = {}) {
    const apiKey = options.apiKey ?? environmentVariable(API_KEY_VARIABLE);
    if (!apiKey) throw new Error(`No API key: pass apiKey or set ${API_KEY_VARIABLE}.`);
    this.client = createClient({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      auth: () => apiKey,
      headers: { 'User-Agent': `controlresell-typescript/${VERSION}` },
      fetch: retryingFetch(options.fetch ?? globalThis.fetch, options.retry) as typeof fetch,
    });
  }

  /** The seller the API key acts for. */
  readonly me = {
    getMe: () => this.call(Me.getMe({ client: this.client })),
  };

  /** The seller's marketplace accounts. */
  readonly accounts = {
    listAccounts: (query?: Query<ListAccountsData>) => this.call(Accounts.listAccounts({ client: this.client, query })),
    getAccount: (id: string) => this.call(Accounts.getAccount({ client: this.client, path: { id } })),
    listAll: (query?: Omit<Query<ListAccountsData>, 'cursor'>) =>
      paginate((cursor) => this.accounts.listAccounts({ ...query, cursor })),
  };

  /** The items of the seller's stock. */
  readonly items = {
    listItems: (query?: Query<ListItemsData>) => this.call(Items.listItems({ client: this.client, query })),
    getItem: (id: number) => this.call(Items.getItem({ client: this.client, path: { id } })),
    listItemListings: (id: number) => this.call(Items.listItemListings({ client: this.client, path: { id } })),
    /** Creates an item in the stock (an `Idempotency-Key` is sent, and kept across the retries). */
    createItem: (body: CreateItemData['body'], options?: WriteOptions) =>
      this.call(Items.createItem({ client: this.client, body, headers: idempotency(options) })),
    /** Updates the given fields of an item (a `PATCH`: the fields left out are kept). */
    updateItem: (id: number, body: UpdateItemData['body']) =>
      this.call(Items.updateItem({ client: this.client, path: { id }, body })),
    /** Deletes an item of the stock; an item still online is refused (`409 item_still_listed`). */
    deleteItem: (id: number) => this.callEmpty(Items.deleteItem({ client: this.client, path: { id } })),
    /** Schedules the publication of an item on the given accounts. */
    publishItem: (id: number, body: PublishItemData['body'], options?: WriteOptions) =>
      this.call(Items.publishItem({ client: this.client, path: { id }, body, headers: idempotency(options) })),
    /** Schedules a price drop of the item's listings. */
    dropItemPrice: (id: number, body: DropItemPriceData['body'], options?: WriteOptions) =>
      this.call(Items.dropItemPrice({ client: this.client, path: { id }, body, headers: idempotency(options) })),
    /** Schedules the republication of an item. */
    republishItem: (id: number, body: RepublishItemData['body'] = {}, options?: WriteOptions) =>
      this.call(Items.republishItem({ client: this.client, path: { id }, body, headers: idempotency(options) })),
    listAll: (query?: Omit<Query<ListItemsData>, 'cursor'>) =>
      paginate((cursor) => this.items.listItems({ ...query, cursor })),
  };

  /** The conversations with buyers. */
  readonly conversations = {
    listConversations: (query?: Query<ListConversationsData>) =>
      this.call(Conversations.listConversations({ client: this.client, query })),
    getConversation: (id: string) => this.call(Conversations.getConversation({ client: this.client, path: { id } })),
    listConversationMessages: (id: string, query?: Query<ListConversationMessagesData>) =>
      this.call(Conversations.listConversationMessages({ client: this.client, path: { id }, query })),
    /** Sends a message to the buyer. */
    sendMessage: (id: string, body: SendMessageData['body'], options?: WriteOptions) =>
      this.call(Conversations.sendMessage({ client: this.client, path: { id }, body, headers: idempotency(options) })),
    /** Sends the buyer an offer. */
    sendOffer: (id: string, body: SendOfferData['body'], options?: WriteOptions) =>
      this.call(Conversations.sendOffer({ client: this.client, path: { id }, body, headers: idempotency(options) })),
    listAll: (query?: Omit<Query<ListConversationsData>, 'cursor'>) =>
      paginate((cursor) => this.conversations.listConversations({ ...query, cursor })),
    listAllMessages: (id: string, query?: Omit<Query<ListConversationMessagesData>, 'cursor'>) =>
      paginate((cursor) => this.conversations.listConversationMessages(id, { ...query, cursor })),
  };

  /** The seller's orders (sales and purchases). */
  readonly orders = {
    listOrders: (query?: Query<ListOrdersData>) => this.call(Orders.listOrders({ client: this.client, query })),
    getOrder: (id: string) => this.call(Orders.getOrder({ client: this.client, path: { id } })),
    /** The shipping labels of an order. */
    listOrderLabels: (id: string) => this.call(Orders.listOrderLabels({ client: this.client, path: { id } })),
    listAll: (query?: Omit<Query<ListOrdersData>, 'cursor'>) =>
      paginate((cursor) => this.orders.listOrders({ ...query, cursor })),
  };

  private async callEmpty(result: Promise<{ error?: unknown; response?: Response }>): Promise<void> {
    const { error, response } = await result;
    if (!response) throw error instanceof Error ? error : new ConnectionError(error);
    if (!response.ok) throw errorOf(response, error);
  }

  private async call<T>(result: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
    const { data, error, response } = await result;
    if (!response) throw error instanceof Error ? error : new ConnectionError(error);
    if (!response.ok || data === undefined) throw errorOf(response, error);
    return data;
  }
}

function environmentVariable(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

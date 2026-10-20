/** One page of a list: its elements and the cursor of the next page (absent or `null` on the last one). */
export interface Page<T> {
  data: Array<T>;
  nextCursor?: string | null;
}

/**
 * Every element of a list paginated by cursor, page after page, as it is iterated (`for await`). [fetchPage] gets the
 * cursor of the page to read (`undefined` for the first one) and must send the same filters each time; the cursor is
 * opaque.
 */
export async function* paginate<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.data;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

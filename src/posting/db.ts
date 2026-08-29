/** The Drizzle handle, in its own module so ids/post/recompute avoid a cycle. */
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export type Db = DrizzleD1Database<typeof schema>;

/** A D1 batch needs at least one statement; Drizzle types it as a tuple. */
export type BatchItem = Parameters<Db['batch']>[0][number];

export function makeDb(binding: D1Database): Db {
  return drizzle(binding, { schema });
}

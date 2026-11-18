// The sealed snapshot's shape, and a strict reader for it.
//
// The grader mounts /input/snapshot.json (DefiLlama's protocol list, frozen once). Every field is checked
// here so the model downstream can trust its inputs: a malformed snapshot stops the run with a message
// naming the first bad field instead of producing a quietly wrong board.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROTOCOL_KEYS = ['slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol'];

function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

function fail(where: string, why: string): never {
  throw new SnapshotError(`snapshot ${where}: ${why}`);
}

function nullableString(v: unknown, where: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') fail(where, 'must be a string or null');
  return v;
}

function nullableNumber(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, 'must be a finite number or null');
  return v;
}

function readProtocol(raw: unknown, i: number): Protocol {
  const at = `protocols[${i}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(at, 'must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of PROTOCOL_KEYS) if (!(k in o)) fail(`${at}.${k}`, 'is missing');
  if (typeof o.slug !== 'string' || o.slug.length === 0 || /\s/.test(o.slug)) fail(`${at}.slug`, 'must be a non-empty string with no whitespace');
  if (typeof o.name !== 'string' || o.name.trim().length === 0) fail(`${at}.name`, 'must be a non-empty string');
  if (!Array.isArray(o.chains) || !o.chains.every((c) => typeof c === 'string')) fail(`${at}.chains`, 'must be an array of strings');
  if (typeof o.tvl_usd !== 'number' || !Number.isFinite(o.tvl_usd) || o.tvl_usd < 0) fail(`${at}.tvl_usd`, 'must be a non-negative number');
  const listed = o.listed_at;
  if (listed !== null && !isDay(listed)) fail(`${at}.listed_at`, 'must be a YYYY-MM-DD day or null');
  return {
    slug: o.slug,
    name: o.name,
    category: nullableString(o.category, `${at}.category`),
    chains: [...(o.chains as string[])],
    tvl_usd: o.tvl_usd,
    change_7d: nullableNumber(o.change_7d, `${at}.change_7d`),
    mcap_usd: nullableNumber(o.mcap_usd, `${at}.mcap_usd`),
    listed_at: listed as string | null,
    gecko_id: nullableString(o.gecko_id, `${at}.gecko_id`),
    symbol: nullableString(o.symbol, `${at}.symbol`),
  };
}

/** Parse and validate the snapshot's JSON text. Throws SnapshotError naming the first problem. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SnapshotError(`snapshot is not JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('root', 'must be an object');
  const o = raw as Record<string, unknown>;
  if (!isDay(o.as_of)) fail('as_of', 'must be a YYYY-MM-DD day');
  if (typeof o.source !== 'string') fail('source', 'must be a string');
  if (typeof o.floor_usd !== 'number' || !Number.isFinite(o.floor_usd) || o.floor_usd < 0) fail('floor_usd', 'must be a non-negative number');
  if (!Array.isArray(o.protocols) || o.protocols.length === 0) fail('protocols', 'must be a non-empty array');
  if (!Array.isArray(o.watchlist) || !o.watchlist.every((s) => typeof s === 'string')) fail('watchlist', 'must be an array of slugs');

  const protocols = o.protocols.map(readProtocol);
  const seen = new Set<string>();
  for (const p of protocols) {
    if (seen.has(p.slug)) fail('protocols', `slug ${p.slug} appears twice`);
    seen.add(p.slug);
  }
  const watchlist = [...(o.watchlist as string[])];
  for (const s of watchlist) if (!seen.has(s)) fail('watchlist', `names ${s}, which protocols does not list`);

  return { as_of: o.as_of as string, source: o.source, floor_usd: o.floor_usd, protocols, watchlist };
}

/** Whole days from `from` to `to`, both YYYY-MM-DD; null when `from` is null. */
export function daysBetween(from: string | null, to: string): number | null {
  if (from === null) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

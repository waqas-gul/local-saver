#!/usr/bin/env node
/**
 * Load the shared-egress lists into app.network_egress_ranges (03 §3.5 (a)): Apple iCloud Private
 * Relay egress ranges and the Tor exit list. Addresses in these lists make a network
 * `shared_egress` (local sharing off).
 *
 *   LOADER_DATABASE_URL=postgres://app_egress_loader:…@… node scripts/load-egress-ranges.cjs
 *   LOADER_DATABASE_URL=… node scripts/load-egress-ranges.cjs --apple apple.csv --tor tor.txt
 *
 * Without --apple/--tor the lists are downloaded. Adjacent and overlapping ranges are merged
 * first (285,000 Apple rows become about 14,000), so the app's coarse-prefix lookup gets a few
 * rows back (review L5). Both sources are replaced in one transaction through
 * app.replace_egress_ranges, which also records the load in app.runtime_flags('egress_ranges'), so
 * staging and production can fail closed when the lists go stale (lib/server/network/egress.ts).
 *
 * Phase 3 (D-4): scheduled daily by .github/workflows/refresh-egress-ranges.yml, connecting as the
 * least-privilege app_egress_loader role, which may only run that function. It runs outside an
 * Edge Function because the merge needs about 4 s of CPU, twice the Edge limit (P3-00).
 */
const { readFileSync } = require("node:fs");
const ipaddr = require("ipaddr.js");
const pg = require("pg");

const SOURCES = {
  private_relay: "https://mask-api.icloud.com/egress-ip-ranges.csv",
  tor: "https://check.torproject.org/torbulkexitlist",
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function read(source, file) {
  if (file) return readFileSync(file, "utf8");
  const response = await fetch(SOURCES[source]);
  if (!response.ok) throw new Error(`${source}: download failed (${response.status})`);
  return response.text();
}

function toBigInt(addr) {
  return addr.toByteArray().reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function fromBigInt(value, bytes) {
  const out = new Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return ipaddr.fromByteArray(out).toString();
}

/** Merge adjacent and overlapping CIDRs and split the result into the fewest aligned blocks. */
function collapse(cidrs) {
  const intervals = cidrs.map((cidr) => {
    const [addr, bits] = ipaddr.parseCIDR(cidr);
    const width = addr.kind() === "ipv4" ? 32 : 128;
    const start = toBigInt(addr) & ~((1n << BigInt(width - bits)) - 1n);
    return { width, start, end: start + (1n << BigInt(width - bits)) - 1n };
  });
  intervals.sort((a, b) => a.width - b.width || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const merged = [];
  for (const next of intervals) {
    const last = merged[merged.length - 1];
    if (last && last.width === next.width && next.start <= last.end + 1n) {
      if (next.end > last.end) last.end = next.end;
    } else {
      merged.push({ ...next });
    }
  }

  const out = [];
  for (const { width, start, end } of merged) {
    let cursor = start;
    while (cursor <= end) {
      // The largest block aligned at cursor that still fits before end.
      let size = cursor === 0n ? 1n << BigInt(width) : cursor & -cursor;
      while (size > end - cursor + 1n) size >>= 1n;
      out.push(`${fromBigInt(cursor, width / 8)}/${width - (size.toString(2).length - 1)}`);
      cursor += size;
    }
  }
  return out;
}

/** Canonical network CIDRs; anything unparsable is counted and skipped. */
function parse(text, source) {
  const cidrs = new Set();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const field = line.split(",")[0].trim();
    if (!field || field.startsWith("#")) continue;
    try {
      const [addr, bits] = field.includes("/")
        ? ipaddr.parseCIDR(field)
        : [ipaddr.parse(field), ipaddr.parse(field).kind() === "ipv4" ? 32 : 128];
      const network = addr.kind() === "ipv4"
        ? ipaddr.IPv4.networkAddressFromCIDR(`${addr}/${bits}`)
        : ipaddr.IPv6.networkAddressFromCIDR(`${addr}/${bits}`);
      cidrs.add(`${network}/${bits}`);
    } catch {
      skipped++;
    }
  }
  if (cidrs.size === 0) throw new Error(`${source}: no usable ranges (refusing to empty the list)`);
  return { listed: cidrs.size, cidrs: collapse([...cidrs]), skipped };
}

async function main() {
  const connectionString = process.env.LOADER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("set LOADER_DATABASE_URL");
  const lists = {
    private_relay: parse(await read("private_relay", arg("--apple")), "private_relay"),
    tor: parse(await read("tor", arg("--tor")), "tor"),
  };

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("begin");
    for (const [source, { cidrs }] of Object.entries(lists)) {
      await client.query("select app.replace_egress_ranges($1, $2::cidr[])", [source, cidrs]);
    }
    await client.query("commit");
    for (const [source, list] of Object.entries(lists)) {
      console.log(`${source}: ${list.listed} ranges listed, ${list.cidrs.length} rows after merging, ${list.skipped} lines skipped`);
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = { collapse, parse };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

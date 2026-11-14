import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://who-is-that-champion-data-api.vercel.app/api';
const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Champion metadata returned HTTP ${response.status}`);

const payload = await response.json();
const rows = payload.champions_data?.en_us;
const version = payload.champions_data?.latest_version;
if (!version || !Array.isArray(rows) || rows.length < 150) {
  throw new Error('Champion metadata response is incomplete.');
}

function splitValues(value) {
  return typeof value === 'string'
    ? value.split(/\s*\/\s*|\s*,\s*/).map((part) => part.trim()).filter(Boolean)
    : [];
}

const champions = rows.map((row) => {
  const releaseYear = Number(row.release_year);
  if (!row.key || !row.name || !Number.isInteger(releaseYear)) {
    throw new Error(`Invalid champion metadata for ${row.name ?? 'an unnamed champion'}.`);
  }

  return {
    id: row.key,
    name: row.name,
    title: row.title ?? '',
    tags: splitValues(row.functions),
    imageFile: `${row.key}.png`,
    metadata: {
      gender: row.gender || '',
      positions: splitValues(row.lane),
      species: [],
      resource: row.resource || 'Manaless',
      rangeType: row.range_type || '',
      regions: splitValues(row.region),
      releaseYear,
    },
  };
});

if (new Set(champions.map((champion) => champion.id)).size !== champions.length) {
  throw new Error('Champion metadata contains duplicate IDs.');
}

const outputUrl = new URL('../data/champions.json', import.meta.url);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify({ version, champions }, null, 2)}\n`, 'utf8');
console.log(`Saved ${champions.length} champions for Data Dragon ${version} to ${fileURLToPath(outputUrl)}.`);

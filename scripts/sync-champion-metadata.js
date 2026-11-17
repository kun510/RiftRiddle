import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://who-is-that-champion-data-api.vercel.app/api';
const loldlePageUrl = 'https://loldle.net/classic';
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

function normalizeChampionName(value) {
  return value.toLowerCase().replace(/['’‘]/g, '').replace(/[^a-z0-9]/g, '');
}

function extractArray(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`LoLdle data marker "${marker}" was not found.`);
  const start = source.indexOf('[', markerIndex);
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('LoLdle champion data array was incomplete.');
}

async function getLoldleSpecies(champions) {
  const pageResponse = await fetch(loldlePageUrl, { signal: AbortSignal.timeout(30000) });
  if (!pageResponse.ok) throw new Error(`LoLdle returned HTTP ${pageResponse.status}.`);
  const pageHtml = await pageResponse.text();
  const indexScript = [...pageHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .find((url) => /\/index\.[^/]+\.js$/i.test(url));
  if (!indexScript) throw new Error('Could not find the LoLdle Classic data bundle.');

  const bundleUrl = new URL(indexScript, loldlePageUrl);
  const bundleResponse = await fetch(bundleUrl, { signal: AbortSignal.timeout(30000) });
  if (!bundleResponse.ok) throw new Error(`LoLdle data bundle returned HTTP ${bundleResponse.status}.`);
  const bundle = await bundleResponse.text();
  const arraySource = extractArray(bundle, 'wl=[');
  const speciesByName = new Map();
  const recordPattern = /\{([^{}]*)\}/g;

  for (const match of arraySource.matchAll(recordPattern)) {
    const nameMatch = match[1].match(/championName:("(?:\\.|[^"\\])*")/);
    const speciesMatch = match[1].match(/species:(\[[^\]]*\])/);
    if (!nameMatch || !speciesMatch) {
      throw new Error('LoLdle champion data is missing a name or species list.');
    }

    const name = JSON.parse(nameMatch[1]);
    const species = JSON.parse(speciesMatch[1]);
    if (!Array.isArray(species) || !species.length || species.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`LoLdle species data is incomplete for ${name}.`);
    }

    const key = normalizeChampionName(name);
    if (speciesByName.has(key)) throw new Error(`LoLdle has duplicate champion data for ${name}.`);
    speciesByName.set(key, species);
  }

  if (speciesByName.size < 150) throw new Error('LoLdle champion data is incomplete.');
  for (const champion of champions) {
    if (!speciesByName.has(normalizeChampionName(champion.name))) {
      throw new Error(`LoLdle species data is missing for ${champion.name}.`);
    }
  }
  return speciesByName;
}

const loldleSpeciesByName = await getLoldleSpecies(rows.map((row) => ({ name: row.name })));
const champions = rows.map((row) => {
  const releaseYear = Number(row.release_year);
  if (!row.key || !row.name || !Number.isInteger(releaseYear)) {
    throw new Error(`Invalid champion metadata for ${row.name ?? 'an unnamed champion'}.`);
  }
  const species = loldleSpeciesByName.get(normalizeChampionName(row.name));

  return {
    id: row.key,
    name: row.name,
    title: row.title ?? '',
    tags: splitValues(row.functions),
    imageFile: `${row.key}.png`,
    metadata: {
      gender: row.gender || '',
      positions: splitValues(row.lane),
      species,
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

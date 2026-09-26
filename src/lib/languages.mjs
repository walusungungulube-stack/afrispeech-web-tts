/**
 * The languages the Listen feature can actually speak.
 *
 * Two code systems have to agree before a language can be offered: afriso uses
 * ISO 639-3, while Google Translate uses its own short codes. A language is
 * listed here only when both exist, so the dropdown can never offer a language
 * the translation step would reject.
 *
 * The name and country list for each code come from the generated table in
 * speech-data.mjs, which this repository owns.
 */

import { LANGUAGE_DATA } from './speech-data.mjs';


/**
 * Languages Gemini TTS has been confirmed to pronounce. Anything missing here
 * is hidden from the dropdown even when Google Translate supports it, because a
 * language the model reads back in an English accent is a worse offer than no
 * offer at all. Filled in from scripts/tts-probe.mjs.
 */
const TTS_CONFIRMED = new Set([]);

const BY_GOOGLE = new Map();
const BY_AFRISO = new Map();

export const SPEECH_LANGUAGES = Object.entries(LANGUAGE_DATA)
  .map(([code, entry]) => ({
    code,
    name: entry.name,
    countries: entry.countries,
    google: entry.google,
    tts: TTS_CONFIRMED.has(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  // `aka` and `twi` are the same continuum under two names; offer it once.
  .filter((lang, i, all) => all.findIndex((l) => l.google === lang.google) === i);

for (const lang of SPEECH_LANGUAGES) {
  // Lookups are lowercased, so index that way. Ndau's Google code carries a
  // region tag ("ndc-ZW") and would otherwise be unreachable by its own code.
  if (!BY_GOOGLE.has(lang.google.toLowerCase())) BY_GOOGLE.set(lang.google.toLowerCase(), lang);
  if (!BY_AFRISO.has(lang.code)) BY_AFRISO.set(lang.code, lang);
}

/** Languages the widget may offer: Google-translatable and TTS-proven. */
export const OFFERED_LANGUAGES = SPEECH_LANGUAGES.filter((l) => l.tts);

/** Resolve an afriso code, a Google code, or an English name. */
export function findSpeechLanguage(value) {
  const key = String(value || '').trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  return BY_AFRISO.get(lower) || BY_GOOGLE.get(lower)
    || SPEECH_LANGUAGES.find((l) => l.name.toLowerCase() === lower)
    || null;
}

/**
 * Which language to default to per country, so a reader in Tanzania is offered
 * Swahili and one in Nigeria Yoruba, rather than whatever sorts first.
 * Countries with no listed African language fall through to English.
 */
const DEFAULT_BY_COUNTRY = {
  // East
  TZ: 'swh', KE: 'swh', UG: 'swh', RW: 'kin', BI: 'run', CD: 'lin',
  CG: 'lin', GA: 'fon', CM: 'fon', CF: 'sag', ET: 'amh', SO: 'som',
  DJ: 'som', ER: 'tir', SS: 'din', SD: 'din',
  // Southern
  ZA: 'zul', ZW: 'sna', ZM: 'sna', BW: 'swh', NA: 'afr', LS: 'sot',
  SZ: 'ssw', MW: 'nya',
  // West
  NG: 'yor', GH: 'aka', TG: 'aka', CI: 'bci', SN: 'wol', GM: 'wol',
  // North and islands
  MA: 'zgh', MG: 'mlg', SC: 'crs',
};

/**
 * Pick a starting language from a browser locale such as "sw-TZ", "yo-NG" or
 * "en-GB": exact country match first, then the language half of the tag, then
 * English.
 */
export function defaultForLocale(locale) {
  const tag = String(locale || '').trim();
  if (!tag) return 'en';

  const [langPart, region] = tag.split(/[-_]/);
  const regional = DEFAULT_BY_COUNTRY[(region || '').toUpperCase()];
  if (regional) {
    const lang = findSpeechLanguage(regional);
    if (lang && lang.tts) return lang.code;
  }

  const direct = findSpeechLanguage(langPart);
  if (direct && direct.tts) return direct.code;

  return 'en';
}

/** Compact payload for the widget's dropdown. */
export function languageCatalogue() {
  return OFFERED_LANGUAGES.map(({ code, name, google, countries }) => ({
    code, name, google, countries,
  }));
}

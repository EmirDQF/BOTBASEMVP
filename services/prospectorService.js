import config from '../config/env.js';
import { createClient } from '@supabase/supabase-js';

const META_TOKEN = process.env.META_AD_LIBRARY_TOKEN || null;
const DEFAULT_COUNTRY = process.env.PROSPECTOR_COUNTRY || 'PE';
const DEFAULT_KEYWORDS = [
  'servicios profesionales',
  'negocios locales',
  'atención al cliente',
  'reservas'
];
const DEFAULT_NICHE = process.env.PROSPECTOR_NICHE || '';

function parseList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [...fallback];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parseList(parsed, fallback);
  } catch {
    // Comma-separated values are the documented CLI/env format.
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function resolveProspectorConfig(options = {}) {
  const keywords = parseList(
    options.keywords ?? process.env.PROSPECTOR_KEYWORDS,
    DEFAULT_KEYWORDS,
  );
  const niche = String(options.niche ?? DEFAULT_NICHE).trim();
  return {
    country: String(options.country ?? DEFAULT_COUNTRY).trim() || DEFAULT_COUNTRY,
    niche,
    keywords: keywords.length ? keywords : [...DEFAULT_KEYWORDS],
    limit: Number(options.limit ?? process.env.PROSPECTOR_LIMIT ?? 50) || 50,
  };
}

let supabase = null;

function getSupabaseClient() {
  if (supabase) return supabase;
  const url = config.supabase?.url || process.env.SUPABASE_URL;
  const key = config.supabase?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabase = createClient(url, key);
  return supabase;
}

function extractPhoneFromText(text) {
  if (!text) return null;
  const digits = (text || '').replace(/[^0-9\+]/g, '');
  // Look for 9-digit sequences possibly prefixed by country code
  const match = digits.match(/(?:51)?(9\d{8})/);
  return match ? match[1] : null;
}

async function fetchAdsForKeyword(keyword, { country = DEFAULT_COUNTRY, limit = 50 } = {}) {
  if (!META_TOKEN) throw new Error('META_AD_LIBRARY_TOKEN is required');
  const base = 'https://graph.facebook.com/v19.0/ads_archive';
  const params = new URLSearchParams({
    access_token: META_TOKEN,
    search_terms: keyword,
    ad_reached_countries: JSON.stringify([country]),
    ad_active_status: 'ACTIVE',
    limit: String(limit),
    fields: 'page_name,page_id,ad_snapshot_url,publisher_platforms,ad_creative{body,link_caption}'
  });
  const url = `${base}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meta Ad Library API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data || [];
}

export async function runProspector(options = {}) {
  const prospectConfig = resolveProspectorConfig(options);
  const stats = { found: 0, upserted: 0, skipped: 0 };
  for (const keyword of prospectConfig.keywords) {
    const kw = prospectConfig.niche ? `${prospectConfig.niche} ${keyword}` : keyword;
    let ads = [];
    try {
      ads = await fetchAdsForKeyword(kw, prospectConfig);
    } catch (e) {
      console.warn('prospector: failed to fetch ads for', kw, e && e.message ? e.message : e);
      continue;
    }

    for (const ad of ads) {
      stats.found += 1;
      const page_name = ad.page_name || null;
      const page_id = ad.page_id || null;
      const ad_snapshot_url = ad.ad_snapshot_url || (ad.ad_creative && ad.ad_creative.url) || null;
      const plataformas = Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms : [];
      const creativeBody = (ad.ad_creative && (ad.ad_creative.body || ad.ad_creative.link_caption)) || '';
      const telefono = extractPhoneFromText(creativeBody);

      const prospect = {
        page_name,
        page_id,
        telefono,
        ad_snapshot_url,
        plataformas,
        updated_at: new Date().toISOString(),
      };

      try {
        const client = getSupabaseClient();
        if (!client) {
          stats.skipped += 1;
          continue;
        }
        const { data, error } = await client.from('prospects').upsert(prospect, { onConflict: 'page_id' }).select('*').single();
        if (error) {
          console.warn('prospector: upsert error', error.message || error);
          stats.skipped += 1;
        } else {
          stats.upserted += 1;
        }
      } catch (e) {
        console.warn('prospector: unexpected error inserting prospect', e && e.message ? e.message : e);
        stats.skipped += 1;
      }
    }
  }

  return stats;
}

export default { runProspector };

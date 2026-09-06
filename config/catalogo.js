import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL
  || process.env.RENDER_EXTERNAL_URL
  || 'http://localhost:3000'
).replace(/\/+$/, '');

const mediaUrl = (file) => `${publicBaseUrl}/media/${file}`;
const parseList = (value, fallback = []) => {
  if (!value) return [...fallback];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Comma-separated values are also supported for simple deployments.
  }
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
};

export const businessInfo = Object.freeze({
  name: process.env.BUSINESS_NAME || 'Empresa Demo',
  industry: process.env.BUSINESS_INDUSTRY || 'Servicios',
  city: process.env.BUSINESS_CITY || 'Ciudad Demo',
  address: process.env.BUSINESS_ADDRESS || 'Dirección no configurada',
  hours: process.env.BUSINESS_HOURS || 'Horario no configurado',
  contactPhone: process.env.BUSINESS_CONTACT_PHONE || '',
  contactPerson: process.env.BUSINESS_CONTACT_PERSON || '',
  advisorWhatsApp: process.env.ADMIN_WHATSAPP_NUMBER || '',
  bookingUrl: process.env.BOOKING_URL || '',
});

export const BUSINESS_CONFIG = businessInfo;

const defaultCatalog = [
  {
    id: 'item_01',
    name: 'Servicio principal',
    slug: 'servicio-principal',
    active: true,
    keywords: ['servicio principal', 'servicio', 'información'],
    description: 'Conoce los detalles de nuestro servicio principal.',
    priceIndicator: 'A consultar',
    mediaFile: 'demo_media_1.jpeg',
    qualificationQuestions: ['¿Para cuándo necesitas este servicio?'],
  },
  {
    id: 'item_02',
    name: 'Servicio secundario',
    slug: 'servicio-secundario',
    active: true,
    keywords: ['servicio secundario', 'opción secundaria'],
    description: 'Una alternativa flexible para tus necesidades.',
    priceIndicator: 'A consultar',
    mediaFile: 'demo_media_2.jpeg',
    qualificationQuestions: ['¿Has usado antes un servicio similar?'],
  },
];

function parseCatalog() {
  if (!process.env.BUSINESS_CATALOG) return defaultCatalog;
  try {
    const parsed = JSON.parse(process.env.BUSINESS_CATALOG);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('BUSINESS_CATALOG must be a non-empty array');
    return parsed.map((item, index) => ({
      id: item.id || `item_${String(index + 1).padStart(2, '0')}`,
      name: String(item.name || `Servicio ${index + 1}`),
      slug: String(item.slug || `servicio-${index + 1}`),
      active: item.active !== false,
      keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
      description: String(item.description || ''),
      priceIndicator: String(item.priceIndicator || 'A consultar'),
      mediaFile: item.mediaFile ? String(item.mediaFile) : null,
      qualificationQuestions: Array.isArray(item.qualificationQuestions)
        ? item.qualificationQuestions.map(String)
        : [],
    }));
  } catch (error) {
    throw new Error(`Invalid BUSINESS_CATALOG: ${error.message}`);
  }
}

export const catalog = Object.freeze(parseCatalog());
export const CATALOGO = catalog;
export const TREATMENT_IMAGES = Object.freeze(
  Object.fromEntries(catalog.filter((item) => item.mediaFile).map((item) => [item.slug, mediaUrl(item.mediaFile)])),
);

export const conversationSettings = Object.freeze({
  greeting: `¡Hola! 👋 Bienvenido/a a ${businessInfo.name}. ¿En qué servicio estás interesado?`,
  fallbackMessage: 'No reconocí ese servicio. Estas son nuestras opciones:',
  handoffMessage: 'Perfecto, una persona de nuestro equipo se comunicará contigo en breve.',
});

export function getItemById(id) {
  return catalog.find((item) => item.id === id) ?? null;
}

export function findItemByKeyword(text) {
  const normalized = String(text || '').toLowerCase();
  return catalog.find((item) => (
    item.active !== false && item.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
  )) ?? null;
}

export function getCatalogSummary() {
  return catalog.filter((item) => item.active !== false).map((item) => `• ${item.name}`).join('\n');
}

export function isSafeMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function localMediaExists(value) {
  try {
    const url = new URL(value);
    if (!url.pathname.startsWith('/media/')) return true;
    const filename = path.basename(decodeURIComponent(url.pathname));
    return fs.existsSync(path.join(moduleDir, '..', 'media', filename));
  } catch {
    return false;
  }
}

export function isAvailableMediaUrl(value) {
  return isSafeMediaUrl(value) && localMediaExists(value);
}

export function getCatalogMedia(key, { requireLocalFile = true } = {}) {
  const item = catalog.find((entry) => entry.slug === key || entry.id === key || entry.keywords.includes(key));
  const file = item?.mediaFile;
  if (!file) return null;
  const url = mediaUrl(file);
  return !requireLocalFile || isAvailableMediaUrl(url) ? url : null;
}

export function obtenerImagen(key) {
  return getCatalogMedia(key);
}

export const BASE_URL = `${publicBaseUrl}/media/`;
export const SERVICIOS = Object.freeze({});
export const CATALOG_DETECTION_RULES = Object.freeze(
  Object.fromEntries(catalog.map((item) => [item.slug, item.keywords])),
);

export const SYSTEM_PROMPT = `Eres el asistente virtual de [NOMBRE DEL NEGOCIO]. Responde breve, amable y con información verificable.
Prioriza responder exactamente lo que la persona pregunta e invita a avanzar solo cuando corresponda.
Usa únicamente los servicios disponibles en el catálogo y nunca inventes citas, precios, profesionales ni servicios.`;

export default catalog;

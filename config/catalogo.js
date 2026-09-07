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
  name: process.env.BUSINESS_NAME || 'CQPharma / Salud Articular',
  industry: process.env.BUSINESS_INDUSTRY || 'Salud articular',
  city: process.env.BUSINESS_CITY || 'Tu ciudad',
  address: process.env.BUSINESS_ADDRESS || 'Dirección no configurada',
  hours: process.env.BUSINESS_HOURS || 'Lunes a sábado',
  contactPhone: process.env.BUSINESS_CONTACT_PHONE || '',
  contactPerson: process.env.BUSINESS_CONTACT_PERSON || '',
  advisorWhatsApp: process.env.ADMIN_WHATSAPP_NUMBER || '',
  bookingUrl: process.env.BOOKING_URL || '',
});

export const BUSINESS_CONFIG = businessInfo;

const defaultCatalog = [
  {
    id: 'item_01',
    name: 'KOLFLEX (CQPharma)',
    slug: 'kolflex',
    active: true,
    keywords: ['1', 'kolflex', 'colageno', 'colágeno', 'dolor articular', 'rodilla', 'rodillas', 'cadera', 'columna'],
    description: 'Colágeno hidrolizado premium con péptidos de alta absorción para acompañar el cuidado de las articulaciones.',
    priceIndicator: 'Promociones disponibles',
    mediaFile: null,
    qualificationQuestions: ['¿Desde cuándo tienes molestias articulares?'],
  },
  {
    id: 'item_02',
    name: 'Consulta y densitometría ósea',
    slug: 'densitometria-osea',
    active: true,
    keywords: ['2', 'densitometria', 'densitometría', 'densitometria osea', 'densitometría ósea', 'huesos', 'osteoporosis', 'consulta médica', 'sedes', 'horarios'],
    description: 'Examen rápido e indoloro para evaluar la salud ósea y orientar una evaluación profesional.',
    priceIndicator: 'A consultar',
    mediaFile: null,
    qualificationQuestions: ['¿Qué ciudad o sede te queda más cerca?'],
  },
  {
    id: 'item_03',
    name: 'Consulta reumatológica / dolor articular',
    slug: 'consulta-reumatologica',
    active: true,
    keywords: ['consulta reumatologica', 'consulta reumatológica', 'reumatologia', 'reumatología', 'dolor articular', 'evaluación', 'evaluacion'],
    description: 'Evaluación preventiva y orientación profesional para dolores articulares.',
    priceIndicator: 'A consultar',
    mediaFile: null,
    qualificationQuestions: ['¿Desde cuándo tienes el dolor articular?'],
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
  greeting: '¡Hola! Te damos la bienvenida a CQPharma Salud Articular 🌿. ¿En qué podemos ayudarte hoy?\n1️⃣ Información y promociones de Kolflex (Colágeno Hidrolizado)\n2️⃣ Densitometría ósea y consultas médicas por dolor\nEscribe 1 o 2 para ayudarte.',
  fallbackMessage: 'Puedes escribir 1 para información de Kolflex o 2 para densitometría ósea y consultas por dolor.',
  handoffMessage: '¡Excelente! Hemos registrado tus datos. En unos minutos un asesor se comunicará contigo para darte todos los detalles. ¡Que tengas un excelente día! 🌿',
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

export const SYSTEM_PROMPT = `Eres el Asistente Virtual Oficial de CQPharma / Salud Articular. Orientas con calidez a personas de 30 años o más interesadas en dolor articular, Kolflex o densitometría ósea.
Responde en máximo 2 o 3 oraciones, sin tecnicismos ni diagnósticos definitivos, y deriva siempre a una evaluación profesional cuando corresponda. Cada respuesta debe terminar con una pregunta cerrada o llamado a la acción.

Árbol de atención:
- Sin contexto: usa el saludo configurado y pide escribir 1 o 2.
- Kolflex, precio u opción 1: explica que es colágeno hidrolizado de alta absorción para acompañar el cuidado articular, menciona que hay promociones y solicita nombre y teléfono para que un asesor llame.
- Densitometría, sedes, horarios u opción 2: indica que se realiza de lunes a sábado y solicita nombre y teléfono para agendar.
- Dolor: expresa empatía, evita diagnosticar y solicita nombre y teléfono para orientación profesional.
- Cuando la persona proporcione nombre o teléfono, confírmalos y comunica que un asesor le llamará en breve.

Nunca inventes precios, citas, sedes ni resultados médicos.`;

export default catalog;

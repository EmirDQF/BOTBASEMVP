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

export const businessInfo = Object.freeze({
  name: process.env.BUSINESS_NAME || 'CQPharma',
  industry: process.env.BUSINESS_INDUSTRY || 'Reumatología y Salud Articular',
  city: process.env.BUSINESS_CITY || 'Lima',
  address: process.env.BUSINESS_ADDRESS || 'Dirección no configurada',
  hours: process.env.BUSINESS_HOURS || 'Lunes a Sábado de 9:00 AM a 5:00 PM',
  contactPhone: process.env.BUSINESS_CONTACT_PHONE || '',
  contactPerson: process.env.BUSINESS_CONTACT_PERSON || 'Especialistas en Reumatología',
  advisorWhatsApp: process.env.ADMIN_WHATSAPP_NUMBER || '',
  bookingUrl: process.env.BOOKING_URL || '',
});

export const BUSINESS_CONFIG = businessInfo;

export const menuPrincipal = `¡Hola! Bienvenido a *CQPharma* 🦴
¿En qué podemos ayudarle hoy?

1️⃣ Agendar una cita médica (S/ 30.00)
2️⃣ Densitometría ósea (S/ 80.00)
3️⃣ Joyflex One y Kolflex (productos articulares)
4️⃣ Horarios y ubicación
5️⃣ Hablar con un especialista (le llamamos en breve)
6️⃣ Ver catálogo completo

*Escriba el número o cuénteme directamente su molestia.*`;

export const catalog = Object.freeze([
  {
    id: 'item_01',
    name: 'Consulta Médica de Reumatología',
    slug: 'consulta_reumatologia',
    active: true,
    keywords: ['1', 'cita', 'consulta', 'reumatologo', 'reumatólogo', 'medico', 'médico', 'agendar', 'precio de consulta'],
    description: 'Evaluación integral del dolor articular, artrosis, artritis y desgaste con especialista.',
    priceIndicator: 'S/ 30.00',
    mediaFile: 'agendatuconsulta.jpeg',
    qualificationQuestions: ['¿Prefiere turno mañana (9AM-1PM) o tarde (2PM-5PM)?'],
  },
  {
    id: 'item_02',
    name: 'Densitometría Ósea Preventiva',
    slug: 'densitometria_osea',
    active: true,
    keywords: ['2', 'densitometria', 'densitometría', 'osteoporosis', 'calcio', 'huesos', 'descarte'],
    description: 'Estudio rápido e indoloro que mide la densidad del hueso para prevenir fracturas por osteoporosis a tiempo.',
    priceIndicator: 'S/ 80.00',
    mediaFile: null,
    qualificationQuestions: ['¿Desea agendar en la mañana o en la tarde?'],
  },
  {
    id: 'item_03',
    name: 'KOLFLEX (Colágeno Hidrolizado Articular Reforzado)',
    slug: 'kolflex',
    active: true,
    keywords: ['kolflex', 'colageno', 'colágeno', 'suplemento', 'bebible', 'rigidez', 'polvo', 'frasco', '3'],
    description: 'Suplemento bebible diario que nutre y fortalece el cartílago desde adentro, quitando la rigidez matutina.',
    priceIndicator: 'S/ 195.00',
    mediaFile: null,
    qualificationQuestions: ['¿Desea coordinar el envío a su domicilio?'],
  },
  {
    id: 'item_04',
    name: 'JOYFLEX ONE (Ácido Hialurónico Intraarticular)',
    slug: 'joyflex_one',
    active: true,
    keywords: ['joyflex', 'joyflex one', 'infiltracion', 'infiltración', 'acido hialuronico', 'ácido hialurónico', 'gel', 'ampolla', 'lubricante'],
    description: 'Infiltración directa en la articulación. Como aceite para bisagras: quita el roce de los huesos y alivia de 3 a 12 meses en una sola sesión.',
    priceIndicator: 'S/ 450.00',
    mediaFile: null,
    qualificationQuestions: ['¿En qué articulación presenta dolor principalmente?'],
  },
  {
    id: 'item_05',
    name: 'Combo Articular Completo (Joyflex One + Kolflex)',
    slug: 'combo_articular',
    active: true,
    keywords: ['combo', 'tratamiento completo', 'ambos', 'paquete articular'],
    description: 'Lubricación inmediata en consulta con Joyflex One + nutrición diaria continua en casa con Kolflex.',
    priceIndicator: 'S/ 580.00 (precio promocional)',
    mediaFile: null,
    qualificationQuestions: ['¿Desea coordinar el paquete completo?'],
  }
]);

export const CATALOGO = catalog;
export const CATALOG_DETECTION_RULES = Object.freeze(
  Object.fromEntries(catalog.map((item) => [item.slug, item.keywords]))
);

export const conversationSettings = Object.freeze({
  greeting: menuPrincipal,
  fallbackMessage: 'Por favor, elija una opción del 1 al 6 o cuénteme en qué articulación siente dolor.',
  handoffMessage: '¡Excelente! Hemos registrado sus datos. En breves minutos un especialista médico se comunicará con usted.',
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
  const item = catalog.find((entry) => entry.slug === key || entry.id === key || (Array.isArray(entry.keywords) && entry.keywords.includes(key)));
  const file = item?.mediaFile;
  if (!file) return null;
  const url = mediaUrl(file);
  return !requireLocalFile || isAvailableMediaUrl(url) ? url : null;
}

export function obtenerImagen(key) {
  return getCatalogMedia(key);
}

export const BASE_URL = `${publicBaseUrl}/media/`;
export const TREATMENT_IMAGES = Object.freeze(
  Object.fromEntries(catalog.filter((item) => item.mediaFile).map((item) => [item.slug, mediaUrl(item.mediaFile)]))
);

export default catalog;
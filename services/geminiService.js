import config from '../config/env.js';
import {
  BUSINESS_CONFIG,
  CATALOG_DETECTION_RULES,
  catalog,
  getCatalogMedia,
} from '../config/catalogo.js';

const LIMA_TIME_ZONE = 'America/Lima';
const SESSION_TTL_MS = Number(process.env.GEMINI_SESSION_TTL_MS || 30 * 60 * 1000);
const BOOKED_TTL_MS = Number(process.env.GEMINI_BOOKED_SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DEBOUNCE_MS = Number(process.env.GEMINI_DEBOUNCE_MS || 2000);
const MAX_HISTORY_MESSAGES = Number(process.env.GEMINI_MAX_HISTORY || 6);
const MAX_OUTPUT_TOKENS = 350;
const CLEANUP_MS = Number(process.env.GEMINI_CLEANUP_MS || 60 * 1000);

export const SYSTEM_PROMPT = `
Eres el asistente virtual comercial de "CQPharma", centro especializado en Reumatología y Salud Articular.
OBJETIVO ÚNICO: Resolver dudas en pocas palabras y CERRAR (cita agendada o pedido confirmado) en el menor número de mensajes posible.

PÚBLICO OBJETIVO:
Adultos de 40 a 60+ años con dolor articular o rigidez. Lenguaje cotidiano, cálido, empático, sin tecnicismos complejos.

REGLAS DE FORMATO (OBLIGATORIAS):
- Máximo 2 a 3 párrafos cortos por respuesta.
- NUNCA termines una respuesta sin una pregunta de cierre por ALTERNATIVA (prohibido hacer preguntas abiertas tipo "¿cuándo puede?" o "¿en qué más le ayudo?").
- Si el usuario saluda o escribe algo genérico/ambiguo, saluda cordialmente y muestra el menú principal:
  "¡Hola! Bienvenido a *CQPharma*. ¿En qué podemos ayudarle hoy?
  1️⃣ Agendar una cita médica
  2️⃣ Densitometría ósea (información y precio)
  3️⃣ Productos articulares (Joyflex One y Kolflex)
  4️⃣ Información general y horarios
  5️⃣ Hablar con un especialista (en breve le llamamos)
  6️⃣ Ver catálogo de productos

  ¿Desea agendar una cita o prefiere consultar por nuestros productos?"
- Si escribe fuera de tema, responde en una línea educada y redirige al menú.
- Reconoce números (1, 2, 3...) y lenguaje natural ("me duele la rodilla al subir gradas" = interés en consulta y Joyflex One).

INFORMACIÓN CLAVE Y ARGUMENTARIO:
- Horario de atención: Lunes a Sábado, de 9:00 AM a 5:00 PM.
- Densitometría ósea: Examen rápido e indoloro que mide el calcio de los huesos para prevenir fracturas por osteoporosis a tiempo.
- JOYFLEX ONE (infiltración intraarticular): Funciona como "aceite para bisagras". Se aplica directo en la articulación para evitar el roce entre huesos; brinda alivio prolongado de 3 a 12 meses.
- KOLFLEX (colágeno hidrolizado bebible): Es el "alimento diario" que nutre el cartílago por dentro y quita la rigidez matutina.
- Diferencia: NO son lo mismo, se complementan. Joyflex lubrica al instante en consulta; Kolflex nutre día a día en casa.
- Combo Articular (Joyflex + Kolflex): Ofrécelo como upsell natural cuando pregunten por cualquiera de los dos.

MANEJO DE OBJECIONES (aplícalo antes de dejar ir al paciente):
- "Es muy caro": Compara el costo-beneficio frente a una cirugía/prótesis o el gasto recurrente en calmantes. Invita a la evaluación médica sin compromiso.
- "Lo voy a pensar": Recuérdale que agendar la evaluación no exige pago inmediato y asegura su turno.
- "¿Funciona de verdad?": Explica que es un tratamiento médico aplicado por especialistas con alto índice de satisfacción, invitándolo a consulta para evaluar su caso.

PREGUNTAS DE CIERRE POR ALTERNATIVA (Elige la que corresponda):
- Si consulta por Dolor / Cita / Densitometría:
  "¿Le acomoda mejor atenderse en el turno mañana (9 AM a 1 PM) o por la tarde (2 PM a 5 PM)?"
- Si consulta por Productos:
  "¿Desea reservar su aplicación de Joyflex One en consulta o coordinamos el envío de su Kolflex a domicilio?"
- Si muestra interés en ambos:
  "¿Coordinamos el combo completo con envío a domicilio o prefiere aplicarse Joyflex en su próxima visita médica?"
- Opción 5 (Hablar con especialista):
  Pide ÚNICAMENTE Nombre completo y Teléfono confirmando que el área médica lo llamará pronto.

HERRAMIENTAS DEL SISTEMA (Etiquetas):
- Si el paciente consulta por un producto o servicio del catálogo y deseas enviar foto de apoyo, añade al final: [ENVIAR_IMAGEN:categoria]
- Cuando el paciente confirme sus datos y turno, genera al final del mensaje el bloque:
<<<LEAD_JSON>>>
{
  "nombre": "Nombre del paciente o null",
  "telefono": "Teléfono o null",
  "distrito": "Distrito o null",
  "motivo": "Consulta / Densitometría / Joyflex / Kolflex",
  "fechaHora": "Día y turno preferido",
  "ready_to_notify": true
}
<<<END_LEAD_JSON>>>

PROHIBICIONES:
- Prohibido dar diagnósticos médicos definitivos por chat.
- Prohibido inventar precios o promociones inexistentes.
- Prohibido terminar con preguntas abiertas.
`;

const chatSessions = new Map();
const failureCounts = new Map();

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const WEEKDAYS = {
  domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3,
  jueves: 4, viernes: 5, sábado: 6, sabado: 6,
};

function sessionId(jid) {
  return String(jid || '').split('@')[0];
}

function scheduleCleanup(sid, session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    chatSessions.delete(sid);
    failureCounts.delete(sid);
  }, session.booked ? BOOKED_TTL_MS : SESSION_TTL_MS);
  session.timer.unref?.();
}

async function restoreSession(sid, session) {
  const { getByPhone } = await import('./leadService.js');
  if (typeof getByPhone !== 'function') return;
  const stored = await getByPhone(sid);
  if (!stored) return;
  session.leadSnapshot = stored;
  session.booked = Boolean(stored.fecha_hora_iso || stored.fechaHoraISO);
}

export function getOrCreateSession(jid) {
  const sid = sessionId(jid);
  let session = chatSessions.get(sid);
  if (!session) {
    session = {
      history: [],
      timer: null,
      lastUserMessageAt: 0,
      booked: false,
      leadSnapshot: null,
      paused: false,
      restorePromise: null,
    };
    session.restorePromise = restoreSession(sid, session).catch(() => null);
    chatSessions.set(sid, session);
  }
  scheduleCleanup(sid, session);
  return session;
}

export async function ensureSessionLoaded(session) {
  if (session?.restorePromise) {
    await session.restorePromise;
    session.restorePromise = null;
  }
  return session;
}

export function pauseSessionById(jid) {
  const sid = sessionId(jid);
  const session = getOrCreateSession(sid);
  session.paused = true;
  return true;
}

export function resumeSessionById(jid) {
  const session = chatSessions.get(sessionId(jid));
  if (!session) return false;
  session.paused = false;
  return true;
}

export function isSessionPaused(jid) {
  return Boolean(chatSessions.get(sessionId(jid))?.paused);
}

export function resetSession(jid) {
  const sid = sessionId(jid);
  chatSessions.delete(sid);
  failureCounts.delete(sid);
  return true;
}

export function mergeRecentUserMessages(history, windowMs = 10000) {
  if (!Array.isArray(history)) return [];
  const result = [];
  for (const message of history) {
    if (message.role !== 'user' || !result.length) {
      result.push(message);
      continue;
    }
    const previous = result[result.length - 1];
    if (previous.role === 'user' && message.at && previous.at && message.at - previous.at <= windowMs) {
      const text = [...(previous.parts || []), ...(message.parts || [])]
        .map((part) => part.text || '').filter(Boolean).join(' ');
      previous.parts = [{ text }];
      previous.text = text;
      previous.at = message.at;
    } else {
      result.push(message);
    }
  }
  return result;
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const partText = (Array.isArray(entry.parts) ? entry.parts : [])
    .map((part) => part?.text || '')
    .join(' ')
    .trim();
  const text = (entry.text && String(entry.text).trim()) || partText || '';
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/no pude procesar|demora t[eé]cnica|falla t[eé]cnica|payload de error|error de|error al/i.test(normalized)) {
    return null;
  }
  return { ...entry, text: normalized, parts: [{ text: normalized }] };
}

function compactHistoryForPrompt(history, maxMessages = MAX_HISTORY_MESSAGES) {
  if (!Array.isArray(history)) return [];
  return history
    .map(normalizeHistoryEntry)
    .filter(Boolean)
    .slice(-maxMessages);
}

function textFromHistory(history) {
  return compactHistoryForPrompt(history)
    .filter((entry) => entry.role === 'user')
    .map((entry) => entry.text || '')
    .filter(Boolean)
    .join('\n');
}

export function extractLeadDataFromText(text, senderPhone = null) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const nameMatch = text.match(/\b(?:me llamo|me llasmo|me llamos|mi nombre es|soy)\s+([A-Za-zÁÉÍÓÚáéíóúÑñÜü]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñÜü]+){0,2})(?=\s*(?:[,.\n]|vivo\b|vi\b|mi\b|tengo\b|y\b|con\b|$))/i);
  
  let phone = text.replace(/\D/g, '').match(/(?:51)?(9\d{8})/)?.[1] || null;
  if (!phone && senderPhone && /este (mismo )?n[uú]mero|mi n[uú]mero de whatsapp|con este whatsapp|a este n[uú]mero/i.test(text)) {
    const rawDigits = String(senderPhone).replace(/\D/g, '');
    phone = rawDigits.match(/(?:51)?(9\d{8})/)?.[1] || (rawDigits.length >= 9 ? rawDigits.slice(-9) : rawDigits);
  }

  const dateMatch = text.match(/\b(?:hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)(?:\s+\d{1,2}\s+de\s+[a-záéíóú]+)?(?:\s+(?:a\s*las?\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i)
    || text.match(/\b\d{1,2}\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:a\s*las?\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
  const motivoMatch = text.match(/\b(?:tratamiento|motivo|producto)\s*(?:es|:)?\s*([^,.\n]+)/i);
  const districtMatch = text.match(/\b(?:vivo|estoy|resido)\s+en\s+([^,.\n]+)/i);

  return {
    nombre: nameMatch?.[1]?.trim() || null,
    telefono: phone || null,
    motivo: motivoMatch?.[1]?.trim() || null,
    distrito: districtMatch?.[1]?.trim() || null,
    fechaHora: dateMatch?.[0]?.trim() || null,
  };
}

export function isValidName(name) {
  return typeof name === 'string'
    && name.trim().length >= 2
    && !/^(?:no proporcionad[oa]|dr\.?\s*\w+|estimado|paciente)$/i.test(name.trim());
}

export function isExplicitConfirmation(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim().toLowerCase();
  if (/\b(pero|cambiar|reprogramar|otra hora|otra fecha|prefiero|no puedo|espera|luego)\b/.test(value)) return false;
  return /^(?:sí|si|confirmo|confirmado|correcto|vale|perfecto|ok|claro|de acuerdo|gracias)(?:[,.]?\s*(?:sí|si|confirmo|confirmado|correcto|vale|perfecto|ok|claro|de acuerdo|gracias))*[.!]?$/.test(value);
}

function extractResultText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.text === 'string') return result.text;
  const response = result?.response;
  if (typeof response?.text === 'string') return response.text;
  return response?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(' ').trim() || '';
}

export function sanitizeModelTextOutput(rawText) {
  if (typeof rawText !== 'string') return '';
  let text = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/\[ENVIAR[_ ]?IMAGEN:[^\]]+\]/gi, '')
    .replace(/\[AGENDAR_CITA:\{[\s\S]*?\}\]/gi, '')
    .replace(/<<<LEAD_JSON>>>[\s\S]*?<<<END_LEAD_JSON>>>/gi, '')
    .replace(/🚨\s*¡?NUEVO PACIENTE AGENDADO!?[\s\S]*?(?=\n\n|$)/i, '')
    .trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const extractText = (value) => {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return '';
        for (const key of ['response', 'respuesta', 'content', 'text', 'texto', 'message']) {
          const candidate = extractText(value[key]);
          if (candidate) return candidate;
        }
        if (Array.isArray(value.parts)) return value.parts.map(extractText).filter(Boolean).join(' ');
        if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ');
        return '';
      };
      text = extractText(parsed) || text;
    } catch {
      text = text
        .replace(/^\s*\{\s*"(?:response|respuesta|texto|text|message)"\s*:\s*"([\s\S]*)"?\s*\}\s*$/i, '$1')
        .replace(/^\s*\{\s*"(?:response|respuesta|texto|text|message)"\s*:\s*"([\s\S]*)$/i, '$1');
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function limaNow() {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: LIMA_TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date());
}

export function buildSystemPromptWithContext(jid, session = null, clinic = null) {
  const profile = { ...BUSINESS_CONFIG, ...(config.businessProfile || {}), ...(clinic || {}) };
  const address = profile.address || 'Dirección de CQPharma';
  const hours = profile.hours || 'Lunes a Sábado de 9:00 AM a 5:00 PM';
  const snapshot = session?.leadSnapshot;
  const patientName = snapshot?.nombre || extractLeadDataFromText(textFromHistory(session?.history))?.nombre;
  const booked = session?.booked ? '\nEsta sesión ya tiene una cita o pedido registrado. No vuelvas a pedir sus datos salvo que solicite cambios.' : '';
  const catalogList = Array.isArray(catalog) && catalog.length
    ? catalog.filter((item) => item.active !== false).map((item) => `- ${item.slug}: ${item.name} (${item.description || ''})`).join('\n')
    : '- joyflex_one: Infiltración de ácido hialurónico intraarticular\n- kolflex: Colágeno hidrolizado bebible';

  return `${SYSTEM_PROMPT}

CATÁLOGO ACTIVO:
${catalogList}

DATOS ACTUALES DEL ENTORNO:
- Empresa: ${profile.name || 'CQPharma'}
- Dirección: ${address}
- Horario: ${hours}
- Fecha y hora actual (Lima): ${limaNow()}
- WhatsApp del cliente: ${sessionId(jid)}
${patientName ? `- Nombre registrado del cliente: ${patientName}` : ''}${snapshot ? `- Datos previos: ${JSON.stringify(snapshot)}` : ''}${booked}`;
}

export function parseTextToLimaDate(text) {
  if (typeof text !== 'string') return null;
  const now = new Date(Date.now());
  const base = new Date(Date.UTC(Number(new Intl.DateTimeFormat('en', { timeZone: LIMA_TIME_ZONE, year: 'numeric' }).format(now)), Number(new Intl.DateTimeFormat('en', { timeZone: LIMA_TIME_ZONE, month: 'numeric' }).format(now)) - 1, Number(new Intl.DateTimeFormat('en', { timeZone: LIMA_TIME_ZONE, day: 'numeric' }).format(now))));
  const value = text.toLowerCase();
  if (value.includes('pasado mañana')) base.setUTCDate(base.getUTCDate() + 2);
  else if (value.includes('mañana')) base.setUTCDate(base.getUTCDate() + 1);
  else if (!value.includes('hoy')) {
    const weekday = Object.entries(WEEKDAYS).find(([name]) => value.includes(name));
    if (weekday) while (base.getUTCDay() !== weekday[1]) base.setUTCDate(base.getUTCDate() + 1);
    const date = value.match(/(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
    if (date) base.setUTCDate(1), base.setUTCMonth(MONTHS[date[2]] - 1), base.setUTCDate(Number(date[1]));
  }
  const time = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    || value.match(/\ba\s*las?\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (!time) return null;
  let hour = Number(time[1]);
  if (time[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (time[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  base.setUTCHours(hour + 5, Number(time[2] || 0), 0, 0);
  return base.toISOString().replace('.000Z', '+00:00');
}

export function parseTextToLimaISO(text) {
  return parseTextToLimaDate(text)?.replace('.000Z', '+00:00') || null;
}

export function formatLimaFechaHoraText(iso) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  const date = new Intl.DateTimeFormat('es-PE', { timeZone: LIMA_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
  const time = new Intl.DateTimeFormat('es-PE', { timeZone: LIMA_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  return `${date.replace(',', '')}, ${time.replace(/\s*a\.?\s*m\.?/i, ' AM').replace(/\s*p\.?\s*m\.?/i, ' PM')}`;
}

function buildRequest(client, message, session, jid, options) {
  const systemPrompt = buildSystemPromptWithContext(jid, session, options.clinic);
  const history = compactHistoryForPrompt(mergeRecentUserMessages(session.history))
    .map((entry) => `${entry.role === 'model' ? 'Asistente' : 'Paciente'}: ${entry.text}`)
    .join('\n');
  const messageParts = Array.isArray(options.messageParts) && options.messageParts.length
    ? options.messageParts
    : [{ type: 'text', content: String(message || '') }];
  const prompt = `${systemPrompt}

${history}
Cliente: ${messageParts.filter((part) => part.type === 'text').map((part) => part.content).join('\n')}`;
  if (typeof client?.generateContent === 'function') {
    const parts = [];
    let previousInputType = null;
    for (const part of messageParts) {
      if (part.type === 'image') {
        parts.push({ inlineData: { mimeType: part.mimeType, data: part.base64Data } });
        if (part.caption) parts.push({ text: part.caption });
        previousInputType = 'image';
      } else {
        const previous = parts[parts.length - 1];
        if (previous?.text && previousInputType === 'text') {
          previous.text += `\n${part.content}`;
        } else {
          parts.push({ text: part.content });
        }
        previousInputType = 'text';
      }
    }
    return {
      structured: true,
      request: {
        contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
        systemInstruction: systemPrompt,
        generationConfig: { maxOutputTokens: options.maxOutputTokens || MAX_OUTPUT_TOKENS },
      },
    };
  }
  return { structured: false, prompt };
}

async function callGemini(client, request, options) {
  const attempts = Math.max(1, Number(options.maxRetries ?? 1) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (request.structured) return await client.generateContent(request.request, { model: config.gemini.model });
      if (typeof client?.generate === 'function') {
        return await client.generate(request.prompt, { model: config.gemini.model, maxOutputTokens: options.maxOutputTokens || MAX_OUTPUT_TOKENS });
      }
      throw new Error('Gemini client does not support generate or generateContent');
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && /timeout|network|ECONNRESET|ECONNREFUSED|5\d{2}/i.test(String(error?.message || error))) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      } else {
        break;
      }
    }
  }
  throw lastError;
}

function parseLeadJson(text) {
  const block = String(text || '').match(/<<<LEAD_JSON>>>\s*([\s\S]*?)\s*<<<END_LEAD_JSON>>>/i);
  if (!block) return null;
  try {
    const parsed = JSON.parse(block[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      nombre: parsed.nombre || null,
      telefono: parsed.telefono || parsed.phone || null,
      distrito: parsed.distrito || parsed.district || null,
      motivo: parsed.motivo || parsed.treatment || null,
      fechaHora: parsed.fechaHora || parsed.fecha_hora_texto || parsed.fechaHoraTexto || parsed.fecha_hora || null,
      ready_to_notify: parsed.ready_to_notify,
    };
  } catch {
    return null;
  }
}

function collectLead(session, message, senderPhone = null, modelLead = null) {
  const current = extractLeadDataFromText(textFromHistory(session.history), senderPhone);
  const incoming = extractLeadDataFromText(message, senderPhone);
  const responseLead = extractLeadDataFromText(modelLead?.rawText || '', senderPhone);
  const lead = {
    nombre: modelLead?.nombre || incoming?.nombre || current?.nombre || session.leadSnapshot?.nombre || null,
    telefono: modelLead?.telefono || incoming?.telefono || current?.telefono || responseLead?.telefono || session.leadSnapshot?.telefono || null,
    distrito: session.leadSnapshot?.distrito || modelLead?.distrito || incoming?.distrito || current?.distrito || responseLead?.distrito || null,
    motivo: modelLead?.motivo || incoming?.motivo || current?.motivo || responseLead?.motivo || session.leadSnapshot?.motivo || null,
    fechaHora: modelLead?.fechaHora || incoming?.fechaHora || current?.fechaHora || responseLead?.fechaHora || session.leadSnapshot?.fecha_hora_texto || null,
  };
  if (lead.fechaHora) {
    lead.fechaHoraISO = parseTextToLimaISO(lead.fechaHora);
    if (lead.fechaHoraISO) lead.fechaHora = formatLimaFechaHoraText(lead.fechaHoraISO);
  }
  lead.ready_to_notify = Boolean(
    isValidName(lead.nombre)
    && /^9\d{8}$/.test(String(lead.telefono || '').replace(/\D/g, ''))
    && (modelLead?.ready_to_notify !== false)
  );
  if (/\bdomingo\b/i.test(`${message} ${lead.fechaHora || ''}`)) {
    lead.outsideClinicHours = true;
    lead.ready_to_notify = false;
  }
  return Object.values(lead).some(Boolean) ? lead : null;
}

export function determinarCategoriaImagen(mensaje, respuestaIA) {
  const texto = String(mensaje || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!texto.trim()) return null;

  const exclusiones = [
    /\b(?:atienden|abierto|abierta|siguen|hora|horario|horarios)\b/,
    /\b(?:cuota|cuotas|mensualidad|mensualidades|financiamiento|forma de pago|formas de pago)\b/,
    /\b(?:sacar cita|agendar|quiero cita|turno|reservar|reserva)\b/,
    /^(?:hola|buenas(?: tardes| dias| noches)?|gracias|ok|dale)[!.?\s]*$/,
  ];
  if (exclusiones.some((pattern) => pattern.test(texto))) return null;

  for (const [categoria, claves] of Object.entries(CATALOG_DETECTION_RULES || {})) {
    if (Array.isArray(claves) && claves.some((clave) => texto.includes(String(clave).toLowerCase()))) {
      return categoria;
    }
  }

  if (Array.isArray(catalog)) {
    for (const item of catalog) {
      const categoria = item.slug;
      const key = categoria.toLowerCase().replace(/[_-]+/g, ' ');
      if (key.length > 2 && texto.includes(key)) return categoria;
    }
  }

  return null;
}

export function getImagenCategoria(categoria) {
  return categoria ? getCatalogMedia(categoria) : null;
}

export async function obtenerRespuestaIA(jid, mensaje, options = {}) {
  const session = getOrCreateSession(jid);
  await ensureSessionLoaded(session);
  const sid = sessionId(jid);
  const now = Date.now();
  if (!options.skipDebounce && now - session.lastUserMessageAt < DEBOUNCE_MS) {
    return { texto: null, leadData: null, skipResponse: true };
  }
  session.lastUserMessageAt = now;
  const messageParts = Array.isArray(options.messageParts) && options.messageParts.length
    ? options.messageParts
    : [{ type: 'text', content: String(mensaje || '') }];
  const messageText = messageParts.filter((part) => part.type === 'text').map((part) => part.content).join('\n');
  session.history.push({ role: 'user', parts: [{ text: messageText }], at: now });
  session.history = compactHistoryForPrompt(session.history, MAX_HISTORY_MESSAGES);

  // Fallback directo si Gemini no está instanciado
  if (!options.client) {
    const normalized = messageText.toLowerCase();
    const hasPhone = /(?:\+?51)?\s*9\d{8}\b/.test(messageText);
    const hasName = isValidName(extractLeadDataFromText(messageText)?.nombre);

    let texto = '';
    if (hasPhone || hasName) {
      texto = '¡Excelente! Hemos registrado sus datos. En breve nuestro especialista se comunicará con usted. ¿Prefiere que le llamemos por la mañana o por la tarde?';
    } else if (normalized.includes('1') || normalized.includes('cita') || normalized.includes('agendar')) {
      texto = 'Con gusto agendamos su consulta en Reumatología. ¿Prefiere atenderse en el turno mañana (9 AM–1 PM) o tarde (2 PM–5 PM)?';
    } else if (normalized.includes('2') || normalized.includes('densitometr') || normalized.includes('hueso')) {
      texto = 'La densitometría ósea es un examen rápido e indoloro que mide el calcio de sus huesos para prevenir fracturas por osteoporosis. ¿Desea agendar su prueba en el turno mañana o tarde?';
    } else if (normalized.includes('3') || normalized.includes('kolflex') || normalized.includes('joyflex') || normalized.includes('producto')) {
      texto = 'Contamos con JOYFLEX ONE (lubrica la articulación en consulta) y KOLFLEX (colágeno que nutre y quita la rigidez diaria). ¿Desea reservar Joyflex One en consulta o coordinamos el envío de Kolflex a domicilio?';
    } else if (normalized.includes('5') || normalized.includes('especialista')) {
      texto = 'Con gusto le comunicamos con un especialista. Por favor indíquenos su nombre completo y número de teléfono para llamarle en breve.';
    } else {
      texto = `¡Hola! Bienvenido a *CQPharma*, especialistas en Reumatología y Salud Articular 🌿.
1️⃣ Agendar una cita médica
2️⃣ Densitometría ósea (información y precio)
3️⃣ Productos articulares (Joyflex One y Kolflex)
4️⃣ Información general y horarios
5️⃣ Hablar con un especialista
6️⃣ Ver catálogo de productos

¿Desea agendar una cita o prefiere consultar por nuestros productos articulares?`;
    }
    return { texto, leadData: collectLead(session, messageText, sid), imagenURL: null, skipResponse: false };
  }

  try {
    const result = await callGemini(options.client, buildRequest(options.client, messageText, session, jid, { ...options, messageParts }), options);
    const rawText = extractResultText(result);
    const parsedLead = parseLeadJson(rawText) || {};
    parsedLead.rawText = rawText;
    const leadData = collectLead(session, messageText, sid, parsedLead);
    let texto = sanitizeModelTextOutput(rawText);
    if (!leadData?.ready_to_notify && !session.booked && /\b(?:tu cita|qued[oó]\s+agendada|ya est[aá]\s+agendada)\b/i.test(texto)) {
      texto = 'Para coordinar su cita médica, ¿prefiere atenderse en el turno mañana (9 AM–1 PM) o por la tarde (2 PM–5 PM)?';
    }
    session.history.push({ role: 'model', parts: [{ text: rawText || '' }] });
    session.history = compactHistoryForPrompt(session.history, MAX_HISTORY_MESSAGES);
    failureCounts.delete(sid);

    const categoria = determinarCategoriaImagen(messageText, rawText);
    const imagenURL = getImagenCategoria(categoria);

    if (leadData?.ready_to_notify && !options.skipLeadPersistence) {
      session.booked = true;
      session.leadSnapshot = { ...leadData, fecha_hora_texto: leadData.fechaHora, fecha_hora_iso: leadData.fechaHoraISO, confirmedAt: new Date().toISOString() };
      try {
        const { saveLeadSnapshot } = await import('./leadService.js');
        await saveLeadSnapshot(sid, session.leadSnapshot);
      } catch (error) {
        console.warn('geminiService: lead snapshot persistence failed:', error?.message || error);
      }
      scheduleCleanup(sid, session);
    }

    return {
      texto,
      leadData,
      imagenURL,
      skipLeadPersistence: Boolean(options.skipLeadPersistence || session.booked),
    };
  } catch (error) {
    const failures = (failureCounts.get(sid) || 0) + 1;
    failureCounts.set(sid, failures);
    session.lastUserMessageAt = 0;
    return {
      texto: failures >= 2
        ? 'En este momento nuestros asesores están en atención. Por favor, intente nuevamente en unos minutos. 🙏'
        : 'Disculpe la demora técnica. ¿Prefiere que le ayudemos agendando una cita o con información de productos? 🙏',
      leadData: null,
      imagenURL: null,
      skipResponse: false,
    };
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of chatSessions) {
    if (now - session.lastUserMessageAt > (session.booked ? BOOKED_TTL_MS : SESSION_TTL_MS)) {
      chatSessions.delete(sid);
      failureCounts.delete(sid);
    }
  }
}, CLEANUP_MS).unref?.();

export default {
  obtenerRespuestaIA,
  sanitizeModelTextOutput,
  isExplicitConfirmation,
  pauseSessionById,
  resumeSessionById,
  isSessionPaused,
  resetSession,
  getOrCreateSession,
  extractLeadDataFromText,
  isValidName,
  determinarCategoriaImagen,
  getImagenCategoria,
};
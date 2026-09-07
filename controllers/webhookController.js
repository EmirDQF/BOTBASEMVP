import config from '../config/env.js';
import geminiService from '../services/geminiService.js';
import leadService from '../services/leadService.js';
import notificationService from '../services/notificationService.js';
import whatsappService from '../services/whatsappService.js';
import forwardToDashboard from '../src/dashboardForwarder.js';
import { getGeminiClient } from '../src/geminiClient.js';
import { createClient } from '@supabase/supabase-js';
import {
  claimMediaSend,
  completeMediaSend,
  hasMediaBeenSent,
  markMediaAsSent,
  sendCampaignWelcome,
} from '../services/mediaTrackingService.js';
import {
  conversationSettings,
  getCatalogMedia,
  isAvailableMediaUrl,
  isSafeMediaUrl,
  obtenerImagen,
} from '../config/catalogo.js';

// Helper: upsert a message into chat_sessions.history
let supabaseClient = null;
const chatSessionHistoryCache = new Map();
const processedMessageIds = new Set();
const welcomeSentRecipients = new Set();
const PROCESSED_IDS_TTL_MS = 5 * 60 * 1000;

async function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  const rawUrl = config.supabase?.url || process.env.SUPABASE_URL;
  const key = config.supabase?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!rawUrl || !key) return null;
  supabaseClient = createClient(rawUrl, key);
  return supabaseClient;
}

async function hardResetUserSession(phone) {
  try {
    const rawDigits = String(phone || '').replace(/\D/g, '');
    const shortPhone = rawDigits.length >= 9 ? rawDigits.slice(-9) : rawDigits;
    const client = await getSupabaseClient();

    const jid = `${rawDigits}@s.whatsapp.net`;
    if (geminiService.resetSession) {
      geminiService.resetSession(jid);
      geminiService.resetSession(`${shortPhone}@s.whatsapp.net`);
    }
    chatSessionHistoryCache.delete(rawDigits);
    chatSessionHistoryCache.delete(shortPhone);

    if (client) {
      await Promise.allSettled([
        client.from('leads').delete().or(`telefono.ilike.%${shortPhone}%,telefono.eq.${shortPhone},telefono.eq.${rawDigits}`),
        client.from('chat_sessions').delete().or(`id.eq.${rawDigits},id.eq.${shortPhone}`),
        client.from('conversations').delete().or(`contact_name.ilike.%${shortPhone}%`),
        client.from('messages').delete().or(`sender.ilike.%${shortPhone}%`)
      ]);
    }
    console.log(`[RESET TOTAL] Lead y sesiones eliminadas para: ${shortPhone} (${rawDigits})`);
    return true;
  } catch (err) {
    console.error('Error en hardResetUserSession:', err?.message || err);
    return false;
  }
}

async function persistToSupabaseConversation({ conversationId, contactNumber, contactName, sender, text, mediaUrl, timestamp }) {
  let supabase;
  try {
    supabase = await getSupabaseClient();
  } catch (error) {
    console.error('[Supabase] Error al persistir conversación:', error);
    return null;
  }
  if (!supabase || !conversationId) return null;

  const normalizedId = String(conversationId).trim();
  const phone = contactNumber || normalizedId;
  const ts = timestamp || new Date().toISOString();
  const lastMessage = text && String(text).trim().length ? String(text).trim() : (mediaUrl ? '[Imagen]' : 'Mensaje');

  try {
    const { error: upsertErr } = await supabase.from('conversations').upsert({
      conversation_id: normalizedId,
      contact_number: phone,
      contact_name: contactName || phone,
      last_message: lastMessage,
      last_message_at: ts,
      created_at: ts
    }, { onConflict: 'conversation_id' });

    if (upsertErr) {
      console.error('[Supabase] Error al persistir conversación:', upsertErr);
      return null;
    }

    const { error: insertErr } = await supabase.from('messages').insert({
      conversation_id: normalizedId,
      contact_number: phone,
      sender,
      text: text || null,
      media_url: mediaUrl || null,
      media_type: mediaUrl ? 'image' : 'text',
      created_at: ts
    });

    if (insertErr) {
      console.error('[Supabase] Error al persistir conversación:', insertErr);
      return null;
    }

    return true;
  } catch (e) {
    console.error('[Supabase] Error al persistir conversación:', e);
    return null;
  }
}

async function persistToChatSessions(sessionIdentifier, entry) {
  try {
    const client = await getSupabaseClient();
    if (!client) return null;

    const sessionId = String(sessionIdentifier || '').replace(/\D/g, '') || String(sessionIdentifier || '');
    const cached = chatSessionHistoryCache.get(sessionId);
    let history = Array.isArray(cached) ? [...cached] : [];

    if (!cached) {
      let { data: existing, error: exErr } = await client.from('chat_sessions').select('id, history').eq('id', sessionId).maybeSingle();
      if (exErr) {
        console.error('[Supabase] Error al persistir conversación:', exErr);
        return null;
      }
      if (existing && existing.history) {
        history = Array.isArray(existing.history) ? existing.history : JSON.parse(existing.history || '[]');
      }
      chatSessionHistoryCache.set(sessionId, history);
    }

    history.push(entry);
    chatSessionHistoryCache.set(sessionId, history);

    const upsertPayload = { id: sessionId, history, updated_at: new Date().toISOString() };
    const { error: upErr } = await client.from('chat_sessions').upsert([upsertPayload], { onConflict: 'id' });
    if (upErr) {
      console.error('[Supabase] Error al persistir conversación:', upErr);
      return null;
    }
    return true;
  } catch (e) {
    console.error('[Supabase] Error al persistir conversación:', e);
    return null;
  }
}

async function notifyMonitorPanel({ conversation_id, contact_name, sender, type, content, media_url, timestamp }) {
  const panelBaseUrl = (process.env.PANEL_BACKEND_URL || 'https://whatsapp-dashboard-z9jm.onrender.com').replace(/\/+$/, '');
  const username = process.env.PANEL_USER || process.env.PANEL_USERNAME;
  const password = process.env.PANEL_PASSWORD || process.env.PANEL_PASS;
  if (!panelBaseUrl || !username || !password) return;

  try {
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const body = {
      conversation_id: String(conversation_id || '').trim(),
      contact_name: contact_name || null,
      sender,
      type: type || 'text',
      content: content || null,
      media_url: media_url || null,
      timestamp: timestamp || new Date().toISOString(),
    };

    const res = await fetch(`${panelBaseUrl}/api/hook`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res || !res.ok) {
      const text = res && typeof res.text === 'function' ? await res.text() : '';
      console.warn('Panel hook failed:', res && res.status ? res.status : 'unknown', text || '');
    }
  } catch (e) {
    console.warn('notifyMonitorPanel failed (non-blocking):', e && e.message ? e.message : e);
  }
}

async function notifyDashboardReply(phone, text, mediaUrl = null, wamid = null) {
  const dashboardUrl = (process.env.PANEL_BACKEND_URL || 'https://whatsapp-dashboard-z9jm.onrender.com').replace(/\/+$/, '');
  try {
    const response = await fetch(`${dashboardUrl}/api/bot-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: String(phone).replace(/\D/g, ''),
        text: text || '',
        type: mediaUrl ? 'image' : 'text',
        mediaUrl: mediaUrl || null,
        wamid: wamid || `bot_${Date.now()}`,
      }),
    });

    if (!response.ok) {
      const responseText = typeof response.text === 'function' ? await response.text() : '';
      console.warn('Dashboard bot reply sync failed:', response.status, responseText);
    }
  } catch (err) {
    console.error('Error sincronizando respuesta con el dashboard:', err?.message || err);
  }
}

function notifyDashboardIncoming(payload) {
  const dashboardUrl = (process.env.PANEL_BACKEND_URL || 'https://whatsapp-dashboard-z9jm.onrender.com').replace(/\/+$/, '');
  fetch(`${dashboardUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.warn('Error sincronizando mensaje entrante con el dashboard:', err?.message || err);
  });
}

function extractPlainText(input) {
  let cleaned = typeof input === 'string' ? input : JSON.stringify(input);
  cleaned = cleaned.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  if ((cleaned.startsWith('{') && cleaned.endsWith('}')) || (cleaned.startsWith('[') && cleaned.endsWith(']'))) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed) {
        const possibleKeys = ['content', 'respuesta', 'response', 'texto', 'text', 'message'];
        for (const key of possibleKeys) {
          if (parsed[key] !== undefined && parsed[key] !== null) {
            if (typeof parsed[key] === 'string' && parsed[key].trim().length > 0) {
              return parsed[key].trim();
            }
            if (typeof parsed[key] === 'object') {
              const nested = extractPlainText(parsed[key]);
              if (nested && nested.trim().length > 0) {
                return nested.trim();
              }
            }
          }
        }

        if (Array.isArray(parsed)) {
          const arrayText = parsed.map((item) => extractPlainText(item)).filter(Boolean).join(' ');
          if (arrayText) return arrayText;
        }

        if (typeof parsed === 'object') {
          const traversed = Object.values(parsed)
            .map((value) => extractPlainText(value))
            .filter(Boolean)
            .join(' ')
            .trim();
          if (traversed) return traversed;
        }
      }
    } catch (e) {
      const malformedPrefixMatch = cleaned.match(/^\s*\{\s*"(?:content|respuesta|response|texto|text|message)"\s*:\s*"?(.*)$/i);
      if (malformedPrefixMatch && malformedPrefixMatch[1]) {
        return malformedPrefixMatch[1].replace(/\}?\s*$/,'').replace(/^"/, '').trim();
      }
      const match = cleaned.match(/"(?:content|respuesta|response|texto|text|message)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
      if (match && match[1]) return match[1].trim();
    }
  }

  return cleaned;
}

function stripInstructionTags(text) {
  return String(text || '')
    .replace(/\[ENVIAR[_ ]?IMAGEN:[^\]]+\]/gi, '')
    .replace(/\[AGENDAR_CITA:\{.*?\}\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function persistAgendaPayload(payload, context = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const rawUrl = config.supabase?.url || process.env.SUPABASE_URL;
  const key = config.supabase?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!rawUrl || !key) return null;

  const record = {
    nombre: payload.nombre || null,
    telefono: payload.telefono || context.phone || null,
    motivo: payload.motivo || null,
    fecha: payload.fecha || null,
    hora: payload.hora || null,
    clinic_id: context.clinicId || null,
    created_at: new Date().toISOString(),
    source: context.source || 'whatsapp',
  };

  try {
    const client = createClient(rawUrl, key);
    const attempts = [
      () => client.from('appointments').insert([record]).select(),
      () => client.from('calendar_events').insert([record]).select(),
      () => client.from('leads').insert([{ telefono: record.telefono, nombre: record.nombre, distrito: null, fecha_hora_texto: record.fecha ? `${record.fecha} ${record.hora || ''}`.trim() : null, fecha_hora_iso: null, created_at: record.created_at, clinic_id: record.clinic_id }]).select(),
    ];

    for (const attempt of attempts) {
      try {
        const { error } = await attempt();
        if (!error) return record;
        const msg = String(error.message || '').toLowerCase();
        if (!msg.includes('does not exist') && !msg.includes('relation') && !msg.includes('not found')) {
          throw error;
        }
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).toLowerCase();
        if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('not found')) {
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    console.warn('webhookController: AGENDAR_CITA storage failed but user message will continue:', e && e.message ? e.message : e);
  }

  return null;
}

const messageBuffers = new Map();
const userProcessingQueues = new Map();
const intakeQueues = new Map();
const BUFFER_WAIT_MS = 3500;

async function downloadIncomingImage(mediaId) {
  const token = config.whatsapp?.token || process.env.WHATSAPP_TOKEN;
  const version = config.whatsapp?.apiVersion || process.env.WHATSAPP_API_VERSION || 'v17.0';
  if (!token || !mediaId) throw new Error('Missing WhatsApp token or media id');
  const metadata = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers: Object.fromEntries([['Author' + 'ization', 'Bearer ' + token]]),
  });
  if (!metadata.ok) throw new Error(`Media metadata request failed: ${metadata.status}`);
  const { url, mime_type: mimeType } = await metadata.json();
  if (!isSafeMediaUrl(url, {
    allowedHosts: ['graph.facebook.com', 'lookaside.fbsbx.com', 'mmg.whatsapp.net'],
  })) {
    throw new Error('Media metadata returned an unsafe URL');
  }
  const binary = await fetch(url, { headers: Object.fromEntries([['Author' + 'ization', 'Bearer ' + token]]) });
  if (!binary.ok) throw new Error(`Media download failed: ${binary.status}`);
  return { mimeType: mimeType || binary.headers.get('content-type') || 'application/octet-stream', base64Data: Buffer.from(await binary.arrayBuffer()).toString('base64') };
}

function enqueueUserWork(from, work) {
  const previous = userProcessingQueues.get(from) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  const tracked = next.finally(() => {
    if (userProcessingQueues.get(from) === tracked) userProcessingQueues.delete(from);
  });
  userProcessingQueues.set(from, tracked);
  return next;
}

async function processBatch(from, buffer) {
  const messageText = buffer.parts.filter((part) => part.type === 'text').map((part) => part.content).join('\n');
  const jid = `${from}@s.whatsapp.net`;
  let clinic = null;
  if (buffer.context?.phoneNumberId) {
    try {
      const client = await getSupabaseClient();
      if (client) {
        const { data, error } = await client.from('clinics').select('*')
          .eq('waba_phone_number_id', buffer.context.phoneNumberId).maybeSingle();
        if (error) console.error('[Supabase] Error al persistir conversación:', error);
        clinic = data || null;
      }
    } catch (error) {
      console.error('[Supabase] Error al persistir conversación:', error);
    }
  }
  try {
    await persistToSupabaseConversation({
      conversationId: from, contactNumber: from, contactName: buffer.context?.contactName || from,
      sender: 'user', text: messageText || null, mediaUrl: null, timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Supabase] Error al persistir conversación:', error);
  }
  let geminiResult;
  try {
    geminiResult = await geminiService.obtenerRespuestaIA(jid, messageText, {
      client: getGeminiClient(), maxRetries: 1, maxOutputTokens: 300, messageParts: buffer.parts, clinic,
    });
  } catch (error) {
    console.error('webhookController: gemini call failed', error);
    return;
  }
  if (!geminiResult || geminiResult.skipResponse || !geminiResult.texto) return;

  const textoParaWhatsApp = stripInstructionTags(geminiService.sanitizeModelTextOutput(extractPlainText(geminiResult.texto)));
  const candidateMediaUrl = geminiResult.imagenURL || null;
  const finalMediaUrl = isAvailableMediaUrl(candidateMediaUrl) ? candidateMediaUrl : null;
  let leadResult = null;
  if (geminiResult.leadData && !geminiResult.skipLeadPersistence) {
    try {
      leadResult = await leadService.saveLead({
        telefono: from, nombre: geminiResult.leadData.nombre, distrito: geminiResult.leadData.distrito,
        fechaHoraISO: geminiResult.leadData.fechaHoraISO, fechaHoraTexto: geminiResult.leadData.fechaHora,
        confirmed: geminiService.isExplicitConfirmation(messageText), clinicId: clinic?.id || null, clinic,
      });
    } catch (error) {
      console.error('[Supabase] Error al persistir conversación:', error);
    }
  }

  try {
    let sendResult;
    if (finalMediaUrl) {
      const imageKey = geminiService.determinarCategoriaImagen(messageText, geminiResult.texto) || finalMediaUrl;
      const alreadySent = await hasMediaBeenSent(from, imageKey);
      const claim = alreadySent ? { claimed: false } : await claimMediaSend({ recipient: from, imageKey });
      if (claim.claimed) {
        try {
          sendResult = await whatsappService.sendWhatsAppMessage(from, textoParaWhatsApp, {
            type: 'image', image: { link: finalMediaUrl }, media: { link: finalMediaUrl }, caption: textoParaWhatsApp,
          });
          await completeMediaSend(claim.id, 'sent');
          await markMediaAsSent(from, imageKey);
        } catch (error) {
          await completeMediaSend(claim.id, 'failed', error?.message || error);
          throw error;
        }
      } else {
        sendResult = await whatsappService.sendWhatsAppMessage(from, textoParaWhatsApp, {});
      }
    } else {
      sendResult = await whatsappService.sendWhatsAppMessage(from, textoParaWhatsApp, {});
    }
    forwardToDashboard({ direction: 'outgoing', outgoing: { to: from, text: textoParaWhatsApp, mediaUrl: finalMediaUrl } });
    await notifyDashboardReply(from, textoParaWhatsApp, finalMediaUrl, sendResult?.messages?.[0]?.id || null);
  } catch (error) {
    console.error('webhookController: failed sending message to user', error);
    return;
  }

  await notifyMonitorPanel({ conversation_id: from, sender: 'bot', type: finalMediaUrl ? 'image' : 'text', content: textoParaWhatsApp, media_url: finalMediaUrl, timestamp: new Date().toISOString() });
  try {
    await persistToSupabaseConversation({ conversationId: from, contactNumber: from, contactName: from, sender: 'bot', text: textoParaWhatsApp, mediaUrl: finalMediaUrl, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[Supabase] Error al persistir conversación:', error);
  }
  try {
    await persistToChatSessions(from, { from: 'patient', text: messageText, phone: from, timestamp: new Date().toISOString() });
    await persistToChatSessions(from, { from: 'bot', text: textoParaWhatsApp, phone: from, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[Supabase] Error al persistir conversación:', error);
  }
  if (leadResult?.readyToNotify && leadResult.lead) {
    try { await notificationService.notifyAdminNewLead(leadResult.lead, { whatsappService, leadService, clinic }); }
    catch (error) { console.error('webhookController: error in admin notify flow', error); }
  }
}

async function addMessageToBuffer(from, part, context) {
  const current = messageBuffers.get(from) || { parts: [], timer: null, lastActivity: 0, context };
  current.parts.push(part);
  current.lastActivity = Date.now();
  current.context = context;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    messageBuffers.delete(from);
    enqueueUserWork(from, () => processBatch(from, current)).catch((error) => console.error('webhookController: batch failed', error));
  }, BUFFER_WAIT_MS);
  messageBuffers.set(from, current);
}

function campaignWelcomeText() {
  return conversationSettings.greeting;
}

async function sendCampaignWelcomeMessage(from) {
  if (welcomeSentRecipients.has(from)) return false;
  try {
    const imageUrl = getCatalogMedia('logo') || obtenerImagen('logo');
    if (!isSafeMediaUrl(imageUrl)) return false;
    const welcomeText = campaignWelcomeText();
    const result = await sendCampaignWelcome({
      recipient: from,
      imageKey: 'logo',
      send: () => whatsappService.sendWhatsAppMessage(from, welcomeText, {
        type: 'image',
        image: { link: imageUrl },
        media: { link: imageUrl },
        caption: welcomeText,
      }),
    });
    if (result.sent || result.alreadySent) welcomeSentRecipients.add(from);
    return result.sent;
  } catch (error) {
    console.error('webhookController: campaign welcome failed', error);
    return false;
  }
}

// Buffering combines rapid text/image messages while the per-user queue prevents overlapping Gemini calls.
export default async function webhookController(req, res, next) {
  try {
    let payload = req.parsedBody || req.body;
    if (Buffer.isBuffer(payload)) payload = JSON.parse(payload.toString('utf8'));
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    if (payload) notifyDashboardIncoming(payload);
    for (const message of messages) {
      const msgId = message?.id;
      if (msgId && processedMessageIds.has(msgId)) continue;
      if (msgId) {
        processedMessageIds.add(msgId);
        setTimeout(() => processedMessageIds.delete(msgId), PROCESSED_IDS_TTL_MS).unref?.();
      }
      if (!message || message.from === 'status@broadcast' || message.type === 'system') continue;
      const from = String(message.from || '').replace(/\D/g, '');
      if (!from) continue;
      const text = message.type === 'text' ? message.text?.body?.trim() : message.image?.caption?.trim();
      const context = {
        contactName: value?.contacts?.[0]?.profile?.name || from,
        phoneNumberId: value?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
      };
      const intake = intakeQueues.get(from) || Promise.resolve();
      const next = intake.then(async () => {
        if (message.type === 'text' && /^\/?(reset|reiniciar|borrar|clear)$/i.test(text || '')) {
          messageBuffers.delete(from);
          await hardResetUserSession(from);
          await sendCampaignWelcomeMessage(from);
          return;
        }
        await sendCampaignWelcomeMessage(from);
        if (message.type === 'image') {
          try {
            const media = await downloadIncomingImage(message.image?.id);
            await addMessageToBuffer(from, { type: 'image', ...media, caption: message.image?.caption ?? null }, context);
          } catch (error) {
            console.error('webhookController: image download failed', error);
          }
        } else if (text) {
          await addMessageToBuffer(from, { type: 'text', content: text }, context);
        }
      });
      const tracked = next.finally(() => { if (intakeQueues.get(from) === tracked) intakeQueues.delete(from); });
      intakeQueues.set(from, tracked);
    }
  } catch (error) {
    console.error('webhookController: background processing error', error);
    if (typeof next === 'function' && !res.headersSent) next(error);
  }
}

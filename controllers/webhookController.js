import { sendWhatsAppMessage } from '../services/whatsappService.js';
import { obtenerRespuestaIA, isSessionPaused } from '../services/geminiService.js';
import { getGeminiClient } from '../src/geminiClient.js';
import { forwardToDashboard } from '../src/dashboardForwarder.js';
import { saveLead } from '../services/leadService.js';
import { menuPrincipal } from '../config/catalogo.js';

const processedMessageIds = new Set();
const userBuffers = new Map();

function cleanIdMemory() {
  if (processedMessageIds.size > 2000) {
    processedMessageIds.clear();
  }
}

setInterval(cleanIdMemory, 10 * 60 * 1000).unref?.();

function sendTextMessage(to, text) {
  return sendWhatsAppMessage(to, text);
}

function sendImageMessage(to, imageUrl, caption = '') {
  return sendWhatsAppMessage(to, caption, {
    media: { link: imageUrl },
    type: 'image',
    caption,
  });
}

export async function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    || process.env.WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

export async function handleWebhook(req, res) {
  res.sendStatus(200);

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf8'));
    } catch (error) {
      console.error('Webhook payload inválido:', error?.message || error);
      return;
    }
  }
  if (!body || body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value?.messages) continue;

      for (const message of value.messages) {
        if (processedMessageIds.has(message.id)) continue;
        processedMessageIds.add(message.id);

        const from = message.from;
        if (!from || isSessionPaused(from)) continue;

        let incomingText = '';
        if (message.type === 'text') {
          incomingText = message.text?.body || '';
        } else if (message.type === 'interactive') {
          incomingText = message.interactive?.button_reply?.title
            || message.interactive?.list_reply?.title
            || '';
        } else if (message.type === 'button') {
          incomingText = message.button?.text || '';
        }
        if (!incomingText.trim()) continue;

        forwardToDashboard({
          from,
          text: incomingText,
          timestamp: message.timestamp,
          type: 'incoming',
        }).catch((error) => console.warn('[Dashboard] No se pudo reenviar mensaje:', error?.message || error));

        enqueueUserMessage(from, incomingText);
      }
    }
  }
}

export const webhookController = handleWebhook;

function enqueueUserMessage(sender, text) {
  let buffer = userBuffers.get(sender);
  if (!buffer) {
    buffer = { messages: [], timer: null };
    userBuffers.set(sender, buffer);
  }

  buffer.messages.push(text);
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    processBatch(sender).catch((error) => {
      console.error('Error procesando lote de mensajes:', error?.message || error);
    });
  }, 2000);
}

async function processBatch(sender) {
  const buffer = userBuffers.get(sender);
  if (!buffer) return;
  userBuffers.delete(sender);

  const fullMessage = buffer.messages.join('\n').trim();
  if (!fullMessage) return;

  try {
    let geminiClient = null;
    try {
      geminiClient = getGeminiClient();
    } catch (error) {
      console.warn('[Gemini] Cliente no disponible:', error?.message || error);
    }

    const result = await obtenerRespuestaIA(sender, fullMessage, { client: geminiClient });
    if (result.skipResponse) return;

    if (result.imagenURL) {
      await sendImageMessage(sender, result.imagenURL, result.texto || '');
    } else if (result.texto?.trim()) {
      await sendTextMessage(sender, result.texto);
    } else {
      await sendTextMessage(sender, menuPrincipal);
    }

    if (result.leadData) {
      try {
        await saveLead({
          telefono: sender,
          nombre: result.leadData.nombre,
          distrito: result.leadData.distrito,
          fechaHoraISO: result.leadData.fechaHoraISO,
          fechaHoraTexto: result.leadData.fechaHora,
          confirmed: result.leadData.ready_to_notify,
        });
      } catch (error) {
        console.warn('[LeadService] No se pudo guardar lead en Supabase:', error?.message || error);
      }
    }
  } catch (error) {
    console.error('Error procesando mensaje de usuario:', error?.message || error);
    await sendTextMessage(
      sender,
      '¡Hola! Bienvenido a *CQPharma*. En este momento estamos actualizando nuestro sistema, en breve un especialista le responderá. 🙏'
    ).catch((sendError) => console.error('Error enviando fallback:', sendError?.message || sendError));
  }
}

export default webhookController;

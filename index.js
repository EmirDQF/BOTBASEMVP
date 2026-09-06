import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import './src/envLoader.js';
import webhookRouter from './routes/webhook.js';
import panelRouter from './routes/panel.js';
import fs from 'fs/promises';
import path from 'path';
import errorHandler from './middleware/errorHandler.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.options(/.*/, cors({ origin: true, credentials: true }));

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

async function getSupabaseConversations() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .order('last_message_at', { ascending: false });

  if (error) {
    console.warn('Supabase conversations query failed:', error.message || error);
    return [];
  }

  return data || [];
}

async function getSupabaseMessages(conversationId) {
  if (!supabase || !conversationId) return [];
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', String(conversationId))
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('Supabase messages query failed:', error.message || error);
    return [];
  }

  return data || [];
}

app.get('/api/conversations', async (req, res) => {
  try {
    const conversations = await getSupabaseConversations();
    return res.json(conversations);
  } catch (error) {
    console.error('GET /api/conversations failed:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const messages = await getSupabaseMessages(req.params.id);
    return res.json(messages);
  } catch (error) {
    console.error('GET /api/conversations/:id/messages failed:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

const publicDir = path.join(process.cwd(), 'public');

function requirePanelAuth(req, res, next) {
  const username = process.env.PANEL_USER || process.env.PANEL_USERNAME;
  const password = process.env.PANEL_PASSWORD || process.env.PANEL_PASS;

  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');

  if (!username || !password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Monitor Panel"');
    return res.status(503).json({
      error: 'Panel no configurado. Define PANEL_USER y PANEL_PASSWORD en Render o tu .env.'
    });
  }

  if (scheme !== 'Basic' || !encoded) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Monitor Panel"');
    return res.status(401).send('Acceso requerido');
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch (error) {
    decoded = '';
  }

  const separatorIndex = decoded.indexOf(':');
  const providedUser = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
  const providedPass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

  if (providedUser !== username || providedPass !== password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Monitor Panel"');
    return res.status(401).send('Credenciales inválidas');
  }

  return next();
}

app.use('/media', express.static(path.join(process.cwd(), 'media')));
app.use(express.static(publicDir));

app.get('/panel', requirePanelAuth, (req, res) => {
  res.sendFile(path.join(publicDir, 'panel.html'));
});

// Limpieza de archivos temporales huérfanos relacionados con leads.
// Esto elimina archivos como leads.json.tmp o leads.test.json.tmp que podrían haber quedado si el proceso
// se cayó mientras se escribía el archivo temporal. Se ejecuta al inicio y no bloquea el arranque en caso de error.
(async function cleanupTmpFiles() {
  try {
    const cwd = process.cwd();
    const files = await fs.readdir(cwd);
    for (const f of files) {
      if (/^leads(\.test)?\.json\.tmp$/.test(f)) {
        const p = path.resolve(cwd, f);
        await fs.rm(p, { force: true });
        console.log(`🧹 Removed orphan tmp file: ${p}`);
      }
    }
  } catch (e) {
    console.warn('Error cleaning tmp files at startup:', e && e.message ? e.message : e);
  }
})();
const port = process.env.PORT || 3000;

// Validaciones ligeras de variables de entorno para evitar que PM2 entre en crash loop silencioso
const requiredLike = ['GEMINI_MODEL', 'ADMIN_WHATSAPP_NUMBER', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN'];
for (const v of requiredLike) {
  if (!process.env[v]) {
    console.warn(`Advertencia: la variable de entorno ${v} no está definida. El proceso seguirá, pero algunas funciones pueden no estar disponibles.`);
  }
}
if (!process.env.GEMINI_API_KEY) {
  console.warn('Advertencia crítica: GEMINI_API_KEY no está definida. Las llamadas a Gemini fallarán hasta que se configure. Evitando crash para que PM2 no entre en loop de reintentos.');
}
if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
  console.warn('Advertencia: WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID no están definidas. El servidor arrancará, pero el envío de mensajes de WhatsApp no funcionará hasta que se configuren.');
}
if (!process.env.WHATSAPP_APP_SECRET) {
  console.warn('Advertencia: WHATSAPP_APP_SECRET no está definida. El webhook aceptará solicitudes sin verificar la firma.');
}

app.get('/', (req, res) => {
  res.send('Bot Operativo 24/7 🚀');
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Express server listening on http://localhost:${port}`);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

// Mount panel API routes
app.use('/api/panel', panelRouter);

// Configure Cloud API webhook routes (if WHATSAPP_TOKEN/etc are set)
app.use('/', webhookRouter);

// Mount centralized error handler at the end of middleware chain
app.use(errorHandler);

// WhatsApp Cloud API integration is handled exclusively by routes/webhook.js.

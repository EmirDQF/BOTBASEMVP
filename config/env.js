import { BUSINESS_CONFIG } from './catalogo.js';

const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || null;
const webhookVerifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  || process.env.VERIFY_TOKEN
  || process.env.WEBHOOK_VERIFY_TOKEN
  || null;

export default {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 110),
  },
  businessNameFallback: process.env.BUSINESS_NAME || 'nuestro negocio',
  businessProfile: {
    name: BUSINESS_CONFIG.name,
    address: BUSINESS_CONFIG.address,
    hours: BUSINESS_CONFIG.hours,
  },
  whatsapp: {
    token: process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || null,
    phoneNumberId,
    appSecret: process.env.WHATSAPP_APP_SECRET || null,
    webhookVerifyToken,
  },
  supabase: {
    url: process.env.SUPABASE_URL || null,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_ROLE
      || null,
  },
  admin: {
    phone: process.env.ADMIN_WHATSAPP_NUMBER || null,
  },
  server: {
    port: Number(process.env.PORT || 3000),
  },
};

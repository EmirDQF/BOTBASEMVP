import { BUSINESS_CONFIG } from './catalogo.js';

export const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN
  || process.env.META_VERIFY_TOKEN
  || 'CQPHARMA_REUMA_2026';
export const whatsappToken = process.env.WHATSAPP_TOKEN;
export const phoneNumberId = process.env.PHONE_NUMBER_ID;
export const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
export const supabaseUrl = process.env.SUPABASE_URL;
export const supabaseKey = process.env.SUPABASE_KEY;

export default {
  verifyToken,
  whatsappToken,
  phoneNumberId,
  geminiApiKey,
  supabaseUrl,
  supabaseKey,
  gemini: {
    apiKey: geminiApiKey || null,
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
    token: whatsappToken || process.env.WHATSAPP_ACCESS_TOKEN || null,
    phoneNumberId: phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    appSecret: process.env.WHATSAPP_APP_SECRET || null,
    webhookVerifyToken: verifyToken,
  },
  supabase: {
    url: process.env.SUPABASE_URL || null,
    serviceRoleKey: supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY
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

import config from '../config/env.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

let cachedClient = null;

export function getGeminiClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.GOOGLE_API_KEY
    || process.env.GEMINI_API_KEY
    || config.gemini?.apiKey;
  const modelName = config.gemini?.model || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const maxOutputTokens = Number(config.gemini?.maxOutputTokens || process.env.GEMINI_MAX_OUTPUT_TOKENS || 110);

  if (!apiKey) {
    console.warn('GOOGLE_API_KEY/GEMINI_API_KEY not set; using the local CQPharma response fallback.');
    return null;
  }

  console.log('[geminiClient] initializing client with model:', modelName);
  const generativeAi = new GoogleGenerativeAI(apiKey);
  cachedClient = generativeAi.getGenerativeModel({
    model: modelName,
    generationConfig: {
      maxOutputTokens,
    },
  });

  return cachedClient;
}

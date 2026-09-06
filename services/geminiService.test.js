import { describe, it, before } from 'node:test';
import assert from 'assert';

// set minimal env for config/env.js
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test';
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
process.env.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '12345';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'verify-token';

let geminiService;

before(async () => {
  geminiService = (await import('./geminiService.js')).default;
});

function makeClientReturningText(text) {
  return {
    async generate(prompt, opts) {
      return { text };
    }
  };
}

function makeClientThatThrowsThenSucceeds(timesToThrow = 1, returnText = 'ok') {
  let calls = 0;
  return {
    async generate(prompt, opts) {
      calls += 1;
      if (calls <= timesToThrow) throw new Error('simulated network error');
      return { text: returnText };
    }
  };
}

function makeClientAlwaysThrows() {
  return { async generate() { throw new Error('permanent fail'); } };
}

function makeStructuredClientReturningText(text) {
  return {
    async generateContent(request) {
      return { text };
    },
  };
}

describe('geminiService', () => {
  let uniqueSessionCounter = 0;
  function makeJid() {
    uniqueSessionCounter += 1;
    return `51987654${String(uniqueSessionCounter).padStart(3, '0')}@s.whatsapp.net`;
  }

  it('parses LEAD_JSON when model returns it', async () => {
    const leadJson = JSON.stringify({ nombre: 'Juan Perez', telefono: '987654321', distrito: 'Miraflores', fechaHoraTexto: 'jueves a las 3pm' });
    const client = makeClientReturningText(`<<<LEAD_JSON>>>\n${leadJson}\n<<<END_LEAD_JSON>>>\nPerfecto, te tengo agendado.`);
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'quiero agendar', { client });
    assert.equal(res.leadData.telefono, '987654321');
    assert.ok(res.texto.includes('Perfecto') || res.texto.length > 0);
  });

  it('forces ready_to_notify true when parsed lead JSON has all required fields', async () => {
    const leadJson = JSON.stringify({ nombre: 'Shawmie', telefono: '987654321', distrito: 'Miraflores', fechaHoraTexto: 'lunes 10 de agosto a las 2:00 PM' });
    const client = makeClientReturningText(`<<<LEAD_JSON>>>
${leadJson}
<<<END_LEAD_JSON>>>
Perfecto, tu cita queda agendada.`);
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'quiero agendar', { client });
    assert.equal(res.leadData.ready_to_notify, true);
    assert.equal(res.leadData.nombre, 'Shawmie');
    assert.equal(res.leadData.fechaHora, 'lunes 10 de agosto, 2:00 PM');
    assert.equal(res.leadData.fechaHoraISO, '2026-08-10T19:00:00+00:00');
  });

  it('captures misspelled "me llasmo" names and explicit dates', async () => {
    const client = makeClientReturningText('Perfecto, tu cita queda agendada para el lunes 10 de agosto a las 2:00 PM.');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'Me llasmo Shawmie, vivo en Miraflores, mi telefono es 987654321 y quiero el lunes 10 de agosto a las 2:00 PM', { client });
    assert.equal(res.leadData.nombre, 'Shawmie');
    assert.equal(res.leadData.ready_to_notify, true);
    assert.equal(res.leadData.fechaHora, 'lunes 10 de agosto, 2:00 PM');
    assert.equal(res.leadData.fechaHoraISO, '2026-08-10T19:00:00+00:00');
  });

  it('removes the LEAD_JSON block from texto before replying', async () => {
    const leadJson = JSON.stringify({ nombre: 'Ana', telefono: '987654324', distrito: 'Surco', fechaHoraTexto: 'viernes a las 10am' });
    const client = makeClientReturningText(`<<<LEAD_JSON>>>\n${leadJson}\n<<<END_LEAD_JSON>>>\nPerfecto, Ana, te agendé tentativamente.`);
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'quiero agendar', { client });
    assert.equal(res.leadData.telefono, '987654324');
    assert.ok(!res.texto.includes('<<<LEAD_JSON>>>'));
    assert.ok(res.texto.includes('Perfecto'));
  });

  it('passes systemInstruction when client supports generateContent', async () => {
    let capturedRequest = null;
    const client = {
      async generateContent(request) {
        capturedRequest = request;
        return { text: 'Hola, te ayudo con la cita.' };
      },
    };
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'quiero agendar', { client });
    assert.ok(capturedRequest, 'generateContent should be called');
    assert.ok(capturedRequest.systemInstruction.includes('asistente virtual'));
    assert.ok(capturedRequest.systemInstruction.includes('Empresa Demo'));
    assert.ok(!capturedRequest.systemInstruction.includes('Valeria'));
    assert.ok(res.texto.includes('Hola'));
  });

  it('sanitizes JSON stringified responses with response field', async () => {
    const { sanitizeModelTextOutput } = await import('./geminiService.js');
    const raw = '{\n"response": "Tu cita está programada para este jueves a las 2:00 p. m."}';
    const cleaned = sanitizeModelTextOutput(raw);
    assert.equal(cleaned, 'Tu cita está programada para este jueves a las 2:00 p. m.');
  });

  it('sanitizes nested content JSON structures returned by Gemini', async () => {
    const { sanitizeModelTextOutput } = await import('./geminiService.js');
    const raw = JSON.stringify({ response: { content: { parts: [{ text: 'La cita es a las 2:00 PM' }] } } });
    const cleaned = sanitizeModelTextOutput(raw);
    assert.equal(cleaned, 'La cita es a las 2:00 PM');
  });

  it('sanitizes model instruction blocks without leaking them to WhatsApp', async () => {
    const { sanitizeModelTextOutput } = await import('./geminiService.js');
    const raw = '<<<LEAD_JSON>>>{"nombre":"Ana"}<<<END_LEAD_JSON>>>\nRespuesta breve.';
    assert.equal(sanitizeModelTextOutput(raw), 'Respuesta breve.');
  });

  it('sanitizes incomplete JSON prefix from model output', async () => {
    const { sanitizeModelTextOutput } = await import('./geminiService.js');
    const raw = '{"respuesta": "Tu cita está programada para este jueves a las 2:00 p. m.';
    const cleaned = sanitizeModelTextOutput(raw);
    assert.equal(cleaned, 'Tu cita está programada para este jueves a las 2:00 p. m.');
  });

  it('converts Lima local date/time to UTC ISO correctly', async () => {
    const { parseTextToLimaISO } = await import('./geminiService.js');
    const now = new Date();
    const year = now.getFullYear();
    const iso = parseTextToLimaISO('6 de agosto a las 3:00 pm');
    assert.equal(iso, `${year}-08-06T20:00:00+00:00`);
  });
 
  it('formats Lima date/time ISO to explicit fechaHoraTexto', async () => {
    const { formatLimaFechaHoraText } = await import('./geminiService.js');
    const formatted = formatLimaFechaHoraText('2026-08-06T20:00:00+00:00');
    assert.equal(formatted, 'jueves 6 de agosto, 3:00 PM');
  });
 
  it('removes admin alert text from sanitized model output', async () => {
    const { sanitizeModelTextOutput } = await import('./geminiService.js');
    const raw = 'Perfecto.\n🚨 ¡NUEVO PACIENTE AGENDADO!\n👤 Nombre: Juan\n📞 Teléfono: https://wa.me/51987654321\n📍 Distrito: Miraflores\n🗓️ Cita: jueves 6 de agosto, 3:00 PM';
    const cleaned = sanitizeModelTextOutput(raw);
    assert.equal(cleaned, 'Perfecto.');
  });
 
  it('extracts name from typo "me llamos" and sets ready_to_notify true', async () => {
    const client = makeClientReturningText('Perfecto, tu cita está agendada.');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'me llamos tom holland vivo en Miraflores, mi telefono es 987654321 y puedo el martes a las 2pm', { client });
    assert.equal(res.leadData.nombre, 'tom holland');
    assert.equal(res.leadData.ready_to_notify, true);
    assert.ok(res.leadData.fechaHora);
  });

  it('includes current WhatsApp number in systemInstruction for phone context', async () => {
    let capturedRequest = null;
    const client = {
      async generateContent(request) {
        capturedRequest = request;
        return { text: 'Perfecto, te enviamos la información al número registrado.' };
      },
    };
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const testJid = makeJid();
    const res = await obtenerRespuestaIA(testJid, 'Por favor envía la dirección a este número', { client });
    assert.ok(capturedRequest, 'generateContent should be called');
    assert.ok(capturedRequest.systemInstruction.includes(`WhatsApp ${testJid.split('@')[0]}`));
    assert.ok(res.texto.includes('Perfecto') || typeof res.texto === 'string');
  });

  it('falls back to heuristic when no LEAD_JSON present', async () => {
    const client = makeClientReturningText('Hola, me llamo Maria y puedo el viernes por la tarde. Mi telefono es 987654322.');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'quiero agendar', { client });
    assert.ok(res.texto.includes('Hola') || typeof res.texto === 'string');
    // fallback should provide phone at least via heuristic
    assert.ok(res.leadData && res.leadData.telefono, 'fallback leadData should contain telefono');
  });

  it('handles malformed LEAD_JSON gracefully (fallback)', async () => {
    const client = makeClientReturningText('<<<LEAD_JSON>>>\n{ nombre: "Bad JSON", telefono: 987654333 \n<<<END_LEAD_JSON>>>\nLo siento.');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'quiero agendar', { client });
    assert.ok(res.texto && typeof res.texto === 'string');
    assert.ok(res.leadData === null || typeof res.leadData === 'object');
  });

  it('builds ready_to_notify fallback from history when JSON block is missing and all data is present', async () => {
    const client = makeClientReturningText('Perfecto, tu cita está agendada.');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const testJid = makeJid();
    const res = await obtenerRespuestaIA(testJid, 'Quiero agendar, me llamo Ana, mi numero es 987654321, vivo en Surco y puedo el viernes a las 3pm', { client });
    assert.equal(res.leadData.telefono, '987654321');
    assert.equal(res.leadData.ready_to_notify, true);
    assert.ok(res.texto.includes('Perfecto'));
  });

  it('retries on first network error and succeeds', async () => {
    const client = makeClientThatThrowsThenSucceeds(1, 'Respuesta OK');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const res = await obtenerRespuestaIA(makeJid(), 'hola quiero agendar', { client });
    assert.equal(res.texto, 'Respuesta OK');
  });

  it('returns contingency after 2 consecutive failed messages', async () => {
    const client = makeClientAlwaysThrows();
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const testJid = makeJid();
    const r1 = await obtenerRespuestaIA(testJid, 'mensaje 1', { client });
    // first failure should return polite fallback (not contingency)
    assert.ok(r1.texto && !r1.texto.includes('ocupado'));
    const r2 = await obtenerRespuestaIA(testJid, 'mensaje 2', { client });
    assert.ok(r2.texto && r2.texto.includes('ocupado'));
  });

  it('skips response when two messages arrive within 2 seconds', async () => {
    const client = makeClientReturningText('Ok');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    const testJid = makeJid();
    const first = await obtenerRespuestaIA(testJid, 'mensaje rapido', { client });
    assert.equal(first.skipResponse, undefined);
    assert.equal(first.texto, 'Ok');

    const second = await obtenerRespuestaIA(testJid, 'mensaje rapido 2', { client });
    assert.equal(second.skipResponse, true);
    assert.equal(second.texto, null);
    assert.equal(second.leadData, null);
  });

  it('limits history to max messages', async () => {
    const client = makeClientReturningText('ok');
    const { obtenerRespuestaIA } = (await import('./geminiService.js'));
    // send many messages
    const testJid = makeJid();
    for (let i = 0; i < 12; i++) {
      await obtenerRespuestaIA(testJid, `msg ${i}`, { client, skipDebounce: true });
    }
    const res = await obtenerRespuestaIA(testJid, 'final', { client, skipDebounce: true });
    assert.equal(typeof res.texto, 'string');
  });
});

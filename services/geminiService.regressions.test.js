import { describe, it, before } from 'node:test';
import assert from 'assert';

// set minimal env for config/env.js
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test';
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
process.env.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '12345';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'verify-token';

let geminiServiceModule;

before(async () => {
  geminiServiceModule = await import('./geminiService.js');
});

describe('regressions: real-conversation bugs', () => {
  it('sanitizes payload with response + LEAD_JSON and returns only response text', async () => {
    const raw = JSON.stringify({ response: 'Tu cita está programada para este jueves a las 2:00 p. m.', LEAD_JSON: { nombre: 'Andre', telefono: '987654321', distrito: 'Miraflores', fecha_hora_texto: 'jueves 12 de agosto a las 2:00 PM' } });
    const cleaned = geminiServiceModule.sanitizeModelTextOutput(raw);
    assert.equal(cleaned, 'Tu cita está programada para este jueves a las 2:00 p. m.');
  });

  it('preserves name when user sends name + context in same message', async () => {
    const client = {
      async generate(prompt, opts) {
        // reply acknowledging the name but not giving a LEAD_JSON block (server will extract)
        return { text: '¡Perfecto, Andre! ¿En qué distrito estás?' };
      }
    };
    const { obtenerRespuestaIA } = await import('./geminiService.js');
    const jid = `51987654001@s.whatsapp.net`;
    const res = await obtenerRespuestaIA(jid, 'Me llamo Andre vi su anuncio en facebook de servicios', { client });
    assert.equal(res.leadData.nombre, 'Andre');
  });

  it('does not mark ready_to_notify for a requested date on domingo and indicates clinic hours', async () => {
    const client = {
      async generate(prompt, opts) {
        // Simulate model replying asking for another day since clinic closed Sunday
        return { text: 'Atendemos de lunes a sábado. ¿Qué otro día de esa semana te viene bien?' };
      }
    };
    const { obtenerRespuestaIA } = await import('./geminiService.js');
    const jid = `51987654002@s.whatsapp.net`;
    const res = await obtenerRespuestaIA(jid, 'puede ser el próximo domingo', { client });
    // Ensure leadData is either null or not ready_to_notify
    if (res.leadData) {
      assert.equal(res.leadData.ready_to_notify, false);
      assert.equal(res.leadData.outsideClinicHours, true);
    }
    // Response should mention the clinic days (we simulated it)
    assert.ok((res.texto || res.text || '').toLowerCase().includes('lunes') || (res.texto || res.text || '').toLowerCase().includes('sábado'));
  });

  it('does not re-ask core booking fields after LEAD_JSON (session.booked)', async () => {
    // Mock client that returns LEAD_JSON on first call, and on second call verifies the system prompt contains the booked notice
    let call = 0;
    const client = {
      async generate(prompt, opts) {
        call += 1;
        if (call === 1) {
          // Return LEAD_JSON in the model output to simulate booking confirmation
          const leadJson = `<<<LEAD_JSON>>>\n{\n  "nombre": "Pedro Prueba",\n  "telefono": "999555444",\n  "distrito": "Miraflores",\n  "fecha_hora_texto": "martes 11 de agosto, 3:00 PM",\n  "ready_to_notify": true\n}\n<<<END_LEAD_JSON>>>\nPerfecto, Pedro. Tu cita queda agendada para martes 11 de agosto a las 3:00 PM.`;
          return { text: leadJson };
        }
        // For the second call, assert the prompt contains the booked-session instruction
        if (call === 2) {
          // The system prompt should include the AVISO about already booked
          assert.ok(String(prompt).includes('AVISO: Este usuario ya tiene una cita agendada'), 'system prompt must include booked notice');
          return { text: 'Sí, tu cita ya está agendada. ¿Deseas cambiar la hora o tienes alguna otra pregunta?' };
        }
        return { text: 'OK' };
      }
    };

    const { obtenerRespuestaIA } = await import('./geminiService.js');
    const jid = `51999555444@s.whatsapp.net`;

    // Step 1: model returns LEAD_JSON -> session should be marked booked
    const r1 = await obtenerRespuestaIA(jid, 'Me gustaría agendar para el próximo martes a las 3pm', { client });
    assert.ok(r1.leadData && r1.leadData.ready_to_notify, 'first call should return leadData ready_to_notify');

    // Step 2: immediate follow-up question — model should get a prompt that contains the booked notice (asserted inside mock)
    const r2 = await obtenerRespuestaIA(jid, 'pero no me habías agendado ya?', { client });
    // ensure r2 did not produce a new incomplete leadData asking for name/phone/district
    if (r2.leadData) {
      // If leadData present, it should match the snapshot values
      assert.equal(r2.leadData.nombre, 'Pedro Prueba');
      assert.equal(r2.leadData.distrito, 'Miraflores');
    }
  });

  it('does not persist or re-notify on casual post-booking follow-ups like gracias', async () => {
    const { obtenerRespuestaIA, getOrCreateSession } = await import('./geminiService.js');
    const jid = `51990001102@s.whatsapp.net`;
    const session = getOrCreateSession(jid);
    session.booked = true;
    session.leadSnapshot = {
      nombre: 'Sandra Perez',
      telefono: '999111222',
      distrito: 'San Juan de Miraflores',
      fecha_hora_texto: 'martes 11 de agosto a las 6:30 PM',
      fecha_hora_iso: '2026-08-11T23:30:00+00:00',
      confirmedAt: new Date().toISOString()
    };

    const client = {
      async generate(prompt, opts) {
        return { text: 'Gracias por la información.' };
      }
    };

    const res = await obtenerRespuestaIA(jid, 'gracias', { client, skipDebounce: true });
    assert.ok(res.leadData, 'leadData should still be returned from snapshot');
    assert.equal(res.leadData.nombre, 'Sandra Perez');
    assert.equal(res.leadData.distrito, 'San Juan de Miraflores');
    assert.equal(res.leadData.fechaHoraISO, '2026-08-11T23:30:00+00:00');
    assert.equal(res.skipLeadPersistence, true, 'booked sessions should skip lead persistence for casual follow-ups');
  });

  it('uses session-stored distrito when model LEAD_JSON contains invented distrito and only one notification should be created logically', async () => {
    // Setup: pre-seed session with confirmed snapshot
    const { obtenerRespuestaIA, getOrCreateSession } = await import('./geminiService.js');
    const jid = `51990000001@s.whatsapp.net`;
    const session = getOrCreateSession(jid);
    session.leadSnapshot = {
      nombre: 'Sandra Perez',
      telefono: '999111222',
      distrito: 'San Juan de Miraflores',
      fecha_hora_texto: null,
      fecha_hora_iso: null,
      confirmedAt: new Date().toISOString()
    };

    // Mock client that returns LEAD_JSON with invented distrito and a fecha
    const client = {
      async generate(prompt, opts) {
        const leadJson = `<<<LEAD_JSON>>>
{
  "nombre": "Sandra Inventada",
  "telefono": "999000000",
  "distrito": "nuestra clínica en lima",
  "fecha_hora_texto": "martes 11 de agosto a las 6:30 PM",
  "ready_to_notify": true
}
<<<END_LEAD_JSON>>>
Perfecto, tu cita queda agendada para martes 11 de agosto a las 6:30 PM.`;
        return { text: leadJson };
      }
    };

    const res = await obtenerRespuestaIA(jid, 'Para la próxima semana el martes a las 6:30pm', { client });
    // The leadData.distrito must be taken from session.leadSnapshot, not from model
    assert.ok(res.leadData, 'leadData should be present');
    assert.equal(res.leadData.distrito, 'San Juan de Miraflores');
  });

  it('resolves "la próxima semana el martes" to Tuesday Aug 11 2026 when today is Fri Aug 7 2026', async () => {
    // Mock current date to 2026-08-07 (Friday) in Lima
    const realNow = Date.now;
    const limaTest = new Date('2026-08-07T12:00:00-05:00').getTime();
    Date.now = () => limaTest;
    try {
      const { parseTextToLimaISO, getOrCreateSession, obtenerRespuestaIA } = await import('./geminiService.js');
      // Seed a session that will be booked with a specific fecha
      const jid = `51990001111@s.whatsapp.net`;
      const session = getOrCreateSession(jid);
      session.booked = true;
      session.leadSnapshot = {
        nombre: 'Test User',
        telefono: '999000111',
        distrito: 'Miraflores',
        fecha_hora_texto: 'martes 11 de agosto a las 6:30 PM',
        fecha_hora_iso: '2026-08-11T23:30:00+00:00',
        confirmedAt: new Date().toISOString()
      };

      // Send follow-up messages that should NOT change the fecha
      const client = { async generate(prompt, opts) { return { text: 'Perfecto, gracias' }; } };
      const r1 = await obtenerRespuestaIA(jid, 'gracias', { client, skipDebounce: true });
      assert.ok(r1.leadData, 'leadData should exist from snapshot');
      assert.equal(r1.leadData.fechaHoraISO, '2026-08-11T23:30:00+00:00');

      const r2 = await obtenerRespuestaIA(jid, '¿necesito llevar algo?', { client, skipDebounce: true });
      assert.ok(r2.leadData, 'leadData should persist across followups');
      assert.equal(r2.leadData.fechaHoraISO, '2026-08-11T23:30:00+00:00');

      // Also verify parseTextToLimaISO still resolves phrase to the same ISO when used directly
      const iso = parseTextToLimaISO('la próxima semana el martes a las 6:30pm');
      assert.equal(iso, '2026-08-11T23:30:00+00:00');
    } finally {
      Date.now = realNow;
    }
  });

});

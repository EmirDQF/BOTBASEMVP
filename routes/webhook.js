import express from 'express';
import rateLimiter from '../middleware/rateLimiter.js';
import makeVerifySignature from '../middleware/verifySignature.js';
import webhookController from '../controllers/webhookController.js';
import config from '../config/env.js';

const router = express.Router();

// GET /webhook for challenge verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.verifyToken) {
    console.log('✅ Webhook verified');
    return res.status(200).send(String(challenge || ''));
  }
  return res.status(403).send('Forbidden');
});

// POST /webhook: respond 200 immediately, then process asynchronously.
router.post('/webhook', express.raw({ type: 'application/json' }), makeVerifySignature(), rateLimiter(), (req, res, next) => {
  // Meta debe recibir el acuse antes de cualquier trabajo de negocio o await.
  res.sendStatus(200);

  const safeRes = {
    headersSent: true,
    status() { return this; },
    json() { return this; },
    send() { return this; },
    setHeader() {},
    getHeader() { return undefined; },
    end() { return this; }
  };

  void (async () => {
    try {
      await webhookController(req, safeRes, next);
    } catch (err) {
      console.error('webhook route: background processing error', err && err.message ? err.message : err);
    }
  })();
});

export default router;

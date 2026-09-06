BOTBASEMVP
=============

Descripción
-----------
Motor genérico de conversaciones para WhatsApp Cloud y Gemini. La configuración del negocio y el catálogo se centralizan en `config/catalogo.js`; `src/config.js` solo conserva exportaciones de compatibilidad.

Variables de entorno (.env)
---------------------------
Colocar un archivo .env en la raíz con al menos las siguientes variables (NO subir .env a git):

- GEMINI_API_KEY=tu_clave
- GEMINI_MODEL=gemini-3.5-flash-lite
- ADMIN_WHATSAPP_NUMBER=+51XXXXXXXXX
- BUSINESS_NAME=Empresa Demo
- BUSINESS_INDUSTRY=Servicios
- BUSINESS_ADDRESS=Av. Principal 123
- BUSINESS_HOURS=Lunes a Sábado de 9:00 AM a 8:00 PM
- BUSINESS_CONTACT_PHONE=+00 000 000 000
- PUBLIC_BASE_URL=https://tu-dominio.example
- PORT=3000

Este proyecto utiliza un loader propio (src/envLoader.js) que lee .env y asigna variables a process.env solo si no existen ya (respeta variables definidas por PM2/host).

Cómo correr el bot
------------------
1. Instalar dependencias: npm install
2. Asegurarse de tener .env en la raíz con GEMINI_API_KEY
3. Iniciar: npm start

Tests y verificaciones
----------------------
- Smoke test que valida el webhook y guardado de leads: `npm run test:smoke` (ejecuta `scripts/smoke-test.js`)
- Tests unitarios de servicios: npm test (o `npm run test:unit`)
- Prospector configurable: `npm run prospect -- --niche "servicios" --keywords "reservas,atención al cliente"`.
  También acepta `PROSPECTOR_NICHE` y `PROSPECTOR_KEYWORDS` en `.env`.

Catálogo y medios
-----------------
- Las imágenes se resuelven desde el catálogo centralizado y solo se envían URLs HTTP(S) válidas.
- Las rutas locales bajo `/media/` se verifican antes de enviarse; una imagen inexistente no bloquea la respuesta de texto.
- La detección de categorías puede ampliarse con `CATALOG_KEYWORDS` sin modificar el controlador.

Política de fallback heurístico
------------------------------
- Gemini recibe instrucciones y el catálogo dinámico mediante `generateContent`; el parser heurístico local es la red de seguridad ante errores recuperables de red/servidor (timeouts, 5xx, ECONN*). No se usa fallback en errores de permisos (403), modelo inexistente (404) o fallos de autorización.
- Cuando el fallback heurístico se activa en producción se registra una advertencia visible: console.warn('⚠️ Fallback heurístico activado ...').

Seguridad
--------
- .env está incluido en .gitignore y nunca debe subirse.

Notas finales
------------
- Commit inicial creado localmente. No se ha hecho push a ningún remoto.
- Si se rota la GEMINI_API_KEY, vuelva a actualizar .env y vuelva a ejecutar: npm run test:smoke

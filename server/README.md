# Gündəm — server

Fastify + PostgreSQL. Eyni ünvanda həm API-ni, həm də veb tətbiqi (`web/`) verir.

- `src/routes/auth.js` — Google OAuth (veb: `#token=`, iOS: `gundem://auth?code=` → `POST /auth/exchange`)
- `src/tools.js` — Gmail / Google Calendar / Google Drive alətləri; claude.ai connector-ları ilə eyni ad, giriş və cavab formatı
- `src/llm.js` — Gemini və ya Claude (`AI_PROVIDER`), alət çağırışları ilə
- `src/ai.js` — `/api/ai/sample`, aylıq limitlər, xərc uçotu
- `app/runtime.js` — brauzerdə `window.claude.use(...)` əvəzi; Gündəm interfeysi dəyişmədən bu serverlə işləyir
- `app/gundem.html` — interfeysin mənbəyi. Dəyişəndən sonra `npm run build:web` işlət.

Lokal işə salmaq:

```bash
cp .env.example .env   # doldur
npm install
npm run build:web
npm run dev            # http://localhost:8080
```

Google Cloud-da lokal üçün redirect URI əlavə et: `http://localhost:8080/auth/google/callback`.

Testlər (PostgreSQL lazımdır):

```bash
npm test                   # 54 API testi (Google və AI mock)
NODE_PATH=$(npm root -g) npm run test:e2e   # brauzer testi, Playwright lazımdır
```

API:
- `GET /api/me`, `DELETE /api/me`
- `GET /api/state`, `PUT /api/state/:key`
- `GET /api/tools`, `POST /api/tool` (`{server, tool, input}`)
- `POST /api/ai/sample`
- `POST /webhooks/revenuecat`

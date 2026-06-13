# CollabGlam Backend — Architecture

CollabGlam is an influencer–brand collaboration platform. This backend is the API,
realtime, and background-jobs server that powers it: identity & subscriptions,
campaign lifecycle, contracts & payments, creator discovery, chat, and email
outreach.

> Package name in `package.json` is `infuencer` (v1.0.0); the running service is
> "CollabGlam back V3".

---

## 1. Technology Stack

| Concern            | Technology |
|--------------------|------------|
| Runtime            | Node.js (CommonJS) |
| Web framework      | Express 5 |
| Database           | MongoDB 7 via Mongoose 8 (+ native `mongodb` driver for GridFS/scripts) |
| File storage       | MongoDB **GridFS** (primary) + AWS **S3** (`@aws-sdk/client-s3`, presigned URLs) |
| Realtime           | **Socket.IO** (rooms/notifications) **+ raw `ws`** (legacy `/ws` chat) |
| Auth               | JWT (`jsonwebtoken`), role-based (`brand` / `influencer` / `admin`) |
| Background jobs    | `node-cron` (in-process schedulers) |
| Payments           | **Stripe** + **Razorpay** |
| Email — outbound   | Nodemailer (SMTP) + AWS **SES** |
| Email — inbound    | SES → inbound webhook parsing (`mailparser`) |
| Cold outreach      | **Instantly** API (OAuth + webhooks) |
| Creator data       | **Modash** API (influencer database), **YouTube** Data API |
| AI                 | **OpenAI** + **Google GenAI** (insights, vision/OCR via `tesseract.js`) |
| Docs/PDF           | `puppeteer`, `pdfkit`, `jspdf`, `docxtemplater`, `libreoffice-convert`, `exceljs` |
| Geo / i18n         | `maxmind` (IP geo), `luxon` / `moment-timezone`, `countries-and-timezones` |

Entry point: **`app.js`** (`npm start` → `node app.js`; `npm run dev` → nodemon).
`server.js` is empty — `app.js` builds the HTTP server directly.

---

## 2. High-Level Topology

```
                          ┌─────────────────────────────────────────────┐
   Browser / Frontend     │              app.js (Express 5)             │
  (collabglam.com, .cloud)│                                             │
        │                 │  CORS allowlist → JSON/urlencoded parsers   │
        │  HTTPS / REST    │  → /uploads static → GridFS file routes     │
        ├─────────────────▶│  → ~60 feature routers → 404 → error handler│
        │                 │                                             │
        │  WebSocket       │  http.createServer(app)                     │
        ├─────────────────▶│   ├── Socket.IO  (notifications, rooms)     │
        │   (/ + /ws)      │   └── ws  /ws    (raw chat, legacy)         │
        │                 └───────────────┬─────────────────────────────┘
        │                                 │
        │                 ┌───────────────┴──────────────┐
        │                 │  Mongoose ⇄ MongoDB Atlas     │
        │                 │  (88 models, GridFS bucket)   │
        │                 └──────────────────────────────┘
        │
        │   In-process cron (started in bootstrap):
        │     • reminderCron        (contract reminders, every min)
        │     • subscriptionEmailJobs (expiry warnings, hourly/daily)
        │     • unseenMessageNotifier (chat nudges)
        │
        └── External: Stripe · Razorpay · AWS S3/SES/STS · Modash ·
            YouTube · Instantly · OpenAI · Google GenAI
```

Everything runs in a **single Node process**: HTTP API, both WebSocket servers,
and the cron jobs share one event loop and one Mongo connection pool
(`maxPoolSize: 20`).

---

## 3. Request Lifecycle

A typical REST request flows:

```
HTTP request
  → CORS check (allowlist from FRONTEND_ORIGIN env or built-in defaults)
  → express.json / urlencoded (50mb limit; large files must use multipart)
  → Router mounted at /<feature>          (app.js §"API ROUTES")
  → Auth middleware                        (auth/* or middlewares/*)
  → Validation                             (express-validator / core/validation)
  → Controller                             (controllers/*Controller.js)
  → Model / Service                        (models/* , services/* , utils/*)
  → ApiResponse / ApiError                 (core/http/*)
  → Global error handler                   (app.js, last middleware)
```

The **global error handler** (`app.js:438`) normalizes Multer errors,
`413 entity.too.large` payloads, and any thrown `ApiError` into a JSON
`{ message }` response.

---

## 4. Layered Structure

The codebase follows a classic **routes → controllers → models/services** layering,
with cross-cutting helpers in `core/`, `utils/`, and `middlewares/`.

```
routes/        (59)  Thin Express routers. Map HTTP verbs+paths → controller fns,
                     attach auth + validation middleware. Mounted in app.js.

controllers/   (66)  Request handlers. Parse req, enforce business rules,
                     orchestrate models/services, shape the response.

models/        (88)  Mongoose schemas — the domain model & persistence layer.

services/      (23)  Reusable domain logic & external integrations
                     (email, contracts, YouTube/OpenAI insights, Instantly).
   services/email/   Email provider abstraction, templates, rendering.

jobs/          (6)   node-cron background workers (subscription emails, mediakit
                     sync, Instantly reply sync, unseen-message notifier).

middlewares/   (7)   Express middleware: auth guards, role guards, rate limiting,
                     image upload.

auth/          (4)   JWT auth strategies: brandAuth, influencerAuth,
                     brandOrInfluencerAuth, adminAuth.

sockets/       (1)   Realtime hub — Socket.IO + raw ws, room management,
                     chat/group-chat message persistence & broadcast.

core/                Framework primitives (provider-agnostic):
   core/http/        ApiError, ApiResponse, HttpStatus, errorCodes
   core/crud/        BaseRepository (generic data-access base)
   core/security/    cors, helmet, rateLimit, sanitize configs
   core/validation/  Validator
   core/pagination/  pagination helper
   core/logging/     logger

utils/         (26)  Domain helpers: quotas, feature gating, gridfs, mailer,
                     invoice numbering, IP geo, search tokenization, notifiers.

constants/     (2)   contract.js, outreach.js — enums & shared constants.

scripts/       (38)  One-off seed / backfill / migration scripts (run manually).

emails/, template/, invoice/, invoices/, assets/, data/   Static assets & templates.

uploads/             Local static files served at /uploads (legacy; GridFS preferred).

lambda/              (empty placeholder for serverless handlers)
```

---

## 5. Core Domains

The ~60 routers group into these functional areas:

### Identity & Access
- **Brand** (`/brand`), **Influencer** (`/influencer`), **Admin** (`/admin`, `/admins`)
- **Brand Members** (`/brand-members`) — multi-user brand teams with role hierarchy
  (`adminRoleGuard`, `utils/adminHierarchy.js`)
- Signatures: brand & influencer e-signatures (`/brandSignature`, `/influencerSignature`)
- JWT-based, role-scoped. Tokens carry `{ brandId | influencerId | adminId, role }`.

### Subscriptions & Billing
- **Subscription** (`/subscription`) — plans, feature gating (`utils/getFeature.js`,
  `utils/brandFeatures.js`, `utils/quota.js`), plan history
- **Payment** (`/payment`), **Payment Details** (`/payment-details`),
  **Brand Wallet** (`/wallet`) — Stripe + Razorpay
- Invoices generated via `invoice/`, `utils/invoiceNumber.js`

### Campaign Lifecycle
- **Campaign** (`/campaign`) → **Apply** (`/apply`) → **Invitations**
  (`/campaign-invitation`, `/newinvitations`)
- **Matched Creators** (`/matched-creators`), **Campaign Reviews**
  (`/campaign-reviews`), **Campaign Intelligence** (`/campaign-intelligence`, AI)
- **Deliverables** (`/deliverable`), performance & deliverable insights

### Contracts, Milestones & Disputes
- **Contract** (`/contract`) — assembled from `contractContent` /
  `contractDocument` via `services/contractAssembler.service.js`; activity log,
  signatures, reminders (`services/contractReminderWorker.js` + `reminderCron`)
- **Milestone** (`/milestone`) + milestone payments
- **Dispute** (`/dispute`)

### Creator Discovery & Insights
- **Modash** (`/modash`) — external influencer database search/enrichment
- **YouTube** (`/youtube`) + **YouTube Insights** (`/youtube-insights`) — reports,
  public shares, OpenAI-generated analysis (`services/youtube*.service.js`)
- **Media Kit** (`/media-kit`), **Lists** (`/list`), **Filters** (`/filters`),
  taxonomy: categories, audience, language, platform, country, timezone

### Messaging (Realtime)
- **Chat** (`/chat`) — 1:1 rooms; **Group Chat** (`/group-chat`)
- Realtime via `sockets/index.js`: Socket.IO for notification rooms
  (`brand:<id>`, `influencer:<id>`, `admin:<id>`) and chat rooms; raw `ws` `/ws`
  endpoint persists & broadcasts chat/group messages directly.

### Email & Cold Outreach
- **Brand Outreach** (`/brand-outreach`), **Outreach** (`/outreach`),
  **Brand Network** (`/brand-network`), **Pipeline** (`/pipeline`),
  **Pitch Folders** (`/pitch-folders`)
- **Instantly** integration (`/instantly`, `/instantly/oauth`,
  `/instantly/webhook`) — mailbox assignment, sequence sending, reply sync job
- **Email** (`/emails`, `/admin-email`) — threaded conversations, inbound SES
  parsing (`services/inboundEmail.service.js`), redaction, aliases

### Platform / CMS / Support
- **Support** (`/support`) tickets, **Contact** (`/contact`), **FAQs** (`/faqs`),
  **Policy** (`/policy`), **Notifications** (`/notifications`),
  **Unsubscribe** (`/unsubscribe`), **Error Logs** (`/error-logs`),
  **Dashboard** (`/dash`), **Business types** (`/business`)

---

## 6. Realtime Architecture

`sockets/index.js` runs **two** WebSocket layers on the same HTTP server:

1. **Socket.IO** — app-wide notifications and typing indicators. Clients `join`
   identity rooms (`brand:`, `influencer:`, `admin:`) and chat rooms. The app
   exposes emit helpers via `app.set(...)`:
   `emitToBrand`, `emitToInfluencer`, `emitToAdmin`, `broadcastToRoom`,
   `broadcastToGroupChatRoom`.
2. **Raw `ws` at `/ws`** — legacy/raw frontend. Handles `joinChat`, `typing`,
   `sendChatMessage`, `joinGroupChat`, `groupTyping`, `sendGroupChatMessage`.
   Messages are validated for participant membership, persisted to the
   `chat` / `groupChat` Mongoose models, then broadcast to **both** transports
   (`broadcastToChatRoom` fans out to Socket.IO rooms *and* the ws room set).

Room membership for raw ws is tracked in an in-memory `Map` (`wsRooms`), so it is
**per-process** — horizontal scaling would require a shared adapter
(e.g. Socket.IO Redis adapter) and externalizing ws room state.

---

## 7. File Storage

Two mechanisms coexist:

- **GridFS** (primary) — configured in `app.js`. Bucket name from
  `GRIDFS_BUCKET` (default `uploads`). Uploads via Multer `memoryStorage`
  (`FILE_SIZE_LIMIT_MB`, default 100MB, max 10 files) streamed into GridFS.
  Served at `GET /file/:filename` and `GET /file/id/:id` with long-lived
  immutable cache headers; non-images get `Content-Disposition: attachment`.
- **AWS S3** — `services/s3upload.js`, `utils/uploadBase64ImagesToS3.js`,
  presigned URLs. Used for email archives, signatures, and larger assets.
- **Local `/uploads`** — `express.static`, legacy.

---

## 8. Background Jobs

Started in `bootstrap()` after the Mongo connection is established:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `reminderCron` | every minute | Contract reminder sweep (`contractReminderWorker`) |
| `subscriptionEmailJobs` | hourly / daily | Warn of expiring subscriptions, renewals |
| `unseenMessageNotifier` | interval | Nudge users about unread chat messages |

Other workers in `jobs/` (run/registered elsewhere or manually): `mediakitSync`,
`instantlyReplySyncJob`, `subsriptionRefresh`.

> Jobs are **in-process**. Running multiple instances of this server would
> double-fire crons unless guarded (leader election / external scheduler).

---

## 9. Cross-Cutting Conventions

- **Errors:** throw `ApiError` (`core/http/ApiError`) with `{ status, code,
  message, details }`; the global handler serializes it. `HttpStatus` and
  `ErrorCodes` enums keep status/codes consistent.
- **Responses:** `core/http/ApiResponse` for success envelopes;
  `humanizeErrorMessage` for user-facing text.
- **Auth:** prefer the strategy in `auth/` (newer, `ApiError`-based) over the
  older `middlewares/*Auth.js`. Tokens are `Bearer` JWTs signed with `JWT_SECRET`.
- **Validation:** `express-validator` in routes + `core/validation/Validator`.
- **Feature gating / quotas:** `utils/getFeature.js`, `utils/brandFeatures.js`,
  `utils/quota.js` enforce subscription-plan limits.
- **Data access:** mostly direct Mongoose calls in controllers; `core/crud/
  BaseRepository.js` provides a generic repository base where used.

---

## 10. Configuration (Environment)

Loaded from `.env` (via `dotenv` / process env). Key groups:

- **Core:** `NODE_ENV`, `PORT`, `MONGODB_URI`, `JWT_SECRET`, `JSON_LIMIT`,
  `GRIDFS_BUCKET`, `FRONTEND_ORIGIN` (CORS allowlist, comma-separated),
  `FRONTEND_URL`, `CAMPAIGN_BASE_URL`, `PLATFORM_NAME`
- **Email:** `SMTP_HOST/PORT/USER/PASS`, `SMTP_URL`, `MAIL_FROM*`,
  `SES_CONFIGURATION_SET`, `EMAIL_ARCHIVE_BUCKET`, `INBOUND_REPLY_DOMAIN`,
  `EMAIL_RELAY_DOMAIN`, `SUPPORT_TEAM_EMAIL`
- **Payments:** `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`,
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
- **AWS:** `AWS_REGION`, `AWS_ACCESS_KEY_ID(/1)`, `AWS_SECRET_ACCESS_KEY(/1)`,
  `AWS_S3_BUCKET_NAME`
- **Integrations:** `MODASH_*`, `YOUTUBE_API_KEY`, `INSTANTLY_*`,
  `OPENAI_API_KEY` + vision models, `TEMPERATURE`, `PRIMARY_TOKENS`/`RETRY_TOKENS`
- **Misc:** `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`, `CHROME_EXECUTABLE_PATH`,
  `INVITE_EXP_MINUTES`, `ADMIN_EMAIL/PASSWORD`

> Note: `app.js` reads `process.env.MONGODB_URI`, while the standalone `db.js`
> helper reads `MONGO_URI` + `DB_NAME` — two different connection paths
> (`db.js` is mainly used by `scripts/`).

---

## 11. Notable Characteristics & Risks

- **Monolith, single process** — API + 2 WS servers + crons share one runtime.
  Simple to deploy, but scaling out needs shared session/room state and
  cron-leader guarding.
- **Dual WebSocket stack** (Socket.IO + raw `ws`) — kept for frontend
  compatibility; new work should standardize on one.
- **Mixed auth layers** (`auth/` vs `middlewares/`) and some duplicated files
  (`rateLimit 2.js`, `instantlyReplySyncJob 2.js`) suggest in-progress
  consolidation.
- **`autoIndex: false`** in production connect — indexes must be created
  explicitly (see `scripts/`), not inferred from schemas at runtime.
- **Large JSON limit (50MB)** — file uploads are expected over multipart/GridFS;
  the error handler actively rejects oversized JSON.

---

*Generated from source inspection of `app.js`, `sockets/index.js`, route
registrations, and the `models/`, `controllers/`, `services/`, `jobs/`, `core/`,
and `utils/` directories.*

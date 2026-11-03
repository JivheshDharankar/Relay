# Relay Frontend Rebuild — Backend/API Contract Reference

Recorded 2026-10-31 before deleting the active `frontend/` implementation.
Backend is FROZEN (Phase 13, 967/967 tests). This document captures contracts
and integration knowledge only — no visual implementation.

## 1. Service topology

| Service      | Address                | Notes                                              |
|--------------|------------------------|----------------------------------------------------|
| Backend      | `http://localhost:4000`| Express, `backend/.env`, frozen                    |
| Frontend     | `http://localhost:3000`| CORS origin; `npm run dev/build/start -p 3000`     |
| Postgres     | `localhost:5432`       | DB `relay_db`, Homebrew `postgresql@16`            |

Backend env (frozen): `MODEL_PROVIDER=mock`, `SUPPLIER_DISCOVERY_PROVIDER=geoapify`,
`MAX_AGENT_STEPS=20`.

## 2. HTTP conventions

- Base: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`).
- JSON in/out. Success envelope: `{ success: true, data: T }`.
- Error envelope: `{ success: false, error: { code, message, details? } }`.
- Auth: `Authorization: Bearer <token>` from `localStorage['relay_session_token']`.
- Client timeouts observed working: 8s default reads, 30s+ for `agent/run`.
- CORS is strict to `http://localhost:3000`. Serving the frontend on any other
  origin breaks browser API calls (E2E used `--disable-web-security` only to
  work around a port conflict — never ship that).

## 3. Authentication (Google VERIFIED — keep this exact contract)

### Google OAuth (Phase 12.5, verified 25/25 Vitest + 4/4 Chrome E2E)

1. Frontend navigates top-level to `GET /api/auth/google` (`initiateGoogle`).
   Backend 302s to Google (state+nonce CSRF). Backend IS configured
   (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` set in `backend/.env`).
2. Google calls back `GET /api/auth/google/callback` (`handleGoogleCallback`,
   single-use state). Backend creates session + user, sets `relay_session`
   cookie, then 302s the browser to:
   `{FRONTEND_URL}/?sessionToken=...` (onboarding complete) or
   `{FRONTEND_URL}/onboarding?sessionToken=...`.
3. Frontend MUST capture `?sessionToken=` on every route, store it as
   `relay_session_token`, strip it from the URL, and refresh
   `GET /api/auth/session`. (Previous implementation: `SessionTokenCatcher`.)
4. Unconfigured backend: navigation (non-JSON) redirects to
   `{FRONTEND_URL}/login?error=GOOGLE_AUTH_UNCONFIGURED`; JSON callers get 503.
   Login MUST surface `?error=`.
5. `GET /api/auth/providers` returns metadata incl. GOOGLE
   `{ id, name, type: 'OAUTH', status, isAvailable, requiresConfig,
   authorizationUrl: '/api/auth/google', errorMessage? }`.
   LESSON: never gate the Google button on this auxiliary fetch — always
   render it; metadata only refines hint text.

### Email / Phone OTP (verified in Chrome E2E)

- `POST /api/auth/email/request-otp` `{ email }` → `{ message, messageId?, cooldownSeconds? }` (429 `OTP_COOLDOWN_ACTIVE` possible).
- `POST /api/auth/email/verify-otp` `{ email, otpCode }` → session payload below.
- `POST /api/auth/phone/request-otp` `{ phone }`, `POST /api/auth/phone/verify-otp` `{ phone, otpCode }` — same shapes.
- Session payload: `{ user: { id, authProvider, email, phone, name, profileImage, onboardingStatus, residentId }, session: { token, expiresAt }, isNewUser }`.
- After login: `GET /api/onboarding/status` → `isComplete ? '/' : '/onboarding'`.
- DEV ONLY: any destination with a requested OTP accepts `123456`
  (`NODE_ENV !== 'production'`). E2E relied on this.
- `GET /api/auth/session` (Bearer) → `{ user, residentId, session: { sessionId, expiresAt } }`, 401 when absent.
- `POST /api/auth/logout` revokes server-side; frontend MUST also clear localStorage.
- IDOR: sending another `residentId` while authenticated → 403. Never send one;
  let the backend derive identity from the session.

## 4. Onboarding (5 resumable steps, verified in Chrome E2E)

`GET /api/onboarding/status` → `{ userId, currentStep, isComplete, hasProfile,
hasAddress, hasSociety, hasMembership, hasPaymentMandate, residentId, updatedAt }`.
Steps (`currentStep`): `PROFILE_REQUIRED` → `ADDRESS_REQUIRED` →
`SOCIETY_REQUIRED` → `SOCIETY_VERIFICATION_REQUIRED` →
`PAYMENT_AUTHORIZATION_REQUIRED` → `ONBOARDING_COMPLETE`.
Each POST returns the updated summary; drive the wizard from it.

- `POST /api/onboarding/profile` — `{ fullName(min 2), email(required), phone?, preferredContactMethod? }`.
- `POST /api/onboarding/address` — `{ addressLine(min 5), city, state, postalCode, country?, latitude(required), longitude(required), isDefault? }`.
- `POST /api/onboarding/society` — `{ societyId, tower?, flatNumber(required), verificationMethod? }`.
- `POST /api/onboarding/verify-society` — no body.
- `POST /api/onboarding/payment-mandate` — `{ spendingLimit(>0, ≤1000000), currency: 'INR', purpose? }`.

Coordinates: backend REQUIRES lat/lng. Previous UI used browser geolocation
("Use my location") + manual fields. NEVER hardcode city→coordinate maps.

## 5. Societies

- `GET /api/societies/search` — query params `q` (NOT `query`), `city`,
  `postalCode`, `lat`, `lng`, `radius`, `limit`. Returns an ARRAY as `data`
  (not `{ societies }`). Registry is IN-MEMORY and diverges from Postgres
  (see F1 below).
- `POST /api/societies/register` — `{ name, address, city, state, postalCode, country?, latitude, longitude }` → created society (`PENDING_VERIFICATION`, id `soc_*`).
- `GET /api/societies/:id`, `GET /api/societies/:id/supplier-delivery-view`
  (privacy-safe address for suppliers; never leaks flats/names).

## 6. Procurement engine + agent

- `POST /api/agent/run` — `{ message(required, ≤5000 chars), residentId?, societyId?, requestId?, metadata? }`.
  BLOCKING (no streaming/SSE/WebSocket exists). Returns `{ success, completed,
  runId, totalSteps, response, steps: [{ stepNumber, thought?, toolCall?: { id, name, arguments, result?, error? }, timestamp }], error? }`.
  NEVER render `thought`. With `MODEL_PROVIDER=mock` the run emits 9 tool steps,
  single product, NO payment/delivery steps (see full-cycle fallback).
- Legacy tool sequence: `createRequest` → `checkAuthorization` →
  `aggregateDemand` → `discoverSuppliers` → `evaluateOffers` → `selectOffer` →
  `createCommunityOrder` → `allocateResidentOrders` → `requestPayment?` →
  `trackDelivery?` → `reconcileOrder`.
- Key result shapes (recorded live; full JSON was in `__tests__/fixtures/`):
  - `createRequest`: `{ orderId, productId, productName, quantity, unit, totalAmount/totalPrice }`.
  - `checkAuthorization`: `{ authorized, mandateId, code, maxAllowed, requestedAmount }`.
  - `aggregateDemand`: `{ societyId, groupsCount, groups[], supplierFacingGroups[] }`.
  - `discoverSuppliers`: `{ eligibleCount, qualifiedCount, suppliers[] }`; each
    `{ supplierId, supplierName, eligible, distanceKm, serviceRadiusKm, deliverySlaHours, reasons[] }`
    (reasons carry e.g. `SLA_VIOLATION (Delivery 14h exceeds 12h SLA limit)`).
  - `evaluateOffers`: `{ rankedOffers[] }` each `{ supplierId, supplierName, totalPrice, deliveryHours, reliabilityScore(0-1), compositeScore, eligible }`.
  - `selectOffer`: `{ supplierId, supplierName, totalPrice, compositeScore, deliveryHours }`.
  - `createCommunityOrder`: `{ order: { id, status, totalAmount, deliveryDeadline, itemsCount }, isDuplicate }`.
  - `allocateResidentOrders`: `{ communityOrderId, deliveryId, allocationsCount }`.
  - `reconcileOrder`: `{ isReconciled, status, communityOrderId, quantityPassed, financialPassed, productPassed, societyPassed, discrepancies[] }`.
- Direct engine endpoints (deterministic, no agent): `POST /api/procurement/{validate, authorize, aggregate, evaluate, orders, reconcile}`.
- 13 canonical stages (backend `orchestration/types.ts`): UNDERSTAND, DISCOVER,
  QUALIFY, QUOTE, NEGOTIATE, SELECT, COMMIT, PAY, FULFILL, VERIFY, ALLOCATE,
  RECONCILE, COMPLETE. The orchestrator store is in-memory with NO http read —
  quote/negotiation/selection/commitment detail exists only inside agent-step
  payloads. UX rule: blocking call → honest indeterminate "Relay is working"
  state → evidence-mapped stages only from returned artifacts; never simulate
  live progress. Mock runs never negotiate — say so explicitly.

## 7. Execution (payment / PO / delivery)

- `POST /api/execution/full-cycle` `{ communityOrderId, allocations? }` — REQUIRED
  fallback when agent steps lack payment/delivery. Returns `{ payments[]:
  [{ orderId, residentOrderStatus, payment: { paymentId, providerReference
  ('MOCK-TXN-*'), status, amount, currency, executedAt, isDuplicate } }],
  supplierPO: { poReference ('MOCK-PO-*'), supplierId, status, confirmedDeliveryEta, totalAmount, currency, isDuplicate },
  delivery: { deliveryId, communityOrderId, status, trackingCode ('TRK-SIM-*'), dispatchedAt?, deliveredAt?, updatedAt },
  reconciliation: {...} }`. Lands delivery at DELIVERED immediately.
- `GET /api/execution/delivery/:communityOrderId` → delivery snapshot (pollable).
- `POST /api/execution/delivery/advance` `{ communityOrderId, targetStatus }` —
  simulation stepping; no honest use post-full-cycle (already DELIVERED).
- `POST /api/execution/{payment, supplier/order}` — direct execution endpoints.

## 8. Portal (resident-facing reads)

- `GET /api/portal/resident` — session-scoped (+IDOR 403). Prisma resident OR
  composite for new users: `{ id, name, email, flatNumber ('{tower}-{flat}' for
  new users), societyId, societyName, societyAddress, societyCity,
  activeMandate: { id, maximumAmount, currency, status } | null, totalOrders }`.
  `activeMandate` HERE is the session-correct mandate authority.
- `GET /api/portal/orders` — session-scoped (+IDOR 403): `[{ id, status,
  totalAmount, currency, deliveryAddress, requestedAt, items[]: { id, productId,
  productName, category, quantity, unit, unitPrice, totalPrice }, payment:
  { id, status, amount, providerReference, createdAt } | null, communityOrder:
  { id, status, supplierName, deliveryStatus, trackingCode } | null }]`.
  Sufficient for order-detail views (no detail endpoint exists).
- `GET /api/portal/community` — aggregated only: `{ id, name, address, city,
  state, verified, totalFlatsRepresentation, registeredResidents,
  verifiedSuppliersCount, totalCommunityOrders, activeDemandPools[]:
  { productId, productName, totalQuantity, unit, contributingOrdersCount,
  estimatedSavingsPct }, collectiveSavingsEstimatePct }`. Never contains PII.
- `GET /api/portal/suppliers` — unscoped Prisma catalog: `[{ id, name, city,
  rating, reliabilityScorePct, serviceRadiusKm, slaHours: 12, catalog[]:
  { productId, name, category, unit, basePrice, moq } }]`.
- `GET /api/portal/payments` — ⚠️ IGNORES the session (`query.residentId || SEED`).
  Returns `{ mandate: { id, maximumAmount, currency, status, authorizedAt,
  usedAmount, remainingLimit, autoExecutionEnabled }, transactions[]:
  { id, status, amount, currency, providerReference, failureCode, executedAt,
  orderId, itemDescription } }`. TRUST RULE (F2): only display its
  remaining/transactions when `payments.mandate.id === resident.activeMandate.id`;
  otherwise they belong to the seed resident and MUST be suppressed (privacy).

## 9. Reconciliation (render verbatim, never recompute)

Full-cycle `reconciliation`: `{ isReconciled, communityOrderId, status:
'RECONCILED'|'FAILED', quantityReconciliation: { passed, communityTotal,
residentSum, difference } (Decimal STRINGS), financialReconciliation: {...},
productIntegrity: { passed, discrepancies[] }, societyIntegrity: { passed,
societyId }, discrepancies[] }`.
Four-pillar display: Community demand (`financial.communityTotal`) =
Supplier PO (`supplierPO.totalAmount`) = Provider debit (`payment.amount`) =
Resident allocations (`financial.residentSum`); differences verbatim.
Banner condition from backend verdicts only
(`isReconciled && status==='RECONCILED' && all passed`) — no float math in UI.

## 10. Known frozen-backend integration gaps (do not fix without approval)

- **F1 — registry/Prisma society split**: onboarding/society APIs use an
  in-memory registry (`soc_*` ids); procurement tools look societies up in
  Postgres. Authenticated procurement for newly onboarded societies FAILS
  (`Society with ID soc_* does not exist`). Only seed-context
  (unauthenticated dev-fallback) runs succeed end-to-end. Frontend MUST surface
  these failures honestly per-stage, never bypass (e.g. never spoof `societyId`).
- **F2 — payments misattribution**: see §8 trust rule.
- No streaming/SSE/WebSocket; no workflow-status endpoint; no RFQ/quote/
  negotiation/selection/commitment/allocation http reads; no order-detail
  endpoint (list suffices); no per-resident used/remaining capacity except via
  the F2-gated payments endpoint.

## 11. Frontend environment

- `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`). No secrets in frontend env.
- Backend must run with its own `.env` (`DATABASE_URL`, `CORS_ORIGIN=http://localhost:3000`, `MODEL_PROVIDER`, etc.). Never place backend secrets in frontend files.

## 12. Verification knowledge

- Backend: `cd backend && npx tsc --noEmit`, `npm test` (967), serves `:4000`.
- Sandbox blocks localhost TCP/listen: localhost probing, `next start`, and
  Chrome launches need one-time approved unsandboxed runs. `setsid` missing on
  macOS — no detached processes; managed servers die with the agent session.
- Previous gates: `tsc` + Vitest + `next build` + real-Chrome E2E
  (playwright-core + system Chrome, dev OTP `123456`). E2E scripts lived in
  `/tmp/relay-e2e/` (ephemeral). Do not commit E2E artifacts.

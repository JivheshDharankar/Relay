# Relay

> **“Tell Relay what you need. Choose how to pay. Relay handles everything in between.”**

Relay is an AI-first multi-agent procurement and exchange platform for apartment communities, built for the **Meta Global AI Developer Hackathon**.

The user gives one natural-language request. Relay autonomously handles procurement within pre-authorized boundaries.

---

## Current Status: Milestone 7 Complete (End-to-End Integration)

Milestone 7 connects and verifies Relay's full multi-agent procurement system end-to-end:

> **“Tell Relay what you need. Choose how to pay. Relay handles everything in between.”**

### Connected Canonical Flow:
```text
Resident (Natural language prompt)
   ↓
Next.js frontend (app/resident)
   ↓
POST /api/agent/run
   ↓
Agent Layer (RelayAgent / Muse Spark Orchestration)
   ↓
ModelProvider (MockModelProvider / MetaSparkProvider / SparkOpenProvider)
   ↓
Controlled ToolRegistry (11 Deterministic Tools)
   1. createRequest
   2. checkAuthorization
   3. aggregateDemand
   4. discoverSuppliers
   5. evaluateOffers
   6. selectOffer
   7. createCommunityOrder
   8. allocateResidentOrders
   9. requestPayment
   10. trackDelivery
   11. reconcileOrder
   ↓
Deterministic Execution Layer & Core
   • PaymentAdapter (pre-auth check, spending cap lock, idempotency)
   • SupplierAdapter (anonymized bulk PO, zero resident PII, 12h SLA)
   • DeliverySimulator (deterministic FSM: PREPARING → DISPATCHED → OUT_FOR_DELIVERY → DELIVERED)
   • Three-Way Reconciliation (Community PO ↔ Resident Allocation ↔ Supplier Invoice)
   ↓
PostgreSQL Persistence (Prisma ORM)
   • ResidentOrder: PAID
   • Payment: SUCCESS (with MOCK-TXN- reference)
   • CommunityOrder: RECONCILED
   • Delivery: DELIVERED (with TRK-SIM- reference)
   • AuditEvent: operational audit trail committed
   ↓
Frontend Reflection
   • 6-stage operational view updated
   • /orders, /payments, /community reflect persisted PostgreSQL state
```

---

## Execution Layer Architecture

```text
                                USER
                                  │
                                  ▼
                         ┌─────────────────┐
                         │   Relay Agent   │
                         │   (Muse Spark)  │
                         └────────┬────────┘
                                  │
                            ModelProvider
                                  │
                     ┌────────────┴────────────┐
                     │                         │
            Meta Spark Provider       Spark Open Provider
             (Meta Model API)         (Open-Weight Endpoint)
                     │                         │
                     └────────────┬────────────┘
                                  │ (or MockModelProvider in dev/tests)
                             Tool Calls
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ Controlled Tools│
                         │  ToolRegistry   │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ Execution Layer │
                         │ExecutionService │
                         └────────┬────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
   Payment Adapter         Supplier Adapter       Delivery Simulator
 (MockPaymentProvider)   (MockSupplierProvider)   (DeliverySimulator)
          │                       │                       │
          ▼                       ▼                       ▼
  • Pre-auth check        • Anonymized bulk PO    • Deterministic FSM
  • Spending cap lock     • Zero resident PII     • PENDING → PREPARING
  • Idempotency safe      • 12h SLA enforcement   • → DISPATCHED
  • Audit ledger event    • Supplier confirmation • → OUT_FOR_DELIVERY
  • residentOrder → PAID  • communityOrder CONF.  • → DELIVERED
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │
                                  ▼
                      ┌─────────────────────────┐
                      │   Deterministic Core    │
                      │                         │
                      │  • Three-Way Reconcile  │
                      │  • Quantity Integrity   │
                      │  • Financial Match      │
                      │  • Audit Trail Ledger   │
                      └───────────┬─────────────┘
                                  │
                                  ▼
                         PostgreSQL / Prisma
```

---

## Execution Layer Modules

### 1. Payment Adapter (`backend/src/execution/payment/`)
- **`PaymentAdapter` Interface**: Pluggable contract for payment gateways (`execute`, `refund`, `verifyMandate`).
- **Authorization Invariant**: The adapter *never* decides authorization limits. The deterministic backend enforces `payment.amount <= mandate.maximumAmount` *before* invoking the adapter.
- **`MockPaymentProvider`**: Simulates payment processing, downtime simulation (`simulateUnavailable: true`), failure injection (`mode: 'failure'`), and idempotency tracking with unique transaction references (`MOCK-TXN-...`).
- **State Transition**: Successfully executed payments atomically update `ResidentOrder.status` to `PAID`.

### 2. Supplier Adapter (`backend/src/execution/supplier/`)
- **`SupplierAdapter` Interface**: Pluggable contract for supplier procurement (`submitPurchaseOrder`, `confirmOrder`, `getOrderStatus`).
- **Privacy & Anonymization Invariant**: Suppliers receive consolidated bulk demand with **zero resident PII** (no names, flat numbers, or individual payment details).
- **`MockSupplierProvider`**: Enforces delivery ETA assignments strictly within the 12-hour SLA window, supports capacity rejection simulation, and ensures purchase order idempotency (`MOCK-PO-...`).
- **State Transition**: Order confirmation transitions `CommunityOrder.status` to `SUPPLIER_CONFIRMED`.

### 3. Delivery Simulator (`backend/src/execution/delivery/`)
- **Deterministic Finite State Machine**: Enforces strict linear progression: `PENDING` → `PREPARING` → `DISPATCHED` → `OUT_FOR_DELIVERY` → `DELIVERED`.
- **State Protection**: Rejects backwards transitions, prevents skipping intermediate states (`INVALID_DELIVERY_TRANSITION`), and locks terminal status once `DELIVERED` (`TERMINAL_STATE_LOCKED`).
- **Tracking & Audit**: Generates unique tracking identifiers (`TRK-SIM-...`) and writes operational audit events at every lifecycle milestone.

### 4. Execution Orchestrator (`backend/src/execution/executionService.ts`)
- Coordinates the complete fulfillment pipeline via `executeFullProcurementCycle`:
  `Resident Order` → `Payment Settlement` → `Supplier Bulk PO` → `Delivery Simulator` → `Unit Allocation` → `Reconciliation`.
- Exposes typed REST endpoints under `/api/execution/` (`/payment`, `/supplier/order`, `/delivery/advance`, `/delivery/:communityOrderId`, `/full-cycle`).

---

## ModelProvider Abstraction

Relay abstracts model execution behind a clean interface (`backend/src/agent/model/ModelProvider.ts`), enabling seamless switching between cloud endpoints, open-weight deployments, and deterministic offline mocks.

| Provider | Identifier | Behavior & Configuration |
| :--- | :--- | :--- |
| **`MockModelProvider`** | `'mock'` | Fully deterministic, zero-cost, offline provider driving the 10-step autonomous procurement workflow. Supports custom scripted sequences for testing edge cases, failures, and recovery. |
| **`MetaSparkProvider`** | `'meta-spark'` (or `'meta'`) | Meta Spark API client. Configured via `META_API_KEY` and `META_SPARK_MODEL_ENDPOINT`. Fails gracefully with `META_API_KEY_MISSING` when unconfigured. |
| **`SparkOpenProvider`** | `'spark-open'` (or `'open'`) | Open-weight model deployment client (e.g. LLaMA/Spark local or hosted endpoint). Configured via `SPARK_OPEN_ENDPOINT`. Fails with `SPARK_OPEN_UNAVAILABLE` if endpoint is offline. |

Provider selection is controlled via the `MODEL_PROVIDER` environment variable (default: `mock`) or programmatically via `getModelProvider(name)`.

---

## Controlled Relay Tools

All tools are registered in a centralized `ToolRegistry` with strict Zod argument validation and schema generation compatible with OpenAI, Gemini, and Meta tool calling specifications.

| Tool Name | Parameters | Core Responsibility & Boundary |
| :--- | :--- | :--- |
| **`createRequest`** | `quantity`, `unit`, `deliveryAddress`, `productId?` | Validates resident request and records baseline procurement demand. |
| **`checkAuthorization`** | `requestedAmount`, `purpose?` | Verifies whether the requested amount is within the resident's active `PaymentMandate` limit. |
| **`aggregateDemand`** | `orderIds?` | Aggregates compatible society demand into **strictly anonymized** bulk groups for suppliers (`supplierFacingGroups`). Zero resident PII leaked. |
| **`discoverSuppliers`** | `productId`, `requestedQuantity`, `maxSlaHours` | Discovers authorized local suppliers and enforces hard constraints: Active status, catalog capability, service radius (Haversine), 12h SLA, and MOQ. |
| **`evaluateOffers`** | `productId`, `totalQuantity` | Ranks supplier quotes using transparent multi-factor scoring (Price 50%, Reliability 30%, SLA Turnaround 20%). Hard constraints applied first. |
| **`selectOffer`** | `productId`, `totalQuantity` | Deterministically selects the winning compliant supplier offer. |
| **`createCommunityOrder`** | `supplierId`, `deliveryDeadline`, `items`, `idempotencyKey?`, `contributingResidentOrderIds?` | Atomically persists `CommunityOrder` + line items, enforces 12h SLA, transitions contributing resident orders to `PROCURED`, guarantees idempotency. |
| **`allocateResidentOrders`** | `communityOrderId`, `allocations` | Allocates delivered community bulk quantities back to individual resident units. Fails immediately with `ALLOCATION_MISMATCH` if quantities do not sum exactly. |
| **`reconcileOrder`** | `communityOrderId` | Executes multi-dimensional quantity, financial invoice equality, product integrity, and society boundary reconciliation. |
| **`requestPayment`** | `residentOrderId`, `amount` | *Clean Stub*: Returns honest status `{ success: false, code: 'PAYMENT_EXECUTION_NOT_CONFIGURED' }`. |
| **`trackDelivery`** | `communityOrderId` | *Clean Stub*: Returns tracking initialization status for physical delivery simulator. |

---

## Relay Agent Orchestration & Safety Invariants

### 1. Authority Invariant
The agent reasons and orchestrates, but cannot mutate state outside tool boundaries. If an authorization check fails (`MANDATE_LIMIT_EXCEEDED`) or a supplier violates the 12h SLA, the agent cannot bypass or override the deterministic decision.

### 2. Autonomous Execution Without Artificial Interruption
When pre-authorized payment mandates exist, Relay does not pause to prompt the user at every intermediate step. It autonomously executes the 10-step procurement pipeline from request creation to final reconciliation.

### 3. Privacy Boundary
Supplier interactions are strictly anonymized:
- **Internal**: Tracks individual resident orders, quantities, and allocations (`Aarav -> 5kg`, `Riya -> 10kg`, `Kabir -> 8kg`).
- **Supplier-Facing**: Aggregated bulk demand (`23kg Rice`, `5L Cooking Oil`) with zero resident names, emails, flat numbers, or contact info.

### 4. Bounded Step Execution
The agent orchestrator enforces a configurable `maxSteps` limit (default: 20). If an agent enters an infinite loop, execution halts safely with `AGENT_STEP_LIMIT_EXCEEDED`.

### 5. Operational Audit Ledger
Every agent action is permanently recorded in `AuditEvent`:
- `AGENT_REQUEST_RECEIVED`
- `AGENT_TOOL_CALLED`
- `AGENT_TOOL_SUCCEEDED`
- `AGENT_TOOL_FAILED`
- `AGENT_WORKFLOW_COMPLETED`
- `AGENT_WORKFLOW_FAILED`
- **Safety Invariant**: Internal model chain-of-thought and speculative prompt tokens are never stored in the audit ledger.

---

## Development API Endpoints

### Agent Endpoint
- `POST /api/agent/run` — Triggers autonomous agent execution for a resident procurement request.
  ```json
  // Request
  {
    "residentId": "22222222-2222-4222-8222-222222222201",
    "societyId": "11111111-1111-4111-8111-111111111111",
    "message": "I need 5 litres of sunflower cooking oil delivered within 12 hours under my pre-authorized mandate."
  }

  // Response (200 OK)
  {
    "success": true,
    "runId": "a1b2c3d4-...",
    "completed": true,
    "totalSteps": 10,
    "response": "Relay autonomous procurement is complete. Your order for 5L Sunflower Cooking Oil has been secured through community demand pooling at Greenview Residency...",
    "steps": [...]
  }
  ```

### Deterministic Procurement Endpoints
Mounted at `/api/procurement/`:
- `POST /api/procurement/validate` — Validate resident request
- `POST /api/procurement/authorize` — Check payment mandate limits
- `POST /api/procurement/aggregate` — Pool society demand
- `POST /api/procurement/evaluate` — Filter & rank supplier quotes
- `POST /api/procurement/orders` — Atomically create community order
- `POST /api/procurement/reconcile` — Execute multi-dimensional reconciliation

---

## Getting Started

### 1. Database Setup & Migration

```bash
# Option A: Start with Docker Compose
docker compose up -d

# Option B: Using Homebrew (macOS)
brew services start postgresql@16
createdb relay_db
```

### 2. Backend Setup & Seeding

```bash
cd backend

npm install
cp .env.example .env

# Run Prisma migrations
npx prisma migrate dev

# Seed database with demo society, residents, suppliers, and aggregation-ready orders
npm run db:seed

# Run comprehensive test suite (66 tests across 4 suites)
npm test

# Start development server
npm run dev
# Running on http://localhost:4000
```

### 3. Frontend Setup

```bash
cd ../frontend

npm install
cp .env.example .env.local
npm test
npm run dev
# Running on http://localhost:3000
```

---

## Verification & Testing

### Complete Test Matrix: 113 Tests Passing (100%)

#### Backend Test Suite (`cd backend && npm test`)
Runs **94 tests** across 6 test suites:
- **End-to-End Integration Tests (`tests/e2e.test.ts` — 13 tests)**:
  - Full 11-step autonomous procurement from prompt to reconciliation via `POST /api/agent/run`
  - Canonical demo scenario: 5L sunflower cooking oil within 12h SLA
  - Mandate authorization boundaries (valid, exact ceiling, exceeded ceiling rejection)
  - Demand aggregation and zero resident PII privacy verification
  - Supplier hard constraints & deterministic multi-factor offer ranking
  - Resident allocation quantity and financial balance invariants
  - Payment idempotency preventing double charges on repeated requests
  - Delivery FSM progression and terminal state lock protection
  - Three-way match reconciliation and PostgreSQL database persistence
  - Portal query persistence (`/api/portal/orders`, `/payments`, `/community`)
- **Agent Layer Tests (`tests/agent.test.ts` — 21 tests)**:
  - ModelProvider abstraction (MockModelProvider text & tool generation)
  - Custom scripted sequence for agent failure/recovery simulation
  - MetaSparkProvider failure on missing API key (`META_API_KEY_MISSING`)
  - SparkOpenProvider failure on unreachable endpoint (`SPARK_OPEN_UNAVAILABLE`)
  - `getModelProvider` factory selection by provider name and environment
  - Tool registration and retrieval in `ToolRegistry`
  - ToolDefinition OpenAI/Meta JSON schema compliance
  - Unknown tool rejection (`UNKNOWN_TOOL`)
  - Strict Zod argument validation (missing fields, negative quantities, invalid enums)
  - Honest stubs for future phases (`requestPayment`, `trackDelivery`)
  - `createRequest` tool execution with deterministic database persistence
  - `checkAuthorization` tool verifying mandate limits
  - `aggregateDemand` tool strictly anonymizing supplier-facing data
  - `discoverSuppliers` tool enforcing 12h SLA and service radius constraints
  - Agent orchestrator bounded loop termination (`finishReason === 'stop'`)
  - Step limit enforcement (`AGENT_STEP_LIMIT_EXCEEDED`)
  - Tool execution error resilience and recovery
  - Operational audit ledger recording without leaking model thoughts
  - Full 10-step autonomous end-to-end procurement workflow from prompt to reconciliation
  - API endpoint: 400 validation on missing prompt
  - API endpoint: 200 execution of autonomous agent run via HTTP
- **Execution Layer Tests (`tests/execution.test.ts` — 15 tests)**:
  - Pre-authorized payment execution within mandate spending limits
  - Mandate cap protection rejecting unauthorized amounts (`MANDATE_LIMIT_EXCEEDED`)
  - Simulated payment provider decline/failure handling
  - Idempotent payment retries preventing duplicate transactions
  - Gateway downtime simulation (`PAYMENT_GATEWAY_UNAVAILABLE`)
  - Anonymized bulk PO submission and confirmation (zero resident PII)
  - Simulated supplier capacity rejection handling
  - Bulk purchase order idempotency
  - Deterministic delivery state machine progression (`PREPARING` → `DISPATCHED` → `OUT_FOR_DELIVERY` → `DELIVERED`)
  - Illegal jump and backwards transition rejection (`INVALID_DELIVERY_TRANSITION`)
  - Terminal state lock preventing modification of delivered orders (`TERMINAL_STATE_LOCKED`)
  - End-to-end autonomous full execution cycle with multi-factor reconciliation (0 quantity & financial discrepancies)
  - HTTP REST endpoints for payment, supplier PO, and delivery tracking
- **Procurement Engine Tests (`tests/procurement.test.ts` — 32 tests)**:
  - Request validation, authorization, demand pooling, supplier constraints, offer evaluation, atomic orders, resident allocation, reconciliation, state machine, idempotency, Decimal precision, audit logging.
- **Domain Model Tests (`tests/domain.test.ts` — 10 tests)**:
  - Model invariants, relations, privacy boundaries, Decimal money/quantity fields, seed idempotence.
- **Health & Infrastructure Tests (`tests/health.test.ts` — 3 tests)**:
  - Health endpoint, database reachability check, 404 handler.

#### Frontend Test Suite (`cd frontend && npm test`)
Runs **19 tests** across 2 test suites:
- **Milestone 6 Components (`__tests__/milestone6-components.test.tsx` — 15 tests)**:
  - `RequestComposer`: Textarea, prompt chips, pre-authorized spending badge, `⌘+Enter` shortcut, loading state, empty input validation.
  - `ActivityTimeline`: Operational event rendering without internal prompts or raw JSON, active step spinner, completed status.
  - `OfferCard`: Supplier identity, pricing, unit cost, 99% reliability score, 12h SLA badge, deterministic decision factors ("Why Relay chose this").
  - `PaymentStatus`: Pre-authorized mandate spending breakdown, transaction reference, autonomous settlement verification, failure/retry handling.
  - `DeliveryTracker`: Sequential fulfillment progression FSM (`PREPARING` → `DISPATCHED` → `OUT_FOR_DELIVERY` → `DELIVERED`), tracking codes, simulated advance trigger.
  - `ReconciliationSummary`: 3-way match integrity, 0 discrepancy indicators, collective savings percentage, allocation table, immutable ledger audit events.
- **UI & API Integration (`__tests__/ui-and-api.test.tsx` — 4 tests)**:
  - UI primitives (Button, Card, Badge) rendering and variant states.
  - Typed API client contract verification.

### Strict Type Checking & Production Builds
```bash
# Backend TypeScript (Strict Mode)
cd backend && npm run build  # 0 errors

# Frontend Production Build
cd ../frontend && npm run build  # 10/10 static pages optimized
```

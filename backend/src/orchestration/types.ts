/**
 * Authoritative lifecycle status of a Relay autonomous procurement workflow.
 */
export type WorkflowStatus =
  | 'DRAFT'
  | 'RECEIVED'
  | 'UNDERSTANDING'
  | 'AWAITING_CLARIFICATION'
  | 'DEMAND_CREATED'
  | 'DISCOVERING_SUPPLIERS'
  | 'QUALIFYING_SUPPLIERS'
  | 'REQUESTING_QUOTES'
  | 'WAITING_FOR_QUOTES'
  | 'NEGOTIATING'
  | 'SELECTING_SUPPLIER'
  | 'COMMITTING_PROCUREMENT'
  | 'AUTHORIZING_PAYMENT'
  | 'EXECUTING_PAYMENT'
  | 'FULFILLING'
  | 'DELIVERING'
  | 'VERIFYING_FULFILLMENT'
  | 'ALLOCATING_RESIDENT_DEMAND'
  | 'RECONCILING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

/**
 * Stable high-level stage representation.
 */
export type WorkflowStage =
  | 'UNDERSTAND'
  | 'DISCOVER'
  | 'QUALIFY'
  | 'QUOTE'
  | 'NEGOTIATE'
  | 'SELECT'
  | 'COMMIT'
  | 'PAY'
  | 'FULFILL'
  | 'VERIFY'
  | 'ALLOCATE'
  | 'RECONCILE'
  | 'COMPLETE';

/**
 * Structured classification of workflow errors to drive deterministic recovery policies.
 */
export type FailureClassification =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'WAITING'
  | 'USER_ACTION_REQUIRED'
  | 'SYSTEM_BLOCKED';

/**
 * Location-agnostic runtime geographic and delivery context.
 */
export interface WorkflowLocation {
  address: string;
  latitude: number;
  longitude: number;
  city?: string;
  radiusMeters?: number;
}

/**
 * Structured output of natural language intent understanding.
 */
/**
 * One validated procurement line item. Catalog items carry the deterministic
 * catalog product ID; validated open-world items carry none (identitySource
 * 'open-world'). Product identity never comes from model-supplied identifiers.
 */
export interface WorkflowLineItem {
  productId?: string;
  productName: string;
  quantity: number;
  unit: string;
  identitySource?: 'catalog' | 'open-world';
  /** Verbatim stated semantic cues; descriptive evidence only. */
  brand?: string;
  packaging?: string;
  packSize?: string;
  priceCue?: string;
  variant?: string;
}

export interface ParsedResidentIntent {
  rawText: string;
  productName: string;
  quantity: number;
  unit: string;
  brand?: string;
  /**
   * Verbatim stated semantic cues from intent extraction. Descriptive
   * evidence only — never authoritative procurement facts.
   */
  packaging?: string;
  packSize?: string;
  priceCue?: string;
  variant?: string;
  constraints?: string[];
  maxBudget?: number;
  isAmbiguous: boolean;
  clarificationQuestion?: string;
  /**
   * Validated multi-item decomposition when the entry path resolved one.
   * Absent for legacy single-item parses. Downstream stages use this only
   * when it carries MORE than one item; single-item behavior is preserved
   * exactly from the legacy productName/quantity/unit fields.
   */
  items?: WorkflowLineItem[];
}

/**
 * Authoritative entity references linking the workflow to backend domain records.
 * Strictly decoupled from internal AI chain-of-thought.
 */
export interface WorkflowEntities {
  residentOrderId?: string;
  residentReference: string;
  societyReference: string;
  supplierCandidateIds?: string[];
  qualifiedSupplierIds?: string[];
  rfqId?: string;
  receivedQuoteIds?: string[];
  negotiatedQuoteIds?: string[];
  selectedQuoteId?: string;
  commitmentId?: string;
  purchaseOrderIds?: string[];
  paymentId?: string;
  fulfillmentOrderIds?: string[];
  deliveryTrackingCodes?: string[];
  allocationSummaryId?: string;
  reconciliationId?: string;
}

/**
 * Top-level Workflow Aggregate representing the complete autonomous procurement lifecycle.
 */
export interface RelayWorkflow {
  id: string;
  residentReference: string;
  societyReference: string;
  requestText: string;
  location: WorkflowLocation;
  status: WorkflowStatus;
  currentStage: WorkflowStage;
  workflowVersion: number;
  intent?: ParsedResidentIntent;
  /**
   * Validated line items resolved at the workflow entry boundary (14.2
   * stack). Consumed by UNDERSTAND; absent for direct-orchestrator callers,
   * which keep the legacy single-item parse path unchanged.
   */
  resolvedItems?: WorkflowLineItem[];
  /**
   * User-stated fulfillment deadline in hours, recorded verbatim from the
   * validated intent when the request named one. Relay's operational
   * guarantee stays 12h; this field exists so the UI can disclose the
   * requested-vs-guaranteed SLA honestly instead of dropping the request.
   */
  requestedDeadlineHours?: number;
  entities: WorkflowEntities;
  stages: WorkflowStageProgress[];
  failureReason?: string;
  failureClassification?: FailureClassification;
  retryCount: number;
  isPaused: boolean;
  pauseReason?: string;
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Persistent snapshot of workflow state after completing an authoritative stage.
 */
export interface WorkflowCheckpoint {
  id: string;
  workflowId: string;
  stage: WorkflowStage;
  status: WorkflowStatus;
  entities: WorkflowEntities;
  snapshot: RelayWorkflow;
  stateSnapshot?: Record<string, unknown>;
  workflowVersion: number;
  timestamp: Date;
}

/**
 * High-level progress milestone for resident/frontend tracking.
 */
export interface WorkflowStageProgress {
  stage: WorkflowStage;
  label: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  completedAt?: Date;
  notes?: string;
}

/**
 * Input to initialize a new autonomous workflow.
 */
export interface CreateWorkflowInput {
  requestText: string;
  residentReference?: string;
  societyReference?: string;
  location?: Partial<WorkflowLocation>;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  resolvedItems?: WorkflowLineItem[];
  requestedDeadlineHours?: number;
}

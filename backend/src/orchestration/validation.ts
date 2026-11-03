import { CreateWorkflowInput, RelayWorkflow, WorkflowStage } from './types';

export class WorkflowValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Workflow validation failed: ${errors.join('; ')}`);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Validates initial workflow creation parameters.
 */
export function validateCreateWorkflowInput(input: CreateWorkflowInput): void {
  const errors: string[] = [];

  if (!input.requestText || input.requestText.trim().length === 0) {
    errors.push('EMPTY_REQUEST: Request text cannot be empty');
  }

  if (input.requestText) {
    const negativeQtyMatch = input.requestText.match(/(?:^|\s)-[0-9]+(?:\.[0-9]+)?(?:\s|$)/);
    if (negativeQtyMatch) {
      errors.push('INVALID_QUANTITY: Negative quantity requested');
    }
  }

  if (input.location) {
    if (input.location.latitude !== undefined && (input.location.latitude < -90 || input.location.latitude > 90)) {
      errors.push(`INVALID_COORDINATES: INVALID_LATITUDE: Latitude must be between -90 and 90. Received ${input.location.latitude}`);
    }
    if (input.location.longitude !== undefined && (input.location.longitude < -180 || input.location.longitude > 180)) {
      errors.push(`INVALID_COORDINATES: INVALID_LONGITUDE: Longitude must be between -180 and 180. Received ${input.location.longitude}`);
    }
  }

  if (errors.length > 0) {
    throw new WorkflowValidationError(errors);
  }
}

/**
 * Validates preconditions required to legally enter a target workflow stage.
 * Strictly prevents state jumping or progressing without authoritative backend entity references.
 */
export function validateStagePreconditions(
  workflow: RelayWorkflow,
  targetStage: WorkflowStage
): void {
  const errors: string[] = [];
  const { entities } = workflow;

  switch (targetStage) {
    case 'UNDERSTAND':
      // Always permitted as entry stage
      break;

    case 'DISCOVER':
      if (!workflow.intent || workflow.intent.isAmbiguous) {
        errors.push('MISSING_PRECONDITION: Valid, unambiguous resident intent is required before supplier discovery');
      }
      break;

    case 'QUALIFY':
      if (!entities.supplierCandidateIds || entities.supplierCandidateIds.length === 0) {
        errors.push('MISSING_PRECONDITION: Discovered supplier candidates are required before qualification');
      }
      break;

    case 'QUOTE':
      if (!entities.qualifiedSupplierIds || entities.qualifiedSupplierIds.length === 0) {
        errors.push('MISSING_PRECONDITION: At least one qualified supplier is required before dispatching RFQs');
      }
      break;

    case 'NEGOTIATE':
    case 'SELECT':
      if (!entities.receivedQuoteIds || entities.receivedQuoteIds.length === 0) {
        errors.push('MISSING_PRECONDITION: Normalized supplier quotes are required for negotiation/selection');
      }
      break;

    case 'COMMIT':
      if (!entities.selectedQuoteId) {
        errors.push('MISSING_PRECONDITION: A validated supplier quote selection is required before procurement commitment');
      }
      break;

    case 'PAY':
      if (!entities.commitmentId) {
        errors.push('MISSING_PRECONDITION: Binding procurement commitment must exist before authorizing payment');
      }
      break;

    case 'FULFILL':
      if (!entities.paymentId) {
        errors.push('MISSING_PRECONDITION: Payment must succeed before creating fulfillment orders');
      }
      break;

    case 'VERIFY':
      if (!entities.fulfillmentOrderIds || entities.fulfillmentOrderIds.length === 0) {
        errors.push('MISSING_PRECONDITION: Fulfillment orders must exist before verification');
      }
      break;

    case 'ALLOCATE':
      if (workflow.currentStage !== 'VERIFY' && workflow.currentStage !== 'ALLOCATE') {
        errors.push('MISSING_PRECONDITION: Fulfillment verification must be completed before entering ALLOCATE stage');
      }
      if (!entities.fulfillmentOrderIds || entities.fulfillmentOrderIds.length === 0) {
        errors.push('MISSING_PRECONDITION: Verified fulfillment orders must exist before resident allocation');
      }
      break;

    case 'RECONCILE':
      if (!entities.allocationSummaryId) {
        errors.push('MISSING_PRECONDITION: Resident allocation must be finalized before reconciliation');
      }
      break;

    case 'COMPLETE':
      validateCompletionInvariants(workflow);
      break;
  }

  if (errors.length > 0) {
    throw new WorkflowValidationError(errors);
  }
}

/**
 * Validates Section 59 Completion Invariants:
 * Guarantees all 7 authoritative pillars and 4-pillar reconciliation are satisfied before terminal COMPLETED state.
 */
export function validateCompletionInvariants(workflow: RelayWorkflow): void {
  const errors: string[] = [];
  const { entities } = workflow;

  // Pillar 1: Valid Resident Order
  if (!entities.residentOrderId) {
    errors.push('MISSING_RESIDENT_ORDER: Resident order identifier must be populated');
  }

  // Pillar 2: Valid Selected Quote
  if (!entities.selectedQuoteId) {
    errors.push('MISSING_SELECTED_QUOTE: Winner quote reference must be linked');
  }

  // Pillar 3: Valid Procurement Commitment & Purchase Orders
  if (!entities.commitmentId) {
    errors.push('MISSING_COMMITMENT: Procurement commitment reference must be linked');
  }
  if (!entities.purchaseOrderIds || entities.purchaseOrderIds.length === 0) {
    errors.push('MISSING_PURCHASE_ORDERS: At least one purchase order must be issued');
  }

  // Pillar 4: Authorized Successful Payment
  if (!entities.paymentId) {
    errors.push('MISSING_PAYMENT: Authoritative payment reference must be linked');
  }

  // Pillar 5: Verified Operational Fulfillment
  if (!entities.fulfillmentOrderIds || entities.fulfillmentOrderIds.length === 0) {
    errors.push('MISSING_FULFILLMENT_ORDERS: Operational fulfillment order must exist');
  }

  // Pillar 6: Resident Monetary & Quantity Allocation
  if (!entities.allocationSummaryId) {
    errors.push('MISSING_ALLOCATION_SUMMARY: Resident allocation summary must be finalized');
  }

  // Pillar 7: 4-Pillar Financial & Quantity Reconciliation
  if (!entities.reconciliationId) {
    errors.push('MISSING_RECONCILIATION: 4-pillar reconciliation result must exist');
  }

  if (errors.length > 0) {
    throw new WorkflowValidationError(errors);
  }
}

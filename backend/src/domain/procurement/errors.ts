import { AppError } from '../errors';

export const ProcurementErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  RESIDENT_NOT_FOUND: 'RESIDENT_NOT_FOUND',
  RESIDENT_INACTIVE: 'RESIDENT_INACTIVE',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  UNIT_MISMATCH: 'UNIT_MISMATCH',
  MANDATE_NOT_FOUND: 'MANDATE_NOT_FOUND',
  MANDATE_INACTIVE: 'MANDATE_INACTIVE',
  MANDATE_LIMIT_EXCEEDED: 'MANDATE_LIMIT_EXCEEDED',
  SOCIETY_MISMATCH: 'SOCIETY_MISMATCH',
  NO_ELIGIBLE_SUPPLIER: 'NO_ELIGIBLE_SUPPLIER',
  SUPPLIER_INACTIVE: 'SUPPLIER_INACTIVE',
  SLA_VIOLATION: 'SLA_VIOLATION',
  MOQ_NOT_MET: 'MOQ_NOT_MET',
  SERVICE_AREA_EXCEEDED: 'SERVICE_AREA_EXCEEDED',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  OFFER_INVALID: 'OFFER_INVALID',
  OFFER_NOT_ELIGIBLE: 'OFFER_NOT_ELIGIBLE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  ALLOCATION_MISMATCH: 'ALLOCATION_MISMATCH',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  DUPLICATE_OPERATION: 'DUPLICATE_OPERATION',
  SELECTION_MISMATCH: 'SELECTION_MISMATCH',
} as const;

export type ProcurementErrorCodeType =
  (typeof ProcurementErrorCode)[keyof typeof ProcurementErrorCode];

const HTTP_STATUS_MAP: Record<ProcurementErrorCodeType, number> = {
  [ProcurementErrorCode.INVALID_REQUEST]: 400,
  [ProcurementErrorCode.RESIDENT_NOT_FOUND]: 404,
  [ProcurementErrorCode.RESIDENT_INACTIVE]: 403,
  [ProcurementErrorCode.PRODUCT_NOT_FOUND]: 404,
  [ProcurementErrorCode.INVALID_QUANTITY]: 400,
  [ProcurementErrorCode.UNIT_MISMATCH]: 400,
  [ProcurementErrorCode.MANDATE_NOT_FOUND]: 404,
  [ProcurementErrorCode.MANDATE_INACTIVE]: 403,
  [ProcurementErrorCode.MANDATE_LIMIT_EXCEEDED]: 403,
  [ProcurementErrorCode.SOCIETY_MISMATCH]: 400,
  [ProcurementErrorCode.NO_ELIGIBLE_SUPPLIER]: 422,
  [ProcurementErrorCode.SUPPLIER_INACTIVE]: 422,
  [ProcurementErrorCode.SLA_VIOLATION]: 422,
  [ProcurementErrorCode.MOQ_NOT_MET]: 422,
  [ProcurementErrorCode.SERVICE_AREA_EXCEEDED]: 422,
  [ProcurementErrorCode.PRODUCT_UNAVAILABLE]: 422,
  [ProcurementErrorCode.OFFER_INVALID]: 400,
  [ProcurementErrorCode.OFFER_NOT_ELIGIBLE]: 422,
  [ProcurementErrorCode.INVALID_STATE_TRANSITION]: 409,
  [ProcurementErrorCode.ALLOCATION_MISMATCH]: 422,
  [ProcurementErrorCode.RECONCILIATION_FAILED]: 422,
  [ProcurementErrorCode.DUPLICATE_OPERATION]: 409,
  [ProcurementErrorCode.SELECTION_MISMATCH]: 400,
};

export class ProcurementError extends AppError {
  constructor(
    code: ProcurementErrorCodeType,
    message: string,
    details?: unknown
  ) {
    const statusCode = HTTP_STATUS_MAP[code] || 400;
    super(message, statusCode, code, details);
  }
}


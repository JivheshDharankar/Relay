export type SupplierResponseErrorCode =
  | 'RFQ_NOT_FOUND'
  | 'SUPPLIER_MISMATCH'
  | 'RFQ_INACTIVE'
  | 'DUPLICATE_RESPONSE'
  | 'MALFORMED_INPUT'
  | 'PROVIDER_ERROR';

export class SupplierResponseError extends Error {
  public readonly code: SupplierResponseErrorCode;
  public readonly details?: unknown;

  constructor(code: SupplierResponseErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'SupplierResponseError';
    this.code = code;
    this.details = details;
  }
}


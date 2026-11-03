export type SupplierContactErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_SENDER'
  | 'MISSING_RECIPIENT'
  | 'REQUEST_TIMEOUT'
  | 'AUTH_ERROR'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'UNSUPPORTED_METHOD';

export class SupplierContactError extends Error {
  public readonly code: SupplierContactErrorCode;
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(
    code: SupplierContactErrorCode,
    message: string,
    status?: number,
    details?: unknown
  ) {
    super(message);
    this.name = 'SupplierContactError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}


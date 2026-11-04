import { Prisma } from '@prisma/client';

export type DecimalLike = Prisma.Decimal | number | string;

/**
 * Coerces a required numeric value or string safely into a Prisma.Decimal.
 * STRICTLY REJECTS undefined, null, empty strings, NaN, and invalid numeric representations.
 * Never silently defaults missing financial values to 0.
 */
export function toDecimal(val: DecimalLike): Prisma.Decimal {
  if (val === undefined || val === null) {
    throw new Error('Cannot convert undefined or null to Decimal: required financial value is missing');
  }
  if (val instanceof Prisma.Decimal) {
    if (val.isNaN()) {
      throw new Error('Invalid numeric value for Decimal: NaN');
    }
    return val;
  }
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) {
      throw new Error(`Invalid numeric value for Decimal: ${val}`);
    }
    return new Prisma.Decimal(val.toString());
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      throw new Error('Cannot convert empty string to Decimal: required financial value is missing');
    }
    try {
      const d = new Prisma.Decimal(trimmed);
      if (d.isNaN()) {
        throw new Error(`Invalid numeric string for Decimal: "${val}"`);
      }
      return d;
    } catch {
      throw new Error(`Invalid numeric string for Decimal: "${val}"`);
    }
  }
  throw new Error(`Unsupported value type for Decimal: ${typeof val}`);
}

/**
 * Coerces an explicitly optional financial value to a Prisma.Decimal.
 * Only use for business fields where absence explicitly denotes zero (e.g. optional discounts or non-assessed delivery fees).
 * Still strictly validates that if a value is present, it is a valid non-empty numeric representation.
 */
export function toDecimalOptional(
  val?: DecimalLike | null,
  defaultValue: DecimalLike = 0
): Prisma.Decimal {
  if (val === undefined || val === null) {
    return toDecimal(defaultValue);
  }
  return toDecimal(val);
}

/**
 * Validates that an amount is non-negative (>= 0).
 * Throws if negative or invalid.
 */
export function toNonNegativeDecimal(val: DecimalLike, fieldName = 'Amount'): Prisma.Decimal {
  const d = toDecimal(val);
  if (d.isNegative()) {
    throw new Error(`${fieldName} cannot be negative: ${d.toString()}`);
  }
  return d;
}

/**
 * Validates that an amount is strictly positive (> 0).
 * Throws if zero, negative, or invalid.
 */
export function toPositiveDecimal(val: DecimalLike, fieldName = 'Amount'): Prisma.Decimal {
  const d = toDecimal(val);
  if (!d.greaterThan(0)) {
    throw new Error(`${fieldName} must be strictly positive: ${d.toString()}`);
  }
  return d;
}

/**
 * Deterministic Decimal addition.
 */
export function addDecimals(...vals: DecimalLike[]): Prisma.Decimal {
  if (vals.length === 0) return new Prisma.Decimal(0);
  return vals.reduce<Prisma.Decimal>(
    (acc, curr) => acc.plus(toDecimal(curr)),
    new Prisma.Decimal(0)
  );
}

/**
 * Deterministic Decimal subtraction: a - b
 */
export function subtractDecimals(a: DecimalLike, b: DecimalLike): Prisma.Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

/**
 * Deterministic Decimal multiplication: a * b
 */
export function multiplyDecimals(a: DecimalLike, b: DecimalLike): Prisma.Decimal {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * Deterministic Decimal division: a / b
 */
export function divideDecimals(a: DecimalLike, b: DecimalLike): Prisma.Decimal {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    throw new Error('Division by zero encountered in Decimal arithmetic');
  }
  return toDecimal(a).dividedBy(divisor);
}

/**
 * Formats/rounds money to standard 2 decimal places (paise/cents).
 */
export function roundMoney(val: DecimalLike): Prisma.Decimal {
  return toDecimal(val).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Formats/rounds quantity to 4 decimal places (precise sub-kg/sub-litre precision).
 */
export function roundQuantity(val: DecimalLike): Prisma.Decimal {
  return toDecimal(val).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Compares two Decimals for exact equality.
 */
export function isDecimalEqual(a: DecimalLike, b: DecimalLike): boolean {
  return toDecimal(a).equals(toDecimal(b));
}

/**
 * Returns true if a < b.
 */
export function isLessThan(a: DecimalLike, b: DecimalLike): boolean {
  return toDecimal(a).lessThan(toDecimal(b));
}

/**
 * Returns true if a <= b.
 */
export function isLessThanOrEqual(a: DecimalLike, b: DecimalLike): boolean {
  return toDecimal(a).lessThanOrEqualTo(toDecimal(b));
}

/**
 * Returns true if a > b.
 */
export function isGreaterThan(a: DecimalLike, b: DecimalLike): boolean {
  return toDecimal(a).greaterThan(toDecimal(b));
}

/**
 * Returns true if a >= b.
 */
export function isGreaterThanOrEqual(a: DecimalLike, b: DecimalLike): boolean {
  return toDecimal(a).greaterThanOrEqualTo(toDecimal(b));
}

/**
 * Returns true if a > 0.
 */
export function isPositive(a: DecimalLike): boolean {
  return toDecimal(a).greaterThan(0);
}


import { Prisma } from '@prisma/client';

export type DecimalLike = Prisma.Decimal | number | string | undefined | null;

/**
 * Coerces a numeric value or string safely into a Prisma.Decimal.
 * Treats undefined or null as 0. Never allows NaN or infinite values.
 */
export function toDecimal(val?: DecimalLike | null): Prisma.Decimal {
  if (val === undefined || val === null) {
    return new Prisma.Decimal(0);
  }
  if (val instanceof Prisma.Decimal) {
    return val;
  }
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) {
      throw new Error(`Invalid numeric value for Decimal: ${val}`);
    }
    return new Prisma.Decimal(val.toString());
  }
  return new Prisma.Decimal(val);
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


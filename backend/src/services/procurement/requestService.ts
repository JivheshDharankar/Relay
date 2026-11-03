import { prisma } from '../../config/prisma';
import {
  ProcurementRequestInput,
  ValidatedProcurementRequest,
  ProcurementError,
  ProcurementErrorCode,
  toDecimal,
  isPositive,
  multiplyDecimals,
  roundMoney,
} from '../../domain/procurement';
import { AuditEventType, ResidentStatus } from '@prisma/client';

export class RequestService {
  /**
   * Deterministically validates a resident procurement request before any business operation.
   */
  public async validateRequest(
    input: ProcurementRequestInput
  ): Promise<ValidatedProcurementRequest> {
    // 1. Quantity validation
    let qtyDecimal;
    try {
      qtyDecimal = toDecimal(input.quantity);
    } catch {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_QUANTITY,
        'Quantity must be a valid numeric Decimal'
      );
    }

    if (!isPositive(qtyDecimal)) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_QUANTITY,
        'Quantity must be strictly greater than zero'
      );
    }

    // 2. Society existence check
    const society = await prisma.society.findUnique({
      where: { id: input.societyId },
    });
    if (!society) {
      throw new ProcurementError(
        ProcurementErrorCode.SOCIETY_MISMATCH,
        `Society with ID ${input.societyId} does not exist`
      );
    }

    // 3. Resident check & status
    const resident = await prisma.resident.findUnique({
      where: { id: input.residentId },
    });
    if (!resident) {
      throw new ProcurementError(
        ProcurementErrorCode.RESIDENT_NOT_FOUND,
        `Resident with ID ${input.residentId} does not exist`
      );
    }

    if (resident.status !== ResidentStatus.ACTIVE) {
      throw new ProcurementError(
        ProcurementErrorCode.RESIDENT_INACTIVE,
        `Resident ${resident.name} is inactive and cannot place procurement requests`
      );
    }

    // 4. Resident-Society belonging check
    if (resident.societyId !== input.societyId) {
      throw new ProcurementError(
        ProcurementErrorCode.SOCIETY_MISMATCH,
        `Resident ${resident.name} belongs to society ${resident.societyId}, not ${input.societyId}`
      );
    }

    // 5. Product check & Unit match
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      include: {
        supplierProducts: {
          orderBy: { basePrice: 'asc' },
        },
      },
    });
    if (!product) {
      throw new ProcurementError(
        ProcurementErrorCode.PRODUCT_NOT_FOUND,
        `Product with ID ${input.productId} does not exist`
      );
    }

    if (product.unit !== input.unit) {
      throw new ProcurementError(
        ProcurementErrorCode.UNIT_MISMATCH,
        `Unit mismatch for ${product.name}: requested ${input.unit}, but product requires ${product.unit}`
      );
    }

    // 6. Idempotency duplicate check
    if (input.idempotencyKey) {
      const existing = await prisma.residentOrder.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        throw new ProcurementError(
          ProcurementErrorCode.DUPLICATE_OPERATION,
          `Request with idempotency key ${input.idempotencyKey} has already been processed`
        );
      }
    }

    // Determine baseline pricing from catalog matching MOQ or lowest available
    const matchingSupplierProduct =
      product.supplierProducts.find((sp) => Number(sp.moq) <= Number(qtyDecimal)) ??
      product.supplierProducts[0];

    const unitPrice = matchingSupplierProduct?.basePrice ?? toDecimal('100.00');
    const totalPrice = roundMoney(multiplyDecimals(qtyDecimal, unitPrice));

    return {
      residentId: resident.id,
      societyId: society.id,
      productId: product.id,
      productName: product.name,
      quantity: qtyDecimal,
      unit: product.unit,
      unitPrice,
      totalPrice,
      deliveryAddress:
        input.deliveryAddress ??
        (resident.flatNumber
          ? `Flat ${resident.flatNumber}, ${society.name}, ${society.city}`
          : society.address),
      idempotencyKey: input.idempotencyKey,
      requestedDeadline: input.requestedDeadline,
    };
  }

  /**
   * Persists a validated resident request into a ResidentOrder and records AuditEvent.
   */
  public async createResidentOrder(
    validated: ValidatedProcurementRequest
  ) {
    const order = await prisma.residentOrder.create({
      data: {
        idempotencyKey: validated.idempotencyKey,
        residentId: validated.residentId,
        societyId: validated.societyId,
        totalAmount: validated.totalPrice,
        currency: 'INR',
        deliveryAddress: validated.deliveryAddress,
        items: {
          create: {
            productId: validated.productId,
            quantity: validated.quantity,
            unitPrice: validated.unitPrice,
            totalPrice: validated.totalPrice,
          },
        },
      },
      include: {
        items: {
          include: { product: true },
        },
      },
    });

    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.REQUEST_CREATED,
        actor: `resident:${validated.residentId}`,
        entityType: 'ResidentOrder',
        entityId: order.id,
        metadata: {
          societyId: validated.societyId,
          productId: validated.productId,
          productName: validated.productName,
          quantity: Number(validated.quantity),
          unit: validated.unit,
          totalPrice: Number(validated.totalPrice),
        },
      },
    });

    return order;
  }
}

export const requestService = new RequestService();


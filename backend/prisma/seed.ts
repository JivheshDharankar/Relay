import { PrismaClient, ProductUnit, ResidentStatus, SupplierStatus, ResidentOrderStatus, PaymentMandateStatus, AuditEventType } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// STABLE DEMO IDENTIFIERS (Ensures complete determinism & idempotence)
// ---------------------------------------------------------------------------

export const SEED_IDS = {
  society: {
    greenview: '11111111-1111-4111-8111-111111111111',
  },
  residents: {
    aarav: '22222222-2222-4222-8222-222222222201',
    riya: '22222222-2222-4222-8222-222222222202',
    kabir: '22222222-2222-4222-8222-222222222203',
    ananya: '22222222-2222-4222-8222-222222222204',
    neel: '22222222-2222-4222-8222-222222222205',
    meera: '22222222-2222-4222-8222-222222222206',
  },
  suppliers: {
    sahyadri: '33333333-3333-4333-8333-333333333301',
    deccan: '33333333-3333-4333-8333-333333333302',
    puneBulk: '33333333-3333-4333-8333-333333333303',
  },
  products: {
    rice: '44444444-4444-4444-8444-444444444401',
    wheat: '44444444-4444-4444-8444-444444444402',
    cookingOil: '44444444-4444-4444-8444-444444444403',
    detergent: '44444444-4444-4444-8444-444444444404',
    cleaningLiquid: '44444444-4444-4444-8444-444444444405',
    sugar: '44444444-4444-4444-8444-444444444406',
    groundnut: '44444444-4444-4444-8444-444444444407',
    toothbrushes: '44444444-4444-4444-8444-444444444408',
    bananas: '44444444-4444-4444-8444-444444444409',
    oranges: '44444444-4444-4444-8444-444444444410',
    apple: '44444444-4444-4444-8444-444444444411',
    bajra: '44444444-4444-4444-8444-444444444412',
    darkChocolate: '44444444-4444-4444-8444-444444444413',
    maida: '44444444-4444-4444-8444-444444444414',
    ambemoharRice: '44444444-4444-4444-8444-444444444415',
  },
  mandates: {
    aarav: '55555555-5555-4555-8555-555555555501',
    riya: '55555555-5555-4555-8555-555555555502',
    kabir: '55555555-5555-4555-8555-555555555503',
    ananya: '55555555-5555-4555-8555-555555555504',
    neel: '55555555-5555-4555-8555-555555555505',
    meera: '55555555-5555-4555-8555-555555555506',
  },
  residentOrders: {
    orderAarav: '66666666-6666-4666-8666-666666666601',
    orderRiya: '66666666-6666-4666-8666-666666666602',
    orderKabir: '66666666-6666-4666-8666-666666666603',
    orderAnanya: '66666666-6666-4666-8666-666666666604',
  },
  orderItems: {
    aaravRice: '77777777-7777-4777-8777-777777777701',
    aaravOil: '77777777-7777-4777-8777-777777777702',
    riyaRice: '77777777-7777-4777-8777-777777777703',
    riyaOil: '77777777-7777-4777-8777-777777777704',
    kabirRice: '77777777-7777-4777-8777-777777777705',
    ananyaWheat: '77777777-7777-4777-8777-777777777706',
    ananyaDetergent: '77777777-7777-4777-8777-777777777707',
  },
};

export async function seed(client: PrismaClient = prisma) {
  // eslint-disable-next-line no-console
  console.log('[Seed] Starting idempotent database seed for Relay Milestone 2...');

  // Clean up transient non-seed orders and community procurement state
  await client.deliveryAllocation.deleteMany({});
  await client.delivery.deleteMany({});
  await client.payment.deleteMany({});
  await client.negotiationRound.deleteMany({});
  await client.negotiation.deleteMany({});
  await client.supplierOffer.deleteMany({});

  // Reset residentOrders communityOrderId to null before deleting community orders
  await client.residentOrder.updateMany({
    data: { communityOrderId: null, status: ResidentOrderStatus.PENDING },
  });

  await client.communityOrderItem.deleteMany({});
  await client.communityOrder.deleteMany({});

  const canonicalOrderIds = Object.values(SEED_IDS.residentOrders);
  await client.orderItem.deleteMany({
    where: { residentOrderId: { notIn: canonicalOrderIds } },
  });
  await client.residentOrder.deleteMany({
    where: { id: { notIn: canonicalOrderIds } },
  });

  // 1. SOCIETY
  const society = await client.society.upsert({
    where: { id: SEED_IDS.society.greenview },
    update: {
      name: 'Greenview Residency',
      address: 'Plot 42, Baner-Pashan Link Road, Baner',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411045',
      latitude: 18.559658,
      longitude: 73.779774,
    },
    create: {
      id: SEED_IDS.society.greenview,
      name: 'Greenview Residency',
      address: 'Plot 42, Baner-Pashan Link Road, Baner',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411045',
      latitude: 18.559658,
      longitude: 73.779774,
    },
  });
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Society: ${society.name} (Pune, 550 residential flats representation)`);

  // 2. RESIDENTS
  const residentsData = [
    {
      id: SEED_IDS.residents.aarav,
      name: 'Aarav Sharma',
      email: 'aarav.sharma@greenview.example.com',
      phone: '+919820011101',
      flatNumber: 'Tower A-101',
      status: ResidentStatus.ACTIVE,
    },
    {
      id: SEED_IDS.residents.riya,
      name: 'Riya Patel',
      email: 'riya.patel@greenview.example.com',
      phone: '+919820011102',
      flatNumber: 'Tower A-204',
      status: ResidentStatus.ACTIVE,
    },
    {
      id: SEED_IDS.residents.kabir,
      name: 'Kabir Verma',
      email: 'kabir.verma@greenview.example.com',
      phone: '+919820011103',
      flatNumber: 'Tower B-302',
      status: ResidentStatus.ACTIVE,
    },
    {
      id: SEED_IDS.residents.ananya,
      name: 'Ananya Desai',
      email: 'ananya.desai@greenview.example.com',
      phone: '+919820011104',
      flatNumber: 'Tower B-405',
      status: ResidentStatus.ACTIVE,
    },
    {
      id: SEED_IDS.residents.neel,
      name: 'Neel Joshi',
      email: 'neel.joshi@greenview.example.com',
      phone: '+919820011105',
      flatNumber: 'Tower C-501',
      status: ResidentStatus.ACTIVE,
    },
    {
      id: SEED_IDS.residents.meera,
      name: 'Meera Kulkarni',
      email: 'meera.kulkarni@greenview.example.com',
      phone: '+919820011106',
      flatNumber: 'Tower C-603',
      status: ResidentStatus.ACTIVE,
    },
  ];

  for (const r of residentsData) {
    await client.resident.upsert({
      where: { id: r.id },
      update: {
        name: r.name,
        email: r.email,
        phone: r.phone,
        flatNumber: r.flatNumber,
        status: r.status,
        societyId: society.id,
      },
      create: {
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        flatNumber: r.flatNumber,
        status: r.status,
        societyId: society.id,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Seeded ${residentsData.length} residents in Greenview Residency`);

  // 3. PRODUCTS
  const productsData = [
    {
      id: SEED_IDS.products.rice,
      name: 'Basmati Rice (Extra Long Grain)',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'RICE-BASMATI-001',
    },
    {
      id: SEED_IDS.products.wheat,
      name: 'Sharbati Whole Wheat Atta',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'WHEAT-SHARBATI-001',
    },
    {
      id: SEED_IDS.products.cookingOil,
      name: 'Cold-Pressed Sunflower Cooking Oil',
      category: 'Oils & Ghee',
      unit: ProductUnit.LITRE,
      sku: 'OIL-SUNFLOWER-001',
    },
    {
      id: SEED_IDS.products.detergent,
      name: 'Eco Clean Laundry Detergent Powder',
      category: 'Household Cleaning',
      unit: ProductUnit.KG,
      sku: 'DET-ECOPOWDER-001',
    },
    {
      id: SEED_IDS.products.cleaningLiquid,
      name: 'Multi-Surface Herbal Disinfectant Liquid',
      category: 'Household Cleaning',
      unit: ProductUnit.LITRE,
      sku: 'CLEAN-HERBAL-001',
    },
    {
      id: SEED_IDS.products.sugar,
      name: 'Organic Refined Cane Sugar',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'SUGAR-CANE-001',
    },
    {
      id: SEED_IDS.products.groundnut,
      name: 'Raw Premium Groundnut (Peanuts)',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'GROUNDNUT-RAW-001',
    },
    {
      id: SEED_IDS.products.toothbrushes,
      name: 'Soft Bristle Bamboo Toothbrushes (Pack of 2)',
      category: 'Personal Care',
      unit: ProductUnit.UNIT,
      sku: 'CARE-BRUSH-002',
    },
    {
      id: SEED_IDS.products.bananas,
      name: 'Fresh Robusta Bananas',
      category: 'Fresh Produce',
      unit: ProductUnit.UNIT,
      sku: 'FRUIT-BANANA-001',
    },
    {
      id: SEED_IDS.products.oranges,
      name: 'Nagpur Mandarin Oranges',
      category: 'Fresh Produce',
      unit: ProductUnit.UNIT,
      sku: 'FRUIT-ORANGE-001',
    },
    {
      id: SEED_IDS.products.apple,
      name: 'Kashmiri Red Apples',
      category: 'Fresh Produce',
      unit: ProductUnit.KG,
      sku: 'FRUIT-APPLE-001',
    },
    {
      id: SEED_IDS.products.bajra,
      name: 'Pearl Millet Bajra Grain',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'MILLET-BAJRA-001',
    },
    {
      id: SEED_IDS.products.darkChocolate,
      name: 'Dark Chocolate Baking Bar 70%',
      category: 'Confectionery',
      unit: ProductUnit.KG,
      sku: 'CONF-DARKCHOC-001',
    },
    {
      id: SEED_IDS.products.maida,
      name: 'Refined Wheat Flour (Maida)',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'FLOUR-MAIDA-001',
    },
    {
      id: SEED_IDS.products.ambemoharRice,
      name: 'Ambemohar Aromatic Rice',
      category: 'Grains & Staples',
      unit: ProductUnit.KG,
      sku: 'RICE-AMBEMOHAR-001',
    },
  ];

  for (const p of productsData) {
    await client.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        category: p.category,
        unit: p.unit,
        sku: p.sku,
      },
      create: {
        id: p.id,
        name: p.name,
        category: p.category,
        unit: p.unit,
        sku: p.sku,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Seeded ${productsData.length} standardized products with controlled units`);

  // 4. SUPPLIERS (With realistic, deterministic operational trade-offs)
  const suppliersData = [
    {
      id: SEED_IDS.suppliers.sahyadri,
      name: 'Sahyadri Agro Wholesalers',
      contactEmail: 'orders@sahyadriagro.example.com',
      contactPhone: '+912025678901',
      address: 'Gala 14, APMC Market Yard, Gultekdi',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411037',
      latitude: 18.487123,
      longitude: 73.868745,
      serviceRadiusKm: 15.0,
      reliabilityScore: 0.96, // High reliability, great quality, limited radius
      status: SupplierStatus.ACTIVE,
    },
    {
      id: SEED_IDS.suppliers.deccan,
      name: 'Deccan Swift Fulfillers',
      contactEmail: 'dispatch@deccanswift.example.com',
      contactPhone: '+912027456789',
      address: 'Sector 10, MIDC Bhosari Industrial Area',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411026',
      latitude: 18.629812,
      longitude: 73.843219,
      serviceRadiusKm: 20.0,
      reliabilityScore: 0.92, // Faster delivery, slightly higher price point
      status: SupplierStatus.ACTIVE,
    },
    {
      id: SEED_IDS.suppliers.puneBulk,
      name: 'Pune Bulk Commodity Hub',
      contactEmail: 'procure@punebulk.example.com',
      contactPhone: '+912026890123',
      address: 'Survey 88, Hadapsar Industrial Estate',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411028',
      latitude: 18.508923,
      longitude: 73.926412,
      serviceRadiusKm: 30.0,
      reliabilityScore: 0.78, // Lowest base prices, wide radius, weaker SLA / reliability
      status: SupplierStatus.ACTIVE,
    },
  ];

  for (const s of suppliersData) {
    await client.supplier.upsert({
      where: { id: s.id },
      update: {
        name: s.name,
        contactEmail: s.contactEmail,
        contactPhone: s.contactPhone,
        address: s.address,
        city: s.city,
        state: s.state,
        postalCode: s.postalCode,
        latitude: s.latitude,
        longitude: s.longitude,
        serviceRadiusKm: s.serviceRadiusKm,
        reliabilityScore: s.reliabilityScore,
        status: s.status,
      },
      create: {
        id: s.id,
        name: s.name,
        contactEmail: s.contactEmail,
        contactPhone: s.contactPhone,
        address: s.address,
        city: s.city,
        state: s.state,
        postalCode: s.postalCode,
        latitude: s.latitude,
        longitude: s.longitude,
        serviceRadiusKm: s.serviceRadiusKm,
        reliabilityScore: s.reliabilityScore,
        status: s.status,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Seeded ${suppliersData.length} suppliers with deterministic reliability snapshots`);

  // 4b. SUPPLIER PRODUCT CAPABILITY & MOQ CATALOG
  const supplierProductsData = [
    // Sahyadri: Staples wholesale specialist (Rice, Wheat, Cooking Oil, Sugar, Groundnut)
    { supplierId: SEED_IDS.suppliers.sahyadri, productId: SEED_IDS.products.rice, basePrice: 85.0, moq: 5.0 },
    { supplierId: SEED_IDS.suppliers.sahyadri, productId: SEED_IDS.products.wheat, basePrice: 45.0, moq: 5.0 },
    { supplierId: SEED_IDS.suppliers.sahyadri, productId: SEED_IDS.products.cookingOil, basePrice: 165.0, moq: 2.0 },
    { supplierId: SEED_IDS.suppliers.sahyadri, productId: SEED_IDS.products.sugar, basePrice: 42.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.sahyadri, productId: SEED_IDS.products.groundnut, basePrice: 120.0, moq: 1.0 },

    // Deccan Swift: Full catalog, low MOQ, slight speed premium
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.rice, basePrice: 90.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.wheat, basePrice: 48.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.cookingOil, basePrice: 170.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.detergent, basePrice: 125.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.cleaningLiquid, basePrice: 115.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.sugar, basePrice: 44.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.groundnut, basePrice: 125.0, moq: 1.0 },
    { supplierId: SEED_IDS.suppliers.deccan, productId: SEED_IDS.products.toothbrushes, basePrice: 65.0, moq: 1.0 },

    // Pune Bulk: Wholesale high-MOQ staples
    { supplierId: SEED_IDS.suppliers.puneBulk, productId: SEED_IDS.products.rice, basePrice: 78.0, moq: 25.0 },
    { supplierId: SEED_IDS.suppliers.puneBulk, productId: SEED_IDS.products.wheat, basePrice: 40.0, moq: 20.0 },
    { supplierId: SEED_IDS.suppliers.puneBulk, productId: SEED_IDS.products.cookingOil, basePrice: 155.0, moq: 15.0 },
    { supplierId: SEED_IDS.suppliers.puneBulk, productId: SEED_IDS.products.sugar, basePrice: 40.0, moq: 2.0 },
    { supplierId: SEED_IDS.suppliers.puneBulk, productId: SEED_IDS.products.groundnut, basePrice: 115.0, moq: 2.0 },
    { supplierId: SEED_IDS.suppliers.puneBulk, productId: SEED_IDS.products.toothbrushes, basePrice: 58.0, moq: 2.0 },
  ];

  for (const sp of supplierProductsData) {
    await client.supplierProduct.upsert({
      where: {
        supplierId_productId: {
          supplierId: sp.supplierId,
          productId: sp.productId,
        },
      },
      update: {
        basePrice: sp.basePrice,
        moq: sp.moq,
        available: true,
      },
      create: {
        supplierId: sp.supplierId,
        productId: sp.productId,
        basePrice: sp.basePrice,
        moq: sp.moq,
        available: true,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Seeded ${supplierProductsData.length} supplier catalog & MOQ capability mappings`);

  // 5. PAYMENT MANDATES (Pre-authorized spending limits)
  const mandatesData = [
    {
      id: SEED_IDS.mandates.aarav,
      residentId: SEED_IDS.residents.aarav,
      maximumAmount: 8000.0,
      currency: 'INR',
      purpose: 'Monthly Community Grocery & Staples Procurement',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-12-31T23:59:59Z'),
      providerReference: 'MANDATE-DEMO-AARAV-001',
      status: PaymentMandateStatus.ACTIVE,
    },
    {
      id: SEED_IDS.mandates.riya,
      residentId: SEED_IDS.residents.riya,
      maximumAmount: 10000.0,
      currency: 'INR',
      purpose: 'Monthly Community Grocery & Staples Procurement',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-12-31T23:59:59Z'),
      providerReference: 'MANDATE-DEMO-RIYA-002',
      status: PaymentMandateStatus.ACTIVE,
    },
    {
      id: SEED_IDS.mandates.kabir,
      residentId: SEED_IDS.residents.kabir,
      maximumAmount: 7500.0,
      currency: 'INR',
      purpose: 'Monthly Community Staples Procurement',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-12-31T23:59:59Z'),
      providerReference: 'MANDATE-DEMO-KABIR-003',
      status: PaymentMandateStatus.ACTIVE,
    },
    {
      id: SEED_IDS.mandates.ananya,
      residentId: SEED_IDS.residents.ananya,
      maximumAmount: 6000.0,
      currency: 'INR',
      purpose: 'Monthly Household & Cleaning Essentials',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-12-31T23:59:59Z'),
      providerReference: 'MANDATE-DEMO-ANANYA-004',
      status: PaymentMandateStatus.ACTIVE,
    },
  ];

  for (const m of mandatesData) {
    await client.paymentMandate.upsert({
      where: { id: m.id },
      update: {
        residentId: m.residentId,
        maximumAmount: m.maximumAmount,
        currency: m.currency,
        purpose: m.purpose,
        periodStart: m.periodStart,
        periodEnd: m.periodEnd,
        providerReference: m.providerReference,
        status: m.status,
      },
      create: {
        id: m.id,
        residentId: m.residentId,
        maximumAmount: m.maximumAmount,
        currency: m.currency,
        purpose: m.purpose,
        periodStart: m.periodStart,
        periodEnd: m.periodEnd,
        providerReference: m.providerReference,
        status: m.status,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Seeded ${mandatesData.length} resident payment mandates with explicit spending boundaries`);

  // 6. REPRESENTATIVE RESIDENT ORDERS (Aggregation-Ready)
  // Order A (Aarav): 5 kg rice (@ ₹85) + 2 L cooking oil (@ ₹165) = ₹755.00
  // Order B (Riya): 10 kg rice (@ ₹85) + 3 L cooking oil (@ ₹165) = ₹1,345.00
  // Order C (Kabir): 8 kg rice (@ ₹85) = ₹680.00
  // Order D (Ananya): 5 kg wheat (@ ₹45) + 2 kg detergent (@ ₹120) = ₹465.00
  // Aggregated rice total: 5 + 10 + 8 = 23 kg!
  // Aggregated cooking oil total: 2 + 3 = 5 L!

  const ordersData = [
    {
      id: SEED_IDS.residentOrders.orderAarav,
      residentId: SEED_IDS.residents.aarav,
      societyId: society.id,
      status: ResidentOrderStatus.PENDING,
      totalAmount: 755.0,
      currency: 'INR',
      deliveryAddress: 'Flat Tower A-101, Greenview Residency, Baner, Pune 411045',
      requestedAt: new Date('2026-10-29T08:30:00Z'),
      items: [
        {
          id: SEED_IDS.orderItems.aaravRice,
          productId: SEED_IDS.products.rice,
          quantity: 5.0,
          unitPrice: 85.0,
          totalPrice: 425.0,
        },
        {
          id: SEED_IDS.orderItems.aaravOil,
          productId: SEED_IDS.products.cookingOil,
          quantity: 2.0,
          unitPrice: 165.0,
          totalPrice: 330.0,
        },
      ],
    },
    {
      id: SEED_IDS.residentOrders.orderRiya,
      residentId: SEED_IDS.residents.riya,
      societyId: society.id,
      status: ResidentOrderStatus.PENDING,
      totalAmount: 1345.0,
      currency: 'INR',
      deliveryAddress: 'Flat Tower A-204, Greenview Residency, Baner, Pune 411045',
      requestedAt: new Date('2026-10-29T08:45:00Z'),
      items: [
        {
          id: SEED_IDS.orderItems.riyaRice,
          productId: SEED_IDS.products.rice,
          quantity: 10.0,
          unitPrice: 85.0,
          totalPrice: 850.0,
        },
        {
          id: SEED_IDS.orderItems.riyaOil,
          productId: SEED_IDS.products.cookingOil,
          quantity: 3.0,
          unitPrice: 165.0,
          totalPrice: 495.0,
        },
      ],
    },
    {
      id: SEED_IDS.residentOrders.orderKabir,
      residentId: SEED_IDS.residents.kabir,
      societyId: society.id,
      status: ResidentOrderStatus.PENDING,
      totalAmount: 680.0,
      currency: 'INR',
      deliveryAddress: 'Flat Tower B-302, Greenview Residency, Baner, Pune 411045',
      requestedAt: new Date('2026-10-29T09:15:00Z'),
      items: [
        {
          id: SEED_IDS.orderItems.kabirRice,
          productId: SEED_IDS.products.rice,
          quantity: 8.0,
          unitPrice: 85.0,
          totalPrice: 680.0,
        },
      ],
    },
    {
      id: SEED_IDS.residentOrders.orderAnanya,
      residentId: SEED_IDS.residents.ananya,
      societyId: society.id,
      status: ResidentOrderStatus.PENDING,
      totalAmount: 465.0,
      currency: 'INR',
      deliveryAddress: 'Flat Tower B-405, Greenview Residency, Baner, Pune 411045',
      requestedAt: new Date('2026-10-29T09:30:00Z'),
      items: [
        {
          id: SEED_IDS.orderItems.ananyaWheat,
          productId: SEED_IDS.products.wheat,
          quantity: 5.0,
          unitPrice: 45.0,
          totalPrice: 225.0,
        },
        {
          id: SEED_IDS.orderItems.ananyaDetergent,
          productId: SEED_IDS.products.detergent,
          quantity: 2.0,
          unitPrice: 120.0,
          totalPrice: 240.0,
        },
      ],
    },
  ];

  for (const o of ordersData) {
    await client.residentOrder.upsert({
      where: { id: o.id },
      update: {
        residentId: o.residentId,
        societyId: o.societyId,
        status: o.status,
        totalAmount: o.totalAmount,
        currency: o.currency,
        deliveryAddress: o.deliveryAddress,
        requestedAt: o.requestedAt,
      },
      create: {
        id: o.id,
        residentId: o.residentId,
        societyId: o.societyId,
        status: o.status,
        totalAmount: o.totalAmount,
        currency: o.currency,
        deliveryAddress: o.deliveryAddress,
        requestedAt: o.requestedAt,
      },
    });

    for (const item of o.items) {
      await client.orderItem.upsert({
        where: { id: item.id },
        update: {
          residentOrderId: o.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
        },
        create: {
          id: item.id,
          residentOrderId: o.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
        },
      });
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[Seed] ✓ Seeded ${ordersData.length} aggregation-ready resident orders`);
  // eslint-disable-next-line no-console
  console.log(`[Seed]   → Compatible demand ready: 5kg + 10kg + 8kg = 23kg Rice`);
  // eslint-disable-next-line no-console
  console.log(`[Seed]   → Compatible demand ready: 2L + 3L = 5L Sunflower Cooking Oil`);

  // 7. INITIAL OPERATIONAL AUDIT EVENT (Deterministic baseline event)
  await client.auditEvent.create({
    data: {
      eventType: AuditEventType.REQUEST_CREATED,
      actor: 'resident:aarav',
      entityType: 'ResidentOrder',
      entityId: SEED_IDS.residentOrders.orderAarav,
      metadata: {
        society: 'Greenview Residency',
        itemsCount: 2,
        totalAmount: 755.0,
        mandateChecked: true,
      },
    },
  });
  // eslint-disable-next-line no-console
  console.log('[Seed] ✓ Recorded baseline operational audit event');
  // eslint-disable-next-line no-console
  console.log('[Seed] Database seeding completed successfully.');
}

if (require.main === module) {
  seed()
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[Seed] Error seeding database:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}


import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Sembrando planes y precios iniciales...');

  // 1. Plan Básico
  const basicPlan = await prisma.plan.upsert({
    where: { code: 'BASIC' },
    update: {},
    create: {
      code: 'BASIC',
      name: 'Plan Básico',
      description: 'Ideal para profesionales y pequeños negocios que comienzan.',
      maxUsers: 1,
      maxSuppliers: 25,
      maxInvoices: 100,
      hasSupplierReceipts: false,
      hasAiInsights: false,
      prices: {
        create: {
          amount: 15000.00,
          currency: 'ARS',
          validFrom: new Date('2026-01-01'),
          validTo: null, // Vigente actual
        },
      },
    },
  });

  // 2. Plan Profesional
  const proPlan = await prisma.plan.upsert({
    where: { code: 'PROFESSIONAL' },
    update: {},
    create: {
      code: 'PROFESSIONAL',
      name: 'Plan Profesional',
      description: 'Para empresas en crecimiento. Hasta 3 celulares y envío de comprobantes a proveedores.',
      maxUsers: 3,
      maxSuppliers: 80,
      maxInvoices: 300,
      hasSupplierReceipts: true,
      hasAiInsights: false,
      prices: {
        create: {
          amount: 35000.00,
          currency: 'ARS',
          validFrom: new Date('2026-01-01'),
          validTo: null, // Vigente actual
        },
      },
    },
  });

  // 3. Plan Ultra
  const ultraPlan = await prisma.plan.upsert({
    where: { code: 'ULTRA' },
    update: {},
    create: {
      code: 'ULTRA',
      name: 'Plan Ultra',
      description: 'Todo lo profesional + Consultas analíticas e insights financieros con Inteligencia Artificial.',
      maxUsers: 3,
      maxSuppliers: 150,
      maxInvoices: 500,
      hasSupplierReceipts: true,
      hasAiInsights: true,
      prices: {
        create: {
          amount: 60000.00,
          currency: 'ARS',
          validFrom: new Date('2026-01-01'),
          validTo: null, // Vigente actual
        },
      },
    },
  });

  console.log('✅ Planes y precios sembrados exitosamente:', {
    basic: basicPlan.name,
    pro: proPlan.name,
    ultra: ultraPlan.name,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

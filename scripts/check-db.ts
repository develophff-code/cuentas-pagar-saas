import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany();
  const users = await prisma.tenantUser.findMany();
  const categories = await prisma.category.findMany();
  const suppliers = await prisma.supplier.findMany();
  const invoices = await prisma.invoice.findMany();
  const sessions = await prisma.conversationSession.findMany();
  const plans = await prisma.plan.findMany();
  const prices = await prisma.planPrice.findMany();

  console.log('--- ESTADO ACTUAL DE LA BASE DE DATOS ---');
  console.log({
    tenants: tenants.length,
    users: users.length,
    categories: categories.length,
    suppliers: suppliers.length,
    invoices: invoices.length,
    conversationSessions: sessions.length,
    plans: plans.length,
    planPrices: prices.length,
  });

  if (categories.length > 0) {
    console.log('Categorías encontradas:', categories.map((c) => ({ id: c.id, name: c.name, tenantId: c.tenantId })));
  }
}

main().finally(() => prisma.$disconnect());

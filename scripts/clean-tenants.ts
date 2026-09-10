import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clean() {
  console.log('🧹 Iniciando limpieza de datos de prueba...');

  // 1. Convertir categorías existentes a categorías maestras globales (tenantId: null)
  // para que no se eliminen en cascada y queden disponibles para todos los nuevos tenants
  await prisma.$executeRawUnsafe(`UPDATE "categories" SET "tenantId" = NULL WHERE "tenantId" IS NOT NULL;`);
  console.log('✅ Categorías convertidas a catálogo global.');

  // 2. Eliminar todas las empresas (Tenants)
  // Gracias a onDelete: Cascade en PostgreSQL, esto elimina en cascada:
  // - tenant_users
  // - payment_grid_configs
  // - suppliers y supplier_bank_accounts
  // - invoices
  // - subscriptions
  const deletedTenants = await prisma.tenant.deleteMany({});
  console.log(`✅ Se eliminaron ${deletedTenants.count} tenants y todos sus registros vinculados.`);

  // 3. Limpiar las sesiones conversacionales activas para que el chat comience desde cero
  const deletedSessions = await prisma.conversationSession.deleteMany({});
  console.log(`✅ Se reiniciaron ${deletedSessions.count} sesiones de conversación.`);

  // 4. Verificar qué quedó en la base de datos
  const remainingTenants = await prisma.tenant.count();
  const remainingUsers = await prisma.tenantUser.count();
  const remainingCategories = await prisma.category.findMany({ select: { name: true, tenantId: true } });
  const remainingPlans = await prisma.plan.findMany({ select: { code: true, name: true } });
  const remainingPrices = await prisma.planPrice.count();

  console.log('\n--- VERIFICACIÓN FINAL ---');
  console.log({
    tenants: remainingTenants,
    users: remainingUsers,
    categoriesCount: remainingCategories.length,
    plansCount: remainingPlans.length,
    planPricesCount: remainingPrices,
  });
  console.log('Categorías preservadas:', remainingCategories.map((c) => c.name));
  console.log('Planes preservados:', remainingPlans.map((p) => p.name));
  console.log('\n🎉 ¡Base de datos limpia y lista para probar desde cero!');
}

clean()
  .catch((err) => {
    console.error('❌ Error durante la limpieza:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

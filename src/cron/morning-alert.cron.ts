import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { whatsappService } from '../modules/whatsapp/whatsapp.service.js';

export function setupMorningAlertCron(): void {
  // Se ejecuta todos los días a las 08:00 AM (hora del servidor)
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Ejecutando verificación de pagos matutinos (próximas 24 horas)...');
    await runMorningPaymentNotifications();
  });
}

export async function runMorningPaymentNotifications(): Promise<void> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      include: {
        users: { where: { isVerified: true } },
        invoices: {
          where: {
            status: { in: ['EN_GRILLA', 'APROBADA'] },
            scheduledPaymentDate: {
              gte: todayStart,
              lte: todayEnd,
            },
          },
          include: {
            supplier: {
              include: { category: true, bankAccounts: true },
            },
          },
        },
      },
    });

    for (const tenant of tenants) {
      if (tenant.invoices.length === 0) continue;

      let totalAmount = 0;
      let body = `☀️ *Reporte Matutino: Pagos del Día (${todayStart.toLocaleDateString('es-AR')})*\n\n`;
      body += `Tienes *${tenant.invoices.length} facturas* programadas para pago hoy:\n\n`;

      tenant.invoices.forEach((inv, index) => {
        const amt = Number(inv.amount);
        totalAmount += amt;
        const bank = inv.supplier.bankAccounts[0];
        const bankDetails = bank?.alias ? `Alias: ${bank.alias}` : bank?.cbuCvu ? `CBU: ${bank.cbuCvu}` : 'Sin datos';

        body += `${index + 1}️⃣ *${inv.supplier.businessName}* (${inv.supplier.category.name})\n`;
        body += `   💵 $ ${amt.toLocaleString('es-AR')} — Comprobante: ${inv.invoiceNumber}\n`;
        body += `   🏦 ${bankDetails}\n\n`;
      });

      body += `💰 *Total a Desembolsar Hoy:* $ ${totalAmount.toLocaleString('es-AR')}\n\n`;
      body += `_Para posponer un pago responde: "Posponer [Nº]" o accede a tu Dashboard._`;

      // Enviar a todos los celulares autorizados de la empresa
      for (const user of tenant.users) {
        try {
          await whatsappService.sendText(user.phoneNumber, body);
        } catch (err: any) {
          console.error(`[Cron] Error enviando alerta a ${user.phoneNumber}:`, err.message);
        }
      }
    }
  } catch (error: any) {
    console.error('[Cron] Error en la ejecución de pagos matutinos:', error);
  }
}

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { botService } from '../modules/bot/bot.service.js';
import { prisma } from '../lib/prisma.js';

export const webhookRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Endpoint de salud
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Receptor de Webhook de WAHA
  fastify.post('/api/webhook/whatsapp', async (request, reply) => {
    const body: any = request.body;

    // WAHA emite eventos como 'message' o 'message.any'
    if (body?.event === 'message' || body?.event === 'message.any') {
      const payload = body.payload;
      if (payload && !payload.fromMe) {
        // Ejecución en segundo plano para responder de inmediato 200 OK al webhook
        botService.handleIncomingMessage({
          id: payload.id,
          from: payload.from,
          body: payload.body,
          hasMedia: payload.hasMedia,
          media: payload.media,
          _data: payload,
        }).catch((err) => {
          fastify.log.error(err, '[Webhook] Error procesando mensaje de WhatsApp');
        });
      }
    }

    return reply.status(200).send({ received: true });
  });

  // Endpoints para el Dashboard Web
  // 1. Grilla de pagos de un tenant
  fastify.get('/api/tenants/:tenantId/grid', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    const invoices = await prisma.invoice.findMany({
      where: { tenantId },
      include: {
        supplier: {
          include: { category: true, bankAccounts: true },
        },
      },
      orderBy: { scheduledPaymentDate: 'asc' },
    });

    return reply.send({ success: true, invoices });
  });

  // 2. Reporte de gastos agrupados por Rubro (Insights Dashboard)
  fastify.get('/api/tenants/:tenantId/insights/rubros', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    const suppliers = await prisma.supplier.findMany({
      where: { tenantId },
      include: { category: true, invoices: true },
    });

    const rubroMap: Record<string, { totalAmount: number; invoiceCount: number; suppliers: string[] }> = {};

    suppliers.forEach((s) => {
      const rubro = s.category?.name || 'Sin Rubro';
      if (!rubroMap[rubro]) {
        rubroMap[rubro] = { totalAmount: 0, invoiceCount: 0, suppliers: [] };
      }
      if (!rubroMap[rubro].suppliers.includes(s.businessName)) {
        rubroMap[rubro].suppliers.push(s.businessName);
      }
      s.invoices.forEach((inv) => {
        rubroMap[rubro].totalAmount += Number(inv.amount);
        rubroMap[rubro].invoiceCount += 1;
      });
    });

    return reply.send({ success: true, rubros: rubroMap });
  });

  // 3. Gestión de Categorías / Rubros (Dashboard Web)
  fastify.get('/api/tenants/:tenantId/categories', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const categories = await prisma.category.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
    return reply.send({ success: true, categories });
  });

  fastify.post('/api/tenants/:tenantId/categories', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { name } = request.body as { name: string };

    if (!name?.trim()) {
      return reply.status(400).send({ success: false, message: 'El nombre de la categoría es requerido.' });
    }

    const category = await prisma.category.upsert({
      where: {
        tenantId_name: {
          tenantId,
          name: name.trim(),
        },
      },
      update: {},
      create: {
        tenantId,
        name: name.trim(),
      },
    });

    return reply.status(201).send({ success: true, category });
  });

  // 4. Modificar estado o fecha de una factura desde el Dashboard
  fastify.patch('/api/invoices/:invoiceId', async (request, reply) => {
    const { invoiceId } = request.params as { invoiceId: string };
    const { status, scheduledPaymentDate } = request.body as any;

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        ...(status ? { status } : {}),
        ...(scheduledPaymentDate ? { scheduledPaymentDate: new Date(scheduledPaymentDate) } : {}),
      },
    });

    return reply.send({ success: true, invoice: updated });
  });
};

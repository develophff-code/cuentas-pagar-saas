import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { botService } from '../modules/bot/bot.service.js';
import { dashboardService } from '../modules/dashboard/dashboard.service.js';
import { prisma } from '../lib/prisma.js';

export const webhookRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Ruta raíz
  fastify.get('/', async () => {
    return {
      service: 'Cuentas a Pagar SaaS API',
      status: 'online',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  });

  // Endpoint de salud
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ==========================================
  // Webhook para YCloud (WhatsApp Cloud API)
  // ==========================================
  
  // Verificación inicial del Webhook (GET) si YCloud o Meta lo requieren
  fastify.get('/api/webhook/ycloud', async (request, reply) => {
    const query: any = request.query;
    const challenge = query['hub.challenge'] || query['challenge'];
    if (challenge) {
      return reply.status(200).send(challenge);
    }
    return reply.status(200).send({ status: 'active', provider: 'ycloud' });
  });

  // Recepción de eventos entrantes de YCloud (POST)
  fastify.post('/api/webhook/ycloud', async (request, reply) => {
    const body: any = request.body;

    // YCloud envía eventos con tipo 'whatsapp.inbound_message.received'
    // o el objeto whatsappInboundMessage directamente
    const inboundMsg = body?.whatsappInboundMessage || body;

    if (inboundMsg && (inboundMsg.from || inboundMsg.type)) {
      const msgType = inboundMsg.type;
      let textBody = '';
      let hasMedia = false;
      let media: any = null;

      if (msgType === 'text') {
        textBody = inboundMsg.text?.body || '';
      } else if (msgType === 'interactive') {
        // Respuestas a botones interactivos
        textBody = inboundMsg.interactive?.button_reply?.id || inboundMsg.interactive?.button_reply?.title || '';
      } else if (msgType === 'image') {
        hasMedia = true;
        media = {
          url: inboundMsg.image?.link || inboundMsg.image?.id,
          mimetype: inboundMsg.image?.mime_type || 'image/jpeg',
          filename: 'factura_recibida.jpg',
        };
        textBody = inboundMsg.image?.caption || '';
      } else if (msgType === 'document') {
        hasMedia = true;
        media = {
          url: inboundMsg.document?.link || inboundMsg.document?.id,
          mimetype: inboundMsg.document?.mime_type || 'application/pdf',
          filename: inboundMsg.document?.filename || 'factura_recibida.pdf',
        };
        textBody = inboundMsg.document?.caption || '';
      }

      if (inboundMsg.from) {
        botService.handleIncomingMessage({
          id: inboundMsg.id || `ycloud_${Date.now()}`,
          from: inboundMsg.from,
          body: textBody,
          hasMedia,
          media,
          _data: inboundMsg,
        }).catch((err) => {
          fastify.log.error(err, '[Webhook YCloud] Error procesando mensaje de WhatsApp');
        });
      }
    }

    return reply.status(200).send({ received: true });
  });

  // ==========================================
  // Webhook para WAHA (Fallback / Autoalojado)
  // ==========================================
  fastify.post('/api/webhook/whatsapp', async (request, reply) => {
    const body: any = request.body;

    if (body?.event === 'message' || body?.event === 'message.any') {
      const payload = body.payload;
      if (payload && !payload.fromMe) {
        botService.handleIncomingMessage({
          id: payload.id,
          from: payload.from,
          body: payload.body,
          hasMedia: payload.hasMedia,
          media: payload.media,
          _data: payload,
        }).catch((err) => {
          fastify.log.error(err, '[Webhook WAHA] Error procesando mensaje de WhatsApp');
        });
      }
    }

    return reply.status(200).send({ received: true });
  });

  // ==========================================
  // Endpoints para el Dashboard Web (HTML y API)
  // ==========================================

  // Dashboard Web UI y Datos de Grilla
  fastify.get('/api/dashboard/grid', async (request, reply) => {
    const query: any = request.query || {};
    const tenantId = query.tenantId;

    if (!tenantId) {
      return reply.status(400).send({ error: 'Falta el parámetro tenantId en la URL.' });
    }

    if (query.format === 'json') {
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
    }

    const html = await dashboardService.renderHtml(tenantId);
    return reply.type('text/html').send(html);
  });

  // Alias directo /dashboard?tenantId=...
  fastify.get('/dashboard', async (request, reply) => {
    const query: any = request.query || {};
    const tenantId = query.tenantId;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Falta el parámetro tenantId en la URL.' });
    }
    const html = await dashboardService.renderHtml(tenantId);
    return reply.type('text/html').send(html);
  });

  // 1. Grilla de pagos de un tenant (JSON)
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
      where: {
        OR: [{ tenantId: null }, { tenantId }],
      },
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

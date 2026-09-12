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

    // Actualización de estado de mensajes salientes (entregado, leído o fallido)
    if (body?.type === 'whatsapp.message.updated' || body?.whatsappMessage) {
      const msgUpdate = body?.whatsappMessage || body;
      if (msgUpdate?.status === 'failed') {
        fastify.log.error(
          `[YCloud Status] ❌ Mensaje saliente a ${msgUpdate.to} FALLÓ. Código: ${msgUpdate.errorCode || ''} - ${msgUpdate.errorMessage || JSON.stringify(msgUpdate.error || {})}`
        );
      } else {
        fastify.log.info(
          `[YCloud Status] ℹ️ Mensaje a ${msgUpdate?.to} actualizado a estado: ${msgUpdate?.status}`
        );
      }
      return reply.status(200).send({ received: true });
    }

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

  // 4. Modificar datos, estado o fecha de una factura desde el Dashboard / API
  fastify.patch('/api/invoices/:invoiceId', async (request, reply) => {
    const { invoiceId } = request.params as { invoiceId: string };
    const {
      amount,
      dueDate,
      invoiceNumber,
      invoiceType,
      status,
      scheduledPaymentDate,
      notes,
    } = request.body as any;

    const existingInvoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { tenant: { include: { paymentGridConfig: true } } },
    });

    if (!existingInvoice) {
      return reply.status(404).send({ success: false, message: 'Factura no encontrada.' });
    }

    let calculatedScheduledDate = scheduledPaymentDate ? new Date(scheduledPaymentDate) : undefined;

    // Si cambió el vencimiento y no se indicó scheduledPaymentDate, recalcular en base a días de corte
    if (dueDate && !scheduledPaymentDate) {
      const { paymentGridService } = await import('../modules/payments/grid.service.js');
      const configuredDays = existingInvoice.tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES';
      calculatedScheduledDate = paymentGridService.calculateScheduledDate(new Date(dueDate), configuredDays);
    }

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        ...(amount !== undefined ? { amount: Number(amount) } : {}),
        ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
        ...(invoiceNumber !== undefined ? { invoiceNumber: invoiceNumber.trim() } : {}),
        ...(invoiceType !== undefined ? { invoiceType: invoiceType.trim() } : {}),
        ...(status ? { status } : {}),
        ...(calculatedScheduledDate ? { scheduledPaymentDate: calculatedScheduledDate } : {}),
        ...(notes !== undefined ? { notes: notes ? notes.trim() : null } : {}),
      },
      include: {
        supplier: {
          include: { category: true, bankAccounts: true },
        },
      },
    });

    return reply.send({ success: true, invoice: updated });
  });

  // 4.1 Anular factura
  fastify.post('/api/invoices/:invoiceId/cancel', async (request, reply) => {
    const { invoiceId } = request.params as { invoiceId: string };
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      return reply.status(404).send({ success: false, message: 'Factura no encontrada.' });
    }

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'CANCELADA' },
      include: { supplier: true },
    });

    return reply.send({ success: true, message: 'Factura anulada con éxito.', invoice: updated });
  });

  // 4.2 Revertir pago de factura
  fastify.post('/api/invoices/:invoiceId/revert-payment', async (request, reply) => {
    const { invoiceId } = request.params as { invoiceId: string };
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      return reply.status(404).send({ success: false, message: 'Factura no encontrada.' });
    }

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'EN_GRILLA' },
      include: { supplier: true },
    });

    return reply.send({
      success: true,
      message: 'Pago revertido con éxito. La factura volvió a estar pendiente en la grilla.',
      invoice: updated,
    });
  });

  // 5. Listar proveedores de un tenant
  fastify.get('/api/tenants/:tenantId/suppliers', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId },
      include: {
        category: true,
        bankAccounts: true,
      },
      orderBy: { businessName: 'asc' },
    });
    return reply.send({ success: true, suppliers });
  });

  // 6. Modificar datos de un proveedor
  fastify.patch('/api/suppliers/:supplierId', async (request, reply) => {
    const { supplierId } = request.params as { supplierId: string };
    const { businessName, phone, categoryId, cuit, email, address, alias, cbuCvu } = request.body as any;

    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      include: { bankAccounts: true },
    });

    if (!supplier) {
      return reply.status(404).send({ success: false, message: 'Proveedor no encontrado.' });
    }

    await prisma.supplier.update({
      where: { id: supplierId },
      data: {
        ...(businessName !== undefined ? { businessName: businessName.trim() } : {}),
        ...(phone !== undefined ? { phone: phone.trim() } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(cuit !== undefined ? { cuit: cuit ? cuit.trim() : null } : {}),
        ...(email !== undefined ? { email: email ? email.trim() : null } : {}),
        ...(address !== undefined ? { address: address ? address.trim() : null } : {}),
      },
    });

    if (alias !== undefined || cbuCvu !== undefined) {
      const primaryBank = supplier.bankAccounts[0];
      if (primaryBank) {
        await prisma.supplierBankAccount.update({
          where: { id: primaryBank.id },
          data: {
            ...(alias !== undefined ? { alias: alias ? alias.trim() : null } : {}),
            ...(cbuCvu !== undefined ? { cbuCvu: cbuCvu ? cbuCvu.trim() : null } : {}),
          },
        });
      } else if (alias || cbuCvu) {
        await prisma.supplierBankAccount.create({
          data: {
            supplierId: supplier.id,
            alias: alias ? alias.trim() : null,
            cbuCvu: cbuCvu ? cbuCvu.trim() : null,
            isPrimary: true,
          },
        });
      }
    }

    const finalSupplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      include: { category: true, bankAccounts: true },
    });

    return reply.send({ success: true, supplier: finalSupplier });
  });

  // 7. Consultar configuración de la empresa (Tenant)
  fastify.get('/api/tenants/:tenantId/config', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        plan: true,
        paymentGridConfig: true,
      },
    });

    if (!tenant) {
      return reply.status(404).send({ success: false, message: 'Empresa no encontrada.' });
    }

    return reply.send({
      success: true,
      tenant: {
        id: tenant.id,
        cuit: tenant.cuit,
        businessName: tenant.businessName,
        plan: tenant.plan?.name,
        paymentDays: tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES',
        morningAlertTime: tenant.paymentGridConfig?.morningAlertTime || '08:00',
      },
    });
  });

  // 8. Modificar configuración de la empresa (Tenant y PaymentGridConfig)
  fastify.patch('/api/tenants/:tenantId/config', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { businessName, paymentDays, morningAlertTime } = request.body as any;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { paymentGridConfig: true },
    });

    if (!tenant) {
      return reply.status(404).send({ success: false, message: 'Empresa no encontrada.' });
    }

    if (businessName !== undefined) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { businessName: businessName.trim() },
      });
    }

    let rescheduledCount = 0;
    if (paymentDays !== undefined || morningAlertTime !== undefined) {
      const updatedConfig = await prisma.paymentGridConfig.upsert({
        where: { tenantId },
        update: {
          ...(paymentDays !== undefined ? { paymentDays: paymentDays.trim().toUpperCase() } : {}),
          ...(morningAlertTime !== undefined ? { morningAlertTime: morningAlertTime.trim() } : {}),
        },
        create: {
          tenantId,
          paymentDays: paymentDays ? paymentDays.trim().toUpperCase() : 'MARTES,JUEVES',
          morningAlertTime: morningAlertTime ? morningAlertTime.trim() : '08:00',
        },
      });

      // Si cambiaron los días de pago, reprogramar facturas activas en grilla
      if (paymentDays !== undefined) {
        const { paymentGridService } = await import('../modules/payments/grid.service.js');
        const pendingInvoices = await prisma.invoice.findMany({
          where: { tenantId, status: 'EN_GRILLA' },
        });

        for (const inv of pendingInvoices) {
          const newSched = paymentGridService.calculateScheduledDate(inv.dueDate, updatedConfig.paymentDays);
          await prisma.invoice.update({
            where: { id: inv.id },
            data: { scheduledPaymentDate: newSched },
          });
        }
        rescheduledCount = pendingInvoices.length;
      }
    }

    const updatedTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { plan: true, paymentGridConfig: true },
    });

    return reply.send({
      success: true,
      tenant: {
        id: updatedTenant?.id,
        cuit: updatedTenant?.cuit,
        businessName: updatedTenant?.businessName,
        plan: updatedTenant?.plan?.name,
        paymentDays: updatedTenant?.paymentGridConfig?.paymentDays,
        morningAlertTime: updatedTenant?.paymentGridConfig?.morningAlertTime,
      },
      rescheduledInvoicesCount: rescheduledCount,
    });
  });
};

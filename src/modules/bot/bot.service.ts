import { prisma } from '../../lib/prisma.js';
import { wahaClient } from '../waha/waha.client.js';
import { invoiceExtractorService } from '../extractor/invoice-extractor.service.js';
import { paymentGridService } from '../payments/grid.service.js';

export interface IncomingWahaMessage {
  id: string;
  from: string; // ej: "54911xxxxxxxx@c.us"
  body?: string;
  hasMedia?: boolean;
  media?: {
    url?: string;
    mimetype?: string;
    filename?: string;
  };
  _data?: any;
}

export class BotService {
  /**
   * Manejador principal de mensajes entrantes desde el webhook de WAHA
   */
  async handleIncomingMessage(msg: IncomingWahaMessage): Promise<void> {
    const rawFrom = msg.from;
    const cleanPhone = rawFrom.replace(/\D/g, '');

    // Evitar procesar mensajes de grupos o estados de WhatsApp
    if (rawFrom.includes('@g.us') || rawFrom.includes('status@broadcast')) {
      return;
    }

    const text = msg.body?.trim() || '';

    // 1. Verificar si el celular pertenece a un usuario/empresa registrada
    const tenantUser = await prisma.tenantUser.findUnique({
      where: { phoneNumber: cleanPhone },
      include: {
        tenant: {
          include: {
            paymentGridConfig: true,
          },
        },
      },
    });

    if (!tenantUser) {
      // Flujo de Prospecto / Onboarding
      await this.handleOnboardingFlow(cleanPhone, rawFrom, text);
      return;
    }

    // 2. Si es un usuario registrado y envió un archivo multimedia (Foto o PDF)
    if (msg.hasMedia && msg.media?.url) {
      await this.handleMediaInvoice(tenantUser, rawFrom, msg.media);
      return;
    }

    // 3. Comandos de texto para usuarios registrados
    await this.handleRegisteredUserText(tenantUser, rawFrom, text);
  }

  /**
   * Flujo de bienvenida, información de planes y alta de cuenta (Onboarding)
   */
  private async handleOnboardingFlow(cleanPhone: string, rawFrom: string, text: string): Promise<void> {
    let session = await prisma.conversationSession.findUnique({
      where: { phoneNumber: cleanPhone },
    });

    if (!session) {
      session = await prisma.conversationSession.create({
        data: {
          phoneNumber: cleanPhone,
          state: 'INITIAL',
          contextData: {},
        },
      });
    }

    const lowerText = text.toLowerCase();

    // Estado inicial o consulta de info
    if (session.state === 'INITIAL' || lowerText.includes('hola') || lowerText.includes('info')) {
      const welcomeMessage = `👋 *¡Bienvenido al SaaS de Gestión de Cuentas a Pagar por WhatsApp!*

Automatiza la recepción de boletas y pagos a tus proveedores en segundos:
📸 *Sube fotos o PDFs* de facturas desde tu celular.
🤖 *Extracción automática* de CUIT, montos, vencimientos y CBU/Alias.
📅 *Grilla semanal inteligente* de pagos para no entrar en mora.
☀️ *Reporte matutino diario* con los pagos de las próximas 24 horas.
📊 *Dashboard web* en tiempo real con analytics y rubros.

*Planes de Suscripción Disponibles:*
1️⃣ *Básico:* Hasta 100 facturas/mes, 25 proveedores, 1 celular.
2️⃣ *Profesional:* Hasta 300 facturas/mes, 80 proveedores, hasta 3 celulares, envío de comprobantes a proveedores y métricas por rubro.
3️⃣ *Ultra:* Hasta 500+ facturas/mes, 150 proveedores, hasta 3 celulares, consultas e insights financieros con IA.

_¿Con qué plan deseas comenzar hoy? Responde con 1, 2 o 3._`;

      await wahaClient.sendButtons(rawFrom, welcomeMessage, [
        { id: 'plan_basic', text: '1. Plan Básico' },
        { id: 'plan_pro', text: '2. Plan Profesional' },
        { id: 'plan_ultra', text: '3. Plan Ultra' },
      ]);

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: { state: 'WAITING_PLAN_SELECTION' },
      });
      return;
    }

    // Selección de Plan
    if (session.state === 'WAITING_PLAN_SELECTION') {
      let chosenPlan = 'BASIC';
      let maxUsers = 1;
      let maxSuppliers = 25;
      let maxInvoices = 100;

      if (lowerText.includes('1') || lowerText.includes('basic')) {
        chosenPlan = 'BASIC';
      } else if (lowerText.includes('2') || lowerText.includes('pro')) {
        chosenPlan = 'PROFESSIONAL';
        maxUsers = 3;
        maxSuppliers = 80;
        maxInvoices = 300;
      } else if (lowerText.includes('3') || lowerText.includes('ultra')) {
        chosenPlan = 'ULTRA';
        maxUsers = 3;
        maxSuppliers = 150;
        maxInvoices = 500;
      } else {
        await wahaClient.sendText(rawFrom, 'Por favor, selecciona una opción válida: *1* (Básico), *2* (Profesional) o *3* (Ultra).');
        return;
      }

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'WAITING_COMPANY_CUIT',
          contextData: { chosenPlan, maxUsers, maxSuppliers, maxInvoices },
        },
      });

      await wahaClient.sendText(
        rawFrom,
        `✅ Has seleccionado el *Plan ${chosenPlan}*.\n\nPara dar de alta tu empresa, por favor escribe el *CUIT* de tu empresa (ej: 30-12345678-9):`
      );
      return;
    }

    // Ingreso de CUIT
    if (session.state === 'WAITING_COMPANY_CUIT') {
      const cleanCuit = text.replace(/\D/g, '');
      if (cleanCuit.length < 10 || cleanCuit.length > 11) {
        await wahaClient.sendText(rawFrom, '⚠️ El CUIT no parece válido. Por favor ingresa los 11 dígitos de tu CUIT:');
        return;
      }

      const ctx = (session.contextData as any) || {};
      ctx.cuit = text.trim();

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'WAITING_COMPANY_NAME',
          contextData: ctx,
        },
      });

      await wahaClient.sendText(rawFrom, '👍 Perfecto. Ahora dinos la *Razón Social o Nombre de Fantasía* de tu empresa:');
      return;
    }

    // Ingreso de Razón Social y Creación de Cuenta
    if (session.state === 'WAITING_COMPANY_NAME') {
      const companyName = text.trim();
      const ctx = (session.contextData as any) || {};

      try {
        // Crear Tenant y TenantUser
        const tenant = await prisma.tenant.create({
          data: {
            cuit: ctx.cuit || '00-00000000-0',
            businessName: companyName,
            planType: ctx.chosenPlan || 'BASIC',
            maxUsers: ctx.maxUsers || 1,
            maxSuppliers: ctx.maxSuppliers || 25,
            maxInvoices: ctx.maxInvoices || 100,
            paymentGridConfig: {
              create: {
                paymentDays: 'MARTES,JUEVES',
                morningAlertTime: '08:00',
              },
            },
            users: {
              create: {
                phoneNumber: cleanPhone,
                fullName: companyName,
                role: 'ADMIN',
              },
            },
          },
        });

        await prisma.conversationSession.delete({ where: { id: session.id } });

        const successMessage = `🎉 *¡Felicitaciones! Tu cuenta para ${companyName} ha sido creada con éxito.*

*Configuración Inicial:*
* CUIT: ${tenant.cuit}
* Plan: ${tenant.planType} (Permite hasta ${tenant.maxUsers} celulares)
* Días de pago fijados: *Martes y Jueves*

🚀 *¡Ya puedes empezar!*
Pruébalo ahora mismo: *envía una foto o PDF de una factura de un proveedor* y el sistema la procesará de inmediato.`;

        await wahaClient.sendText(rawFrom, successMessage);
      } catch (err: any) {
        console.error('[BotService] Error creando empresa:', err);
        await wahaClient.sendText(rawFrom, 'Hubo un inconveniente creando la cuenta. Si ya estabas registrado, intenta escribir "Hola".');
      }
      return;
    }
  }

  /**
   * Procesa la recepción de una foto o PDF de factura
   */
  private async handleMediaInvoice(tenantUser: any, rawFrom: string, media: any): Promise<void> {
    await wahaClient.startTyping(rawFrom);
    await wahaClient.sendText(rawFrom, '⏳ *Descargando y analizando tu comprobante con IA...* Dame unos segundos.');

    try {
      // 1. Descargar archivo multimedia
      const { buffer, mimeType } = await wahaClient.downloadMedia(media.url);

      // 2. Extraer información con Gemini Vision
      const extracted = await invoiceExtractorService.extractFromBuffer(buffer, mimeType);

      // 3. Buscar o dar de alta al Proveedor
      let supplier = await prisma.supplier.findFirst({
        where: {
          tenantId: tenantUser.tenantId,
          cuit: extracted.cuitEmisor,
        },
        include: { bankAccounts: true },
      });

      if (!supplier) {
        supplier = await prisma.supplier.create({
          data: {
            tenantId: tenantUser.tenantId,
            cuit: extracted.cuitEmisor,
            businessName: extracted.razonSocial,
            categories: extracted.rubroSugerido || 'General',
            bankAccounts: {
              create: {
                cbuCvu: extracted.cbuCvu,
                alias: extracted.alias,
                bankName: extracted.banco,
              },
            },
          },
          include: { bankAccounts: true },
        });
      } else if ((extracted.cbuCvu || extracted.alias) && supplier.bankAccounts.length === 0) {
        // Actualizar datos bancarios si antes no los tenía
        await prisma.supplierBankAccount.create({
          data: {
            supplierId: supplier.id,
            cbuCvu: extracted.cbuCvu,
            alias: extracted.alias,
            bankName: extracted.banco,
          },
        });
      }

      // 4. Calcular fecha en la grilla semanal
      const dueDate = new Date(extracted.fechaVencimiento);
      const configuredDays = tenantUser.tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES';
      const scheduledDate = paymentGridService.calculateScheduledDate(dueDate, configuredDays);

      // 5. Registrar la factura en la base de datos
      const invoice = await prisma.invoice.create({
        data: {
          tenantId: tenantUser.tenantId,
          supplierId: supplier.id,
          invoiceNumber: extracted.numeroComprobante,
          invoiceType: extracted.tipoComprobante,
          amount: extracted.importeTotal,
          vatAmount: extracted.importeIva,
          issueDate: extracted.fechaEmision ? new Date(extracted.fechaEmision) : null,
          dueDate: dueDate,
          scheduledPaymentDate: scheduledDate,
          status: 'EN_GRILLA',
          rawOcrData: extracted as any,
        },
      });

      await wahaClient.stopTyping(rawFrom);

      // 6. Enviar confirmación interactiva
      const formattedAmount = new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
      }).format(extracted.importeTotal);

      const friendlyGridDate = paymentGridService.formatFriendlyDate(scheduledDate);

      const confirmText = `📄 *Comprobante Procesado Exitosamente*

🏢 *Proveedor:* ${extracted.razonSocial} (CUIT: ${extracted.cuitEmisor})
🏷️ *Rubro:* ${supplier.categories}
🧾 *Comprobante:* ${extracted.tipoComprobante} Nº ${extracted.numeroComprobante}
💰 *Total:* ${formattedAmount}
⏰ *Vencimiento:* ${extracted.fechaVencimiento}
📅 *Asignado a Grilla de Pago:* *${friendlyGridDate}*
🏦 *Datos de Pago:* ${extracted.alias ? `Alias: ${extracted.alias}` : extracted.cbuCvu ? `CBU: ${extracted.cbuCvu}` : 'Sin datos bancarios'}

_El pago quedó agendado. Recibirás el recordatorio la mañana de su pago._`;

      await wahaClient.sendButtons(rawFrom, confirmText, [
        { id: `posponer_${invoice.id}`, text: 'Posponer 1 Semana' },
        { id: `pagar_hoy_${invoice.id}`, text: 'Pagar Hoy' },
      ]);
    } catch (error: any) {
      await wahaClient.stopTyping(rawFrom);
      console.error('[BotService] Error procesando factura:', error);
      await wahaClient.sendText(
        rawFrom,
        `❌ No pudimos procesar la factura automáticamente: ${error.message}.\nPor favor intenta enviar una foto más nítida o en formato PDF.`
      );
    }
  }

  /**
   * Comandos de texto y consultas para usuarios autenticados
   */
  private async handleRegisteredUserText(tenantUser: any, rawFrom: string, text: string): Promise<void> {
    const lower = text.toLowerCase();

    // Ver pagos de hoy o de la semana
    if (lower.includes('pagos') || lower.includes('hoy') || lower.includes('grilla')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);

      const invoices = await prisma.invoice.findMany({
        where: {
          tenantId: tenantUser.tenantId,
          status: { in: ['EN_GRILLA', 'APROBADA'] },
          scheduledPaymentDate: {
            gte: today,
            lte: nextWeek,
          },
        },
        include: {
          supplier: {
            include: { bankAccounts: true },
          },
        },
        orderBy: { scheduledPaymentDate: 'asc' },
      });

      if (invoices.length === 0) {
        await wahaClient.sendText(rawFrom, '🎉 *No tienes pagos programados para los próximos 7 días.*');
        return;
      }

      let report = `📋 *Próximos Pagos en Grilla Semanal:*\n\n`;
      let totalSum = 0;

      invoices.forEach((inv, index) => {
        const amt = Number(inv.amount);
        totalSum += amt;
        const dateStr = paymentGridService.formatFriendlyDate(inv.scheduledPaymentDate);
        const bank = inv.supplier.bankAccounts[0];
        const bankStr = bank?.alias ? `Alias: ${bank.alias}` : bank?.cbuCvu ? `CBU: ${bank.cbuCvu}` : 'Sin datos';

        report += `${index + 1}️⃣ *${inv.supplier.businessName}* (${inv.supplier.categories})\n`;
        report += `   💵 $ ${amt.toLocaleString('es-AR')} — 📅 ${dateStr}\n`;
        report += `   🏦 ${bankStr} — Nº ${inv.invoiceNumber}\n\n`;
      });

      report += `*Total a Pagar:* $ ${totalSum.toLocaleString('es-AR')}`;
      await wahaClient.sendText(rawFrom, report);
      return;
    }

    // Consultas de IA / Insights (Plan Ultra)
    if (lower.includes('insight') || lower.includes('cuanto') || lower.includes('analisis') || lower.includes('proveedor')) {
      if (tenantUser.tenant.planType !== 'ULTRA') {
        await wahaClient.sendText(
          rawFrom,
          '💡 *Esta consulta requiere el Plan Ultra.* Con el Plan Ultra puedes consultar insights financieros con IA sobre proveedores, gastos por rubro y proyecciones.'
        );
        return;
      }

      await wahaClient.startTyping(rawFrom);

      // Traer resumen de facturas y proveedores
      const suppliers = await prisma.supplier.findMany({
        where: { tenantId: tenantUser.tenantId },
        include: { invoices: true },
      });

      const summaryData = suppliers.map((s) => ({
        proveedor: s.businessName,
        rubro: s.categories,
        totalFacturas: s.invoices.length,
        montoTotalHistorico: s.invoices.reduce((acc, i) => acc + Number(i.amount), 0),
        facturasPendientes: s.invoices.filter((i) => i.status === 'EN_GRILLA').length,
      }));

      const aiResponse = await invoiceExtractorService.generateSupplierInsights(summaryData, text);
      await wahaClient.stopTyping(rawFrom);
      await wahaClient.sendText(rawFrom, aiResponse);
      return;
    }

    // Mensaje de ayuda genérico
    const helpMessage = `👋 *Hola ${tenantUser.fullName}*

Puedes interactuar con el sistema de las siguientes formas:
📸 *Envía una foto o PDF:* Carga automática de factura y proveedor.
📋 *Escribe "pagos":* Ver grilla de pagos de los próximos 7 días.
${tenantUser.tenant.planType === 'ULTRA' ? '🤖 *Haz preguntas financieras:* Ej. "¿Cuánto le pagamos este mes a cada rubro?"' : ''}
🌐 *Dashboard Web:* Visualiza la grilla completa en tiempo real.`;

    await wahaClient.sendText(rawFrom, helpMessage);
  }
}

export const botService = new BotService();

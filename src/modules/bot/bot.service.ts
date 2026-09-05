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

    // 3. Comprobar si el usuario registrado está en medio de un flujo de alta de proveedor
    const activeSession = await prisma.conversationSession.findUnique({
      where: { phoneNumber: cleanPhone },
    });

    if (activeSession && activeSession.state.startsWith('SUPPLIER_REG_')) {
      await this.handleSupplierRegistrationStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    // 4. Comandos de texto e intenciones para usuarios registrados
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
        // Crear Tenant, Categorías iniciales y TenantUser
        const tenant = await prisma.tenant.create({
          data: {
            cuit: ctx.cuit || '00-00000000-0',
            businessName: companyName,
            planType: ctx.chosenPlan || 'BASIC',
            maxUsers: ctx.maxUsers || 1,
            maxSuppliers: ctx.maxSuppliers || 25,
            maxInvoices: ctx.maxInvoices || 100,
            categories: {
              createMany: {
                data: [
                  { name: 'General' },
                  { name: 'Insumos y Oficina' },
                  { name: 'Materia Prima' },
                  { name: 'Servicios' },
                ],
              },
            },
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
* Envía una foto o PDF de una factura de un proveedor.
* O escribe *"Quiero dar de alta un nuevo proveedor"* para registrar proveedores manualmente.`;

        await wahaClient.sendText(rawFrom, successMessage);
      } catch (err: any) {
        console.error('[BotService] Error creando empresa:', err);
        await wahaClient.sendText(rawFrom, 'Hubo un inconveniente creando la cuenta. Si ya estabas registrado, intenta escribir "Hola".');
      }
      return;
    }
  }

  /**
   * Flujo de Alta Conversacional de Nuevo Proveedor (WhatsApp)
   */
  private async startSupplierRegistration(tenantUser: any, rawFrom: string): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;
    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'SUPPLIER_REG_NAME',
        contextData: { tenantId: tenantUser.tenantId },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'SUPPLIER_REG_NAME',
        contextData: { tenantId: tenantUser.tenantId },
      },
    });

    const msg = `📝 *Alta de Nuevo Proveedor*

Vamos a registrar el proveedor paso a paso.
Por favor, escribe el *Nombre o Razón Social* del proveedor:`;

    await wahaClient.sendText(rawFrom, msg);
  }

  private async handleSupplierRegistrationStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};

    // Paso 1: Recibe Nombre -> Pide Rubro/Categoría
    if (session.state === 'SUPPLIER_REG_NAME') {
      const businessName = text.trim();
      if (!businessName) {
        await wahaClient.sendText(rawFrom, '⚠️ El nombre no puede estar vacío. Por favor escribe el nombre o razón social:');
        return;
      }

      ctx.businessName = businessName;

      // Obtener categorías existentes del Tenant
      const categories = await prisma.category.findMany({
        where: { tenantId: tenantUser.tenantId },
        orderBy: { name: 'asc' },
      });

      let categoryPrompt = `👍 *Nombre:* ${businessName}\n\n🏷️ *Rubro o Categoría (Obligatorio):*\n`;
      if (categories.length > 0) {
        categoryPrompt += `Puedes elegir una de tus categorías existentes o escribir una nueva:\n`;
        categories.forEach((c, idx) => {
          categoryPrompt += `• ${c.name}\n`;
        });
      } else {
        categoryPrompt += `Escribe el rubro o categoría comercial (ej: Ferretería, Insumos, Alimentos, etc.):\n`;
      }
      categoryPrompt += `\n_Escribe el nombre del rubro:_`;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'SUPPLIER_REG_CATEGORY',
          contextData: ctx,
        },
      });

      await wahaClient.sendText(rawFrom, categoryPrompt);
      return;
    }

    // Paso 2: Recibe Rubro -> Pide Teléfono (Obligatorio)
    if (session.state === 'SUPPLIER_REG_CATEGORY') {
      const categoryName = text.trim();
      if (!categoryName) {
        await wahaClient.sendText(rawFrom, '⚠️ El rubro es obligatorio. Por favor ingresa el nombre de la categoría:');
        return;
      }

      // Buscar o crear la categoría
      let category = await prisma.category.findFirst({
        where: {
          tenantId: tenantUser.tenantId,
          name: { equals: categoryName, mode: 'insensitive' },
        },
      });

      if (!category) {
        category = await prisma.category.create({
          data: {
            tenantId: tenantUser.tenantId,
            name: categoryName,
          },
        });
      }

      ctx.categoryId = category.id;
      ctx.categoryName = category.name;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'SUPPLIER_REG_PHONE',
          contextData: ctx,
        },
      });

      const phonePrompt = `🏷️ *Rubro asignado:* ${category.name}\n\n📱 *Teléfono de Contacto (Obligatorio):*\nIngresa el número de WhatsApp o teléfono del proveedor:`;
      await wahaClient.sendText(rawFrom, phonePrompt);
      return;
    }

    // Paso 3: Recibe Teléfono -> Pide CUIT / Datos Bancarios Opcionales
    if (session.state === 'SUPPLIER_REG_PHONE') {
      const cleanInputPhone = text.replace(/\D/g, '');
      if (cleanInputPhone.length < 8) {
        await wahaClient.sendText(rawFrom, '⚠️ Por favor ingresa un número de teléfono válido:');
        return;
      }

      ctx.phone = text.trim();

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'SUPPLIER_REG_OPTIONAL',
          contextData: ctx,
        },
      });

      const optionalPrompt = `📱 *Teléfono:* ${ctx.phone}\n\n🏦 *Datos Opcionales (CUIT / CBU / Alias):*\nSi tienes el CUIT o datos bancarios para transferirle, escríbelos ahora (ej: "CUIT 30-12345678-9, Alias PROVEEDOR.PAGOS").\n\nSi es un proveedor informal sin estos datos, responde *Omitir*.`;
      await wahaClient.sendText(rawFrom, optionalPrompt);
      return;
    }

    // Paso 4: Recibe Datos Opcionales o "Omitir" -> Crea Proveedor en DB
    if (session.state === 'SUPPLIER_REG_OPTIONAL') {
      const lower = text.toLowerCase();
      let cuit: string | null = null;
      let alias: string | null = null;
      let cbu: string | null = null;

      if (!lower.includes('omitir') && !lower.includes('no') && !lower.includes('ninguno')) {
        // Intentar detectar CUIT si viene en el texto
        const cuitMatch = text.match(/\b\d{2}[-]?\d{8}[-]?\d{1}\b/);
        if (cuitMatch) {
          cuit = cuitMatch[0];
        }

        // Detectar alias si contiene palabras tipo ALIAS
        const aliasMatch = text.match(/alias[:\s]+([a-zA-Z0-9.\-_]+)/i);
        if (aliasMatch) {
          alias = aliasMatch[1];
        }

        // Detectar CBU/CVU de 22 dígitos
        const cbuMatch = text.match(/\b\d{22}\b/);
        if (cbuMatch) {
          cbu = cbuMatch[0];
        }
      }

      // Crear proveedor en PostgreSQL
      const supplier = await prisma.supplier.create({
        data: {
          tenantId: tenantUser.tenantId,
          categoryId: ctx.categoryId,
          businessName: ctx.businessName,
          phone: ctx.phone,
          cuit: cuit,
          bankAccounts: (alias || cbu) ? {
            create: {
              alias: alias,
              cbuCvu: cbu,
            },
          } : undefined,
        },
        include: {
          category: true,
          bankAccounts: true,
        },
      });

      // Limpiar sesión conversacional
      await prisma.conversationSession.delete({ where: { id: session.id } });

      const finalMsg = `🎉 *¡Proveedor Registrado Exitosamente!*

🏢 *Nombre:* ${supplier.businessName}
🏷️ *Rubro:* ${supplier.category.name}
📱 *Teléfono:* ${supplier.phone}
🆔 *CUIT:* ${supplier.cuit || '_No informado (informal)_'}
🏦 *Datos de Pago:* ${alias ? `Alias: ${alias}` : cbu ? `CBU: ${cbu}` : '_No informados_'}

Ya puedes asociarle facturas y registrar pagos para este proveedor.`;

      await wahaClient.sendText(rawFrom, finalMsg);
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

      // 3. Buscar o crear la categoría
      const categoryName = extracted.rubroSugerido || 'General';
      let category = await prisma.category.findFirst({
        where: {
          tenantId: tenantUser.tenantId,
          name: { equals: categoryName, mode: 'insensitive' },
        },
      });

      if (!category) {
        category = await prisma.category.create({
          data: {
            tenantId: tenantUser.tenantId,
            name: categoryName,
          },
        });
      }

      // 4. Buscar o dar de alta al Proveedor
      let supplier = await prisma.supplier.findFirst({
        where: {
          tenantId: tenantUser.tenantId,
          cuit: extracted.cuitEmisor,
        },
        include: { category: true, bankAccounts: true },
      });

      if (!supplier) {
        supplier = await prisma.supplier.create({
          data: {
            tenantId: tenantUser.tenantId,
            categoryId: category.id,
            cuit: extracted.cuitEmisor,
            businessName: extracted.razonSocial,
            phone: 'Sin teléfono registrado',
            bankAccounts: {
              create: {
                cbuCvu: extracted.cbuCvu,
                alias: extracted.alias,
                bankName: extracted.banco,
              },
            },
          },
          include: { category: true, bankAccounts: true },
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

      // 5. Calcular fecha en la grilla semanal
      const dueDate = new Date(extracted.fechaVencimiento);
      const configuredDays = tenantUser.tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES';
      const scheduledDate = paymentGridService.calculateScheduledDate(dueDate, configuredDays);

      // 6. Registrar la factura en la base de datos
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

      // 7. Enviar confirmación interactiva
      const formattedAmount = new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
      }).format(extracted.importeTotal);

      const friendlyGridDate = paymentGridService.formatFriendlyDate(scheduledDate);

      const confirmText = `📄 *Comprobante Procesado Exitosamente*

🏢 *Proveedor:* ${extracted.razonSocial} (CUIT: ${extracted.cuitEmisor})
🏷️ *Rubro:* ${supplier.category?.name || category.name}
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

    // 1. Detección de intención para alta de proveedor
    const hasNuevo = lower.includes('nuevo') || lower.includes('nueva');
    const hasProveedor = lower.includes('proveedor');

    if (hasNuevo && hasProveedor) {
      await this.startSupplierRegistration(tenantUser, rawFrom);
      return;
    }

    // 2. Manejo de ambigüedad si menciona proveedor con intenciones de alta sin ambas palabras
    if (
      hasProveedor &&
      (lower.includes('alta') || lower.includes('crear') || lower.includes('registrar') || lower.includes('agregar'))
    ) {
      const ambiguityMsg = `Entiendo que quieres registrar un nuevo proveedor. Puedes hacerlo de esta manera:
• "Quiero dar de alta un nuevo proveedor"
• "Registrar nuevo proveedor"`;
      await wahaClient.sendText(rawFrom, ambiguityMsg);
      return;
    }

    // 3. Ver pagos de hoy o de la semana
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
            include: { category: true, bankAccounts: true },
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

        report += `${index + 1}️⃣ *${inv.supplier.businessName}* (${inv.supplier.category.name})\n`;
        report += `   💵 $ ${amt.toLocaleString('es-AR')} — 📅 ${dateStr}\n`;
        report += `   🏦 ${bankStr} — Nº ${inv.invoiceNumber}\n\n`;
      });

      report += `*Total a Pagar:* $ ${totalSum.toLocaleString('es-AR')}`;
      await wahaClient.sendText(rawFrom, report);
      return;
    }

    // 4. Consultas de IA / Insights (Plan Ultra)
    if (lower.includes('insight') || lower.includes('cuanto') || lower.includes('analisis') || lower.includes('proveedores')) {
      if (tenantUser.tenant.planType !== 'ULTRA') {
        await wahaClient.sendText(
          rawFrom,
          '💡 *Esta consulta requiere el Plan Ultra.* Con el Plan Ultra puedes consultar insights financieros con IA sobre proveedores, gastos por rubro y proyecciones.'
        );
        return;
      }

      await wahaClient.startTyping(rawFrom);

      // Traer resumen de facturas y proveedores con su categoría
      const suppliers = await prisma.supplier.findMany({
        where: { tenantId: tenantUser.tenantId },
        include: { category: true, invoices: true },
      });

      const summaryData = suppliers.map((s) => ({
        proveedor: s.businessName,
        rubro: s.category.name,
        telefono: s.phone,
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
📝 *Escribe "Registrar nuevo proveedor":* Alta manual guiada de proveedores formales o informales.
📋 *Escribe "pagos":* Ver grilla de pagos de los próximos 7 días.
${tenantUser.tenant.planType === 'ULTRA' ? '🤖 *Haz preguntas financieras:* Ej. "¿Cuánto le pagamos este mes a cada rubro?"' : ''}
🌐 *Dashboard Web:* Visualiza la grilla completa en tiempo real.`;

    await wahaClient.sendText(rawFrom, helpMessage);
  }
}

export const botService = new BotService();

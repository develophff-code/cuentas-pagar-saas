import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { whatsappService } from '../whatsapp/whatsapp.service.js';
import { invoiceExtractorService } from '../extractor/invoice-extractor.service.js';
import { paymentGridService } from '../payments/grid.service.js';

export interface IncomingWahaMessage {
  id: string;
  from: string; // ej: "54911xxxxxxxx@c.us" o "+54911xxxxxxxx"
  body?: string;
  hasMedia?: boolean;
  media?: {
    url?: string;
    mimetype?: string;
    filename?: string;
  };
  _data?: any;
}

export const PREFERRED_CATEGORIES = [
  'Mercadería y Materias Primas',
  'Servicios Públicos (Luz, Gas, Agua, Internet)',
  'Impuestos y Tasas',
  'Alquileres y Expensas',
  'Logística y Fletes',
  'Mantenimiento y Limpieza',
  'Honorarios Profesionales',
  'Librería e Insumos de Oficina',
  'Publicidad y Marketing',
  'Gastos Generales',
];

export class BotService {
  /**
   * Manejador principal de mensajes entrantes desde el webhook
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
            plan: {
              include: { prices: true },
            },
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

    // Validación de período de prueba de 7 días y estado de suscripción
    const isTrial = tenantUser.tenant.subscriptionStatus === 'TRIAL';
    const isTrialExpired = isTrial && new Date() > new Date(tenantUser.tenant.trialEndsAt);
    const isPastDue = tenantUser.tenant.subscriptionStatus === 'PAST_DUE';

    if (isTrialExpired || isPastDue) {
      if (isTrialExpired && !isPastDue) {
        await prisma.tenant.update({
          where: { id: tenantUser.tenantId },
          data: { subscriptionStatus: 'PAST_DUE' },
        });
      }

      const now = new Date();
      const currentPrice = tenantUser.tenant.plan?.prices.find(
        (p) => new Date(p.validFrom) <= now && (!p.validTo || new Date(p.validTo) >= now)
      );
      const priceStr = currentPrice ? `$ ${Number(currentPrice.amount).toLocaleString('es-AR')}` : '';

      const paywallMsg = `🔒 *Tu período de prueba gratuita de 7 días ha finalizado.*

Para continuar automatizando tus facturas y acceder a la grilla de pagos de tu *${tenantUser.tenant.plan?.name}* (${priceStr}/mes), activa tu suscripción:

👉 *Enlace de Pago Seguro (Mercado Pago):*
https://www.mercadopago.com.ar/subscriptions/checkout?pref_id=suscripcion_${tenantUser.tenant.id}

_Apenas se registre el pago, tu cuenta se reactivará de forma inmediata._`;

      await whatsappService.sendText(rawFrom, paywallMsg);
      return;
    }

    // 2. Si es un usuario registrado y envió un archivo multimedia (Foto o PDF)
    if (msg.hasMedia && msg.media?.url) {
      await this.handleMediaInvoice(tenantUser, rawFrom, msg.media);
      return;
    }

    // 3. Comprobar si el usuario registrado está en medio de un flujo activo
    const activeSession = await prisma.conversationSession.findUnique({
      where: { phoneNumber: cleanPhone },
    });

    if (activeSession && activeSession.state.startsWith('SUPPLIER_REG_')) {
      await this.handleSupplierRegistrationStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('SUPPLIER_EDIT_')) {
      await this.handleSupplierEditStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('INVOICE_REG_')) {
      await this.handleManualInvoiceRegistrationStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('INVOICE_EDIT_')) {
      await this.handleInvoiceEditStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state === 'WAITING_NEW_PAYMENT_DATE') {
      await this.handleNewPaymentDateStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('ADD_USER_')) {
      await this.handleAddUserStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('PAYMENT_REG_')) {
      await this.handleRegisterPaymentStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('INVOICE_CANCEL_')) {
      await this.handleInvoiceCancelStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('PAYMENT_REVERT_')) {
      await this.handlePaymentRevertStep(tenantUser, activeSession, rawFrom, text);
      return;
    }

    if (activeSession && activeSession.state.startsWith('TENANT_EDIT_')) {
      await this.handleTenantEditStep(tenantUser, activeSession, rawFrom, text);
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

      await whatsappService.sendButtons(rawFrom, welcomeMessage, [
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
        await whatsappService.sendText(rawFrom, 'Por favor, selecciona una opción válida: *1* (Básico), *2* (Profesional) o *3* (Ultra).');
        return;
      }

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'WAITING_COMPANY_CUIT',
          contextData: { chosenPlan, maxUsers, maxSuppliers, maxInvoices },
        },
      });

      await whatsappService.sendText(
        rawFrom,
        `✅ Has seleccionado el *Plan ${chosenPlan}*.\n\nPara dar de alta tu empresa, por favor escribe el *CUIT* de tu empresa (11 dígitos o con guiones ej: 20-12432936-2):`
      );
      return;
    }

    // Ingreso y validación estricta de CUIT (11 dígitos numéricos o 13 con guiones)
    if (session.state === 'WAITING_COMPANY_CUIT') {
      const rawText = text.trim();
      const cleanCuit = rawText.replace(/\D/g, '');

      const hasHyphens = rawText.includes('-');
      const isValidWithHyphens = hasHyphens && /^\d{2}-\d{8}-\d{1}$/.test(rawText);
      const isValidNumeric = !hasHyphens && /^\d{11}$/.test(cleanCuit);

      if (!isValidWithHyphens && !isValidNumeric) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ *Formato de CUIT inválido.*\nEl CUIT debe tener exactamente *11 dígitos numéricos* (ej: 20124329362) o *13 caracteres con guiones* (ej: 20-12432936-2).\n\nPor favor, escríbelo nuevamente:'
        );
        return;
      }

      const formattedCuit = isValidWithHyphens
        ? rawText
        : `${cleanCuit.slice(0, 2)}-${cleanCuit.slice(2, 10)}-${cleanCuit.slice(10)}`;

      const ctx = (session.contextData as any) || {};
      ctx.cuit = formattedCuit;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'WAITING_COMPANY_NAME',
          contextData: ctx,
        },
      });

      await whatsappService.sendText(rawFrom, '👍 Perfecto. Ahora dinos la *Razón Social o Nombre de Fantasía* de tu empresa:');
      return;
    }

    // Ingreso de Razón Social y Creación de Cuenta
    if (session.state === 'WAITING_COMPANY_NAME') {
      const companyName = text.trim();
      const ctx = (session.contextData as any) || {};

      try {
        // Buscar el plan seleccionado en la base de datos
        const planCode = (ctx.chosenPlan || 'BASIC') as any;
        const plan = await prisma.plan.findUnique({
          where: { code: planCode },
        });

        // 7 días de prueba gratuita
        const trialDays = 7;
        const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
        const friendlyTrialDate = trialEndsAt.toLocaleDateString('es-AR');

        // Crear Tenant y TenantUser
        const tenant = await prisma.tenant.create({
          data: {
            cuit: ctx.cuit || '00-00000000-0',
            businessName: companyName,
            planId: plan ? plan.id : undefined,
            subscriptionStatus: 'TRIAL',
            trialEndsAt: trialEndsAt,
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

        const planName = plan ? plan.name : `Plan ${planCode}`;
        const maxPhones = plan ? plan.maxUsers : 1;

        const successMessage = `🎉 *¡Felicitaciones! Tu cuenta para ${companyName} ha sido creada con éxito.*

*Configuración Inicial:*
* CUIT: ${tenant.cuit}
* Plan: ${planName} (Permite hasta ${maxPhones} celulares)
* 🎁 *Prueba Gratuita:* 7 días activos hasta el *${friendlyTrialDate}*
* Días de pago fijados: *Martes y Jueves*

🚀 *¡Ya puedes empezar!*
* 📸 *Envía una foto o PDF:* Carga automática con IA.
* 📝 *Escribe "Cargar factura":* Registro manual si no tienes comprobante digital.
* 👥 *Escribe "Registrar nuevo proveedor":* Alta manual de proveedores.
${maxPhones > 1 ? '* 📱 *Escribe "Cargar celular":* Para autorizar otros celulares de tu equipo (hasta ' + maxPhones + ').\n' : ''}
💡 _Escribe *"Menu"* o *"Ayuda"* en cualquier momento para ver todas las opciones disponibles._`;

        await whatsappService.sendText(rawFrom, successMessage);
      } catch (err: any) {
        console.error('[BotService] Error creando empresa:', err);
        await whatsappService.sendText(rawFrom, 'Hubo un inconveniente creando la cuenta. Si ya estabas registrado, intenta escribir "Hola".');
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

    await whatsappService.sendText(rawFrom, msg);
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
        await whatsappService.sendText(rawFrom, '⚠️ El nombre no puede estar vacío. Por favor escribe el nombre o razón social:');
        return;
      }

      ctx.businessName = businessName;

      // Obtener categorías existentes (globales del catálogo o propias de la empresa)
      const allCategories = await prisma.category.findMany({
        where: {
          OR: [{ tenantId: null }, { tenantId: tenantUser.tenantId }],
        },
      });

      // Ordenar respetando el orden preferido (1 al 10) y luego las personalizadas
      const sortedCategories = allCategories.sort((a, b) => {
        const idxA = PREFERRED_CATEGORIES.indexOf(a.name);
        const idxB = PREFERRED_CATEGORIES.indexOf(b.name);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.name.localeCompare(b.name);
      });

      let categoryPrompt = `👍 *Nombre:* ${businessName}\n\n🏷️ *Rubro o Categoría (Obligatorio):*\n`;
      if (sortedCategories.length > 0) {
        categoryPrompt += `Selecciona el *número* del rubro correspondiente:\n\n`;
        sortedCategories.forEach((c, idx) => {
          categoryPrompt += `${idx + 1}️⃣ ${c.name}\n`;
        });
        categoryPrompt += `\n_Responde con el número de la categoría (ej: 1) o escribe un nuevo rubro:_`;
      } else {
        categoryPrompt += `Escribe el rubro o categoría comercial (ej: Ferretería, Insumos, Alimentos, etc.):\n`;
      }

      ctx.categoriesList = sortedCategories.map((c) => ({ id: c.id, name: c.name }));

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'SUPPLIER_REG_CATEGORY',
          contextData: ctx,
        },
      });

      await whatsappService.sendText(rawFrom, categoryPrompt);
      return;
    }

    // Paso 2: Recibe Rubro -> Pide Teléfono (Obligatorio)
    if (session.state === 'SUPPLIER_REG_CATEGORY') {
      const input = text.trim();
      if (!input) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ El rubro es obligatorio. Por favor responde con el número o nombre de la categoría:'
        );
        return;
      }

      const categoriesList: { id: string; name: string }[] = ctx.categoriesList || [];
      let category: any = null;

      // 1. Verificar si respondió con un número de la lista (ej: 1, 2, 10)
      const num = parseInt(input, 10);
      if (!isNaN(num)) {
        if (num >= 1 && num <= categoriesList.length) {
          const selected = categoriesList[num - 1];
          category = await prisma.category.findUnique({ where: { id: selected.id } });
        } else {
          await whatsappService.sendText(
            rawFrom,
            `⚠️ Opción no válida. Por favor responde con un número del 1 al ${categoriesList.length} o escribe el nombre del rubro:`
          );
          return;
        }
      } else {
        // 2. Si escribió texto, buscar por coincidencia de nombre o crear nueva categoría
        category = await prisma.category.findFirst({
          where: {
            name: { equals: input, mode: 'insensitive' },
            OR: [{ tenantId: null }, { tenantId: tenantUser.tenantId }],
          },
        });

        if (!category) {
          category = await prisma.category.create({
            data: {
              tenantId: tenantUser.tenantId,
              name: input,
            },
          });
        }
      }

      if (!category) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ No se pudo asignar la categoría. Por favor escribe el número o nombre del rubro:'
        );
        return;
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
      await whatsappService.sendText(rawFrom, phonePrompt);
      return;
    }

    // Paso 3: Recibe Teléfono -> Pide CUIT / Datos Bancarios Opcionales
    if (session.state === 'SUPPLIER_REG_PHONE') {
      const cleanInputPhone = text.replace(/\D/g, '');
      if (cleanInputPhone.length < 8) {
        await whatsappService.sendText(rawFrom, '⚠️ Por favor ingresa un número de teléfono válido:');
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
      await whatsappService.sendText(rawFrom, optionalPrompt);
      return;
    }

    // Paso 4: Recibe Datos Opcionales o "Omitir" -> Crea Proveedor en DB
    if (session.state === 'SUPPLIER_REG_OPTIONAL') {
      const lower = text.toLowerCase();
      let cuit: string | null = null;
      let alias: string | null = null;
      let cbu: string | null = null;

      if (!lower.includes('omitir') && !lower.includes('no') && !lower.includes('ninguno')) {
        const cuitMatch = text.match(/\b\d{2}[-]?\d{8}[-]?\d{1}\b/);
        if (cuitMatch) {
          cuit = cuitMatch[0];
        }

        const aliasMatch = text.match(/alias[:\s]+([a-zA-Z0-9.\-_]+)/i);
        if (aliasMatch) {
          alias = aliasMatch[1];
        }

        const cbuMatch = text.match(/\b\d{22}\b/);
        if (cbuMatch) {
          cbu = cbuMatch[0];
        }
      }

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

      await prisma.conversationSession.delete({ where: { id: session.id } });

      const finalMsg = `🎉 *¡Proveedor Registrado Exitosamente!*

🏢 *Nombre:* ${supplier.businessName}
🏷️ *Rubro:* ${supplier.category.name}
📱 *Teléfono:* ${supplier.phone}
🆔 *CUIT:* ${supplier.cuit || '_No informado (informal)_'}
🏦 *Datos de Pago:* ${alias ? `Alias: ${alias}` : cbu ? `CBU: ${cbu}` : '_No informados_'}

💡 *Siguiente paso:* Ya puedes cargarle una factura escribiendo *"Cargar factura"* o enviando una foto/PDF del comprobante.`;

      await whatsappService.sendText(rawFrom, finalMsg);
      return;
    }
  }

  /**
   * Flujo de Modificación / Edición de Proveedor (WhatsApp)
   */
  private async startSupplierEditFlow(
    tenantUser: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;

    // Buscar proveedores existentes de la empresa
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenantUser.tenantId },
      include: { category: true, bankAccounts: true },
      orderBy: { businessName: 'asc' },
    });

    if (suppliers.length === 0) {
      await whatsappService.sendText(
        rawFrom,
        '⚠️ *Aún no tienes proveedores registrados.* Para registrar uno nuevo, escribe *"Registrar nuevo proveedor"*.'
      );
      return;
    }

    // Verificar si el usuario ya especificó el nombre en el comando (ej: "editar proveedor ferretería")
    const searchName = text
      .replace(/^(editar|modificar|actualizar|cambiar)(\s+un)?\s+proveedor\s*/i, '')
      .trim()
      .toLowerCase();

    let selectedSupplier = null;
    if (searchName.length >= 2) {
      selectedSupplier = suppliers.find(
        (s) =>
          s.businessName.toLowerCase() === searchName ||
          s.businessName.toLowerCase().includes(searchName)
      );
    }

    // Si solo hay un proveedor registrado, seleccionarlo directamente
    if (!selectedSupplier && suppliers.length === 1) {
      selectedSupplier = suppliers[0];
    }

    if (selectedSupplier) {
      await prisma.conversationSession.upsert({
        where: { phoneNumber: cleanPhone },
        update: {
          state: 'SUPPLIER_EDIT_FIELD_SELECT',
          contextData: {
            tenantId: tenantUser.tenantId,
            supplierId: selectedSupplier.id,
            supplierName: selectedSupplier.businessName,
          },
        },
        create: {
          phoneNumber: cleanPhone,
          state: 'SUPPLIER_EDIT_FIELD_SELECT',
          contextData: {
            tenantId: tenantUser.tenantId,
            supplierId: selectedSupplier.id,
            supplierName: selectedSupplier.businessName,
          },
        },
      });

      await this.sendSupplierEditFieldPrompt(rawFrom, selectedSupplier);
      return;
    }

    // Si hay varios proveedores, mostrar la lista numerada
    let prompt = `📝 *Modificación de Proveedor*\n\nSelecciona el número del proveedor que deseas editar:\n\n`;
    suppliers.forEach((s, idx) => {
      prompt += `${idx + 1}️⃣ *${s.businessName}* (${s.category?.name || 'Sin rubro'})\n`;
    });
    prompt += `\n_Responde con el número de la lista o escribe el nombre del proveedor (o escribe *Cancelar* para salir):_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'SUPPLIER_EDIT_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          suppliersList: suppliers.map((s) => ({ id: s.id, name: s.businessName })),
        },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'SUPPLIER_EDIT_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          suppliersList: suppliers.map((s) => ({ id: s.id, name: s.businessName })),
        },
      },
    });

    await whatsappService.sendText(rawFrom, prompt);
  }

  private async sendSupplierEditFieldPrompt(rawFrom: string, supplier: any): Promise<void> {
    const bank = supplier.bankAccounts?.[0];
    const bankStr = bank?.alias ? `Alias: ${bank.alias}` : bank?.cbuCvu ? `CBU: ${bank.cbuCvu}` : '_No informado_';

    const msg = `🏢 *Editar Proveedor: ${supplier.businessName}*

1️⃣ *Razón Social / Nombre:* ${supplier.businessName}
2️⃣ *Rubro / Categoría:* ${supplier.category?.name || 'Sin Rubro'}
3️⃣ *Teléfono / WhatsApp:* ${supplier.phone}
4️⃣ *CBU / Alias Bancario:* ${bankStr}

_Responde con el número del dato que deseas modificar (1 al 4) o escribe *Cancelar* para salir:_`;

    await whatsappService.sendText(rawFrom, msg);
  }

  private async sendSupplierUpdatedConfirmation(
    rawFrom: string,
    supplier: any,
    detail: string
  ): Promise<void> {
    const bank = supplier.bankAccounts?.[0];
    const bankStr = bank?.alias ? `Alias: ${bank.alias}` : bank?.cbuCvu ? `CBU: ${bank.cbuCvu}` : '_No informado_';

    const msg = `✅ *¡Proveedor actualizado con éxito!*
_${detail}_

🏢 *Razón Social:* ${supplier.businessName}
🏷️ *Rubro:* ${supplier.category?.name || 'Sin Rubro'}
📱 *Teléfono:* ${supplier.phone}
🆔 *CUIT:* ${supplier.cuit || '_No informado_'}
🏦 *Datos de Pago:* ${bankStr}

💡 _Los pagos y notificaciones futuras utilizarán estos nuevos datos._`;

    await whatsappService.sendText(rawFrom, msg);
  }

  private async handleSupplierEditStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};
    const input = text.trim();
    const lower = input.toLowerCase();

    // Salida global / Cancelación
    if (lower === 'cancelar' || lower === 'salir' || lower === 'volver') {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '❌ Operación cancelada. El proveedor no fue modificado.');
      return;
    }

    // Paso 1: Selección de proveedor de la lista
    if (session.state === 'SUPPLIER_EDIT_SELECT') {
      const suppliersList: { id: string; name: string }[] = ctx.suppliersList || [];
      let selectedSupplier: any = null;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= suppliersList.length) {
        selectedSupplier = await prisma.supplier.findUnique({
          where: { id: suppliersList[num - 1].id },
          include: { category: true, bankAccounts: true },
        });
      } else {
        selectedSupplier = await prisma.supplier.findFirst({
          where: {
            tenantId: tenantUser.tenantId,
            businessName: { contains: input, mode: 'insensitive' },
          },
          include: { category: true, bankAccounts: true },
        });
      }

      if (!selectedSupplier) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Proveedor no identificado. Por favor responde con el número de la lista o escribe *Cancelar*:'
        );
        return;
      }

      ctx.supplierId = selectedSupplier.id;
      ctx.supplierName = selectedSupplier.businessName;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'SUPPLIER_EDIT_FIELD_SELECT',
          contextData: ctx,
        },
      });

      await this.sendSupplierEditFieldPrompt(rawFrom, selectedSupplier);
      return;
    }

    // Paso 2: Selección del campo a modificar (1=Nombre, 2=Rubro, 3=Teléfono, 4=CBU/Alias)
    if (session.state === 'SUPPLIER_EDIT_FIELD_SELECT') {
      if (input === '1' || lower.includes('nombre') || lower.includes('razon') || lower.includes('razón')) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'SUPPLIER_EDIT_VAL_NAME',
            contextData: ctx,
          },
        });
        await whatsappService.sendText(
          rawFrom,
          `✏️ *Modificar Nombre / Razón Social*\n\nEscribe el nuevo nombre para *${ctx.supplierName}*:\n\n_O escribe *Cancelar* para salir._`
        );
        return;
      }

      if (input === '2' || lower.includes('rubro') || lower.includes('categoria') || lower.includes('categoría')) {
        const allCategories = await prisma.category.findMany({
          where: {
            OR: [{ tenantId: null }, { tenantId: tenantUser.tenantId }],
          },
        });

        const sortedCategories = allCategories.sort((a, b) => {
          const idxA = PREFERRED_CATEGORIES.indexOf(a.name);
          const idxB = PREFERRED_CATEGORIES.indexOf(b.name);
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          if (idxA !== -1) return -1;
          if (idxB !== -1) return 1;
          return a.name.localeCompare(b.name);
        });

        let catPrompt = `🏷️ *Modificar Rubro / Categoría para ${ctx.supplierName}*\n\nSelecciona el *número* del nuevo rubro correspondiente:\n\n`;
        sortedCategories.forEach((c, idx) => {
          catPrompt += `${idx + 1}️⃣ ${c.name}\n`;
        });
        catPrompt += `\n_Responde con el número de la categoría (ej: 1) o escribe un nuevo rubro (o *Cancelar*):_`;

        ctx.categoriesList = sortedCategories.map((c) => ({ id: c.id, name: c.name }));

        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'SUPPLIER_EDIT_VAL_CATEGORY',
            contextData: ctx,
          },
        });

        await whatsappService.sendText(rawFrom, catPrompt);
        return;
      }

      if (
        input === '3' ||
        lower.includes('telefono') ||
        lower.includes('teléfono') ||
        lower.includes('whatsapp') ||
        lower.includes('celular')
      ) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'SUPPLIER_EDIT_VAL_PHONE',
            contextData: ctx,
          },
        });
        await whatsappService.sendText(
          rawFrom,
          `📱 *Modificar Teléfono / WhatsApp para ${ctx.supplierName}*\n\nIngresa el nuevo número de celular o WhatsApp:\n\n_O escribe *Cancelar* para salir._`
        );
        return;
      }

      if (
        input === '4' ||
        lower.includes('cbu') ||
        lower.includes('alias') ||
        lower.includes('banco') ||
        lower.includes('bancario') ||
        lower.includes('cuenta')
      ) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'SUPPLIER_EDIT_VAL_BANK',
            contextData: ctx,
          },
        });
        await whatsappService.sendText(
          rawFrom,
          `🏦 *Modificar Datos Bancarios para ${ctx.supplierName}*\n\nIngresa el nuevo Alias (ej: "PROVEEDOR.PAGOS") o CBU de 22 dígitos (o ambos):\n\n_Si deseas borrar los datos bancarios responde *Eliminar*, o *Cancelar* para salir._`
        );
        return;
      }

      await whatsappService.sendText(
        rawFrom,
        '⚠️ Opción no válida. Responde con un número del 1 al 4 para elegir el dato a modificar (o escribe *Cancelar*):'
      );
      return;
    }

    // Paso 3A: Guardar nuevo nombre
    if (session.state === 'SUPPLIER_EDIT_VAL_NAME') {
      const newName = input;
      if (!newName || newName.length < 2) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ El nombre debe tener al menos 2 caracteres. Por favor escribe el nuevo nombre:'
        );
        return;
      }

      const updated = await prisma.supplier.update({
        where: { id: ctx.supplierId },
        data: { businessName: newName },
        include: { category: true, bankAccounts: true },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendSupplierUpdatedConfirmation(rawFrom, updated, 'Razón Social actualizada');
      return;
    }

    // Paso 3B: Guardar nuevo rubro
    if (session.state === 'SUPPLIER_EDIT_VAL_CATEGORY') {
      const categoriesList: { id: string; name: string }[] = ctx.categoriesList || [];
      let category: any = null;

      const num = parseInt(input, 10);
      if (!isNaN(num)) {
        if (num >= 1 && num <= categoriesList.length) {
          const selected = categoriesList[num - 1];
          category = await prisma.category.findUnique({ where: { id: selected.id } });
        } else {
          await whatsappService.sendText(
            rawFrom,
            `⚠️ Opción no válida. Responde con un número del 1 al ${categoriesList.length} o escribe el nombre del rubro:`
          );
          return;
        }
      } else {
        category = await prisma.category.findFirst({
          where: {
            name: { equals: input, mode: 'insensitive' },
            OR: [{ tenantId: null }, { tenantId: tenantUser.tenantId }],
          },
        });

        if (!category) {
          category = await prisma.category.create({
            data: {
              tenantId: tenantUser.tenantId,
              name: input,
            },
          });
        }
      }

      if (!category) {
        await whatsappService.sendText(rawFrom, '⚠️ No se pudo asignar la categoría. Intenta nuevamente:');
        return;
      }

      const updated = await prisma.supplier.update({
        where: { id: ctx.supplierId },
        data: { categoryId: category.id },
        include: { category: true, bankAccounts: true },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendSupplierUpdatedConfirmation(rawFrom, updated, `Rubro actualizado a "${category.name}"`);
      return;
    }

    // Paso 3C: Guardar nuevo teléfono
    if (session.state === 'SUPPLIER_EDIT_VAL_PHONE') {
      const cleanDigits = input.replace(/\D/g, '');
      if (cleanDigits.length < 8) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Por favor ingresa un número de teléfono válido (mínimo 8 dígitos):'
        );
        return;
      }

      const updated = await prisma.supplier.update({
        where: { id: ctx.supplierId },
        data: { phone: input },
        include: { category: true, bankAccounts: true },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendSupplierUpdatedConfirmation(rawFrom, updated, `Teléfono actualizado a ${input}`);
      return;
    }

    // Paso 3D: Guardar nuevos datos bancarios
    if (session.state === 'SUPPLIER_EDIT_VAL_BANK') {
      if (lower === 'eliminar' || lower === 'borrar' || lower === 'quitar') {
        await prisma.supplierBankAccount.deleteMany({
          where: { supplierId: ctx.supplierId },
        });

        const updated = await prisma.supplier.findUnique({
          where: { id: ctx.supplierId },
          include: { category: true, bankAccounts: true },
        });

        await prisma.conversationSession.delete({ where: { id: session.id } });
        await this.sendSupplierUpdatedConfirmation(rawFrom, updated, 'Datos bancarios eliminados');
        return;
      }

      const cbuMatch = input.match(/\b\d{22}\b/);
      const aliasMatch =
        input.match(/alias[:\s]+([a-zA-Z0-9.\-_]+)/i) ||
        (!cbuMatch && input.match(/^[a-zA-Z0-9.\-_]{4,}$/) ? [null, input] : null);

      const cbu = cbuMatch ? cbuMatch[0] : null;
      const alias = aliasMatch ? aliasMatch[1] : null;

      if (!cbu && !alias) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ No se reconoció un CBU (22 dígitos) ni Alias válido. Ingresa el Alias (ej: "PROVEEDOR.PAGOS") o CBU (o escribe *Eliminar* / *Cancelar*):'
        );
        return;
      }

      const existingBank = await prisma.supplierBankAccount.findFirst({
        where: { supplierId: ctx.supplierId },
      });

      if (existingBank) {
        await prisma.supplierBankAccount.update({
          where: { id: existingBank.id },
          data: {
            ...(cbu ? { cbuCvu: cbu } : {}),
            ...(alias ? { alias: alias } : {}),
          },
        });
      } else {
        await prisma.supplierBankAccount.create({
          data: {
            supplierId: ctx.supplierId,
            cbuCvu: cbu,
            alias: alias,
            isPrimary: true,
          },
        });
      }

      const updated = await prisma.supplier.findUnique({
        where: { id: ctx.supplierId },
        include: { category: true, bankAccounts: true },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendSupplierUpdatedConfirmation(rawFrom, updated, 'Datos bancarios actualizados');
      return;
    }
  }

  /**
   * Flujo de Carga Manual de Factura / Boleta (WhatsApp)
   */
  private async startManualInvoiceRegistration(tenantUser: any, rawFrom: string): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;

    // Buscar proveedores existentes de la empresa
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenantUser.tenantId },
      include: { category: true },
      orderBy: { businessName: 'asc' },
    });

    if (suppliers.length === 0) {
      await whatsappService.sendText(
        rawFrom,
        `⚠️ *Aún no tienes proveedores registrados.*

Para cargar una factura manual primero necesitas al menos un proveedor.
Puedes darlo de alta escribiendo:
👉 *"Quiero dar de alta un nuevo proveedor"*`
      );
      return;
    }

    let supplierPrompt = `📝 *Carga Manual de Factura*\n\nSelecciona el proveedor para esta factura:\n\n`;
    suppliers.forEach((s, idx) => {
      supplierPrompt += `${idx + 1}️⃣ *${s.businessName}* (${s.category.name})\n`;
    });
    supplierPrompt += `\n_Responde con el número de la lista o el nombre del proveedor:_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'INVOICE_REG_SUPPLIER',
        contextData: {
          tenantId: tenantUser.tenantId,
          suppliersList: suppliers.map((s) => ({ id: s.id, name: s.businessName })),
        },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'INVOICE_REG_SUPPLIER',
        contextData: {
          tenantId: tenantUser.tenantId,
          suppliersList: suppliers.map((s) => ({ id: s.id, name: s.businessName })),
        },
      },
    });

    await whatsappService.sendText(rawFrom, supplierPrompt);
  }

  private async handleManualInvoiceRegistrationStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};

    // Paso 1: Selección de Proveedor -> Solicitar Monto
    if (session.state === 'INVOICE_REG_SUPPLIER') {
      const suppliersList = ctx.suppliersList || [];
      const numSelection = parseInt(text.trim(), 10);
      let selectedSupplier: any = null;

      if (!isNaN(numSelection) && numSelection >= 1 && numSelection <= suppliersList.length) {
        selectedSupplier = suppliersList[numSelection - 1];
      } else {
        selectedSupplier = suppliersList.find((s: any) =>
          s.name.toLowerCase().includes(text.trim().toLowerCase())
        );
      }

      if (!selectedSupplier) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Proveedor no identificado. Por favor responde con el número de la lista o el nombre exacto:'
        );
        return;
      }

      ctx.supplierId = selectedSupplier.id;
      ctx.supplierName = selectedSupplier.name;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'INVOICE_REG_AMOUNT',
          contextData: ctx,
        },
      });

      const amountPrompt = `🏢 *Proveedor seleccionado:* ${selectedSupplier.name}\n\n💰 *Monto Total de la Factura:*\nPor favor ingresa el monto a pagar (ej: 6100 o 6100.50):`;
      await whatsappService.sendText(rawFrom, amountPrompt);
      return;
    }

    // Paso 2: Recibe Monto -> Solicitar Fecha de Vencimiento
    if (session.state === 'INVOICE_REG_AMOUNT') {
      const cleanNum = text.replace(/[^0-9.,]/g, '').replace(',', '.');
      const amount = parseFloat(cleanNum);

      if (isNaN(amount) || amount <= 0) {
        await whatsappService.sendText(rawFrom, '⚠️ Monto inválido. Ingresa un número mayor a 0 (ej: 15400 o 6100.50):');
        return;
      }

      ctx.amount = amount;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'INVOICE_REG_DUE_DATE',
          contextData: ctx,
        },
      });

      const datePrompt = `💰 *Monto:* $ ${amount.toLocaleString('es-AR')}\n\n📅 *Fecha de Vencimiento:*\nIngresa la fecha de vencimiento (ej: 15/09/2026, o escribe "hoy", "mañana", "en 7 dias"):`;
      await whatsappService.sendText(rawFrom, datePrompt);
      return;
    }

    // Paso 3: Recibe Fecha de Vencimiento -> Solicitar Comprobante / Detalle
    if (session.state === 'INVOICE_REG_DUE_DATE') {
      const lower = text.toLowerCase().trim();
      let dueDate = new Date();

      if (lower.includes('hoy')) {
        dueDate = new Date();
      } else if (lower.includes('mañana')) {
        dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 1);
      } else if (lower.match(/en\s+(\d+)\s+d/)) {
        const days = parseInt(lower.match(/en\s+(\d+)\s+d/)![1], 10);
        dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + days);
      } else {
        // Formatos DD/MM/AAAA o YYYY-MM-DD
        const partsSlash = text.split('/');
        if (partsSlash.length === 3) {
          const dd = parseInt(partsSlash[0], 10);
          const mm = parseInt(partsSlash[1], 10) - 1;
          const yyyy = parseInt(partsSlash[2], 10);
          dueDate = new Date(yyyy, mm, dd);
        } else {
          const parsed = new Date(text);
          if (!isNaN(parsed.getTime())) {
            dueDate = parsed;
          }
        }
      }

      if (isNaN(dueDate.getTime())) {
        await whatsappService.sendText(rawFrom, '⚠️ Fecha no reconocida. Por favor ingresa en formato DD/MM/AAAA (ej: 15/09/2026):');
        return;
      }

      ctx.dueDate = dueDate.toISOString();

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'INVOICE_REG_DETAILS',
          contextData: ctx,
        },
      });

      const detailsPrompt = `📅 *Vencimiento:* ${dueDate.toLocaleDateString('es-AR')}\n\n🧾 *Número de Comprobante o Detalle:*\nEscribe el número de factura o detalle (ej: 0002-00001578 o "Compra de insumos de limpieza").\n_O escribe *Omitir* si no tienes el número:_`;
      await whatsappService.sendText(rawFrom, detailsPrompt);
      return;
    }

    // Paso 4: Recibe Detalle -> Guarda Factura en la Grilla y Confirma
    if (session.state === 'INVOICE_REG_DETAILS') {
      const lower = text.toLowerCase().trim();
      let invoiceNumber = 'S/N';
      let notes: string | null = null;

      if (!lower.includes('omitir') && !lower.includes('no')) {
        invoiceNumber = text.trim();
        notes = text.trim();
      }

      const dueDate = new Date(ctx.dueDate);
      const configuredDays = tenantUser.tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES';
      const scheduledDate = paymentGridService.calculateScheduledDate(dueDate, configuredDays);

      const invoice = await prisma.invoice.create({
        data: {
          tenantId: tenantUser.tenantId,
          supplierId: ctx.supplierId,
          invoiceNumber: invoiceNumber,
          invoiceType: 'Manual',
          amount: ctx.amount,
          dueDate: dueDate,
          scheduledPaymentDate: scheduledDate,
          status: 'EN_GRILLA',
          notes: notes,
        },
        include: {
          supplier: {
            include: { category: true, bankAccounts: true },
          },
        },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });

      const formattedAmount = new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
      }).format(ctx.amount);

      const friendlyGridDate = paymentGridService.formatFriendlyDate(scheduledDate);
      const bank = invoice.supplier.bankAccounts[0];
      const bankStr = bank?.alias ? `Alias: ${bank.alias}` : bank?.cbuCvu ? `CBU: ${bank.cbuCvu}` : 'Sin datos';

      const confirmMsg = `📄 *Factura Registrada con Éxito*

🏢 *Proveedor:* ${invoice.supplier.businessName} (${invoice.supplier.category.name})
🧾 *Comprobante:* ${invoice.invoiceNumber}
💰 *Total:* ${formattedAmount}
⏰ *Vencimiento:* ${dueDate.toLocaleDateString('es-AR')}
📅 *Agendada para pago el:* *${friendlyGridDate}*
🏦 *Datos de Pago:* ${bankStr}

_Quedó incorporada a tu grilla de pagos._`;

      await whatsappService.sendButtons(rawFrom, confirmMsg, [
        { id: `cambiar_fecha_${invoice.id}`, text: '📅 Cambiar Fecha' },
        { id: `posponer_${invoice.id}`, text: '⏰ Posponer 1 Sem.' },
        { id: `pagar_hoy_${invoice.id}`, text: '⚡ Pagar Hoy' },
      ]);
      return;
    }
  }

  /**
   * Flujo de Modificación / Edición de Factura (WhatsApp)
   */
  private async startInvoiceEditFlow(
    tenantUser: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;

    // Buscar facturas pendientes o activas en grilla
    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA'] },
      },
      include: {
        supplier: {
          include: { category: true, bankAccounts: true },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    if (invoices.length === 0) {
      await whatsappService.sendText(
        rawFrom,
        '⚠️ *No tienes facturas pendientes en tu grilla para modificar.* Para cargar una nueva, envía una foto o escribe *"Cargar factura"*.'
      );
      return;
    }

    // Verificar si el usuario ya especificó un número o nombre en el comando (ej: "editar factura 0001-00004523")
    const searchParam = text
      .replace(/^(editar|modificar|actualizar|corregir|cambiar)(\s+una)?\s+(factura|boleta|comprobante)\s*/i, '')
      .trim()
      .toLowerCase();

    let selectedInvoice = null;
    if (searchParam.length >= 2) {
      selectedInvoice = invoices.find(
        (inv) =>
          inv.invoiceNumber.toLowerCase().includes(searchParam) ||
          inv.supplier.businessName.toLowerCase().includes(searchParam)
      );
    }

    // Si solo hay una factura activa, seleccionarla directamente
    if (!selectedInvoice && invoices.length === 1) {
      selectedInvoice = invoices[0];
    }

    if (selectedInvoice) {
      await prisma.conversationSession.upsert({
        where: { phoneNumber: cleanPhone },
        update: {
          state: 'INVOICE_EDIT_FIELD_SELECT',
          contextData: {
            tenantId: tenantUser.tenantId,
            invoiceId: selectedInvoice.id,
            supplierName: selectedInvoice.supplier.businessName,
          },
        },
        create: {
          phoneNumber: cleanPhone,
          state: 'INVOICE_EDIT_FIELD_SELECT',
          contextData: {
            tenantId: tenantUser.tenantId,
            invoiceId: selectedInvoice.id,
            supplierName: selectedInvoice.supplier.businessName,
          },
        },
      });

      await this.sendInvoiceEditFieldPrompt(rawFrom, selectedInvoice);
      return;
    }

    // Si hay varias facturas, mostrar la lista numerada
    let prompt = `📋 *Modificación de Facturas*\n\nSelecciona el *número* de la factura que deseas modificar:\n\n`;
    invoices.forEach((inv, idx) => {
      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(inv.amount));
      const dueStr = inv.dueDate.toLocaleDateString('es-AR');
      prompt += `${idx + 1}️⃣ *${inv.supplier.businessName}* — ${inv.invoiceType || 'Factura'} Nº ${inv.invoiceNumber}\n   💵 ${amtStr} — 📅 Vto: ${dueStr}\n\n`;
    });
    prompt += `_Responde con el número de la lista (ej: 1) o escribe *Cancelar* para salir:_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'INVOICE_EDIT_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          invoicesList: invoices.map((inv) => ({
            id: inv.id,
            number: inv.invoiceNumber,
            supplier: inv.supplier.businessName,
          })),
        },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'INVOICE_EDIT_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          invoicesList: invoices.map((inv) => ({
            id: inv.id,
            number: inv.invoiceNumber,
            supplier: inv.supplier.businessName,
          })),
        },
      },
    });

    await whatsappService.sendText(rawFrom, prompt);
  }

  private async sendInvoiceEditFieldPrompt(rawFrom: string, invoice: any): Promise<void> {
    const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(invoice.amount));
    const dueStr = invoice.dueDate.toLocaleDateString('es-AR');
    const schedStr = paymentGridService.formatFriendlyDate(invoice.scheduledPaymentDate);

    const msg = `🧾 *Editar Factura: ${invoice.supplier.businessName}*
📄 *Comprobante actual:* ${invoice.invoiceType || 'Factura'} Nº ${invoice.invoiceNumber}

1️⃣ *Monto:* ${amtStr}
2️⃣ *Fecha de Vencimiento:* ${dueStr} (Agendada en grilla: ${schedStr})
3️⃣ *Número de Comprobante:* ${invoice.invoiceNumber}
4️⃣ *Tipo de Comprobante:* ${invoice.invoiceType || 'Factura'}

_Responde con el número del dato que deseas modificar (1 al 4) o escribe *Cancelar* para salir:_`;

    await whatsappService.sendText(rawFrom, msg);
  }

  private async sendInvoiceUpdatedConfirmation(
    rawFrom: string,
    invoice: any,
    detail: string
  ): Promise<void> {
    const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(invoice.amount));
    const dueStr = invoice.dueDate.toLocaleDateString('es-AR');
    const schedStr = paymentGridService.formatFriendlyDate(invoice.scheduledPaymentDate);

    const msg = `✅ *¡Factura actualizada con éxito!*
_${detail}_

🏢 *Proveedor:* ${invoice.supplier.businessName}
📄 *Comprobante:* ${invoice.invoiceType || 'Factura'} Nº ${invoice.invoiceNumber}
💰 *Monto:* ${amtStr}
⏰ *Nuevo Vencimiento:* ${dueStr}
📅 *Fecha en Grilla Semanal:* *${schedStr}*

💡 _Los cambios ya se encuentran reflejados en tu Grilla de Pagos y Dashboard._`;

    await whatsappService.sendText(rawFrom, msg);
  }

  private async handleInvoiceEditStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};
    const input = text.trim();
    const lower = input.toLowerCase();

    // Salida global / Cancelación
    if (lower === 'cancelar' || lower === 'salir' || lower === 'volver') {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '❌ Operación cancelada. La factura no fue modificada.');
      return;
    }

    // Paso 1: Selección de factura de la lista
    if (session.state === 'INVOICE_EDIT_SELECT') {
      const invoicesList: { id: string; number: string; supplier: string }[] = ctx.invoicesList || [];
      let selectedInvoice: any = null;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= invoicesList.length) {
        selectedInvoice = await prisma.invoice.findUnique({
          where: { id: invoicesList[num - 1].id },
          include: { supplier: { include: { category: true, bankAccounts: true } } },
        });
      } else {
        selectedInvoice = await prisma.invoice.findFirst({
          where: {
            tenantId: tenantUser.tenantId,
            status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA'] },
            OR: [
              { invoiceNumber: { contains: input, mode: 'insensitive' } },
              { supplier: { businessName: { contains: input, mode: 'insensitive' } } },
            ],
          },
          include: { supplier: { include: { category: true, bankAccounts: true } } },
        });
      }

      if (!selectedInvoice) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Factura no identificada. Por favor responde con el número de la lista o escribe *Cancelar*:'
        );
        return;
      }

      ctx.invoiceId = selectedInvoice.id;
      ctx.supplierName = selectedInvoice.supplier.businessName;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'INVOICE_EDIT_FIELD_SELECT',
          contextData: ctx,
        },
      });

      await this.sendInvoiceEditFieldPrompt(rawFrom, selectedInvoice);
      return;
    }

    // Paso 2: Selección del campo a modificar (1=Monto, 2=Vencimiento, 3=Número, 4=Tipo)
    if (session.state === 'INVOICE_EDIT_FIELD_SELECT') {
      if (
        input === '1' ||
        lower.includes('monto') ||
        lower.includes('importe') ||
        lower.includes('precio') ||
        lower.includes('total')
      ) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'INVOICE_EDIT_VAL_AMOUNT',
            contextData: ctx,
          },
        });
        await whatsappService.sendText(
          rawFrom,
          `💰 *Modificar Monto de la Factura*\n\nIngresa el nuevo monto a pagar para la factura de *${ctx.supplierName}* (ej: 45000 o 45000.50):\n\n_O escribe *Cancelar* para salir._`
        );
        return;
      }

      if (
        input === '2' ||
        lower.includes('vencimiento') ||
        lower.includes('fecha') ||
        lower.includes('vto')
      ) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'INVOICE_EDIT_VAL_DUEDATE',
            contextData: ctx,
          },
        });
        await whatsappService.sendText(
          rawFrom,
          `📅 *Modificar Fecha de Vencimiento*\n\nIngresa la nueva fecha de vencimiento (ej: "28/09/2026", "el próximo viernes" o "mañana"):\n\n_O escribe *Cancelar* para salir._`
        );
        return;
      }

      if (
        input === '3' ||
        lower.includes('numero') ||
        lower.includes('número') ||
        lower.includes('comprobante')
      ) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'INVOICE_EDIT_VAL_NUMBER',
            contextData: ctx,
          },
        });
        await whatsappService.sendText(
          rawFrom,
          `🔢 *Modificar Número de Comprobante*\n\nIngresa el nuevo número de comprobante (ej: "0001-00045239"):\n\n_O escribe *Cancelar* para salir._`
        );
        return;
      }

      if (input === '4' || lower.includes('tipo')) {
        const typePrompt = `📄 *Modificar Tipo de Comprobante para ${ctx.supplierName}*\n\nSelecciona el *número* correspondiente al tipo de comprobante:\n\n1️⃣ Factura A\n2️⃣ Factura B\n3️⃣ Factura C\n4️⃣ Recibo\n5️⃣ Ticket / Factura M / Otro\n\n_Responde con el número de la opción (1 al 5) o escribe el tipo directamente (o *Cancelar*):_`;

        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'INVOICE_EDIT_VAL_TYPE',
            contextData: ctx,
          },
        });

        await whatsappService.sendText(rawFrom, typePrompt);
        return;
      }

      await whatsappService.sendText(
        rawFrom,
        '⚠️ Opción no válida. Responde con un número del 1 al 4 para elegir el dato a modificar (o escribe *Cancelar*):'
      );
      return;
    }

    // Paso 3A: Guardar nuevo monto
    if (session.state === 'INVOICE_EDIT_VAL_AMOUNT') {
      const cleanAmountStr = input.replace(/[$ ]/g, '');
      let parsedAmount = NaN;
      if (cleanAmountStr.includes(',') && cleanAmountStr.includes('.')) {
        parsedAmount = parseFloat(cleanAmountStr.replace(/\./g, '').replace(',', '.'));
      } else if (cleanAmountStr.includes(',')) {
        parsedAmount = parseFloat(cleanAmountStr.replace(',', '.'));
      } else {
        parsedAmount = parseFloat(cleanAmountStr);
      }

      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Monto no válido. Por favor ingresa un número positivo (ej: 45000 o 45000.50):'
        );
        return;
      }

      const updated = await prisma.invoice.update({
        where: { id: ctx.invoiceId },
        data: { amount: parsedAmount },
        include: { supplier: { include: { category: true, bankAccounts: true } } },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendInvoiceUpdatedConfirmation(rawFrom, updated, 'Monto actualizado');
      return;
    }

    // Paso 3B: Guardar nueva fecha de vencimiento y recalcular grilla
    if (session.state === 'INVOICE_EDIT_VAL_DUEDATE') {
      const newDueDate = this.parseNaturalDate(input);
      if (!newDueDate) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Fecha no reconocida. Por favor ingresa un formato válido como "25/09/2026", "mañana" o "el próximo viernes":'
        );
        return;
      }

      const configuredDays = tenantUser.tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES';
      const newScheduledDate = paymentGridService.calculateScheduledDate(newDueDate, configuredDays);

      const updated = await prisma.invoice.update({
        where: { id: ctx.invoiceId },
        data: {
          dueDate: newDueDate,
          scheduledPaymentDate: newScheduledDate,
        },
        include: { supplier: { include: { category: true, bankAccounts: true } } },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendInvoiceUpdatedConfirmation(rawFrom, updated, 'Fecha de vencimiento y pago reprogramada');
      return;
    }

    // Paso 3C: Guardar nuevo número de comprobante
    if (session.state === 'INVOICE_EDIT_VAL_NUMBER') {
      if (!input || input.length < 1) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ El número de comprobante no puede estar vacío. Ingrésalo nuevamente:'
        );
        return;
      }

      const updated = await prisma.invoice.update({
        where: { id: ctx.invoiceId },
        data: { invoiceNumber: input },
        include: { supplier: { include: { category: true, bankAccounts: true } } },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendInvoiceUpdatedConfirmation(rawFrom, updated, `Número de comprobante actualizado a "${input}"`);
      return;
    }

    // Paso 3D: Guardar nuevo tipo de comprobante
    if (session.state === 'INVOICE_EDIT_VAL_TYPE') {
      let selectedType = input;
      if (input === '1') selectedType = 'Factura A';
      else if (input === '2') selectedType = 'Factura B';
      else if (input === '3') selectedType = 'Factura C';
      else if (input === '4') selectedType = 'Recibo';
      else if (input === '5') selectedType = 'Ticket';

      const updated = await prisma.invoice.update({
        where: { id: ctx.invoiceId },
        data: { invoiceType: selectedType },
        include: { supplier: { include: { category: true, bankAccounts: true } } },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });
      await this.sendInvoiceUpdatedConfirmation(rawFrom, updated, `Tipo de comprobante actualizado a "${selectedType}"`);
      return;
    }
  }

  /**
   * Flujo de Anulación de Factura (WhatsApp)
   */
  private async startInvoiceCancelFlow(
    tenantUser: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;

    // Buscar facturas activas o pendientes para anular
    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA', 'POSTERGADA'] },
      },
      include: {
        supplier: {
          include: { category: true, bankAccounts: true },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    if (invoices.length === 0) {
      await whatsappService.sendText(
        rawFrom,
        '⚠️ *No tienes facturas activas o pendientes para anular.*'
      );
      return;
    }

    // Verificar si el usuario ya especificó un número o nombre en el comando
    const searchParam = text
      .replace(/^(anular|cancelar|eliminar|borrar)(\s+una)?\s+(factura|boleta|comprobante)\s*/i, '')
      .trim()
      .toLowerCase();

    let selectedInvoice = null;
    if (searchParam.length >= 2) {
      selectedInvoice = invoices.find(
        (inv) =>
          inv.invoiceNumber.toLowerCase().includes(searchParam) ||
          inv.supplier.businessName.toLowerCase().includes(searchParam)
      );
    }

    if (!selectedInvoice && invoices.length === 1) {
      selectedInvoice = invoices[0];
    }

    if (selectedInvoice) {
      await prisma.conversationSession.upsert({
        where: { phoneNumber: cleanPhone },
        update: {
          state: 'INVOICE_CANCEL_CONFIRM',
          contextData: {
            tenantId: tenantUser.tenantId,
            invoiceId: selectedInvoice.id,
            invoiceNumber: selectedInvoice.invoiceNumber,
            supplierName: selectedInvoice.supplier.businessName,
          },
        },
        create: {
          phoneNumber: cleanPhone,
          state: 'INVOICE_CANCEL_CONFIRM',
          contextData: {
            tenantId: tenantUser.tenantId,
            invoiceId: selectedInvoice.id,
            invoiceNumber: selectedInvoice.invoiceNumber,
            supplierName: selectedInvoice.supplier.businessName,
          },
        },
      });

      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(selectedInvoice.amount));
      const dueStr = selectedInvoice.dueDate.toLocaleDateString('es-AR');

      const confirmPrompt = `⚠️ *¿Confirmas la anulación de esta factura?*

🏢 *Proveedor:* ${selectedInvoice.supplier.businessName}
📄 *Comprobante:* ${selectedInvoice.invoiceType || 'Factura'} Nº ${selectedInvoice.invoiceNumber}
💵 *Monto:* ${amtStr}
📅 *Vencimiento:* ${dueStr}

_Al anularla, la factura saldrá de tu grilla de pagos y de tus recordatorios diarios._

1️⃣ *Sí, anular factura*
2️⃣ *No, cancelar operación*

_Responde con el número de la opción (1 o 2):_`;

      await whatsappService.sendText(rawFrom, confirmPrompt);
      return;
    }

    // Si hay varias facturas, listarlas numeradas
    let prompt = `🗑️ *Anulación de Factura*\n\nSelecciona el *número* de la factura que deseas anular:\n\n`;
    invoices.forEach((inv, idx) => {
      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(inv.amount));
      const dueStr = inv.dueDate.toLocaleDateString('es-AR');
      prompt += `${idx + 1}️⃣ *${inv.supplier.businessName}* — ${inv.invoiceType || 'Factura'} Nº ${inv.invoiceNumber}\n   💵 ${amtStr} — 📅 Vto: ${dueStr}\n\n`;
    });
    prompt += `_Responde con el número de la lista (ej: 1) o escribe *Cancelar* para salir:_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'INVOICE_CANCEL_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          invoicesList: invoices.map((inv) => ({
            id: inv.id,
            number: inv.invoiceNumber,
            supplier: inv.supplier.businessName,
          })),
        },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'INVOICE_CANCEL_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          invoicesList: invoices.map((inv) => ({
            id: inv.id,
            number: inv.invoiceNumber,
            supplier: inv.supplier.businessName,
          })),
        },
      },
    });

    await whatsappService.sendText(rawFrom, prompt);
  }

  private async handleInvoiceCancelStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};
    const input = text.trim();
    const lower = input.toLowerCase();

    if (lower === 'cancelar' || lower === 'salir' || lower === 'volver') {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '❌ Operación cancelada. La factura continúa activa.');
      return;
    }

    // Paso 1: Selección de factura de la lista
    if (session.state === 'INVOICE_CANCEL_SELECT') {
      const invoicesList: { id: string; number: string; supplier: string }[] = ctx.invoicesList || [];
      let selectedInvoice: any = null;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= invoicesList.length) {
        selectedInvoice = await prisma.invoice.findUnique({
          where: { id: invoicesList[num - 1].id },
          include: { supplier: true },
        });
      } else {
        selectedInvoice = await prisma.invoice.findFirst({
          where: {
            tenantId: tenantUser.tenantId,
            status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA', 'POSTERGADA'] },
            OR: [
              { invoiceNumber: { contains: input, mode: 'insensitive' } },
              { supplier: { businessName: { contains: input, mode: 'insensitive' } } },
            ],
          },
          include: { supplier: true },
        });
      }

      if (!selectedInvoice) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Factura no identificada. Por favor responde con el número de la lista o escribe *Cancelar*:'
        );
        return;
      }

      ctx.invoiceId = selectedInvoice.id;
      ctx.invoiceNumber = selectedInvoice.invoiceNumber;
      ctx.supplierName = selectedInvoice.supplier.businessName;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'INVOICE_CANCEL_CONFIRM',
          contextData: ctx,
        },
      });

      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(selectedInvoice.amount));
      const dueStr = selectedInvoice.dueDate.toLocaleDateString('es-AR');

      const confirmPrompt = `⚠️ *¿Confirmas la anulación de esta factura?*

🏢 *Proveedor:* ${selectedInvoice.supplier.businessName}
📄 *Comprobante:* ${selectedInvoice.invoiceType || 'Factura'} Nº ${selectedInvoice.invoiceNumber}
💵 *Monto:* ${amtStr}
📅 *Vencimiento:* ${dueStr}

_Al anularla, la factura saldrá de tu grilla de pagos y de tus recordatorios diarios._

1️⃣ *Sí, anular factura*
2️⃣ *No, cancelar operación*

_Responde con el número de la opción (1 o 2):_`;

      await whatsappService.sendText(rawFrom, confirmPrompt);
      return;
    }

    // Paso 2: Confirmación expresa
    if (session.state === 'INVOICE_CANCEL_CONFIRM') {
      if (input === '1' || lower === 'si' || lower === 'sí' || lower.includes('anular')) {
        const updated = await prisma.invoice.update({
          where: { id: ctx.invoiceId },
          data: { status: 'CANCELADA' },
          include: { supplier: true },
        });

        await prisma.conversationSession.delete({ where: { id: session.id } });

        const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(updated.amount));

        const successMsg = `🚫 *¡Factura Anulada con Éxito!*

🏢 *Proveedor:* ${updated.supplier.businessName}
📄 *Comprobante:* ${updated.invoiceType || 'Factura'} Nº ${updated.invoiceNumber}
💵 *Monto:* ${amtStr}

💡 _El comprobante ha sido cancelado y ya no figura en tu Grilla Semanal de Pagos ni en los recordatorios._`;

        await whatsappService.sendText(rawFrom, successMsg);
        return;
      }

      if (input === '2' || lower === 'no' || lower.includes('cancelar')) {
        await prisma.conversationSession.delete({ where: { id: session.id } });
        await whatsappService.sendText(rawFrom, '👍 Operación cancelada. La factura continúa activa en tu grilla.');
        return;
      }

      await whatsappService.sendText(
        rawFrom,
        '⚠️ Opción no válida. Responde *1* para confirmar la anulación o *2* para mantener la factura:'
      );
      return;
    }
  }

  /**
   * Flujo de Reversión de Pago (WhatsApp)
   */
  private async startPaymentRevertFlow(
    tenantUser: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;

    // Buscar facturas con estado PAGADA
    const paidInvoices = await prisma.invoice.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        status: 'PAGADA',
      },
      include: {
        supplier: {
          include: { category: true, bankAccounts: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 15,
    });

    if (paidInvoices.length === 0) {
      await whatsappService.sendText(
        rawFrom,
        'ℹ️ *No tienes facturas marcadas como pagadas para revertir.*'
      );
      return;
    }

    // Verificar si el usuario especificó número o proveedor
    const searchParam = text
      .replace(/^(revertir|deshacer|cancelar)(\s+el)?\s+(pago|factura pagada)\s*/i, '')
      .trim()
      .toLowerCase();

    let selectedInvoice = null;
    if (searchParam.length >= 2) {
      selectedInvoice = paidInvoices.find(
        (inv) =>
          inv.invoiceNumber.toLowerCase().includes(searchParam) ||
          inv.supplier.businessName.toLowerCase().includes(searchParam)
      );
    }

    if (!selectedInvoice && paidInvoices.length === 1) {
      selectedInvoice = paidInvoices[0];
    }

    if (selectedInvoice) {
      await prisma.conversationSession.upsert({
        where: { phoneNumber: cleanPhone },
        update: {
          state: 'PAYMENT_REVERT_CONFIRM',
          contextData: {
            tenantId: tenantUser.tenantId,
            invoiceId: selectedInvoice.id,
            invoiceNumber: selectedInvoice.invoiceNumber,
            supplierName: selectedInvoice.supplier.businessName,
          },
        },
        create: {
          phoneNumber: cleanPhone,
          state: 'PAYMENT_REVERT_CONFIRM',
          contextData: {
            tenantId: tenantUser.tenantId,
            invoiceId: selectedInvoice.id,
            invoiceNumber: selectedInvoice.invoiceNumber,
            supplierName: selectedInvoice.supplier.businessName,
          },
        },
      });

      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(selectedInvoice.amount));

      const confirmPrompt = `↩️ *¿Confirmas la reversión del pago de esta factura?*

🏢 *Proveedor:* ${selectedInvoice.supplier.businessName}
📄 *Comprobante:* ${selectedInvoice.invoiceType || 'Factura'} Nº ${selectedInvoice.invoiceNumber}
💵 *Monto:* ${amtStr}

_Al revertir el pago, la factura volverá al estado *Pendiente / En Grilla* para su programación de pago._

1️⃣ *Sí, revertir pago y volver a la grilla*
2️⃣ *No, cancelar operación*

_Responde con el número de la opción (1 o 2):_`;

      await whatsappService.sendText(rawFrom, confirmPrompt);
      return;
    }

    // Si hay varias facturas pagadas, listarlas numeradas
    let prompt = `↩️ *Reversión de Pago Registrado*\n\nSelecciona el *número* del pago que deseas revertir:\n\n`;
    paidInvoices.forEach((inv, idx) => {
      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(inv.amount));
      const dueStr = inv.dueDate.toLocaleDateString('es-AR');
      prompt += `${idx + 1}️⃣ *${inv.supplier.businessName}* — ${inv.invoiceType || 'Factura'} Nº ${inv.invoiceNumber}\n   💵 ${amtStr} — 📅 Vto: ${dueStr}\n\n`;
    });
    prompt += `_Responde con el número de la lista (ej: 1) o escribe *Cancelar* para salir:_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'PAYMENT_REVERT_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          invoicesList: paidInvoices.map((inv) => ({
            id: inv.id,
            number: inv.invoiceNumber,
            supplier: inv.supplier.businessName,
          })),
        },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'PAYMENT_REVERT_SELECT',
        contextData: {
          tenantId: tenantUser.tenantId,
          invoicesList: paidInvoices.map((inv) => ({
            id: inv.id,
            number: inv.invoiceNumber,
            supplier: inv.supplier.businessName,
          })),
        },
      },
    });

    await whatsappService.sendText(rawFrom, prompt);
  }

  private async handlePaymentRevertStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};
    const input = text.trim();
    const lower = input.toLowerCase();

    if (lower === 'cancelar' || lower === 'salir' || lower === 'volver') {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '❌ Operación cancelada. El pago continúa registrado.');
      return;
    }

    // Paso 1: Selección de factura de la lista
    if (session.state === 'PAYMENT_REVERT_SELECT') {
      const invoicesList: { id: string; number: string; supplier: string }[] = ctx.invoicesList || [];
      let selectedInvoice: any = null;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= invoicesList.length) {
        selectedInvoice = await prisma.invoice.findUnique({
          where: { id: invoicesList[num - 1].id },
          include: { supplier: true },
        });
      } else {
        selectedInvoice = await prisma.invoice.findFirst({
          where: {
            tenantId: tenantUser.tenantId,
            status: 'PAGADA',
            OR: [
              { invoiceNumber: { contains: input, mode: 'insensitive' } },
              { supplier: { businessName: { contains: input, mode: 'insensitive' } } },
            ],
          },
          include: { supplier: true },
        });
      }

      if (!selectedInvoice) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Pago no identificado. Por favor responde con el número de la lista o escribe *Cancelar*:'
        );
        return;
      }

      ctx.invoiceId = selectedInvoice.id;
      ctx.invoiceNumber = selectedInvoice.invoiceNumber;
      ctx.supplierName = selectedInvoice.supplier.businessName;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'PAYMENT_REVERT_CONFIRM',
          contextData: ctx,
        },
      });

      const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(selectedInvoice.amount));

      const confirmPrompt = `↩️ *¿Confirmas la reversión del pago de esta factura?*

🏢 *Proveedor:* ${selectedInvoice.supplier.businessName}
📄 *Comprobante:* ${selectedInvoice.invoiceType || 'Factura'} Nº ${selectedInvoice.invoiceNumber}
💵 *Monto:* ${amtStr}

_Al revertir el pago, la factura volverá al estado *Pendiente / En Grilla* para su programación de pago._

1️⃣ *Sí, revertir pago y volver a la grilla*
2️⃣ *No, cancelar operación*

_Responde con el número de la opción (1 o 2):_`;

      await whatsappService.sendText(rawFrom, confirmPrompt);
      return;
    }

    // Paso 2: Confirmación expresa
    if (session.state === 'PAYMENT_REVERT_CONFIRM') {
      if (input === '1' || lower === 'si' || lower === 'sí' || lower.includes('revertir')) {
        const updated = await prisma.invoice.update({
          where: { id: ctx.invoiceId },
          data: { status: 'EN_GRILLA' },
          include: { supplier: true },
        });

        await prisma.conversationSession.delete({ where: { id: session.id } });

        const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(updated.amount));

        const successMsg = `↩️ *¡Pago Revertido Exitosamente!*

🏢 *Proveedor:* ${updated.supplier.businessName}
📄 *Comprobante:* ${updated.invoiceType || 'Factura'} Nº ${updated.invoiceNumber}
💵 *Monto:* ${amtStr}

💡 _La factura volvió a estar activa en tu Grilla Semanal de Pagos y Dashboard._`;

        await whatsappService.sendText(rawFrom, successMsg);
        return;
      }

      if (input === '2' || lower === 'no' || lower.includes('cancelar')) {
        await prisma.conversationSession.delete({ where: { id: session.id } });
        await whatsappService.sendText(rawFrom, '👍 Operación cancelada. El comprobante permanece como Pagado.');
        return;
      }

      await whatsappService.sendText(
        rawFrom,
        '⚠️ Opción no válida. Responde *1* para revertir el pago o *2* para mantenerlo como Pagado:'
      );
      return;
    }
  }

  /**
   * Formatea días de pago para visualización amigable
   */
  private formatDaysFriendly(daysStr: string): string {
    const dayMap: Record<string, string> = {
      LUNES: 'Lunes',
      MARTES: 'Martes',
      MIERCOLES: 'Miércoles',
      MIÉRCOLES: 'Miércoles',
      JUEVES: 'Jueves',
      VIERNES: 'Viernes',
      SABADO: 'Sábado',
      SÁBADO: 'Sábado',
      DOMINGO: 'Domingo',
    };
    const parts = daysStr.split(',').map((d) => dayMap[d.trim().toUpperCase()] || d.trim());
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} y ${parts[1]}`;
    return parts.slice(0, -1).join(', ') + ' y ' + parts[parts.length - 1];
  }

  /**
   * Flujo de Configuración y Modificación de Datos del Tenant (WhatsApp)
   */
  private async startTenantEditFlow(tenantUser: any, rawFrom: string): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantUser.tenantId },
      include: {
        plan: true,
        paymentGridConfig: true,
      },
    });

    if (!tenant) return;

    const currentDays = tenant.paymentGridConfig?.paymentDays || 'MARTES,JUEVES';
    const friendlyDays = this.formatDaysFriendly(currentDays);
    const planName = tenant.plan?.name || 'Plan Activo';

    const menu = `⚙️ *Configuración de Empresa: ${tenant.businessName}*
🆔 *CUIT:* ${tenant.cuit}
📦 *Plan Activo:* ${planName}

1️⃣ *Razón Social:* ${tenant.businessName}
2️⃣ *Días de Pago en Grilla:* ${friendlyDays}
3️⃣ *Cancelar*

_Responde con el número del dato que deseas modificar (1 o 2) o escribe *Cancelar*:_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'TENANT_EDIT_MENU',
        contextData: {
          tenantId: tenant.id,
          businessName: tenant.businessName,
          currentDays: currentDays,
        },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'TENANT_EDIT_MENU',
        contextData: {
          tenantId: tenant.id,
          businessName: tenant.businessName,
          currentDays: currentDays,
        },
      },
    });

    await whatsappService.sendText(rawFrom, menu);
  }

  private async handleTenantEditStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};
    const input = text.trim();
    const lower = input.toLowerCase();

    if (lower === 'cancelar' || lower === 'salir' || lower === 'volver') {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '❌ Operación cancelada. Los datos de la empresa no fueron modificados.');
      return;
    }

    if (session.state === 'TENANT_EDIT_MENU' && input === '3') {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '❌ Operación cancelada. Los datos de la empresa no fueron modificados.');
      return;
    }

    // Paso 1: Selección de opción del menú
    if (session.state === 'TENANT_EDIT_MENU') {
      if (input === '1' || lower.includes('razon') || lower.includes('razón') || lower.includes('nombre')) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'TENANT_EDIT_VAL_NAME',
            contextData: ctx,
          },
        });

        await whatsappService.sendText(
          rawFrom,
          `✏️ *Modificar Razón Social*\n\nEscribe el nuevo nombre o razón social de tu empresa:\n(Actual: *${ctx.businessName}*)\n\n_O escribe *Cancelar* para salir._`
        );
        return;
      }

      if (input === '2' || lower.includes('dias') || lower.includes('días') || lower.includes('grilla') || lower.includes('pago')) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: {
            state: 'TENANT_EDIT_VAL_DAYS',
            contextData: ctx,
          },
        });

        const friendlyDays = this.formatDaysFriendly(ctx.currentDays || 'MARTES,JUEVES');

        const prompt = `📅 *Modificar Días de Pago en Grilla Semanal*
(Actual: *${friendlyDays}*)

Selecciona el *número* de una de las combinaciones habituales o escribe tus días:

1️⃣ Martes y Jueves (Recomendado)
2️⃣ Lunes y Jueves
3️⃣ Miércoles y Viernes
4️⃣ Solo Viernes
5️⃣ Todos los días hábiles (Lunes a Viernes)

_Responde con el número de la opción (1 al 5) o escribe días específicos separados por coma (ej: "Lunes, Miércoles"):_`;

        await whatsappService.sendText(rawFrom, prompt);
        return;
      }

      await whatsappService.sendText(
        rawFrom,
        '⚠️ Opción no válida. Responde *1* para Razón Social o *2* para Días de Pago (o escribe *Cancelar*):'
      );
      return;
    }

    // Paso 2A: Guardar nueva razón social
    if (session.state === 'TENANT_EDIT_VAL_NAME') {
      if (!input || input.length < 2) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ La razón social debe tener al menos 2 caracteres. Ingrésala nuevamente:'
        );
        return;
      }

      const updated = await prisma.tenant.update({
        where: { id: tenantUser.tenantId },
        data: { businessName: input },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });

      const msg = `✅ *¡Razón Social actualizada con éxito!*

🏢 *Nueva Razón Social:* ${updated.businessName}
🆔 *CUIT:* ${updated.cuit}

💡 _El nuevo nombre se verá reflejado en tus reportes, dashboard y comprobantes enviados a proveedores._`;

      await whatsappService.sendText(rawFrom, msg);
      return;
    }

    // Paso 2B: Guardar nuevos días de pago y reprogramar facturas en grilla
    if (session.state === 'TENANT_EDIT_VAL_DAYS') {
      let newDaysStr = '';

      if (input === '1') newDaysStr = 'MARTES,JUEVES';
      else if (input === '2') newDaysStr = 'LUNES,JUEVES';
      else if (input === '3') newDaysStr = 'MIERCOLES,VIERNES';
      else if (input === '4') newDaysStr = 'VIERNES';
      else if (input === '5') newDaysStr = 'LUNES,MARTES,MIERCOLES,JUEVES,VIERNES';
      else {
        // Parsear días del texto libre
        const validDays = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
        const words = input
          .toUpperCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .split(/[\s,y]+/);

        const matched = validDays.filter((vd) => words.includes(vd));
        if (matched.length > 0) {
          newDaysStr = matched.join(',');
        }
      }

      if (!newDaysStr) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ No se reconocieron días válidos. Responde con un número del 1 al 5 o escribe los días (ej: "Lunes, Jueves"):'
        );
        return;
      }

      // 1. Actualizar configuración en DB
      await prisma.paymentGridConfig.upsert({
        where: { tenantId: tenantUser.tenantId },
        update: { paymentDays: newDaysStr },
        create: { tenantId: tenantUser.tenantId, paymentDays: newDaysStr },
      });

      // 2. Reprogramar automáticamente las facturas activas en grilla
      const pendingInvoices = await prisma.invoice.findMany({
        where: {
          tenantId: tenantUser.tenantId,
          status: 'EN_GRILLA',
        },
      });

      for (const inv of pendingInvoices) {
        const newSched = paymentGridService.calculateScheduledDate(inv.dueDate, newDaysStr);
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { scheduledPaymentDate: newSched },
        });
      }

      await prisma.conversationSession.delete({ where: { id: session.id } });

      const friendlyNewDays = this.formatDaysFriendly(newDaysStr);

      const msg = `✅ *¡Días de Pago en Grilla Actualizados!*

📅 *Nuevos Días de Corte:* *${friendlyNewDays}*
🔄 Se reprogramaron *${pendingInvoices.length} facturas pendientes* a las nuevas fechas de tu grilla semanal.

💡 _Los nuevos comprobantes que cargues se agendarán automáticamente respetando este esquema._`;

      await whatsappService.sendText(rawFrom, msg);
      return;
    }
  }

  /**
   * Procesa la recepción de una foto o PDF de factura con IA
   */
  private async handleMediaInvoice(tenantUser: any, rawFrom: string, media: any): Promise<void> {
    await whatsappService.startTyping(rawFrom);
    await whatsappService.sendText(rawFrom, '⏳ *Descargando y analizando tu comprobante con IA...* Dame unos segundos.');

    try {
      // 1. Descargar archivo multimedia
      const { buffer, mimeType } = await whatsappService.downloadMedia(media.url);

      // 2. Extraer información con Gemini Vision
      const extracted = await invoiceExtractorService.extractFromBuffer(buffer, mimeType);

      // 3. Buscar o crear la categoría (priorizando catálogo global o propio de la empresa)
      const categoryName = extracted.rubroSugerido || 'General';
      let category = await prisma.category.findFirst({
        where: {
          name: { equals: categoryName, mode: 'insensitive' },
          OR: [{ tenantId: null }, { tenantId: tenantUser.tenantId }],
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

      await whatsappService.stopTyping(rawFrom);

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

      await whatsappService.sendButtons(rawFrom, confirmText, [
        { id: `cambiar_fecha_${invoice.id}`, text: '📅 Cambiar Fecha' },
        { id: `posponer_${invoice.id}`, text: '⏰ Posponer 1 Sem.' },
        { id: `pagar_hoy_${invoice.id}`, text: '⚡ Pagar Hoy' },
      ]);
    } catch (error: any) {
      await whatsappService.stopTyping(rawFrom);
      console.error('[BotService] Error procesando factura:', error);
      await whatsappService.sendText(
        rawFrom,
        `❌ No pudimos procesar la factura automáticamente: ${error.message}.\nPor favor intenta enviar una foto más nítida o en formato PDF.`
      );
    }
  }

  /**
   * Comandos de texto y consultas para usuarios autenticados
   */
  private async handleRegisteredUserText(tenantUser: any, rawFrom: string, text: string): Promise<void> {
    const lower = text.toLowerCase().trim();

    // Invocación explícita del Menú de Opciones
    if (
      lower === 'menu' ||
      lower === 'menú' ||
      lower === 'ayuda' ||
      lower === 'help' ||
      lower === 'opciones' ||
      lower === 'hola' ||
      lower === 'inicio'
    ) {
      await this.sendHelpMenu(tenantUser, rawFrom);
      return;
    }

    // 0. Manejo de botones de envío de comprobante a proveedor
    if (text.startsWith('enviar_comprobante_')) {
      const invoiceId = text.replace('enviar_comprobante_', '').trim();
      await this.sendSupplierPaymentReceipt(tenantUser, rawFrom, invoiceId);
      return;
    }

    if (text === 'no_enviar_comprobante' || lower === 'no enviar') {
      await whatsappService.sendText(rawFrom, '👍 Perfecto. El pago quedó registrado en tu grilla y Dashboard.');
      return;
    }

    // 0.1 Manejo de botones e intenciones de reprogramación de fecha de pago
    if (
      text.startsWith('cambiar_fecha_') ||
      lower.includes('cambiar fecha') ||
      lower.includes('otra fecha') ||
      lower.includes('modificar fecha')
    ) {
      await this.initiateChangePaymentDate(tenantUser, rawFrom, text);
      return;
    }

    if (
      text.startsWith('posponer_') ||
      lower.includes('posponer') ||
      lower.includes('7 dias') ||
      lower.includes('7 días') ||
      lower.includes('1 semana') ||
      lower.includes('una semana')
    ) {
      await this.handlePostponeInvoice(tenantUser, rawFrom, text);
      return;
    }

    if (
      text.startsWith('pagar_hoy_') ||
      lower.includes('pagar hoy') ||
      lower.includes('pago hoy')
    ) {
      await this.handlePayTodayInvoice(tenantUser, rawFrom, text);
      return;
    }

    // 1. Atajo Menú 1: Carga Automática con Foto / PDF
    if (lower === '1' || lower === '1.' || lower.includes('como subir') || lower.includes('cargar foto')) {
      await whatsappService.sendText(
        rawFrom,
        '📸 *Carga Automática de Facturas y Proveedores:*\n\nSimplemente saca una foto con tu cámara a la factura o ticket (o adjunta un PDF) y envíalo a este chat.\n\nNuestra IA extraerá emisor, CUIT, montos, vencimiento y programará la fecha de pago en tu grilla semanal automáticamente.'
      );
      return;
    }

    // 2. Detección de intención para alta de proveedor
    const hasNuevo = lower.includes('nuevo') || lower.includes('nueva') || lower === '2' || lower === '2.';
    const hasProveedor = lower.includes('proveedor') || lower === '2' || lower === '2.';

    if (hasNuevo && hasProveedor) {
      await this.startSupplierRegistration(tenantUser, rawFrom);
      return;
    }

    // 2.1 Manejo de ambigüedad si menciona proveedor con intenciones de alta sin ambas palabras
    if (
      hasProveedor &&
      (lower.includes('alta') || lower.includes('crear') || lower.includes('registrar') || lower.includes('agregar'))
    ) {
      const ambiguityMsg = `Entiendo que quieres registrar un nuevo proveedor. Puedes hacerlo de esta manera:
• "Quiero dar de alta un nuevo proveedor"
• "Registrar nuevo proveedor"`;
      await whatsappService.sendText(rawFrom, ambiguityMsg);
      return;
    }

    // 2.2 Detección de intención para modificar/editar proveedor
    const isEditSupplier =
      lower.includes('editar proveedor') ||
      lower.includes('modificar proveedor') ||
      lower.includes('actualizar proveedor') ||
      lower.includes('cambiar proveedor') ||
      lower.includes('editar un proveedor') ||
      lower.includes('modificar un proveedor');

    if (isEditSupplier) {
      await this.startSupplierEditFlow(tenantUser, rawFrom, text);
      return;
    }

    // 3. Carga manual de facturas / invoices
    const isManualInvoice =
      lower === '3' ||
      lower === '3.' ||
      lower.includes('cargar factura') ||
      lower.includes('registrar factura') ||
      lower.includes('nueva factura') ||
      lower.includes('alta factura') ||
      lower.includes('cargar boleta') ||
      lower.includes('cargar ticket');

    if (isManualInvoice) {
      await this.startManualInvoiceRegistration(tenantUser, rawFrom);
      return;
    }

    // 3.1 Detección de intención para modificar/editar factura
    const isEditInvoice =
      lower.includes('editar factura') ||
      lower.includes('modificar factura') ||
      lower.includes('actualizar factura') ||
      lower.includes('corregir factura') ||
      lower.includes('cambiar factura') ||
      lower.includes('editar comprobante') ||
      lower.includes('modificar comprobante') ||
      lower.includes('editar boleta') ||
      lower.includes('modificar boleta');

    if (isEditInvoice) {
      await this.startInvoiceEditFlow(tenantUser, rawFrom, text);
      return;
    }

    // 3.2 Detección de intención para anular factura
    const isCancelInvoice =
      lower.includes('anular factura') ||
      lower.includes('cancelar factura') ||
      lower.includes('eliminar factura') ||
      lower.includes('borrar factura') ||
      lower.includes('dar de baja factura') ||
      lower.includes('anular comprobante') ||
      lower.includes('cancelar comprobante');

    if (isCancelInvoice) {
      await this.startInvoiceCancelFlow(tenantUser, rawFrom, text);
      return;
    }

    // 3.3 Detección de intención para revertir pago
    const isRevertPayment =
      lower.includes('revertir pago') ||
      lower.includes('deshacer pago') ||
      lower.includes('cancelar pago') ||
      lower.includes('revertir factura pagada') ||
      lower.includes('desmarcar pagada') ||
      lower.includes('revertir el pago');

    if (isRevertPayment) {
      await this.startPaymentRevertFlow(tenantUser, rawFrom, text);
      return;
    }

    // 3.4 Detección de intención para configurar empresa / días de pago / razón social
    const isTenantConfig =
      lower.includes('configurar empresa') ||
      lower.includes('modificar empresa') ||
      lower.includes('editar empresa') ||
      lower.includes('datos empresa') ||
      lower.includes('mi empresa') ||
      lower.includes('dias de pago') ||
      lower.includes('días de pago') ||
      lower.includes('cambiar dias') ||
      lower.includes('cambiar días') ||
      lower.includes('razon social') ||
      lower.includes('razón social') ||
      lower === 'configuracion' ||
      lower === 'configuración';

    if (isTenantConfig) {
      await this.startTenantEditFlow(tenantUser, rawFrom);
      return;
    }

    // 4. Ver pagos de hoy o de la semana
    if (lower === '4' || lower === '4.' || lower.includes('pagos') || lower.includes('hoy') || lower.includes('grilla')) {
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
        await whatsappService.sendText(rawFrom, '🎉 *No tienes pagos programados para los próximos 7 días.*');
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
      await whatsappService.sendText(rawFrom, report);
      return;
    }

    // 5. Registrar Pago de Factura (Todos los Planes)
    const isRegisterPayment =
      lower === '5' ||
      lower === '5.' ||
      lower.includes('registrar pago') ||
      lower.includes('pagar factura') ||
      lower.includes('marcar pagada') ||
      lower.includes('pago realizado') ||
      lower.includes('registrar un pago') ||
      lower.includes('hacer pago');

    if (isRegisterPayment) {
      await this.startRegisterPaymentFlow(tenantUser, rawFrom);
      return;
    }

    // 6. Dashboard Web
    if (
      lower === '6' ||
      lower === '6.' ||
      lower.includes('dashboard') ||
      lower.includes('panel') ||
      lower.includes('web')
    ) {
      const dashboardMsg = `🌐 *Dashboard Web en Tiempo Real*

Puedes consultar el estado de tus facturas, grilla de pagos y métricas por rubro en:
🔗 ${env.APP_BASE_URL}/api/dashboard/grid?tenantId=${tenantUser.tenantId}

💡 _En producción, este enlace contará con login web seguro y vista Kanban completa._`;
      await whatsappService.sendText(rawFrom, dashboardMsg);
      return;
    }

    // 7. Cargar / Autorizar Celular (Planes Profesional y Ultra)
    const isAddPhone =
      lower === '7' ||
      lower === '7.' ||
      lower.includes('cargar celular') ||
      lower.includes('agregar celular') ||
      lower.includes('nuevo celular') ||
      lower.includes('alta celular') ||
      lower.includes('cargar telefono') ||
      lower.includes('agregar telefono') ||
      lower.includes('autorizar celular');

    if (isAddPhone) {
      await this.startAddUserFlow(tenantUser, rawFrom);
      return;
    }

    // 8. Métricas y Gastos por Rubro (Planes Profesional y Ultra)
    const isRubros =
      lower === '8' ||
      lower === '8.' ||
      lower.includes('metrica') ||
      lower.includes('métrica') ||
      lower.includes('rubro') ||
      lower.includes('categoria') ||
      lower.includes('categoría');

    if (isRubros) {
      await this.handleRubrosMetrics(tenantUser, rawFrom);
      return;
    }

    // 9. Envío de Comprobantes a Proveedores (Planes Profesional y Ultra)
    const isSupplierReceipt =
      lower === '9' ||
      lower === '9.' ||
      lower.includes('envio a proveedor') ||
      lower.includes('envío a proveedor') ||
      lower.includes('comprobante a proveedor') ||
      lower.includes('enviar comprobante');

    if (isSupplierReceipt) {
      await this.handleSupplierReceiptsInfo(tenantUser, rawFrom);
      return;
    }

    // 10. Consultas de IA / Insights (Plan Ultra)
    const isAiQuery =
      lower === '10' ||
      lower === '10.' ||
      lower.includes('insight') ||
      lower.includes('cuanto gastamos') ||
      lower.includes('analisis financiero') ||
      lower.includes('análisis financiero') ||
      lower.includes('proyeccion') ||
      lower.includes('proyección');

    if (isAiQuery) {
      if (tenantUser.tenant.plan?.code !== 'ULTRA') {
        await whatsappService.sendText(
          rawFrom,
          '💡 *Esta consulta requiere el Plan Ultra.* Con el Plan Ultra puedes consultar insights financieros con IA sobre proveedores, gastos por rubro y proyecciones.'
        );
        return;
      }

      await whatsappService.startTyping(rawFrom);

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
      await whatsappService.stopTyping(rawFrom);
      await whatsappService.sendText(rawFrom, aiResponse);
      return;
    }

    // Mensaje de Ayuda por defecto (Fallback)
    await this.sendHelpMenu(tenantUser, rawFrom);
  }

  /**
   * Envía el Menú de Opciones completo y adaptado dinámicamente según el plan de la empresa
   */
  private async sendHelpMenu(tenantUser: any, rawFrom: string): Promise<void> {
    const planCode = tenantUser.tenant.plan?.code || 'BASIC';
    const planName = tenantUser.tenant.plan?.name || `Plan ${planCode}`;
    const maxPhones = tenantUser.tenant.plan?.maxUsers || 1;
    const companyName = tenantUser.tenant.businessName || tenantUser.fullName;

    let helpMessage = `👋 *Menú de Opciones — ${companyName}*\n`;
    helpMessage += `📦 *Tu Plan Activo:* ${planName}\n\n`;
    helpMessage += `Tienes disponibles las siguientes funciones:\n\n`;
    helpMessage += `📸 *1. Envía una foto o PDF:* Carga automática de factura y proveedor con IA.\n`;
    helpMessage += `👥 *2. Registrar nuevo proveedor:* Escribe *"Registrar nuevo proveedor"* para dar de alta proveedores, o *"Editar proveedor"* para modificar sus datos (teléfono, CBU/alias, nombre, rubro).\n`;
    helpMessage += `📝 *3. Facturas (Carga, Edición y Baja):* Escribe *"Cargar factura"* para registrar, *"Editar factura"* para modificar datos, o *"Anular factura"* para darla de baja.\n`;
    helpMessage += `📅 *4. Pagos:* Escribe *"Pagos"* para ver la grilla de pagos programados de los próximos 7 días y el total a pagar.\n`;
    helpMessage += `💸 *5. Pagos (Registrar o Revertir):* Escribe *"Registrar pago"* para marcar una factura como pagada, o *"Revertir pago"* si se registró por equivocación.\n`;
    helpMessage += `🌐 *6. Dashboard Web:* Escribe *"Dashboard"* para acceder a tu panel de control y métricas.\n`;

    if (maxPhones > 1) {
      helpMessage += `📱 *7. Cargar Celular:* Escribe *"Cargar celular"* para autorizar a miembros de tu equipo (permite hasta ${maxPhones} celulares).\n`;
    }

    helpMessage += `⚙️ *Configuración de Empresa:* Escribe *"Configurar empresa"* para modificar tu razón social o los días preferidos de pago de la grilla semanal.\n`;

    if (planCode === 'PROFESSIONAL' || planCode === 'ULTRA') {
      helpMessage += `\n✨ *Funciones adicionales de tu ${planName}:*\n`;
      helpMessage += `📊 *8. Métricas por Rubro:* Escribe *"Métricas por rubro"* para ver el desglose consolidado de gastos por categoría.\n`;
      helpMessage += `📲 *9. Envío a Proveedores:* Escribe *"Enviar comprobante"* para enviar la constancia de pago al WhatsApp del proveedor.\n`;
    }

    if (planCode === 'ULTRA') {
      helpMessage += `🤖 *10. Consultas Financieras con IA:* Pregunta lo que necesites en lenguaje natural (ej: *"¿Cuánto le pagamos este mes a cada rubro?"*, *"¿Qué proveedor acumula más deuda?"*).\n`;
    }

    if (planCode === 'BASIC') {
      helpMessage += `\n💡 _Tip: Con los planes Profesional y Ultra accedes además a multi-celulares autorizados, métricas por rubro, envío automático de comprobantes por WhatsApp y a consultas e insights financieros con IA._\n`;
    }

    await whatsappService.sendText(rawFrom, helpMessage);
  }

  /**
   * Intérprete inteligente de fechas en lenguaje natural o formatos estándar
   */
  private parseNaturalDate(text: string): Date | null {
    const clean = text.trim().toLowerCase();
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    if (clean === 'hoy') {
      return now;
    }
    if (clean === 'mañana' || clean === 'manana') {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return d;
    }

    const inDaysMatch = clean.match(/en\s+(\d+)\s+d/);
    if (inDaysMatch) {
      const days = parseInt(inDaysMatch[1], 10);
      const d = new Date(now);
      d.setDate(d.getDate() + days);
      return d;
    }

    const dayNames = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    for (let i = 0; i < dayNames.length; i++) {
      const name = dayNames[i];
      const nameNorm = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const cleanNorm = clean.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (cleanNorm.includes(nameNorm)) {
        const todayDay = now.getDay();
        let daysToAdd = (i - todayDay + 7) % 7;
        if (daysToAdd === 0) daysToAdd = 7;
        const d = new Date(now);
        d.setDate(d.getDate() + daysToAdd);
        return d;
      }
    }

    const slashParts = clean.split('/');
    if (slashParts.length === 3) {
      const dd = parseInt(slashParts[0], 10);
      const mm = parseInt(slashParts[1], 10) - 1;
      let yyyy = parseInt(slashParts[2], 10);
      if (yyyy < 100) yyyy += 2000;
      const d = new Date(yyyy, mm, dd);
      if (!isNaN(d.getTime())) return d;
    } else if (slashParts.length === 2) {
      const dd = parseInt(slashParts[0], 10);
      const mm = parseInt(slashParts[1], 10) - 1;
      const yyyy = now.getFullYear();
      let d = new Date(yyyy, mm, dd);
      if (d < now) {
        d = new Date(yyyy + 1, mm, dd);
      }
      if (!isNaN(d.getTime())) return d;
    }

    const hyphenParts = clean.split('-');
    if (hyphenParts.length === 3) {
      if (hyphenParts[0].length === 4) {
        const parsed = new Date(clean);
        if (!isNaN(parsed.getTime())) return parsed;
      } else {
        const dd = parseInt(hyphenParts[0], 10);
        const mm = parseInt(hyphenParts[1], 10) - 1;
        let yyyy = parseInt(hyphenParts[2], 10);
        if (yyyy < 100) yyyy += 2000;
        const d = new Date(yyyy, mm, dd);
        if (!isNaN(d.getTime())) return d;
      }
    }

    const fallback = new Date(clean);
    if (!isNaN(fallback.getTime())) {
      return fallback;
    }

    return null;
  }

  /**
   * Inicia el flujo conversacional para cambiar la fecha de pago a una fecha personalizada
   */
  private async initiateChangePaymentDate(tenantUser: any, rawFrom: string, text: string): Promise<void> {
    let invoiceId: string | null = null;
    if (text.startsWith('cambiar_fecha_')) {
      invoiceId = text.replace('cambiar_fecha_', '').trim();
    }

    let invoice = null;
    if (invoiceId) {
      invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, tenantId: tenantUser.tenantId },
        include: { supplier: true },
      });
    }

    if (!invoice) {
      invoice = await prisma.invoice.findFirst({
        where: { tenantId: tenantUser.tenantId },
        orderBy: { createdAt: 'desc' },
        include: { supplier: true },
      });
    }

    if (!invoice) {
      await whatsappService.sendText(rawFrom, '⚠️ No tienes facturas registradas en la grilla para reprogramar.');
      return;
    }

    const friendlyCurrent = paymentGridService.formatFriendlyDate(invoice.scheduledPaymentDate);
    const amountStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(invoice.amount));

    await prisma.conversationSession.upsert({
      where: { phoneNumber: tenantUser.phoneNumber },
      update: {
        state: 'WAITING_NEW_PAYMENT_DATE',
        contextData: { invoiceId: invoice.id },
      },
      create: {
        phoneNumber: tenantUser.phoneNumber,
        state: 'WAITING_NEW_PAYMENT_DATE',
        contextData: { invoiceId: invoice.id },
      },
    });

    const prompt = `📅 *Cambiar Fecha de Pago*\n\n` +
      `🏢 *Proveedor:* ${invoice.supplier.businessName}\n` +
      `🧾 *Comprobante:* Nº ${invoice.invoiceNumber}\n` +
      `💰 *Monto:* ${amountStr}\n` +
      `📅 *Fecha actual en grilla:* ${friendlyCurrent}\n\n` +
      `Por favor, escribe la *nueva fecha* en la que deseas pagar (ej: *25/09*, *15/10/2026*, *el viernes*, *en 10 días*, o *mañana*):`;

    await whatsappService.sendText(rawFrom, prompt);
  }

  /**
   * Procesa la nueva fecha de pago enviada por el usuario
   */
  private async handleNewPaymentDateStep(tenantUser: any, session: any, rawFrom: string, text: string): Promise<void> {
    const ctx = (session.contextData as any) || {};
    const invoiceId = ctx.invoiceId;

    const parsedDate = this.parseNaturalDate(text);
    if (!parsedDate) {
      await whatsappService.sendText(
        rawFrom,
        '⚠️ No pudimos interpretar esa fecha. Por favor escribe una fecha válida como *25/09/2026*, *viernes*, o *en 5 días*:'
      );
      return;
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: tenantUser.tenantId },
      include: { supplier: true },
    });

    if (!invoice) {
      await prisma.conversationSession.delete({ where: { id: session.id } });
      await whatsappService.sendText(rawFrom, '⚠️ No se encontró la factura a reprogramar.');
      return;
    }

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        scheduledPaymentDate: parsedDate,
      },
    });

    await prisma.conversationSession.delete({ where: { id: session.id } });

    const newFriendlyDate = paymentGridService.formatFriendlyDate(parsedDate);
    const successMsg = `✅ *¡Fecha de Pago Actualizada!*

🏢 *Proveedor:* ${invoice.supplier.businessName}
🧾 *Comprobante:* Nº ${invoice.invoiceNumber}
📅 *Nueva Fecha de Pago:* *${newFriendlyDate}*

_La factura quedó reprogramada en tu grilla de pagos._`;

    await whatsappService.sendText(rawFrom, successMsg);
  }

  /**
   * Pospone la factura 7 días
   */
  private async handlePostponeInvoice(tenantUser: any, rawFrom: string, text: string): Promise<void> {
    let invoiceId: string | null = null;
    if (text.startsWith('posponer_')) {
      invoiceId = text.replace('posponer_', '').trim();
    }

    let invoice = null;
    if (invoiceId) {
      invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, tenantId: tenantUser.tenantId },
        include: { supplier: true },
      });
    }

    if (!invoice) {
      invoice = await prisma.invoice.findFirst({
        where: { tenantId: tenantUser.tenantId },
        orderBy: { createdAt: 'desc' },
        include: { supplier: true },
      });
    }

    if (!invoice) {
      await whatsappService.sendText(rawFrom, '⚠️ No tienes facturas registradas en la grilla para posponer.');
      return;
    }

    const currentScheduled = new Date(invoice.scheduledPaymentDate);
    const newDate = new Date(currentScheduled);
    newDate.setDate(newDate.getDate() + 7);

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { scheduledPaymentDate: newDate },
    });

    const friendlyNew = paymentGridService.formatFriendlyDate(newDate);
    const msg = `⏰ *Pago Pospuesto 1 Semana*\n\n` +
      `🏢 *Proveedor:* ${invoice.supplier.businessName}\n` +
      `🧾 *Comprobante:* Nº ${invoice.invoiceNumber}\n` +
      `📅 *Nueva Fecha Programada:* *${friendlyNew}*\n\n` +
      `_Si prefieres fijar otra fecha exacta, escribe "Cambiar fecha"._`;

    await whatsappService.sendText(rawFrom, msg);
  }

  /**
   * Marca el pago para el día de hoy
   */
  private async handlePayTodayInvoice(tenantUser: any, rawFrom: string, text: string): Promise<void> {
    let invoiceId: string | null = null;
    if (text.startsWith('pagar_hoy_')) {
      invoiceId = text.replace('pagar_hoy_', '').trim();
    }

    let invoice = null;
    if (invoiceId) {
      invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, tenantId: tenantUser.tenantId },
        include: { supplier: true },
      });
    }

    if (!invoice) {
      invoice = await prisma.invoice.findFirst({
        where: { tenantId: tenantUser.tenantId },
        orderBy: { createdAt: 'desc' },
        include: { supplier: true },
      });
    }

    if (!invoice) {
      await whatsappService.sendText(rawFrom, '⚠️ No tienes facturas registradas en la grilla.');
      return;
    }

    const today = new Date();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { scheduledPaymentDate: today },
    });

    const friendlyToday = paymentGridService.formatFriendlyDate(today);
    const msg = `⚡ *Agendado para Pagar Hoy*\n\n` +
      `🏢 *Proveedor:* ${invoice.supplier.businessName}\n` +
      `🧾 *Comprobante:* Nº ${invoice.invoiceNumber}\n` +
      `📅 *Fecha de Pago:* *${friendlyToday}*\n\n` +
      `_Quedó priorizado para los pagos del día de hoy._`;

    await whatsappService.sendText(rawFrom, msg);
  }

  /**
   * Inicia el flujo conversacional para autorizar un nuevo celular en la empresa (Multi-usuario)
   */
  private async startAddUserFlow(tenantUser: any, rawFrom: string): Promise<void> {
    const cleanPhone = tenantUser.phoneNumber;
    const maxUsers = tenantUser.tenant.plan?.maxUsers || 1;

    const currentUsersCount = await prisma.tenantUser.count({
      where: { tenantId: tenantUser.tenantId },
    });

    if (currentUsersCount >= maxUsers) {
      await whatsappService.sendText(
        rawFrom,
        `⚠️ *Límite de celulares alcanzado.*\n\nTu plan actual (*${tenantUser.tenant.plan?.name}*) permite hasta *${maxUsers} celulares* autorizados y ya tienes ${currentUsersCount} registrados.\n\nPara autorizar más celulares, escribe *"Planes"* o consulta por el Plan Ultra.`
      );
      return;
    }

    await prisma.conversationSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: {
        state: 'ADD_USER_PHONE',
        contextData: { tenantId: tenantUser.tenantId, maxUsers, currentUsersCount },
      },
      create: {
        phoneNumber: cleanPhone,
        state: 'ADD_USER_PHONE',
        contextData: { tenantId: tenantUser.tenantId, maxUsers, currentUsersCount },
      },
    });

    const msg = `📱 *Alta de Celular Autorizado*\n\n` +
      `Tu *${tenantUser.tenant.plan?.name}* permite hasta *${maxUsers} celulares* vinculados a *${tenantUser.tenant.businessName}* (actualmente ${currentUsersCount}/${maxUsers} activos).\n\n` +
      `Por favor, escribe el *número de WhatsApp* del nuevo celular a autorizar (con código de área, ej: 2644758321 o 5491123456789):`;

    await whatsappService.sendText(rawFrom, msg);
  }

  /**
   * Maneja los pasos para autorizar un nuevo celular (teléfono y nombre)
   */
  private async handleAddUserStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};

    // Paso 1: Recibe Número de Celular
    if (session.state === 'ADD_USER_PHONE') {
      const cleanDigits = text.replace(/\D/g, '');

      if (cleanDigits.length < 8) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ *Número inválido.* Por favor ingresa un número de teléfono o celular válido (ej: 2644758321 o 5491123456789):'
        );
        return;
      }

      // Normalizar formato estándar argentino si no tiene código de país
      let normalizedPhone = cleanDigits;
      if (normalizedPhone.length === 10) {
        normalizedPhone = `549${normalizedPhone}`;
      } else if (normalizedPhone.length === 11 && normalizedPhone.startsWith('9')) {
        normalizedPhone = `54${normalizedPhone}`;
      }

      // Validar si ya existe
      const existingUser = await prisma.tenantUser.findUnique({
        where: { phoneNumber: normalizedPhone },
        include: { tenant: true },
      });

      if (existingUser) {
        if (existingUser.tenantId === tenantUser.tenantId) {
          await whatsappService.sendText(
            rawFrom,
            `⚠️ El número *+${normalizedPhone}* ya está registrado en tu empresa para *${existingUser.fullName}*.\n\nPor favor ingresa otro número diferente:`
          );
        } else {
          await whatsappService.sendText(
            rawFrom,
            `⚠️ El número *+${normalizedPhone}* ya se encuentra asociado a otra cuenta.\n\nPor favor ingresa otro número:`
          );
        }
        return;
      }

      ctx.newPhoneNumber = normalizedPhone;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'ADD_USER_NAME',
          contextData: ctx,
        },
      });

      const namePrompt = `👍 Número validado: *+${normalizedPhone}*\n\n👤 *Nombre y Apellido:*\nPor favor, escribe el nombre y apellido o cargo de la persona que usará este celular (ej: "Mariana Gómez - Administración"):`;
      await whatsappService.sendText(rawFrom, namePrompt);
      return;
    }

    // Paso 2: Recibe Nombre y crea el usuario en la BD
    if (session.state === 'ADD_USER_NAME') {
      const fullName = text.trim();
      if (!fullName) {
        await whatsappService.sendText(rawFrom, '⚠️ El nombre no puede estar vacío. Por favor escribe el nombre de la persona:');
        return;
      }

      const newUser = await prisma.tenantUser.create({
        data: {
          tenantId: tenantUser.tenantId,
          phoneNumber: ctx.newPhoneNumber,
          fullName: fullName,
          role: 'OPERATOR',
          isVerified: true,
        },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });

      const successMsg = `🎉 *¡Celular Autorizado con Éxito!*\n\n` +
        `👤 *Nombre:* ${newUser.fullName}\n` +
        `📱 *Celular:* +${newUser.phoneNumber}\n` +
        `🏢 *Empresa:* ${tenantUser.tenant.businessName}\n\n` +
        `✅ A partir de este momento, ${newUser.fullName} puede enviar fotos de facturas, cargar comprobantes o consultar la grilla desde su propio WhatsApp.`;

      await whatsappService.sendText(rawFrom, successMsg);

      // Intentar enviar mensaje de bienvenida al nuevo celular
      try {
        const welcomeNewUser = `👋 *¡Hola ${newUser.fullName}!* Has sido autorizado para operar en el sistema de *Cuentas a Pagar* de *${tenantUser.tenant.businessName}*.\n\n` +
          `Desde este chat puedes:\n` +
          `📸 Enviar fotos o PDFs de facturas para carga automática con IA.\n` +
          `📝 Escribir *"Cargar factura"* para registrar boletas en papel.\n` +
          `📋 Escribir *"Pagos"* para consultar la grilla de pagos semanal.\n\n` +
          `_Escribe *"Menu"* o *"Ayuda"* en cualquier momento para ver las opciones disponibles._`;

        await whatsappService.sendText(newUser.phoneNumber, welcomeNewUser);
      } catch (err) {
        console.warn('[BotService] No se pudo enviar mensaje directo al nuevo celular:', err);
      }

      return;
    }
  }

  /**
   * Inicia el flujo conversacional para registrar el pago de una factura pendiente
   */
  private async startRegisterPaymentFlow(tenantUser: any, rawFrom: string): Promise<void> {
    const suppliersWithPending = await prisma.supplier.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        invoices: {
          some: {
            status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA'] },
          },
        },
      },
      include: {
        invoices: {
          where: {
            status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA'] },
          },
          orderBy: { dueDate: 'asc' },
        },
        category: true,
      },
      orderBy: { businessName: 'asc' },
    });

    if (suppliersWithPending.length === 0) {
      await whatsappService.sendText(
        rawFrom,
        '🎉 *¡Excelente! No tienes facturas pendientes de pago en tu grilla.* Todas las facturas se encuentran al día.'
      );
      return;
    }

    let msg = `💸 *Registrar Pago de Factura*\n\nSelecciona el *Proveedor* al que le realizaste el pago:\n\n`;
    suppliersWithPending.forEach((s, idx) => {
      const totalPendingAmt = s.invoices.reduce((sum, inv) => sum + Number(inv.amount), 0);
      const formattedAmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(totalPendingAmt);
      const invCount = s.invoices.length;
      msg += `${idx + 1}️⃣ *${s.businessName}* (${invCount} ${invCount === 1 ? 'factura pendiente' : 'facturas pendientes'} — Total: ${formattedAmt})\n`;
    });
    msg += `\n_Responde con el número de la lista o escribe el nombre del proveedor:_`;

    await prisma.conversationSession.upsert({
      where: { phoneNumber: tenantUser.phoneNumber },
      update: {
        state: 'PAYMENT_REG_SUPPLIER',
        contextData: {
          tenantId: tenantUser.tenantId,
          suppliers: suppliersWithPending.map((s) => ({ id: s.id, name: s.businessName })),
        },
      },
      create: {
        phoneNumber: tenantUser.phoneNumber,
        state: 'PAYMENT_REG_SUPPLIER',
        contextData: {
          tenantId: tenantUser.tenantId,
          suppliers: suppliersWithPending.map((s) => ({ id: s.id, name: s.businessName })),
        },
      },
    });

    await whatsappService.sendText(rawFrom, msg);
  }

  /**
   * Maneja la selección del proveedor y luego la factura a marcar como pagada
   */
  private async handleRegisterPaymentStep(
    tenantUser: any,
    session: any,
    rawFrom: string,
    text: string
  ): Promise<void> {
    const ctx = (session.contextData as any) || {};

    // Paso 1: Selección de Proveedor
    if (session.state === 'PAYMENT_REG_SUPPLIER') {
      const input = text.trim().toLowerCase();
      const suppliersList: { id: string; name: string }[] = ctx.suppliers || [];

      let selectedSupplier: { id: string; name: string } | undefined;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= suppliersList.length) {
        selectedSupplier = suppliersList[num - 1];
      } else {
        selectedSupplier = suppliersList.find((s) => s.name.toLowerCase().includes(input));
      }

      if (!selectedSupplier) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Proveedor no reconocido. Por favor responde con el *número* de la lista o el nombre del proveedor:'
        );
        return;
      }

      const pendingInvoices = await prisma.invoice.findMany({
        where: {
          tenantId: tenantUser.tenantId,
          supplierId: selectedSupplier.id,
          status: { in: ['EN_GRILLA', 'PENDIENTE', 'APROBADA'] },
        },
        orderBy: { dueDate: 'asc' },
      });

      if (pendingInvoices.length === 0) {
        await prisma.conversationSession.delete({ where: { id: session.id } });
        await whatsappService.sendText(
          rawFrom,
          `👍 *${selectedSupplier.name}* ya no tiene facturas pendientes de pago registradas.`
        );
        return;
      }

      let invMsg = `🧾 *Facturas Pendientes de ${selectedSupplier.name}:*\n\n`;
      pendingInvoices.forEach((inv, idx) => {
        const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(inv.amount));
        const dueStr = inv.dueDate.toLocaleDateString('es-AR');
        invMsg += `${idx + 1}️⃣ *${inv.invoiceType} Nº ${inv.invoiceNumber}*\n`;
        invMsg += `   💵 Monto: ${amtStr} — 📅 Vencimiento: ${dueStr}\n\n`;
      });
      invMsg += `_Responde con el número de la factura que deseas registrar como pagada:_`;

      await prisma.conversationSession.update({
        where: { id: session.id },
        data: {
          state: 'PAYMENT_REG_INVOICE',
          contextData: {
            tenantId: tenantUser.tenantId,
            supplierId: selectedSupplier.id,
            supplierName: selectedSupplier.name,
            invoices: pendingInvoices.map((i) => ({
              id: i.id,
              number: i.invoiceNumber,
              type: i.invoiceType,
              amount: Number(i.amount),
            })),
          },
        },
      });

      await whatsappService.sendText(rawFrom, invMsg);
      return;
    }

    // Paso 2: Selección de Factura y Marcado como Pagada
    if (session.state === 'PAYMENT_REG_INVOICE') {
      const input = text.trim().toLowerCase();
      const invoicesList: { id: string; number: string; type: string; amount: number }[] = ctx.invoices || [];

      let selectedInvoice: { id: string; number: string; type: string; amount: number } | undefined;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= invoicesList.length) {
        selectedInvoice = invoicesList[num - 1];
      } else {
        selectedInvoice = invoicesList.find((i) => i.number.toLowerCase().includes(input));
      }

      if (!selectedInvoice) {
        await whatsappService.sendText(
          rawFrom,
          '⚠️ Factura no reconocida. Por favor responde con el *número* de la lista:'
        );
        return;
      }

      const updated = await prisma.invoice.update({
        where: { id: selectedInvoice.id },
        data: {
          status: 'PAGADA',
        },
        include: {
          supplier: true,
          tenant: true,
        },
      });

      await prisma.conversationSession.delete({ where: { id: session.id } });

      const amtFormatted = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(updated.amount));
      const payDateStr = new Date().toLocaleDateString('es-AR');

      const canSendReceipt =
        tenantUser.tenant.plan?.hasSupplierReceipts ||
        tenantUser.tenant.plan?.code === 'PROFESSIONAL' ||
        tenantUser.tenant.plan?.code === 'ULTRA';

      const hasSupplierPhone =
        updated.supplier.phone &&
        updated.supplier.phone.trim().length >= 8 &&
        !updated.supplier.phone.toLowerCase().includes('sin teléfono');

      if (canSendReceipt && hasSupplierPhone) {
        const confirmWithReceipt = `🎉 *¡Pago Registrado Exitosamente!*

🏢 *Proveedor:* ${updated.supplier.businessName}
🧾 *Comprobante:* ${updated.invoiceType} Nº ${updated.invoiceNumber}
💰 *Monto Pagado:* ${amtFormatted}
📅 *Fecha de Pago:* ${payDateStr}

_El comprobante quedó marcado como PAGADO en tu grilla y Dashboard._

¿Deseas enviar la constancia de pago formal por WhatsApp a *${updated.supplier.businessName}* (+${updated.supplier.phone})?`;

        await whatsappService.sendButtons(rawFrom, confirmWithReceipt, [
          { id: `enviar_comprobante_${updated.id}`, text: 'Enviar Comprobante' },
          { id: 'no_enviar_comprobante', text: 'No enviar' },
        ]);
      } else {
        const simpleConfirm = `🎉 *¡Pago Registrado Exitosamente!*

🏢 *Proveedor:* ${updated.supplier.businessName}
🧾 *Comprobante:* ${updated.invoiceType} Nº ${updated.invoiceNumber}
💰 *Monto Pagado:* ${amtFormatted}
📅 *Fecha de Pago:* ${payDateStr}

_El comprobante quedó marcado como PAGADO en tu grilla y Dashboard._`;

        await whatsappService.sendText(rawFrom, simpleConfirm);
      }

      return;
    }
  }

  /**
   * Envía un mensaje formal de comprobante de pago al WhatsApp del proveedor
   */
  private async sendSupplierPaymentReceipt(tenantUser: any, rawFrom: string, invoiceId: string): Promise<void> {
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: tenantUser.tenantId },
      include: { supplier: true, tenant: true },
    });

    if (!invoice) {
      await whatsappService.sendText(rawFrom, '⚠️ No se encontró la factura solicitada.');
      return;
    }

    if (!invoice.supplier.phone || invoice.supplier.phone.length < 8) {
      await whatsappService.sendText(rawFrom, '⚠️ El proveedor no tiene un número de teléfono válido registrado.');
      return;
    }

    const amtStr = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(invoice.amount));
    const dateStr = new Date().toLocaleDateString('es-AR');

    const receiptMessage = `📄 *Constancia de Pago — ${invoice.tenant.businessName}*

Estimado/a *${invoice.supplier.businessName}*,
Le informamos que se ha registrado el pago de su comprobante:

🧾 *Comprobante:* ${invoice.invoiceType} Nº ${invoice.invoiceNumber}
💰 *Monto Abonado:* ${amtStr}
📅 *Fecha de Pago:* ${dateStr}

_Este mensaje es un comprobante automático emitido por ${invoice.tenant.businessName}._`;

    // Intentar primero con la Plantilla Oficial de Meta (llega aunque el proveedor nunca haya escrito al bot)
    const templateName = env.YCLOUD_PAYMENT_TEMPLATE_NAME;
    const templateLang = env.YCLOUD_TEMPLATE_LANG;

    try {
      await whatsappService.sendTemplate(invoice.supplier.phone, templateName, templateLang, [
        invoice.supplier.businessName,
        invoice.tenant.businessName,
        `${invoice.invoiceType} Nº ${invoice.invoiceNumber}`,
        amtStr,
        dateStr,
      ]);

      await whatsappService.sendText(
        rawFrom,
        `📲 *¡Comprobante enviado con éxito!*\nSe notificó a *${invoice.supplier.businessName}* al número +${invoice.supplier.phone}.`
      );
    } catch (templateErr: any) {
      console.warn(
        '[BotService] No se pudo enviar con plantilla (quizás aún no aprobada). Intentando fallback con texto libre:',
        templateErr?.response?.data || templateErr?.message
      );

      try {
        await whatsappService.sendText(invoice.supplier.phone, receiptMessage);
        await whatsappService.sendText(
          rawFrom,
          `📲 *¡Comprobante enviado con éxito!*\nSe notificó a *${invoice.supplier.businessName}* al número +${invoice.supplier.phone}.`
        );
      } catch (err: any) {
        console.error('[BotService] Error enviando comprobante a proveedor:', err?.response?.data || err?.message);
        await whatsappService.sendText(
          rawFrom,
          `⚠️ No se pudo entregar el mensaje al proveedor (+${invoice.supplier.phone}). Verifique que la plantilla esté aprobada en YCloud o que el número cuente con WhatsApp activo.`
        );
      }
    }
  }

  /**
   * Genera el reporte de compras y gastos acumulados por Rubro / Categoría
   */
  private async handleRubrosMetrics(tenantUser: any, rawFrom: string): Promise<void> {
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenantUser.tenantId },
      include: {
        category: true,
        invoices: true,
      },
    });

    if (suppliers.length === 0) {
      await whatsappService.sendText(rawFrom, '📊 *Aún no tienes proveedores ni facturas registradas para generar métricas.*');
      return;
    }

    const rubroMap: Record<string, { total: number; count: number; suppliers: Set<string> }> = {};
    let grandTotal = 0;
    let totalInvoices = 0;

    suppliers.forEach((s) => {
      const catName = s.category?.name || 'General';
      if (!rubroMap[catName]) {
        rubroMap[catName] = { total: 0, count: 0, suppliers: new Set() };
      }
      rubroMap[catName].suppliers.add(s.businessName);

      s.invoices.forEach((inv) => {
        const amt = Number(inv.amount);
        rubroMap[catName].total += amt;
        rubroMap[catName].count += 1;
        grandTotal += amt;
        totalInvoices += 1;
      });
    });

    let msg = `📊 *Métricas y Gastos por Rubro — ${tenantUser.tenant.businessName}*\n\n`;
    const sortedRubros = Object.entries(rubroMap).sort((a, b) => b[1].total - a[1].total);

    sortedRubros.forEach(([rubro, data]) => {
      const formatted = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(data.total);
      const percentage = grandTotal > 0 ? ((data.total / grandTotal) * 100).toFixed(1) : '0';
      msg += `🏷️ *${rubro}:* ${formatted} (${percentage}%)\n`;
      msg += `   • ${data.count} ${data.count === 1 ? 'comprobante' : 'comprobantes'} (${data.suppliers.size} ${data.suppliers.size === 1 ? 'proveedor' : 'proveedores'})\n\n`;
    });

    const totalFormatted = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(grandTotal);
    msg += `💰 *Gasto Total Acumulado:* ${totalFormatted}\n`;
    msg += `🧾 *Total de Comprobantes:* ${totalInvoices}\n\n`;
    msg += `💡 _Para ver los gráficos interactivos, escribe *"Dashboard"*.`;

    await whatsappService.sendText(rawFrom, msg);
  }

  /**
   * Muestra la información explicativa sobre cómo funciona el envío de comprobantes a proveedores
   */
  private async handleSupplierReceiptsInfo(tenantUser: any, rawFrom: string): Promise<void> {
    const msg = `📲 *Envío de Comprobantes a Proveedores*\n\n` +
      `Con tu *${tenantUser.tenant.plan?.name}*, el sistema envía automáticamente una constancia formal de pago directo al WhatsApp de tu proveedor.\n\n` +
      `*¿Cómo se utiliza?*\n` +
      `1️⃣ Cuando realices una transferencia a un proveedor, escribe *"Registrar pago"*.\n` +
      `2️⃣ Selecciona la factura abonada.\n` +
      `3️⃣ El sistema te preguntará si deseas notificar al proveedor y le enviará el comprobante al instante con el detalle del pago.\n\n` +
      `👉 _Escribe *"Registrar pago"* para asentar un pago y enviar el comprobante._`;

    await whatsappService.sendText(rawFrom, msg);
  }
}

export const botService = new BotService();

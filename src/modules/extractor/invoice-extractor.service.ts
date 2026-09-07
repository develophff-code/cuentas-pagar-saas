import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../../config/env.js';

export interface ExtractedInvoiceData {
  cuitEmisor: string;
  razonSocial: string;
  tipoComprobante: string;
  numeroComprobante: string;
  fechaEmision: string | null;
  fechaVencimiento: string;
  importeTotal: number;
  importeIva: number | null;
  cbuCvu: string | null;
  alias: string | null;
  banco: string | null;
  rubroSugerido: string;
}

export class InvoiceExtractorService {
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    }
  }

  /**
   * Extrae los campos fiscales, montos, vencimientos y datos bancarios desde un PDF o Imagen
   */
  async extractFromBuffer(fileBuffer: Buffer, mimeType: string): Promise<ExtractedInvoiceData> {
    if (!this.genAI) {
      throw new Error('GEMINI_API_KEY no está configurada en el archivo .env');
    }

    // Modelos estables con soporte multimodal y alta cuota en producción
    const candidateModels = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];

    const prompt = `
Eres un analista financiero y contable experto en comprobantes fiscales, facturas, tickets fiscales (AFIP/ARCA), recibos y boletas comerciales.
Analiza detenidamente la imagen o documento adjunto y extrae los datos clave para el sistema de Cuentas a Pagar a Proveedores.

Ten en cuenta que los tickets fiscales tipo "TICKET FACTURA A" o "FACTURA A" suelen tener:
- Razón Social del emisor (arriba de todo).
- CUIT del emisor (11 dígitos).
- Punto de Venta y Comp. Nº (ej: 00002-00001578).
- Fecha de Emisión y Fecha de Vencimiento / Vto CAE. Si no tiene fecha de vencimiento explícita, usa la de emisión o suma 15 días.
- Importe Total (ej: Total $ 6,100.00 -> 6100.00) e IVA.
- Rubro comercial según los productos vendidos (ej: Limpieza, Ferretería, Alimentos, etc.).

Devuelve EXCLUSIVAMENTE un objeto JSON válido con esta estructura:
{
  "cuitEmisor": "CUIT o identificador fiscal del emisor/proveedor (números limpios o XX-XXXXXXXX-X)",
  "razonSocial": "Nombre o razón social del emisor / comercio",
  "tipoComprobante": "Tipo (ej: Factura A, Ticket Factura A, Factura B, Factura C, Recibo, Boleta)",
  "numeroComprobante": "Número completo (ej: 00002-00001578)",
  "fechaEmision": "YYYY-MM-DD o null si no es legible",
  "fechaVencimiento": "YYYY-MM-DD",
  "importeTotal": 0.00,
  "importeIva": 0.00,
  "cbuCvu": "CBU o CVU de 22 dígitos si figura en la factura para transferencia, o null",
  "alias": "Alias bancario si figura, o null",
  "banco": "Nombre del banco si figura, o null",
  "rubroSugerido": "Categoría o rubro principal (ej: Limpieza y Química, Insumos, Ferretería, Alimentos, etc.)"
}
`;

    let lastError: any = null;

    for (const modelName of candidateModels) {
      try {
        const model = this.genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        });

        const result = await model.generateContent([
          prompt,
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: fileBuffer.toString('base64'),
            },
          },
        ]);

        const responseText = result.response.text()?.trim() || '{}';
        const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(cleanJson);

        return {
          cuitEmisor: parsed.cuitEmisor?.toString() || '00-00000000-0',
          razonSocial: parsed.razonSocial || 'Proveedor No Identificado',
          tipoComprobante: parsed.tipoComprobante || 'Factura',
          numeroComprobante: parsed.numeroComprobante || 'S/N',
          fechaEmision: parsed.fechaEmision || null,
          fechaVencimiento: parsed.fechaVencimiento || new Date().toISOString().split('T')[0],
          importeTotal: Number(parsed.importeTotal) || 0,
          importeIva: parsed.importeIva ? Number(parsed.importeIva) : null,
          cbuCvu: parsed.cbuCvu?.toString() || null,
          alias: parsed.alias || null,
          banco: parsed.banco || null,
          rubroSugerido: parsed.rubroSugerido || 'General',
        };
      } catch (error: any) {
        console.warn(`[InvoiceExtractorService] Reintentando con siguiente modelo tras fallo en ${modelName}:`, error.message);
        lastError = error;
      }
    }

    console.error('[InvoiceExtractorService] Fallaron todos los modelos candidatos:', lastError);
    throw new Error(`Fallo al extraer datos de la boleta: ${lastError?.message || 'Error desconocido'}`);
  }

  /**
   * Genera insights financieros comparativos sobre proveedores y gastos (Plan Ultra)
   */
  async generateSupplierInsights(supplierSummaryData: any, userQuery: string): Promise<string> {
    if (!this.genAI) {
      throw new Error('GEMINI_API_KEY no configurada');
    }

    const model = this.genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

    const prompt = `
Eres un CFO y asesor financiero experto para una PyME / SaaS de gestión de pagos a proveedores.
Aquí tienes los datos consolidados de facturación, proveedores y rubros:
${JSON.stringify(supplierSummaryData, null, 2)}

El usuario pregunta: "${userQuery}"

Responde de manera profesional, sintética y directa, ideal para ser leída rápidamente en WhatsApp (usa negritas, listas cortas con viñetas y emojis clave).
`;

    const result = await model.generateContent(prompt);
    return result.response.text() || 'No fue posible generar insights en este momento.';
  }
}

export const invoiceExtractorService = new InvoiceExtractorService();

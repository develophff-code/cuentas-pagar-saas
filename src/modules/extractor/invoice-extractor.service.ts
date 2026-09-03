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

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const prompt = `
Eres un analista financiero experto en comprobantes fiscales, facturas y boletas comerciales (especialmente de Argentina y Latinoamérica).
Analiza detenidamente la imagen o documento adjunto y extrae los datos clave para el sistema de Cuentas a Pagar a Proveedores.

Devuelve EXCLUSIVAMENTE un objeto JSON válido con la siguiente estructura:
{
  "cuitEmisor": "CUIT o identificador fiscal del emisor/proveedor (formato XX-XXXXXXXX-X o números limpios)",
  "razonSocial": "Nombre o razón social del emisor / proveedor",
  "tipoComprobante": "Tipo (ej: Factura A, Factura B, Factura C, Recibo, Liquidación, Boleta)",
  "numeroComprobante": "Número completo (ej: 0004-00012345)",
  "fechaEmision": "YYYY-MM-DD o null si no es legible",
  "fechaVencimiento": "YYYY-MM-DD (si no indica vencimiento explícito, usa la fecha de emisión o suma 15 días)",
  "importeTotal": 0.00,
  "importeIva": 0.00,
  "cbuCvu": "CBU o CVU de 22 dígitos si figura en la factura para transferencia, o null",
  "alias": "Alias bancario si figura, o null",
  "banco": "Nombre del banco si figura, o null",
  "rubroSugerido": "Categoría o rubro principal del proveedor (ej: Insumos de Oficina, Materia Prima, Ferretería, Servicios, Logística, Alimentos, etc.)"
}
`;

    try {
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
      console.error('[InvoiceExtractorService] Error en procesamiento con Gemini:', error.message);
      throw new Error(`Fallo al extraer datos de la boleta: ${error.message}`);
    }
  }

  /**
   * Genera insights financieros comparativos sobre proveedores y gastos (Plan Ultra)
   */
  async generateSupplierInsights(supplierSummaryData: any, userQuery: string): Promise<string> {
    if (!this.genAI) {
      throw new Error('GEMINI_API_KEY no configurada');
    }

    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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

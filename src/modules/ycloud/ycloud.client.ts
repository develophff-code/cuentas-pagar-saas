import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env.js';

export interface YcloudSendMessagePayload {
  to: string;
  type: 'text' | 'interactive' | 'image' | 'document';
  text?: { body: string };
  interactive?: any;
  image?: { link?: string; caption?: string };
  document?: { link?: string; filename?: string; caption?: string };
}

export class YcloudClient {
  private api: AxiosInstance;
  private fromNumber: string;

  constructor() {
    this.fromNumber = process.env.YCLOUD_PHONE_NUMBER || '';
    this.api = axios.create({
      baseURL: 'https://api.ycloud.com/v2',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.YCLOUD_API_KEY || '',
      },
      timeout: 30000,
    });
  }

  /**
   * Envía un mensaje de texto simple vía YCloud / WhatsApp Cloud API
   */
  async sendText(to: string, text: string): Promise<any> {
    const formattedTo = this.formatPhone(to);
    try {
      const response = await this.api.post('/whatsapp/messages', {
        from: this.fromNumber,
        to: formattedTo,
        type: 'text',
        text: { body: text },
      });
      return response.data;
    } catch (error: any) {
      console.error(`[YcloudClient] Error enviando texto a ${formattedTo}:`, error?.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Envía un mensaje de plantilla oficial (Template HSM) vía YCloud / WhatsApp Cloud API
   * Permite iniciar conversaciones hacia proveedores aún fuera de la ventana de 24 horas.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string = 'es',
    bodyParameters: string[] = []
  ): Promise<any> {
    const formattedTo = this.formatPhone(to);

    const payload: any = {
      from: this.fromNumber,
      to: formattedTo,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode,
        },
      },
    };

    if (bodyParameters.length > 0) {
      payload.template.components = [
        {
          type: 'body',
          parameters: bodyParameters.map((param) => ({
            type: 'text',
            text: param,
          })),
        },
      ];
    }

    try {
      const response = await this.api.post('/whatsapp/messages', payload);
      return response.data;
    } catch (error: any) {
      console.error(
        `[YcloudClient] Error enviando plantilla ${templateName} a ${formattedTo}:`,
        error?.response?.data || error.message
      );
      throw error;
    }
  }

  /**
   * Envía un mensaje interactivo con botones de respuesta rápida (hasta 3 botones en Meta)
   */
  async sendButtons(to: string, bodyText: string, buttons: { id: string; text: string }[]): Promise<any> {
    const formattedTo = this.formatPhone(to);

    // Meta WhatsApp Cloud API admite hasta 3 botones de respuesta rápida
    const quickReplyButtons = buttons.slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: b.id,
        title: b.text.length > 20 ? b.text.substring(0, 20) : b.text,
      },
    }));

    try {
      const response = await this.api.post('/whatsapp/messages', {
        from: this.fromNumber,
        to: formattedTo,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: quickReplyButtons,
          },
        },
      });
      return response.data;
    } catch (error: any) {
      console.warn(`[YcloudClient] Error enviando botones interactivos, enviando fallback a texto:`, error?.response?.data || error.message);
      let fallback = `${bodyText}\n\n`;
      buttons.forEach((b, i) => {
        fallback += `${i + 1}️⃣ ${b.text}\n`;
      });
      return this.sendText(formattedTo, fallback);
    }
  }

  /**
   * Descarga un archivo multimedia recibido por WhatsApp a través de YCloud
   */
  async downloadMedia(mediaUrlOrId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      // Si ya viene como URL directa
      if (mediaUrlOrId.startsWith('http')) {
        const response = await axios.get(mediaUrlOrId, {
          responseType: 'arraybuffer',
          headers: {
            'X-API-Key': process.env.YCLOUD_API_KEY || '',
          },
          timeout: 30000,
        });
        const mimeType = String(response.headers['content-type'] || 'application/octet-stream');
        return { buffer: Buffer.from(response.data), mimeType };
      }

      // Si viene como mediaId de WhatsApp Cloud API
      const metaRes = await this.api.get(`/whatsapp/media/${mediaUrlOrId}`);
      const directUrl = metaRes.data?.url || metaRes.data?.link;
      const downloadRes = await axios.get(directUrl, {
        responseType: 'arraybuffer',
        headers: {
          'X-API-Key': process.env.YCLOUD_API_KEY || '',
        },
      });

      const mimeType = String(downloadRes.headers['content-type'] || 'application/octet-stream');
      return { buffer: Buffer.from(downloadRes.data), mimeType };
    } catch (error: any) {
      console.error(`[YcloudClient] Error descargando multimedia:`, error?.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Limpia y formatea el número a formato internacional E.164 (+549...)
   */
  public formatPhone(phone: string): string {
    let clean = phone.replace(/@c\.us/g, '').replace(/[^0-9]/g, '');

    // Si ya empieza con 549 y tiene 13 dígitos (+54 9 11 xxxx xxxx)
    if (clean.startsWith('549')) {
      return `+${clean}`;
    }

    // Si empieza con 54 pero le falta el 9 móvil (ej: 5411xxxxxxxx con 12 dígitos)
    if (clean.startsWith('54') && clean.length === 12) {
      clean = `549${clean.slice(2)}`;
      return `+${clean}`;
    }

    // Si empieza con 0 (ej: 011xxxxxxxx o 0351xxxxxxx)
    if (clean.startsWith('0')) {
      clean = clean.slice(1);
    }

    // Si empieza con 15 local (ej: 1544445555)
    if (clean.startsWith('15') && clean.length === 10) {
      clean = `11${clean.slice(2)}`;
    }

    // Si es un número local de 10 dígitos (ej: 1144445555 o 351xxxxxxx)
    if (clean.length === 10) {
      clean = `549${clean}`;
      return `+${clean}`;
    }

    return clean.startsWith('+') ? clean : `+${clean}`;
  }
}

export const ycloudClient = new YcloudClient();

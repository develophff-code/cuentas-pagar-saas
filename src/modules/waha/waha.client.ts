import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env.js';

export interface SendMessageResponse {
  id: string;
  timestamp: number;
}

export interface WahaButton {
  id: string;
  text: string;
}

export class WahaClient {
  private api: AxiosInstance;
  private defaultSession: string;

  constructor() {
    this.defaultSession = env.WAHA_SESSION;
    this.api = axios.create({
      baseURL: env.WAHA_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        ...(env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : {}),
      },
      timeout: 30000,
    });
  }

  /**
   * Envía un mensaje de texto simple a un chat o número de WhatsApp
   */
  async sendText(chatId: string, text: string, session = this.defaultSession): Promise<any> {
    const formattedChatId = this.formatChatId(chatId);
    try {
      const response = await this.api.post('/api/sendText', {
        session,
        chatId: formattedChatId,
        text,
      });
      return response.data;
    } catch (error: any) {
      console.error(`[WahaClient] Error enviando texto a ${formattedChatId}:`, error?.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Envía un mensaje interactivo con botones
   */
  async sendButtons(
    chatId: string,
    title: string,
    buttons: WahaButton[],
    footer?: string,
    session = this.defaultSession
  ): Promise<any> {
    const formattedChatId = this.formatChatId(chatId);
    try {
      // WAHA soporta sendButtons con botones de respuesta rápida
      const response = await this.api.post('/api/send/buttons/reply', {
        session,
        chatId: formattedChatId,
        title,
        footer: footer || 'SaaS Cuentas a Pagar',
        buttons: buttons.map((b) => ({
          id: b.id,
          text: b.text,
        })),
      });
      return response.data;
    } catch (error: any) {
      // Fallback a texto si el motor no soporta botones interactivos
      console.warn(`[WahaClient] Botones no soportados por el motor, enviando menú de texto alternativo.`);
      let fallbackText = `${title}\n\n`;
      buttons.forEach((b, index) => {
        fallbackText += `${index + 1}️⃣ ${b.text}\n`;
      });
      fallbackText += `\n_Responde con el número o texto de la opción._`;
      return this.sendText(formattedChatId, fallbackText, session);
    }
  }

  /**
   * Envía un archivo adjunto (PDF, imagen, comprobante)
   */
  async sendFile(
    chatId: string,
    fileUrl: string,
    filename: string,
    caption?: string,
    session = this.defaultSession
  ): Promise<any> {
    const formattedChatId = this.formatChatId(chatId);
    try {
      const response = await this.api.post('/api/sendFile', {
        session,
        chatId: formattedChatId,
        file: {
          url: fileUrl,
          filename,
        },
        caption,
      });
      return response.data;
    } catch (error: any) {
      console.error(`[WahaClient] Error enviando archivo a ${formattedChatId}:`, error?.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Descarga un archivo multimedia recibido por webhook
   */
  async downloadMedia(mediaUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      const url = mediaUrl.startsWith('http') ? mediaUrl : `${env.WAHA_BASE_URL}${mediaUrl}`;
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          ...(env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : {}),
        },
        timeout: 30000,
      });

      const mimeType = String(response.headers['content-type'] || 'application/octet-stream');
      return {
        buffer: Buffer.from(response.data),
        mimeType,
      };
    } catch (error: any) {
      console.error(`[WahaClient] Error descargando multimedia de ${mediaUrl}:`, error.message);
      throw error;
    }
  }

  /**
   * Notifica indicador de "escribiendo..." en el chat
   */
  async startTyping(chatId: string, session = this.defaultSession): Promise<void> {
    try {
      await this.api.post('/api/startTyping', {
        session,
        chatId: this.formatChatId(chatId),
      });
    } catch {
      // Silencioso
    }
  }

  /**
   * Detiene el indicador de "escribiendo..."
   */
  async stopTyping(chatId: string, session = this.defaultSession): Promise<void> {
    try {
      await this.api.post('/api/stopTyping', {
        session,
        chatId: this.formatChatId(chatId),
      });
    } catch {
      // Silencioso
    }
  }

  /**
   * Formatea un número de teléfono a chatId de WhatsApp si viene en formato estándar
   */
  public formatChatId(phoneOrChatId: string): string {
    if (phoneOrChatId.includes('@')) {
      return phoneOrChatId;
    }
    const cleanNumber = phoneOrChatId.replace(/\D/g, '');
    return `${cleanNumber}@c.us`;
  }
}

export const wahaClient = new WahaClient();

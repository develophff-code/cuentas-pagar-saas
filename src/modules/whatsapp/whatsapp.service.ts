import { wahaClient } from '../waha/waha.client.js';
import { ycloudClient } from '../ycloud/ycloud.client.js';

export class WhatsAppService {
  private get provider(): string {
    return (process.env.WHATSAPP_PROVIDER || 'ycloud').toLowerCase();
  }

  async sendText(to: string, text: string): Promise<any> {
    if (this.provider === 'waha') {
      return wahaClient.sendText(to, text);
    }
    return ycloudClient.sendText(to, text);
  }

  async sendButtons(to: string, title: string, buttons: { id: string; text: string }[]): Promise<any> {
    if (this.provider === 'waha') {
      return wahaClient.sendButtons(to, title, buttons);
    }
    return ycloudClient.sendButtons(to, title, buttons);
  }

  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string = 'es',
    bodyParameters: string[] = []
  ): Promise<any> {
    if (this.provider === 'waha') {
      const fallbackText = `[Notificación ${templateName}]: ${bodyParameters.join(' - ')}`;
      return wahaClient.sendText(to, fallbackText);
    }
    return ycloudClient.sendTemplate(to, templateName, languageCode, bodyParameters);
  }

  async downloadMedia(mediaUrlOrId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (this.provider === 'waha') {
      return wahaClient.downloadMedia(mediaUrlOrId);
    }
    return ycloudClient.downloadMedia(mediaUrlOrId);
  }

  async startTyping(to: string): Promise<void> {
    if (this.provider === 'waha') {
      await wahaClient.startTyping(to);
    }
  }

  async stopTyping(to: string): Promise<void> {
    if (this.provider === 'waha') {
      await wahaClient.stopTyping(to);
    }
  }
}

export const whatsappService = new WhatsAppService();

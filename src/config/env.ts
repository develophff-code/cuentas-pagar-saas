import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/cuentas_pagar_saas?schema=public'),
  WAHA_BASE_URL: z.string().default('https://waha.averiq.cloud'),
  WAHA_API_KEY: z.string().default(''),
  WAHA_SESSION: z.string().default('default'),
  GEMINI_API_KEY: z.string().default(''),
  APP_BASE_URL: z.string().default('http://localhost:4000'),
  WHATSAPP_PROVIDER: z.string().default('ycloud'),
  YCLOUD_API_KEY: z.string().optional(),
  YCLOUD_PHONE_NUMBER: z.string().optional(),
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);

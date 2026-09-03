import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { env } from './config/env.js';
import { webhookRoutes } from './routes/webhook.routes.js';
import { setupMorningAlertCron } from './cron/morning-alert.cron.js';

const app = Fastify({
  logger: {
    level: 'info',
  },
});

async function main() {
  // Plugins
  await app.register(cors, {
    origin: true,
  });
  await app.register(formbody);

  // Rutas
  await app.register(webhookRoutes);

  // Iniciar el Cron Job matutino
  setupMorningAlertCron();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`🚀 Servidor SaaS Cuentas a Pagar activo en http://${env.HOST}:${env.PORT}`);
    app.log.info(`🔗 Webhook para WAHA: http://${env.HOST}:${env.PORT}/api/webhook/whatsapp`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

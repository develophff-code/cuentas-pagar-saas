# 📱 Cuentas a Pagar SaaS — Bot de WhatsApp & Gestión de Proveedores

Plataforma SaaS operada de forma nativa a través de **WhatsApp** (vía **YCloud / WhatsApp Cloud API**) para la automatización integral del ciclo de cuentas a pagar: recepción inteligente de facturas y tickets, ordenamiento en grilla semanal de corte, emisión de comprobantes formales de pago, panel web en tiempo real y análisis financiero con Inteligencia Artificial.

* **Dominio Producción:** [https://apagar.averiq.cloud](https://apagar.averiq.cloud)
* **Repositorio:** [https://github.com/develophff-code/cuentas-pagar-saas](https://github.com/develophff-code/cuentas-pagar-saas)
* **Rama Activa de Desarrollo:** `develop`

---

## 🚀 Funcionalidades Principales

1. 📸 **Carga Automática con IA (Fotos y PDFs):** Envío directo de fotos o archivos PDF de facturas/tickets. Google Gemini 2.0 Flash extrae: CUIT emisor, Razón Social, Tipo y Número de Comprobante, Fecha de Vencimiento, Monto Total, IVA, CBU/CVU/Alias bancario y clasificación automática por Rubro.
2. 🏢 **Gestión y Edición de Proveedores:** Alta guiada y modificación conversacional de proveedores (Razón Social, Rubro del 1 al 10, Celular/WhatsApp y CBU/Alias).
3. 🧾 **Carga Manual y Modificación de Facturas:** Registro y corrección de comprobantes (monto, fecha de vencimiento, tipo y número). Al cambiar el vencimiento, la fecha de pago en grilla se recalcula automáticamente.
4. 🚫 **Anulación y Reversión de Pagos:** Anulación de comprobantes cargados por error (`CANCELADA`) y reversión de pagos registrados por equivocación (`EN_GRILLA`) con confirmación interactiva.
5. 📅 **Grilla Semanal de Pagos & Configuración:** Asignación inteligente a los días de corte de la empresa (ej. Martes y Jueves). Si la empresa modifica sus días de pago, todas las facturas en grilla se reprograman de forma automática.
6. 💳 **Registrador de Pagos & Envío de Constancias:** Flujo guiado para asentar pagos realizados y despacho automático de constancia formal de pago vía WhatsApp directo al número del proveedor.
7. 🌐 **Dashboard Web en Tiempo Real:** Interfaz responsiva con métricas clave (Total a pagar en 7 días, vencidos, pendientes, pagados, anulados), desglose por rubro y tabla interactiva.
8. 👥 **Multi-usuario por Empresa (Planes Profesional y Ultra):** Autorización de hasta 3 números celulares por tenant con roles compartidos.
9. 📊 **Métricas por Rubro:** Resumen consolidado directo en WhatsApp de compras y gastos acumulados por categoría comercial.
10. 📲 **Envío Automatizado a Proveedores:** Notificación inmediata con detalle del pago acreditado.
11. 🧠 **Consultas Financieras con IA (Plan Ultra):** Asesor analítico en lenguaje natural sobre finanzas, tendencias de gasto y sugerencias de optimización de flujo de fondos.

---

## 💬 Comandos Disponibles en WhatsApp

| Comando / Frase | Acción |
| :--- | :--- |
| `Menú` o `Ayuda` | Despliega el menú principal con las opciones habilitadas para el plan activo. |
| `Registrar nuevo proveedor` | Alta guiada de un nuevo proveedor (formal o informal). |
| `Editar proveedor` | Modificar razón social, rubro comercial, teléfono o CBU/alias de un proveedor. |
| `Cargar factura` | Carga manual paso a paso de una factura o ticket en papel. |
| `Editar factura` | Modificar monto, fecha de vencimiento, tipo o número de una factura en grilla. |
| `Anular factura` | Dar de baja una factura cargada por error (`CANCELADA`). |
| `Pagos` | Consulta las facturas agendadas en la grilla para los próximos 7 días y el total a pagar. |
| `Registrar pago` | Asienta el pago de una factura y ofrece enviar el comprobante al WhatsApp del proveedor. |
| `Revertir pago` | Deshace un pago registrado por equivocación, volviendo la factura a estado `EN_GRILLA`. |
| `Configurar empresa` / `Días de pago` | Modifica la razón social o los días preferidos de pago (con recálculo automático de la grilla). |
| `Dashboard` | Genera el enlace de acceso directo al panel web en tiempo real. |
| `Cargar celular` | Autoriza celulares adicionales del equipo (hasta 3 para Profesional y Ultra). |
| `Métricas por rubro` | Desglose consolidado de gastos acumulados por rubro comercial (Profesional y Ultra). |
| *Consulta en lenguaje natural* | Preguntas financieras analizadas con IA (exclusivo Plan Ultra). |

---

## 🏗️ Arquitectura del Sistema

```mermaid
flowchart TD
    User["📱 Usuario / Proveedor"] <-->|"WhatsApp Oficial"| Meta["🌐 WhatsApp Cloud API - Meta"]
    Meta <-->|"Webhooks / Mensajes"| YCloud["☁️ YCloud Gateway"]
    YCloud <-->|"HTTPS - SSL"| Apache["🛡️ Apache2 Reverse Proxy - apagar.averiq.cloud"]
    Apache <-->|"ProxyPass Puerto 4000"| Fastify["⚡ Backend Fastify / Node.js - PM2"]
    Fastify <-->|"Buffer Foto / PDF"| Gemini["🤖 Google Gemini IA - Extracción OCR"]
    Gemini -->|"JSON Estructurado"| Fastify
    Fastify <-->|"Prisma ORM"| Postgres["🐘 PostgreSQL"]
    Cron["⏰ Morning Alert Cron - 08:00 AM"] -->|"Resumen Pagos 24h"| Fastify
    Fastify -->|"Dashboard HTML / API"| Browser["💻 Navegador Web"]
```

---

## 🛠️ Stack Tecnológico

* **Runtime:** Node.js v22+ / v24+ con TypeScript
* **Framework Web:** [Fastify](https://fastify.dev/) con plugins de CORS y Formbody
* **ORM:** [Prisma](https://www.prisma.io/) v6
* **Base de Datos:** PostgreSQL
* **WhatsApp Provider:** [YCloud](https://ycloud.com/) (WhatsApp Cloud API oficial de Meta) / Soporte WAHA
* **Inteligencia Artificial:** [Google Generative AI](https://www.npmjs.com/package/@google/generative-ai) (Gemini 2.0 Flash)
* **Servidor Web & Proxy:** Apache2 con módulos `proxy`, `proxy_http`, `headers`, `ssl`
* **Certificados SSL:** Let's Encrypt vía Certbot
* **Gestor de Procesos:** PM2

---

## ⚙️ Configuración y Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto (basado en `.env.example`):

```env
# Servidor
PORT=4000
HOST=0.0.0.0
APP_BASE_URL=https://apagar.averiq.cloud

# Base de Datos PostgreSQL
DATABASE_URL="postgresql://postgres:TU_PASSWORD@localhost:5432/cuentas_pagar_saas?schema=public"

# Proveedor WhatsApp (YCloud para producción)
WHATSAPP_PROVIDER=ycloud
YCLOUD_API_KEY=tu_ycloud_api_key_aqui
YCLOUD_PHONE_NUMBER=54911xxxxxxxx

# Google Gemini IA
GEMINI_API_KEY=tu_gemini_api_key_aqui

# MercadoPago (Opcional - Fase Final)
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_WEBHOOK_SECRET=
```

---

## 💻 Scripts Disponibles

```bash
# Desarrollo local con recarga en vivo
npm run dev

# Compilar TypeScript a JavaScript de producción
npm run build

# Iniciar servidor compilado en producción
npm run start

# Sincronizar esquema de base de datos con Prisma
npx prisma db push

# Poblar categorías maestras y planes de suscripción
npx prisma db seed

# Limpiar datos de tenants/facturas de prueba (conserva categorías y planes)
npm run db:clean
```

---

## 🚀 Despliegue en Servidor AWS EC2 (Apache2 + PM2)

### 1. Configuración de VirtualHost en Apache2
Crea `/etc/apache2/sites-available/apagar.averiq.cloud.conf`:

```apache
<VirtualHost *:80>
    ServerName apagar.averiq.cloud

    ProxyPreserveHost On
    ProxyRequests Off
    LimitRequestBody 26214400

    RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
    RequestHeader set X-Real-IP expr=%{REMOTE_ADDR}
    ProxyTimeout 60

    ProxyPass / http://127.0.0.1:4000/
    ProxyPassReverse / http://127.0.0.1:4000/

    ErrorLog ${APACHE_LOG_DIR}/apagar_error.log
    CustomLog ${APACHE_LOG_DIR}/apagar_access.log combined
</VirtualHost>
```

Habilitar y recargar:
```bash
sudo a2ensite apagar.averiq.cloud.conf
sudo apache2ctl configtest
sudo systemctl reload apache2
```

### 2. Certificado SSL con Certbot
```bash
sudo certbot --apache -d apagar.averiq.cloud
```

### 3. Puesta en marcha con PM2
```bash
cd /var/www/html/apagar
npm install
npx prisma generate
npx prisma db push
npx prisma db seed
npm run build

# Iniciar con PM2
pm2 start dist/server.js --name "apagar-saas"
pm2 save
pm2 startup
```

### 4. Configurar Webhook en YCloud
* **Webhook URL:** `https://apagar.averiq.cloud/api/webhook/ycloud`
* **Eventos:** `whatsapp.inbound_message.received`

---

## 🔄 Flujo de Actualización Continua (CI/CD)

1. Desarrollar y verificar cambios en local en la rama `develop`.
2. Subir commits a GitHub:
   ```bash
   git add .
   git commit -m "feat: nueva funcionalidad"
   git push origin develop
   ```
3. En la EC2, actualizar y reiniciar en 5 segundos con el script `deploy.sh`:
   ```bash
   ./deploy.sh
   ```

Contenido de `deploy.sh`:
```bash
#!/bin/bash
echo "🚀 Actualizando Cuentas a Pagar SaaS..."
git pull origin develop
npm run build
pm2 restart apagar-saas
echo "✅ Despliegue completado con éxito."
```

---

## 📄 Licencia

Desarrollado para uso propietario y comercial en plataforma SaaS.

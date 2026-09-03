# 📱 Cuentas a Pagar SaaS - Bot de WhatsApp & Gestión de Proveedores

Plataforma SaaS operada principalmente a través de **WhatsApp** para la automatización integral de cuentas a pagar, recepción inteligente de facturas/boletas de proveedores, ordenamiento en grilla semanal de corte y análisis financiero con Inteligencia Artificial.

Repositorio: [https://github.com/develophff-code/cuentas-pagar-saas](https://github.com/develophff-code/cuentas-pagar-saas)

---

## 🚀 Características Principales

* 📸 **Ingesta Multimodal:** Recibe fotos tomadas con la cámara del celular o archivos PDF de facturas directamente por WhatsApp.
* 🤖 **Extracción con IA (Gemini Vision):** Identifica automáticamente CUIT emisor, Razón Social, Número y Tipo de comprobante, Vencimiento, Monto Total, IVA, CBU/Alias bancario y **clasificación por Rubro**.
* 📅 **Grilla Semanal de Pagos:** Ubica cada factura en los días fijos de pago configurados por la empresa (ej. Martes y Jueves) previos a la fecha límite para evitar mora.
* ☀️ **Alertas Matutinas (Cron):** Notifica automáticamente a las 08:00 AM a los celulares autorizados el resumen de compromisos de las próximas 24 horas con datos de transferencia.
* 👥 **Arquitectura Multi-tenant:**
  * **Plan Básico:** 1 celular, hasta 25 proveedores y 100 facturas/mes.
  * **Plan Profesional:** Hasta 3 celulares por empresa, 80 proveedores, envío de comprobantes y analítica por rubro.
  * **Plan Ultra:** Hasta 3 celulares, 150+ proveedores, consultas analíticas e insights financieros conversacionales con IA.
* 🏷️ **Ficha de Proveedores y Rubros:** Registro unificado de proveedores con cuentas bancarias y rubros comerciales para comparativas de compras.
* 📊 **API REST para Dashboard Web:** Endpoints listos para visualización Kanban de pagos, edición de fechas y gráficos de gastos por rubro.

---

## 🏗️ Arquitectura del Sistema

```mermaid
flowchart LR
    User["📱 Celular Cliente"] <-->|Mensajes, Fotos, PDFs| WAHA["WAHA (WhatsApp HTTP API)"]
    WAHA -->|Webhook POST| Backend["⚡ Backend Fastify (Node.js/TS)"]
    Backend -->|Buffer Imagen/PDF| Gemini["🤖 Gemini Vision (OCR)"]
    Gemini -->|JSON Estructurado| Backend
    Backend <-->|Prisma ORM| Postgres[("🐘 PostgreSQL")]
    Cron["⏰ Morning Cron (08:00 AM)"] -->|Reporte Diario 24h| Backend
    Backend -->|Notificaciones| WAHA
```

---

## 🛠️ Stack Tecnológico

* **Runtime:** Node.js v24+ con TypeScript
* **Framework Web:** [Fastify](https://fastify.dev/)
* **ORM:** [Prisma](https://www.prisma.io/)
* **Base de Datos:** PostgreSQL
* **WhatsApp Gateway:** [WAHA (WhatsApp HTTP API)](https://github.com/devlikeapro/waha)
* **Inteligencia Artificial:** [Google Generative AI SDK](https://www.npmjs.com/package/@google/generative-ai) (Gemini 1.5 / 2.5 Flash)
* **Scheduler:** Node-Cron
* **Validación de Entorno:** Zod

---

## ⚙️ Configuración e Instalación

### 1. Clonar el repositorio
```bash
git clone https://github.com/develophff-code/cuentas-pagar-saas.git
cd cuentas-pagar-saas
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
Crea el archivo `.env` a partir de `.env.example`:

```env
PORT=4000
HOST=0.0.0.0

# Base de datos PostgreSQL
DATABASE_URL="postgresql://postgres:TU_PASSWORD@localhost:5432/cuentas_pagar_saas?schema=public"

# Conexión WAHA
WAHA_BASE_URL="https://waha.averiq.cloud"
WAHA_API_KEY="tu_waha_api_key"
WAHA_SESSION="default"

# Google Gemini API
GEMINI_API_KEY="tu_gemini_api_key"
```

### 4. Ejecutar migraciones de base de datos
```bash
npx prisma migrate dev --name init
```

### 5. Iniciar en modo desarrollo
```bash
npm run dev
```

El servidor quedará escuchando en `http://localhost:4000`.

---

## 🌿 Flujo de Trabajo con Git (Git Flow)

Este proyecto utiliza un modelo de ramas estructurado:

* **`main`**: Rama principal y estable lista para producción.
* **`develop`**: Rama de desarrollo activo donde se integran y prueban todas las nuevas características antes de fusionarse a `main`.

### Comandos iniciales para subir el código:

```bash
# Inicializar repositorio local
git init
git branch -M main

# Agregar archivos y primer commit
git add .
git commit -m "feat: initial commit - core architecture, prisma schema, waha client and gemini extractor"

# Vincular repositorio remoto y subir main
git remote add origin https://github.com/develophff-code/cuentas-pagar-saas.git
git push -u origin main

# Crear y posicionarse en la rama develop
git checkout -b develop
git push -u origin develop
```

A partir de allí, todo el trabajo diario se realiza sobre **`develop`**.

---

## 📄 Licencia

Desarrollado para uso propietario y comercial en plataforma SaaS.

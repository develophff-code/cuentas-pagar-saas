-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('BASIC', 'PROFESSIONAL', 'ULTRA');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDIENTE', 'EN_GRILLA', 'APROBADA', 'PAGADA', 'POSTERGADA', 'CANCELADA');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "cuit" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "address" TEXT,
    "planType" "PlanType" NOT NULL DEFAULT 'BASIC',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxUsers" INTEGER NOT NULL DEFAULT 1,
    "maxSuppliers" INTEGER NOT NULL DEFAULT 25,
    "maxInvoices" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "isVerified" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cuit" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "categories" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bank_accounts" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "bankName" TEXT,
    "cbuCvu" TEXT,
    "alias" TEXT,
    "accountType" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL DEFAULT 'A',
    "amount" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2),
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3) NOT NULL,
    "scheduledPaymentDate" TIMESTAMP(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'EN_GRILLA',
    "fileUrl" TEXT,
    "mimeType" TEXT,
    "notes" TEXT,
    "rawOcrData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_grid_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentDays" TEXT NOT NULL DEFAULT 'MARTES,JUEVES',
    "morningAlertTime" TEXT NOT NULL DEFAULT '08:00',
    "autoSchedule" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_grid_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IDLE',
    "contextData" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_cuit_key" ON "tenants"("cuit");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_phoneNumber_key" ON "tenant_users"("phoneNumber");

-- CreateIndex
CREATE INDEX "tenant_users_phoneNumber_idx" ON "tenant_users"("phoneNumber");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_categories_idx" ON "suppliers"("tenantId", "categories");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_cuit_key" ON "suppliers"("tenantId", "cuit");

-- CreateIndex
CREATE INDEX "invoices_tenantId_scheduledPaymentDate_idx" ON "invoices"("tenantId", "scheduledPaymentDate");

-- CreateIndex
CREATE INDEX "invoices_tenantId_status_idx" ON "invoices"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_grid_configs_tenantId_key" ON "payment_grid_configs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_sessions_phoneNumber_key" ON "conversation_sessions"("phoneNumber");

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bank_accounts" ADD CONSTRAINT "supplier_bank_accounts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_grid_configs" ADD CONSTRAINT "payment_grid_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

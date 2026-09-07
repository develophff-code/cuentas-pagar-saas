/*
  Warnings:

  - You are about to drop the column `categories` on the `suppliers` table. All the data in the column will be lost.
  - Added the required column `categoryId` to the `suppliers` table without a default value. This is not possible if the table is not empty.
  - Made the column `phone` on table `suppliers` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "suppliers_tenantId_categories_idx";

-- DropIndex
DROP INDEX "suppliers_tenantId_cuit_key";

-- AlterTable
ALTER TABLE "suppliers" DROP COLUMN "categories",
ADD COLUMN     "categoryId" TEXT NOT NULL,
ALTER COLUMN "cuit" DROP NOT NULL,
ALTER COLUMN "phone" SET NOT NULL;

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenantId_name_key" ON "categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_cuit_idx" ON "suppliers"("tenantId", "cuit");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_categoryId_idx" ON "suppliers"("tenantId", "categoryId");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 4: Role screen optimistic locking + "last saved by" (ROLE-8), designation lookups (DSG).

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "updated_by_id" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "users_designation_idx" ON "users"("designation");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

/**
 * المندوب الذكي — هل الميزة مفعّلة لهذا المندوب؟ (إعداد «مناديب محدّدون» في إعدادات الشركة)
 * العلم نفسه (Tenant.aiRepEnabled) يُفحص عند المستدعي؛ هنا النطاق ونشاط الحساب فقط.
 */
import prisma from '../config/database';
import { repInScope, settingsView, AiRepSettingsView } from './settings';

export async function aiRepForRep(tid: string, salesRepId: string): Promise<boolean> {
  const [row, rep] = await Promise.all([
    prisma.aiRepSettings.findUnique({ where: { tenantId: tid }, select: { repScope: true, repIds: true } }),
    prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { isActive: true } }),
  ]);
  return rep?.isActive === true && repInScope(settingsView(row as Partial<AiRepSettingsView> | null), salesRepId);
}

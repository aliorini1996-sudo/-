/**
 * قائمة تجربة النظام المحاسبي المتكامل (§8.1) — من M0 حتى قرار المالك بالإتاحة العامة.
 *
 * `LEDGER_PILOT_TENANTS` معرّفات شركات مفصولة بفواصل. **غيابه أو فراغه = لا أحد**
 * (فشلٌ مغلق): من M0 إلى M3 لا ترحيل آلي ولا معالج كامل، وتفعيل شركة حقيقية
 * يُنتج دفاتر يصطدم بها إعداد M3.
 *
 * دالة صرفة: البيئة تُمرَّر صراحةً فتُختبر بلا `process.env`.
 * إزالة الحارس التزامٌ مستقل بقرار المالك يحذف هذه الدالة واختبارها معاً.
 */
export function isLedgerPilotTenant(
  tenantId: string | null | undefined,
  env: { LEDGER_PILOT_TENANTS?: string | undefined } | NodeJS.ProcessEnv,
): boolean {
  const id = (tenantId ?? '').trim();
  if (!id) return false;
  const raw = env.LEDGER_PILOT_TENANTS;
  if (typeof raw !== 'string' || !raw.trim()) return false;
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(id);
}

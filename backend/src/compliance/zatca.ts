// ============================================================================
// محوّل امتثال ZATCA (السعودية) — المرحلة الأولى: توليد رمز QR بترميز TLV
// ----------------------------------------------------------------------------
// رمز QR للمرحلة الأولى = Base64 لسلسلة TLV من 5 حقول:
//   1) اسم البائع  2) الرقم الضريبي  3) الطابع الزمني  4) الإجمالي شامل الضريبة  5) إجمالي الضريبة
// تطبيق حقيقي مطابق لمواصفة الهيئة (لا وهمي).
// ============================================================================
import type { ComplianceInvoice, ComplianceProvider, ComplianceResult } from './provider';

// يبني عنصر TLV واحد (وسم + طول + قيمة UTF-8)
function tlv(tag: number, value: string): Buffer {
  const val = Buffer.from(value, 'utf8');
  // الطول بايت واحد يكفي لحقول المرحلة الأولى (< 256 بايت)
  return Buffer.concat([Buffer.from([tag]), Buffer.from([val.length]), val]);
}

// يولّد حمولة QR بصيغة ZATCA (Base64)
export function zatcaQrBase64(p: {
  sellerName: string; vatNumber: string; timestampIso: string; total: string; vatTotal: string;
}): string {
  const buf = Buffer.concat([
    tlv(1, p.sellerName),
    tlv(2, p.vatNumber),
    tlv(3, p.timestampIso),
    tlv(4, p.total),
    tlv(5, p.vatTotal),
  ]);
  return buf.toString('base64');
}

export const zatcaProvider: ComplianceProvider = {
  id: 'zatca',
  countryLabel: 'ZATCA — السعودية (المرحلة الأولى)',
  async build(inv: ComplianceInvoice): Promise<ComplianceResult> {
    const qr = zatcaQrBase64({
      sellerName: inv.seller.name,
      vatNumber: inv.seller.taxNumber,
      timestampIso: inv.issuedAt.toISOString(),
      total: inv.total.toFixed(2),
      vatTotal: inv.vatTotal.toFixed(2),
    });
    return { ok: true, provider: 'zatca', status: 'generated', qr };
  },
};

// توليد رمز QR للفاتورة الضريبية وفق متطلبات هيئة الزكاة والضريبة والجمارك (ZATCA) — المرحلة الأولى
// الرمز يشفّر 5 حقول بصيغة TLV (Tag-Length-Value) ثم Base64

// يبني عنصر TLV واحد: [رقم الحقل][طول القيمة بالبايت][بايتات القيمة UTF-8]
function tlv(tag: number, value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value ?? ''));
  return [tag, bytes.length, ...bytes];
}

export interface ZatcaQrData {
  sellerName: string;   // اسم البائع (الشركة)
  vatNumber: string;    // الرقم الضريبي للبائع (15 رقماً)
  timestamp: string;    // تاريخ ووقت الفاتورة بصيغة ISO 8601 (مثال: 2026-06-23T10:30:00Z)
  total: number;        // إجمالي الفاتورة شامل الضريبة
  vatTotal: number;     // مبلغ ضريبة القيمة المضافة
}

// يُرجع سلسلة Base64 جاهزة لتُحوَّل إلى رمز QR
export function buildZatcaQr(d: ZatcaQrData): string {
  const all = [
    ...tlv(1, d.sellerName),
    ...tlv(2, d.vatNumber),
    ...tlv(3, d.timestamp),
    ...tlv(4, d.total.toFixed(2)),
    ...tlv(5, d.vatTotal.toFixed(2)),
  ];
  let binary = '';
  for (const b of all) binary += String.fromCharCode(b);
  return btoa(binary);
}

// يحوّل تاريخ الفاتورة إلى صيغة ZATCA الزمنية (ISO 8601 بثوانٍ بلا أجزاء)
export function zatcaTimestamp(date: string | Date): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

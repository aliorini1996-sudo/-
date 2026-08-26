// عميل ميسر (Moyasar) — بوابة الدفع السعودية.
//
// المبدأ الامني الحاكم: المفتاح السري يعيش في متغير البيئة MOYASAR_SECRET_KEY
// حصرا — لا يُسجل في اللوج ولا يصل الواجهة ولا يدخل المستودع. والدفع كله يتم
// على صفحة ميسر المستضافة فلا تمر اي بيانات بطاقة بخوادمنا (خارج نطاق PCI).
//
// المصادقة: HTTP Basic بالمفتاح السري اسم مستخدم وكلمة مرور فارغة.
// المبالغ: بالهللات (ريال × ١٠٠) — قاعدة ميسر.

const BASE = 'https://api.moyasar.com/v1';

export interface MoyasarInvoice {
  id: string;
  status: string; // initiated | paid | canceled | expired | ...
  amount: number; // هللات
  currency: string;
  description: string | null;
  url: string;
  created_at: string;
}

export function moyasarConfigured(): boolean {
  return !!process.env.MOYASAR_SECRET_KEY;
}

function authHeader(): string {
  const key = process.env.MOYASAR_SECRET_KEY || '';
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok) {
    const msg = (data as { message?: string })?.message || `HTTP ${res.status}`;
    // لا نطبع الجسم كاملا — قد يحوي تفاصيل حساسة؛ الرسالة المقتضبة تكفي للتشخيص
    throw new Error(`Moyasar ${method} ${path}: ${msg}`);
  }
  return data as T;
}

/** انشاء فاتورة دفع مستضافة — تعيد رابط صفحة الدفع */
export function createInvoice(params: {
  amountHalalas: number;
  description: string;
  successUrl: string;
  backUrl: string;
  metadata?: Record<string, string>;
}): Promise<MoyasarInvoice> {
  return call<MoyasarInvoice>('POST', '/invoices', {
    amount: params.amountHalalas,
    currency: 'SAR',
    description: params.description,
    success_url: params.successUrl,
    back_url: params.backUrl,
    metadata: params.metadata,
  });
}

/** جلب فاتورة من ميسر — مصدر الحقيقة الوحيد لحالة الدفع (لا نثق بجسم اي webhook) */
export function fetchInvoice(id: string): Promise<MoyasarInvoice> {
  return call<MoyasarInvoice>('GET', `/invoices/${encodeURIComponent(id)}`);
}

/** كائن الدفعة لدى ميسر — ما يخصنا منه: الحالة والمبلغ والمردود */
export interface MoyasarPayment {
  id: string;
  status: string;          // paid | refunded | voided | failed | authorized | captured
  amount: number;          // بالهللات
  refunded?: number;       // المبلغ المردود بالهللات (٠ = لا ردّ)
  currency?: string;
  invoice_id?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * جلب دفعة من ميسر — لازم للاسترداد.
 * حدث `payment_refunded` يصل في جسم webhook، وجسم webhook لا يُوثق به مبدئياً
 * في هذا الملف؛ فالردّ لا يُعتمد حتى تؤكّده ميسر بمفتاحنا السرّي.
 */
export function fetchPayment(id: string): Promise<MoyasarPayment> {
  return call<MoyasarPayment>('GET', `/payments/${encodeURIComponent(id)}`);
}

/** الغاء فاتورة لدى ميسر — يستخدم لتنظيف فاتورة انشئت ولم يكتمل ربطها عندنا */
export function cancelInvoice(id: string): Promise<MoyasarInvoice> {
  return call<MoyasarInvoice>('PUT', `/invoices/${encodeURIComponent(id)}/cancel`);
}

/** ريال → هللات بتقريب امن (يرفض القيم غير المنطقية) */
export function sarToHalalas(sar: number): number {
  if (!Number.isFinite(sar) || sar <= 0 || sar > 1_000_000) {
    throw new Error('مبلغ غير صالح');
  }
  return Math.round(sar * 100);
}

/**
 * محرّك مزامنة الصفّ الصادر (Outbox) — يرفع المستندات المُنشأة أوف‑لاين عند عودة الاتصال.
 *
 * المبدأ: الخادم هو المرجع الوحيد. نعيد إرسال الحمولة كما التُقطت (مع clientRef = idempotency)،
 * فيمنحها الخادم الرقم النهائي ويشغّل منطقه. التكرار مستحيل (القيد على clientRef).
 *
 * الترتيب: الفواتير قبل السندات، وضمن كلٍّ بالترتيب الزمني (clientCreatedAt) — يحفظ تبعية
 * سند←فاتورة (M5). رفض الأعمال (4xx) ⇒ حالة «مرفوض» (M6)؛ انقطاع/5xx ⇒ يبقى في الصفّ.
 */

import repApi from './repApi';
import { outboxAll, outboxUpdate, OutboxDoc } from './offlineDb';

let syncing = false;
type Listener = () => void;
const listeners = new Set<Listener>();

// إشعار الواجهة بتغيّر الصفّ (شارة «N بانتظار الرفع»)
export function onOutboxChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() { listeners.forEach((fn) => { try { fn(); } catch { /* */ } }); }

export interface SyncResult { sent: number; rejected: number; pending: number; stopped: boolean }

/**
 * يرفع كل المستندات المصفوفة بالترتيب. آمن للاستدعاء المتكرّر (قفل داخلي).
 * يتوقّف عند أول انقطاع/خطأ خادم مؤقّت (يبقى الباقي مصفوفاً)؛ يتابع عند رفض الأعمال.
 */
export async function syncOutbox(): Promise<SyncResult> {
  if (syncing) return { sent: 0, rejected: 0, pending: 0, stopped: false };
  syncing = true;
  let sent = 0, rejected = 0, stopped = false;
  try {
    const queued = (await outboxAll())
      .filter((d) => d.status === 'queued')
      // الفواتير قبل السندات، ثم زمنياً — يضمن وجود الفاتورة قبل سندها على الخادم
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'invoice' ? -1 : 1;
        return a.clientCreatedAt.localeCompare(b.clientCreatedAt);
      });

    for (const doc of queued) {
      const endpoint = doc.kind === 'invoice' ? '/invoices' : '/receipts';
      try {
        const res = await repApi.post(endpoint, doc.payload);
        const server = res.data?.data ?? {};
        await outboxUpdate({ ...doc, status: 'sent', serverNumber: server.number, serverId: server.id });
        sent++;
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status && status >= 400 && status < 500) {
          // رفض أعمال (تجاوز ائتمان/سعر مرفوض/صنف معطّل...) — لا يُعاد، يراجعه المندوب (M6)
          const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
          await outboxUpdate({ ...doc, status: 'rejected', error: msg || 'رفضه الخادم' });
          rejected++;
        } else {
          // انقطاع أو خطأ خادم مؤقّت (5xx) — يبقى مصفوفاً، ونتوقّف (الشبكة غير مستقرّة)
          stopped = true;
          break;
        }
      }
    }
  } finally {
    syncing = false;
    notify();
  }
  const pending = (await outboxAll()).filter((d) => d.status === 'queued').length;
  return { sent, rejected, pending, stopped };
}

// عدد المستندات المنتظرة الآن
export async function pendingCount(): Promise<number> {
  return (await outboxAll()).filter((d) => d.status === 'queued').length;
}

// المستندات المرفوضة (لواجهة المراجعة — M6)
export async function rejectedDocs(): Promise<OutboxDoc[]> {
  return (await outboxAll()).filter((d) => d.status === 'rejected');
}

let started = false;
// يبدأ المزامنة التلقائية عند عودة الاتصال + محاولة أولى عند الإقلاع
export function startAutoSync(): void {
  if (started) return;
  started = true;
  window.addEventListener('online', () => { syncOutbox(); });
  // محاولة عند الإقلاع (قد يكون هناك صفّ متبقٍّ من جلسة سابقة)
  if (navigator.onLine) syncOutbox();
}

// هل الطلب فشل بسبب انقطاع الشبكة (لا استجابة خادم)؟ — للتفريق عن رفض الأعمال
export function isNetworkError(err: unknown): boolean {
  return !(err as { response?: unknown })?.response;
}

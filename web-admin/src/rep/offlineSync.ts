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
import { outboxAll, outboxUpdate, outboxDelete, OutboxDoc, currentRepId } from './offlineDb';

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
/**
 * مستندات صاحب الجلسة الحالية فقط. الخادم ينسب المستند لصاحب التوكن لحظة الرفع،
 * فرفعُ مستند مندوب بجلسة زميله ينسبه للزميل (عمولة/مخزون/تحصيل خاطئة) أو يُرفض 403
 * تحت عزل العملاء. المستندات القديمة بلا repId تُعتبر للمالك الحالي (ترقية سلسة).
 */
function ownedByCurrentRep(d: OutboxDoc): boolean {
  const me = currentRepId();
  return !d.repId || !me || d.repId === me;
}

export async function syncOutbox(): Promise<SyncResult> {
  if (syncing) return { sent: 0, rejected: 0, pending: 0, stopped: false };
  syncing = true;
  let sent = 0, rejected = 0, stopped = false;
  try {
    // ترتيب التبعية: العميل قبل فاتورته/سنده/زيارته — يضمن حلّ customerClientRef على الخادم
    const rank = (k: OutboxDoc['kind']) => (k === 'customer' ? 0 : k === 'invoice' ? 1 : k === 'receipt' ? 2 : 3);
    const endpointOf = (k: OutboxDoc['kind']) =>
      k === 'customer' ? '/customers' : k === 'invoice' ? '/invoices' : k === 'receipt' ? '/receipts' : '/visits';
    const queued = (await outboxAll())
      .filter((d) => d.status === 'queued' && ownedByCurrentRep(d))
      .sort((a, b) => (rank(a.kind) - rank(b.kind)) || a.clientCreatedAt.localeCompare(b.clientCreatedAt));

    for (const doc of queued) {
      const endpoint = endpointOf(doc.kind);
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
  const pending = (await outboxAll()).filter((d) => d.status === 'queued' && ownedByCurrentRep(d)).length;
  return { sent, rejected, pending, stopped };
}

// عدد المستندات المنتظرة الآن
export async function pendingCount(): Promise<number> {
  return (await outboxAll()).filter((d) => d.status === 'queued' && ownedByCurrentRep(d)).length;
}

// المستندات المرفوضة (لواجهة المراجعة — M6)
export async function rejectedDocs(): Promise<OutboxDoc[]> {
  return (await outboxAll()).filter((d) => d.status === 'rejected' && ownedByCurrentRep(d));
}

export async function rejectedCount(): Promise<number> {
  return (await rejectedDocs()).length;
}

// كل مستندات الصفّ (منتظر + مرفوض) — لواجهة المراجعة، الأحدث أولاً
export async function outboxDocs(): Promise<OutboxDoc[]> {
  return (await outboxAll())
    .filter((d) => d.status !== 'sent' && ownedByCurrentRep(d))
    .sort((a, b) => b.clientCreatedAt.localeCompare(a.clientCreatedAt));
}

// إعادة مستند مرفوض إلى الصفّ (بعد أن يعالج سببه — مثل رفع حدّ الائتمان من الأدمن)
export async function requeue(clientRef: string): Promise<void> {
  const doc = (await outboxAll()).find((d) => d.clientRef === clientRef);
  if (doc) { await outboxUpdate({ ...doc, status: 'queued', error: undefined }); notify(); }
}

// إزالة مستند من الصفّ (المندوب يعالج الورقة يدوياً)
export async function discard(clientRef: string): Promise<void> {
  await outboxDelete(clientRef);
  notify();
}

let started = false;
/**
 * مزامنة تلقائية عدوانية (M7) — «نقطة حفظ مبكّرة»: نرفع الصفّ فور توفّر أي اتصال كي تصل
 * المستندات للخادم قبل أي طرد لتخزين المتصفّح (iOS Safari يطرد بعد خمول/ضغط). المحفّزات:
 *   - حدث online (عودة الشبكة)      - إحضار التطبيق للمقدّمة (visibilitychange)
 *   - دورياً كل 30ث عند وجود اتصال  - محاولة عند الإقلاع
 * تعمل على كل المنصّات (بخلاف Background Sync API المحصور في كروم ولا يدعم iOS).
 * syncOutbox آمن للاستدعاء المتكرّر (قفل داخلي + يقرأ الصفّ فقط حين فارغ).
 */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  const trySync = () => { if (navigator.onLine) syncOutbox(); };
  window.addEventListener('online', trySync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) trySync(); });
  window.setInterval(trySync, 30000);
  trySync();
}

// هل الطلب فشل بسبب انقطاع الشبكة (لا استجابة خادم)؟ — للتفريق عن رفض الأعمال
export function isNetworkError(err: unknown): boolean {
  return !(err as { response?: unknown })?.response;
}

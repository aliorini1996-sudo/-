// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — اعتماديات فرع الإصدار في الإنتاج (Prisma، المخازن، حلقة المفاتيح، الدفتر، البثّ)
// ----------------------------------------------------------------------------
// مفصولة عن routes/invoicesZatca.ts عمداً: اختبارات الفرع تحقن مخازن ذاكرة ومحاكي معاملة، ولا تستورد config/database.
// • المعاملة التفاعلية بمهلٍ صريحة (§2.2): maxWait 10 ثوانٍ (الانتظار على قفل صفّ الوحدة) وtimeout 20 ثانية (الختم داخلها).
//   القفل داخل العملية (unitMutex) يصفّ الطلبات **قبل** طلب اتصال من المجمّع، فلا ينتظر أحدٌ على القفل وهو يحجز اتصالاً.
// • قيود دفتر العميل هي دوالّ services/accounting نفسها التي يستدعيها المسار القديم — بلا نسخة ثانية من المنطق.
// • التنبيه (ختم/سلسلة): سطر سجلّ برموز ثابتة (لا أسرار ولا نصّ فاتورة) + إشعار لإدارة الشركة خارج المعاملة الملغاة.
// لا يستورد services/gl.
// ============================================================================

import prisma from '../config/database';
import { prismaZatcaDocumentStore } from '../compliance/zatca/documentStore.prisma';
import { prismaIssuanceStore } from '../compliance/zatca/issueStore.prisma';
import { prismaEgsUnitStore } from '../compliance/zatca/onboardingStore';
import { prismaGoLiveStore } from '../compliance/zatca/goLiveStore.prisma';
import { keyringFromEnv } from '../compliance/zatca/secrets';
import { issuanceUnitMutex } from '../compliance/zatca/unitMutex';
import { postCashInvoiceEntries, postInvoiceEntries, postReturnEntries } from '../services/accounting';
import { publishInvoicesChanged } from '../services/liveEvents';
import { submitDocumentNow } from '../services/zatcaSubmit';
import type { NoteIssuanceDeps } from './invoicesNotes';
import type { Phase2Tx } from './invoicesZatca';

/** مهل معاملة الإصدار (§2.2). */
export const ISSUANCE_TX_MAX_WAIT_MS = 10_000;
export const ISSUANCE_TX_TIMEOUT_MS = 20_000;

let cached: NoteIssuanceDeps | null = null;

export function productionPhase2Deps(env: NodeJS.ProcessEnv = process.env): NoteIssuanceDeps {
  if (cached) return cached;
  const units = prismaEgsUnitStore(prisma);
  const documents = prismaZatcaDocumentStore(prisma);
  cached = {
    db: prisma,
    units,
    documents,
    chain: prismaIssuanceStore(),
    // حلقة المفاتيح تُقرأ لكل طلب (مفتاح مفقود ⇒ 503 من الفرع لا انهيار عند الإقلاع)
    keyring: () => keyringFromEnv(env),
    ledger: {
      postCashInvoice: (tx, tenantId, invoiceId, customerId, total, at) => postCashInvoiceEntries(tx as never, tenantId, invoiceId, customerId, total, at),
      postCreditInvoice: (tx, tenantId, invoiceId, customerId, total, at) => postInvoiceEntries(tx as never, tenantId, invoiceId, customerId, total, at),
      // Z5.5: الإشعار الدائن قيودُه قيود مرتجع، والمدين قيود فاتورة آجلة — البُناة القائمة نفسها بلا نسخة ثانية
      postReturn: (tx, tenantId, invoiceId, customerId, total, at) => postReturnEntries(tx as never, tenantId, invoiceId, customerId, total, at),
      postDebitNote: (tx, tenantId, invoiceId, customerId, total, at) => postInvoiceEntries(tx as never, tenantId, invoiceId, customerId, total, at),
      creditLimitNotice: async (tx, i) => {
        await tx.notification.create({
          data: {
            tenantId: i.tenantId,
            type: 'CREDIT_LIMIT_EXCEEDED',
            title: 'تجاوز الحد الائتماني',
            body: `العميل ${i.customerName} تجاوز حده الائتماني`,
            customerId: i.customerId,
            salesRepId: i.salesRepId,
            data: JSON.stringify({ invoiceId: i.invoiceId, balance: i.balance, limit: i.limit }),
          },
        });
      },
    },
    transaction: <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> =>
      prisma.$transaction(tx => fn(tx), { maxWait: ISSUANCE_TX_MAX_WAIT_MS, timeout: ISSUANCE_TX_TIMEOUT_MS }),
    publish: publishInvoicesChanged,
    // Z5.5 (نقد 13): رابط دفعٍ قائم على فاتورةٍ أُسقط جزء من قيمتها بإشعار دائن لا يبقى حيّاً — خارج المعاملة دائماً
    expireLinks: (tenantId, invoiceId) => {
      void import('../services/paylink')
        .then(m => m.expireStaleLinks(tenantId, invoiceId))
        .catch(e => console.error('[zatca:note] expire links failed:', (e as Error).message));
    },
    alert: async (err, at) => {
      console.error(`[zatca:issue] ${err.code} tenant=${at.tenantId} source=${err.logDetail?.source ?? '-'} code=${err.logDetail?.code ?? '-'}`);
      try {
        await prisma.notification.create({
          data: {
            tenantId: at.tenantId,
            type: 'ZATCA_ISSUE_FAILED',
            title: 'تعذّر إصدار فاتورة ضريبية',
            body: 'تعذّر توقيع فاتورة ضريبية إلكترونياً ولم تُصدر — أعد المحاولة، وإن تكرّر فراجع إعدادات الفوترة الإلكترونية',
            customerId: at.customerId,
            data: JSON.stringify({ code: err.code, source: err.logDetail?.source ?? null, detail: err.logDetail?.code ?? null }),
          },
        });
      } catch { /* التنبيه لا يغيّر الردّ */ }
    },
    now: () => new Date(),
    env,
    mutex: issuanceUnitMutex,
    // Z5.8 (D11): حفظ المستند الانتقاليّ لمراجعة الإدارة — طابور ZatcaCutoverReview (لا رفض صامت). ونقد 3: قراءة حسم الإدارة
    // لإعادة الرفع بمفتاح clientRef فتنتهي دورة الرفع (قبول ⇒ يُصدَر/يُسجَّل، رفض ⇒ يُرفض نهائياً) بدل حلقةٍ لا تنتهي.
    cutover: {
      record: input => prismaGoLiveStore(prisma).recordCutover(input),
      find: async (tenantId, clientRef) => {
        const row = await prismaGoLiveStore(prisma).findCutoverByClientRef(tenantId, clientRef);
        return row ? { status: row.status } : null;
      },
    },
    // Z5.4: الاعتماد الحيّ للقياسية — مقعد الإرسال المحجوز للطلب الحيّ (Z5.3 §الحصص)، ولا يرمي أبداً
    submitInline: async (ref, opts) => {
      try {
        return await submitDocumentNow(ref, { inline: true, timeoutMs: opts.timeoutMs });
      } catch (e) {
        console.error(`[zatca:clearance] inline submit failed doc=${ref.documentId}: ${(e as Error).message}`);
        return null;
      }
    },
  };
  return cached;
}

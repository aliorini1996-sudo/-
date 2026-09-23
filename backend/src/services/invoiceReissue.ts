// ============================================================================
// ZATCA المرحلة الثانية (Z5.4) — توصيل إعادة إصدار الفاتورة المبسّطة المرفوضة بالإنتاج (design Z5.9)
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.4» + design §3 Z5.9:
//   • الورقة عند المشتري فعلاً، فلا إبطال ولا رقم ثانٍ: مستندٌ جديد بالرقم والتاريخ نفسيهما (attemptNo + 1) من
//     `einvoiceSnapshot` — لا تُقرأ أسعار اليوم ولا بطاقة العميل اليوم، فلا ينحرف عن المطبوع.
//   • السلسلة تتقدّم بالقفل والـCAS نفسيهما: قفل الوحدة داخل العملية (issuanceUnitMutex) ثم FOR UPDATE داخل المعاملة.
//   • مهلة الإبلاغ من الإصدار **الأصلي** (نقد 15): الفاتورة تأخّرت فعلاً وتبقى ظاهرةً متأخّرة حتى تُقبل محاولة.
//   • بعد الالتزام: محاولة إرسال واحدة حيّة (best-effort) ثم بثّ — المسح شبكة الأمان على كلّ حال.
// لا يستورد services/gl (حارس tests/gl-hooks-static.test.ts).
// ============================================================================

import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { prismaZatcaDocumentStore } from '../compliance/zatca/documentStore.prisma';
import { ZatcaHttpError } from '../compliance/zatca/errors';
import { runIssuance } from '../compliance/zatca/issueTx';
import { openIssuanceSigning } from '../compliance/zatca/issueSigner';
import { prismaIssuanceStore, type IssuanceTx } from '../compliance/zatca/issueStore.prisma';
import { prismaEgsUnitStore } from '../compliance/zatca/onboardingStore';
import { reissueDecision, reissueInTx, type ReissueDecision, type ReissueResult } from '../compliance/zatca/reissue';
import { keyringFromEnv } from '../compliance/zatca/secrets';
import { issuanceUnitMutex } from '../compliance/zatca/unitMutex';
import { publishInvoicesChanged } from './liveEvents';
import { submitDocumentNow } from './zatcaSubmit';

/** مهل معاملة إعادة الإصدار — كمعاملة الإصدار نفسها (§2.2). */
export const REISSUE_TX_MAX_WAIT_MS = 10_000;
export const REISSUE_TX_TIMEOUT_MS = 20_000;
/** مهلة محاولة الإرسال الحيّة بعد الالتزام (المسح يُكمل إن انقضت). */
export const REISSUE_SUBMIT_TIMEOUT_MS = 15_000;

const INVOICE_REISSUE_SELECT = {
  id: true, tenantId: true, number: true, status: true, zatcaPhase: true, invoiceSubtype: true, einvoiceStatus: true,
  einvoiceSnapshot: true, issuedAt: true, customerId: true, salesRepId: true,
} satisfies Prisma.InvoiceSelect;

export interface ReissueOutcome {
  ok: boolean;
  decision: ReissueDecision;
  result: ReissueResult | null;
  /** حالة المستند بعد محاولة الإرسال الحيّة (SIGNED إن لم تُحسم). */
  documentStatus: string | null;
}

/**
 * يعيد إصدار مستند مبسّط رفضته الهيئة. يرمي ZatcaHttpError من الختم/السلسلة/الوحدة كما يفعل مسار الإصدار،
 * ويعيد القرار (لا رمي) حين لا تكون الفاتورة مؤهَّلة — المسار يحوّله إلى 409 برسالته العربية.
 */
export async function reissuePhase2Invoice(
  input: { tenantId: string; invoiceId: string; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<ReissueOutcome> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const documents = prismaZatcaDocumentStore(prisma);
  const units = prismaEgsUnitStore(prisma);

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.tenantId },
    select: INVOICE_REISSUE_SELECT,
  });
  const projection = invoice ? await documents.loadProjection(input.tenantId, input.invoiceId) : null;
  const decision = reissueDecision({
    invoice: {
      status: invoice?.status ?? '',
      zatcaPhase: invoice?.zatcaPhase ?? null,
      invoiceSubtype: invoice?.invoiceSubtype ?? null,
      einvoiceStatus: invoice?.einvoiceStatus ?? null,
      einvoiceSnapshot: invoice?.einvoiceSnapshot ?? null,
      issuedAt: invoice?.issuedAt ?? null,
    },
    document: projection ? { attemptNo: projection.attemptNo, status: projection.status } : null,
  });
  if (!decision.ok) return { ok: false, decision, result: null, documentStatus: projection?.status ?? null };

  const egsUnitId = (projection as { egsUnitId: string }).egsUnitId;
  const unit = await units.loadUnit(egsUnitId);
  if (!unit || unit.tenantId !== input.tenantId) {
    throw new ZatcaHttpError('ZATCA_UNIT_UNAVAILABLE', { logDetail: { source: 'REISSUE', code: 'NO_UNIT' } });
  }
  const signing = await openIssuanceSigning(
    { store: units, keyring: () => keyringFromEnv(env), now },
    { id: unit.id, tenantId: unit.tenantId, keyVersion: unit.keyVersion, vatNumber: unit.vatNumber },
  );
  const seller = await units.loadSellerSettings(input.tenantId);

  const result = await runIssuance<ReissueResult>({
    unitId: unit.id,
    transaction: () => prisma.$transaction(
      async tx => reissueInTx<IssuanceTx>(tx as IssuanceTx, { chain: prismaIssuanceStore(), documents, now: () => now }, {
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        attemptNo: decision.attemptNo,
        subtype: '02',
        snapshot: decision.snapshot,
        originalIssuedAt: decision.issuedAt,
        signing,
        sellerVat: seller?.taxNumber ?? null,
        hooks: {
          remirror: async (t, mirror) => {
            await t.invoice.update({ where: { id: input.invoiceId }, data: { ...mirror } });
          },
        },
      }),
      { maxWait: REISSUE_TX_MAX_WAIT_MS, timeout: REISSUE_TX_TIMEOUT_MS },
    ),
  });

  // محاولة حيّة واحدة (best-effort): فشلها لا يُلغي إصداراً التُزم، والمسح الدوري يُكمل
  let documentStatus: string | null = 'SIGNED';
  try {
    const sent = await submitDocumentNow({ documentId: result.documentId, tenantId: input.tenantId }, {
      inline: true, timeoutMs: REISSUE_SUBMIT_TIMEOUT_MS,
    });
    documentStatus = sent.kind === 'done' ? sent.status : 'SIGNED';
  } catch (e) {
    console.error(`[zatca:reissue] submit failed doc=${result.documentId}: ${(e as Error).message}`);
  }
  try {
    const after = await documents.loadProjection(input.tenantId, input.invoiceId);
    if (after) documentStatus = after.status;
  } catch { /* الحالة المعروضة لا تُفشل إصداراً التُزم */ }

  publishInvoicesChanged(input.tenantId);
  return { ok: true, decision, result, documentStatus };
}

// ============================================================================
// ZATCA المرحلة الثانية (Z5.7) — مسارات شاشة متابعة المستندات وتنزيل الـXML الموقَّع
// ----------------------------------------------------------------------------
// موجّهٌ **مستقلّ** يُركَّب على `/api/invoices` بعد الموجّه الأصليّ (سطرا mount في index.ts وحدهما): مسارٌ لا يطابقه
// شيءٌ في `routes/invoices.ts` يسقط إليه، فلا تُلمس ملفات يعمل عليها مسارٌ آخر الآن.
//
// ما يسدّه (فجوات وثّقتها Z5.6 نصّاً في web-admin/src/lib/zatca/docQueue.ts):
//   ١) **العدّاد عن الشركة لا عن نافذةٍ من ٢٠٠ صفّ**: الشاشة كانت تصفّح جدول الفواتير وتصنّف في المتصفّح، فشركةٌ
//      كبيرة يسقط أقدمُ مستنداتها من القراءة — وهي بعينها الأقرب لتجاوز مهلة الإبلاغ (٢٤ ساعة = مخالفة نظامية).
//      هنا `GROUP BY einvoiceStatus` على صفوف المرحلة الثانية وحدها، وعدّ التأخّر من `zatca_documents` بفهرس المهلة.
//   ٢) **رسائل الهيئة لكلّ مستند**: مخزَّنة في `ZatcaDocument.validation` و`ZatcaApiLog` ولا يعيدها مسار. تُسقَط هنا
//      بقائمة حقولٍ بيضاء ومُنقّاة (compliance/zatca/docsPanel.ts) — لا سرّ ولا رمز ولا OTP ولا جسم ردٍّ خام.
//   ٣) **مفتاح إيقاف الإرسال** (`CompanySettings.zatcaSubmitPausedAt`): كان بيد رمز التشغيل (`/api/ops/zatca-sweep`)
//      وحده، فمدير الشركة يرى «تأخّراً» ولا يعرف أنّ الإرسال موقوف. يُقرأ هنا، ويُبدَّل بمدير الشركة (ADMIN) نفسه.
//   ٤) **تنزيل الـXML الموقَّع**: المستند القانونيّ كان محبوساً في القاعدة مضغوطاً بلا أيّ مخرج.
//
// حراسة ثابتة في كلّ مسار:
//   • شركة غير مفعَّلة للمرحلة الثانية (`zatcaPhase2StartedAt = NULL`) **لا تُستعلَم أبداً بعد قراءة إعداداتها**:
//     تُردّ 200 بـ`live:false` وأصفار (الشاشة تُخفي نفسها)، والمسارات التي تخصّ مستنداً بعينها تردّ 404.
//   • كلّ استعلام بـ`tenantId`، وكلّ استعلام على الفواتير يحمل قيد نطاق مستخدم الشركة (`scopedRecordWhere`)
//     كما في `GET /invoices` — مستخدمٌ مقيَّد لا يرى في شاشة الضريبة ما مُنع عنه في شاشة الفواتير.
//   • `zatcaPhase: 2` في كلّ مرشِّح فواتير: صفّ المرحلة الأولى لا يدخل هذه الشاشة ولا يُعدّ فيها.
// ============================================================================

import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { scopedRecordWhere, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { gunzipXml } from '../compliance/zatca/documentStore';
import {
  BUCKET_MIRRORS, MAX_LOG_ROWS, NON_FINAL_DOCUMENT_STATUSES, QUEUE_BUCKETS, apiLogLineOf, bucketOfMirror,
  contentDispositionOf, countsFromMirrors, diagnosticsOf, emptyCounts, headlineMessage, isQueueFilter, isXmlVariant,
  mirrorMessagesOf, xmlFileNameOf, type QueueFilter, type XmlVariant,
} from '../compliance/zatca/docsPanel';
import { isShareableDocument, makeShareToken, shareSecretFrom, shareUrlOf } from '../compliance/zatca/publicView';
import { isOverdue, subtypeOfTypeName } from '../compliance/zatca/status';

const router = Router();

/**
 * الموجّه الأصليّ (`routes/invoices.ts`) يفتح بـ`authenticate`، فالطلب الذي يسقط إلينا يحمل `req.user` مصدَّقاً.
 * فلا نعيد قراءة الحساب من القاعدة مرّةً ثانية، ولا نترك المسار مفتوحاً إن ركّبه أحدٌ يوماً في موضعٍ آخر.
 */
const ensureAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user) { next(); return; }
  void authenticate(req, res, next);
};

router.use(ensureAuth);

// ─── ثوابت وأدوات ───

/** كلّ مرايا المرحلة الثانية — مرشِّح «الكلّ» صريحٌ لا `not: null`: قيمةٌ غريبة لا تدخل الشاشة بلا دلو. */
const ALL_MIRRORS: readonly string[] = Object.freeze([...new Set(QUEUE_BUCKETS.flatMap(b => [...BUCKET_MIRRORS[b]]))]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 5_000;

const intParam = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** قيد النطاق يُلفّ في علاقة الفاتورة للاستعلامات التي تبدأ من جدول المستندات؛ والفارغ لا يُكتب أصلاً. */
const relScope = (scope: Record<string, unknown>): Record<string, unknown> =>
  Object.keys(scope).length === 0 ? {} : { invoice: scope };

interface LiveGate {
  live: boolean;
  submitPausedAt: Date | null;
}

/**
 * البوابة الوحيدة: قراءةٌ واحدة لإعدادات الشركة. `zatcaPhase2StartedAt` هو مفتاح «حيّة» (z5_plan §0 قاعدة 1)،
 * وما دام فارغاً لا يُنفَّذ أيّ استعلامٍ آخر من هذه الشاشة على تلك الشركة.
 */
async function liveGate(tid: string): Promise<LiveGate> {
  const s = await prisma.companySettings.findUnique({
    where: { tenantId: tid },
    select: { zatcaPhase2StartedAt: true, zatcaSubmitPausedAt: true },
  });
  return { live: s?.zatcaPhase2StartedAt != null, submitPausedAt: s?.zatcaSubmitPausedAt ?? null };
}

const INVOICE_SELECT = {
  id: true, number: true, invoiceDate: true, issuedAt: true, total: true, currency: true, status: true,
  einvoiceStatus: true, einvoiceWarnings: true, invoiceSubtype: true, documentKind: true,
  customer: { select: { id: true, name: true } },
} as const;

const DOC_SELECT = {
  id: true, invoiceId: true, attemptNo: true, icv: true, uuid: true, typeName: true, typeCode: true, flow: true,
  status: true, httpStatus: true, validation: true, attempts: true, sentAttempts: true, nextAttemptAt: true,
  firstSubmitAt: true, finalizedAt: true, reportDeadline: true, issueDate: true, issueTime: true, updatedAt: true,
} as const;

type InvoiceRow = {
  id: string; number: string; invoiceDate: Date; issuedAt: Date | null; total: number; currency: string | null;
  status: string; einvoiceStatus: string | null; einvoiceWarnings: string | null; invoiceSubtype: string | null;
  documentKind: string | null; customer: { id: string; name: string } | null;
};

type DocRow = {
  id: string; invoiceId: string; attemptNo: number; icv: number; uuid: string; typeName: string; typeCode: string;
  flow: string; status: string; httpStatus: number | null; validation: unknown; attempts: number; sentAttempts: number;
  nextAttemptAt: Date | null; firstSubmitAt: Date | null; finalizedAt: Date | null; reportDeadline: Date | null;
  issueDate: string; issueTime: string; updatedAt: Date;
};

/** النسخة المعتمدة تُخزَّن للمعتمدة وحدها (submit.ts: `clearedXmlGz` تُكتب حين وصل مستند الهيئة). */
const hasClearedXml = (status: string): boolean => status === 'CLEARED' || status === 'CLEARED_WARN';

/** صفّ الشاشة: الفاتورة (المرآة) + آخر محاولة مستند (التشخيص) — بلا بايتات ولا لقطة XML ولا رمز الهيئة الكامل. */
function rowOf(inv: InvoiceRow, doc: DocRow | null, now: Date) {
  const overdue = doc ? isOverdue({ status: doc.status, reportDeadline: doc.reportDeadline }, now) : false;
  const diagnostics = doc ? diagnosticsOf(doc.validation) : null;
  const headline = diagnostics ? headlineMessage(diagnostics) : (mirrorMessagesOf(inv.einvoiceWarnings)[0] ?? null);
  return {
    invoiceId: inv.id,
    number: inv.number,
    invoiceDate: inv.invoiceDate,
    issuedAt: inv.issuedAt,
    total: inv.total,
    currency: inv.currency,
    invoiceStatus: inv.status,
    documentKind: inv.documentKind,
    subtype: inv.invoiceSubtype ?? (doc ? subtypeOfTypeName(doc.typeName) : null),
    customerName: inv.customer?.name ?? null,
    mirror: inv.einvoiceStatus,
    bucket: bucketOfMirror(inv.einvoiceStatus, overdue),
    overdue,
    document: doc === null ? null : {
      id: doc.id,
      attemptNo: doc.attemptNo,
      icv: doc.icv,
      uuid: doc.uuid,
      status: doc.status,
      flow: doc.flow,
      httpStatus: doc.httpStatus,
      attempts: doc.attempts,
      sentAttempts: doc.sentAttempts,
      nextAttemptAt: doc.nextAttemptAt,
      firstSubmitAt: doc.firstSubmitAt,
      finalizedAt: doc.finalizedAt,
      reportDeadline: doc.reportDeadline,
      updatedAt: doc.updatedAt,
      xml: { signed: true, cleared: hasClearedXml(doc.status) },
    },
    lastMessage: headline,
  };
}

/** آخر محاولة لكلّ فاتورة من دفعةٍ واحدة (لا استعلام لكلّ صفّ). */
function latestByInvoice(docs: readonly DocRow[]): Map<string, DocRow> {
  const out = new Map<string, DocRow>();
  for (const d of docs) {
    const cur = out.get(d.invoiceId);
    if (!cur || d.attemptNo > cur.attemptNo) out.set(d.invoiceId, d);
  }
  return out;
}

// ─── 1) الملخّص: عدّادات الشركة كلّها + حال مفتاح الإرسال ───

/**
 * `GET /api/invoices/einvoice/summary`
 * ثلاثة استعلامات مهما كبرت الشركة: الإعدادات، تجميعة المرايا، وعدّ التأخّر (+ أقرب مهلة) من فهرس المهلة.
 */
router.get('/einvoice/summary', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const gate = await liveGate(tid);
    if (!gate.live) {
      res.json({ success: true, data: { live: false, submitPausedAt: null, counts: emptyCounts(), total: 0, earliestDeadlineAt: null } });
      return;
    }
    const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const now = new Date();
    const [groups, overdue] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['einvoiceStatus'],
        where: { tenantId: tid, zatcaPhase: 2, einvoiceStatus: { in: ALL_MIRRORS as string[] }, ...scope },
        _count: { _all: true },
      }),
      prisma.zatcaDocument.aggregate({
        _count: { _all: true },
        _min: { reportDeadline: true },
        where: {
          tenantId: tid, status: { in: NON_FINAL_DOCUMENT_STATUSES as string[] },
          reportDeadline: { lt: now }, ...relScope(scope),
        },
      }),
    ]);
    const counts = countsFromMirrors(
      groups.map(g => ({ mirror: g.einvoiceStatus, count: g._count._all })),
      overdue._count._all,
    );
    const total = QUEUE_BUCKETS.reduce((n, b) => n + counts[b], 0);
    res.json({
      success: true,
      data: {
        live: true,
        submitPausedAt: gate.submitPausedAt,
        counts,
        total,
        earliestDeadlineAt: overdue._min.reportDeadline ?? null,
        at: now,
      },
    });
  } catch (e) { next(e); }
});

// ─── 2) القائمة: صفحة واحدة من دلوٍ واحد ───

/**
 * `GET /api/invoices/einvoice/documents?state=all|overdue|blocked|pending|rejected|done&limit=&offset=`
 * استعلامان: صفحةُ المفاتيح ثمّ مستنداتها دفعةً واحدة. لا لقطة XML ولا بايتات في أيّ ردّ.
 */
router.get('/einvoice/documents', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const state: QueueFilter = isQueueFilter(req.query.state) ? req.query.state : 'all';
    const gate = await liveGate(tid);
    if (!gate.live) {
      res.json({ success: true, data: { live: false, state, rows: [], hasMore: false, submitPausedAt: null } });
      return;
    }
    const limit = intParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(req.query.offset, 0, 0, MAX_OFFSET);
    const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const now = new Date();

    let invoices: InvoiceRow[];
    let docs: DocRow[];

    if (state === 'overdue') {
      // التأخّر حالةٌ على المستند لا على المرآة: يُقرأ من فهرس المهلة، الأقرب فوتاً أوّلاً
      const found = await prisma.zatcaDocument.findMany({
        where: {
          tenantId: tid, status: { in: NON_FINAL_DOCUMENT_STATUSES as string[] },
          reportDeadline: { lt: now }, ...relScope(scope),
        },
        orderBy: [{ reportDeadline: 'asc' }, { id: 'asc' }],
        skip: offset, take: limit + 1,
        select: { ...DOC_SELECT, invoice: { select: INVOICE_SELECT } },
      }) as unknown as Array<DocRow & { invoice: InvoiceRow }>;
      docs = found.map(({ invoice: _i, ...d }) => d);
      invoices = found.map(f => f.invoice);
    } else {
      const mirrors = state === 'all' ? ALL_MIRRORS : BUCKET_MIRRORS[state];
      invoices = await prisma.invoice.findMany({
        where: { tenantId: tid, zatcaPhase: 2, einvoiceStatus: { in: mirrors as string[] }, ...scope },
        orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
        skip: offset, take: limit + 1,
        select: INVOICE_SELECT,
      }) as unknown as InvoiceRow[];
      const ids = invoices.map(i => i.id);
      docs = ids.length === 0 ? [] : (await prisma.zatcaDocument.findMany({
        where: { tenantId: tid, invoiceId: { in: ids } },
        orderBy: [{ attemptNo: 'desc' }],
        select: DOC_SELECT,
      })) as unknown as DocRow[];
    }

    const hasMore = invoices.length > limit;
    const page = hasMore ? invoices.slice(0, limit) : invoices;
    const byInvoice = latestByInvoice(docs);
    res.json({
      success: true,
      data: {
        live: true,
        state,
        submitPausedAt: gate.submitPausedAt,
        rows: page.map(inv => rowOf(inv, byInvoice.get(inv.id) ?? null, now)),
        hasMore,
        limit,
        offset,
      },
    });
  } catch (e) { next(e); }
});

// ─── 3) تشخيص مستندٍ واحد: رسائل الهيئة وأثر الطلبات ───

/** `GET /api/invoices/:id/einvoice/messages` — ما قالته الهيئة لهذا المستند، منقّى. 404 لغير المرحلة الثانية. */
router.get('/:id/einvoice/messages', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const doc = await prisma.zatcaDocument.findFirst({
      where: { tenantId: tid, invoiceId: req.params.id, ...relScope(scope) },
      orderBy: { attemptNo: 'desc' },
      select: { ...DOC_SELECT, invoice: { select: { number: true, einvoiceStatus: true, einvoiceWarnings: true } } },
    }) as unknown as (DocRow & { invoice: { number: string; einvoiceStatus: string | null; einvoiceWarnings: string | null } }) | null;
    if (!doc) { res.status(404).json({ success: false, message: 'لا يوجد مستند ضريبي لهذه الفاتورة' }); return; }

    const logs = await prisma.zatcaApiLog.findMany({
      where: { tenantId: tid, documentId: doc.id },
      orderBy: { createdAt: 'desc' },
      take: MAX_LOG_ROWS,
      select: { createdAt: true, endpoint: true, httpStatus: true, outcome: true, durationMs: true, errorText: true },
    });

    const now = new Date();
    res.json({
      success: true,
      data: {
        invoiceId: doc.invoiceId,
        number: doc.invoice.number,
        mirror: doc.invoice.einvoiceStatus,
        document: {
          id: doc.id, attemptNo: doc.attemptNo, icv: doc.icv, uuid: doc.uuid, status: doc.status, flow: doc.flow,
          subtype: subtypeOfTypeName(doc.typeName), httpStatus: doc.httpStatus, attempts: doc.attempts,
          sentAttempts: doc.sentAttempts, nextAttemptAt: doc.nextAttemptAt, firstSubmitAt: doc.firstSubmitAt,
          finalizedAt: doc.finalizedAt, reportDeadline: doc.reportDeadline, issueDate: doc.issueDate,
          issueTime: doc.issueTime, updatedAt: doc.updatedAt,
          overdue: isOverdue({ status: doc.status, reportDeadline: doc.reportDeadline }, now),
          xml: { signed: true, cleared: hasClearedXml(doc.status) },
        },
        diagnostics: diagnosticsOf(doc.validation),
        mirrorMessages: mirrorMessagesOf(doc.invoice.einvoiceWarnings),
        logs: logs.map(apiLogLineOf),
      },
    });
  } catch (e) { next(e); }
});

// ─── 4) تنزيل الـXML ───

/**
 * `GET /api/invoices/:id/einvoice/xml?variant=signed|cleared`
 * البايتات كما خزّنها المحرّك (gzip بلا فقد) تُفكّ وتُرسل نصّاً. الافتراضيّ: المعتمدة إن وُجدت (هي المستند القانونيّ
 * للقياسية)، وإلّا الموقَّعة. طلبُ نسخةٍ غير مخزَّنة يردّ 404 صراحةً — لا ملفٌّ فارغ يُحسب فاتورةً.
 */
router.get('/:id/einvoice/xml', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const doc = await prisma.zatcaDocument.findFirst({
      where: { tenantId: tid, invoiceId: req.params.id, ...relScope(scope) },
      orderBy: { attemptNo: 'desc' },
      select: { id: true, attemptNo: true, status: true, invoice: { select: { number: true } } },
    });
    if (!doc) { res.status(404).json({ success: false, message: 'لا يوجد مستند ضريبي لهذه الفاتورة' }); return; }

    const asked = req.query.variant;
    const variant: XmlVariant = isXmlVariant(asked) ? asked : (hasClearedXml(doc.status) ? 'cleared' : 'signed');

    let gz: Uint8Array | null = null;
    if (variant === 'cleared') {
      const r = await prisma.zatcaDocument.findUnique({ where: { id: doc.id }, select: { clearedXmlGz: true } });
      gz = r?.clearedXmlGz ?? null;
    } else {
      const r = await prisma.zatcaDocument.findUnique({ where: { id: doc.id }, select: { xmlGz: true } });
      gz = r?.xmlGz ?? null;
    }
    if (!gz || gz.length === 0) {
      res.status(404).json({ success: false, message: 'النسخة المطلوبة من المستند غير مخزّنة' });
      return;
    }

    let xml: string;
    try {
      xml = gunzipXml(gz);
    } catch {
      res.status(500).json({ success: false, message: 'تعذّر فكّ ضغط المستند المخزّن' });
      return;
    }
    const fileName = xmlFileNameOf({ number: doc.invoice?.number ?? null, attemptNo: doc.attemptNo, variant });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', contentDispositionOf(fileName));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(xml);
  } catch (e) { next(e); }
});

// ─── 5) مفتاح إيقاف الإرسال بيد مدير الشركة ───

/**
 * `POST /api/invoices/einvoice/submit-pause` — الجسم `{ paused: boolean }`.
 * مدير الشركة (ADMIN) وحده: هذا مفتاحٌ يوقف تسليم مستندات الشركة كلّها إلى الهيئة، ومهلة الإبلاغ تسري وهو موقوف.
 * يُكتب له أثرٌ في `zatca_api_logs` (endpoint = `ui:submit-pause`) — قرارٌ نظاميّ لا يمرّ بلا سجلّ.
 */
router.post('/einvoice/submit-pause', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'ADMIN') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const tid = tenantId(req);
    const body = (req.body ?? {}) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') { res.status(400).json({ success: false, message: 'paused مطلوب (true/false)' }); return; }
    const gate = await liveGate(tid);
    if (!gate.live) { res.status(404).json({ success: false, message: 'الفوترة الإلكترونية غير مفعّلة لهذه الشركة' }); return; }

    const { setTenantSubmitPaused } = await import('../services/zatcaSubmit');
    let pausedAt: Date | null;
    try {
      ({ pausedAt } = await setTenantSubmitPaused(tid, body.paused));
    } catch (e) {
      if ((e as Error)?.message === 'COMPANY_SETTINGS_NOT_FOUND') {
        res.status(404).json({ success: false, message: 'إعدادات الشركة غير موجودة' });
        return;
      }
      throw e;
    }
    // الأثر لا يُفشل الإجراء: المفتاح بُدِّل فعلاً، وفشل كتابة السطر لا يعيده
    try {
      await prisma.zatcaApiLog.create({
        data: {
          tenantId: tid, actorId: req.user?.id ?? null, endpoint: 'ui:submit-pause',
          outcome: body.paused ? 'PAUSED' : 'RESUMED',
        },
      });
    } catch (e) {
      console.error('zatca submit-pause log error:', (e as Error).message);
    }
    res.json({ success: true, data: { pausedAt } });
  } catch (e) { next(e); }
});

// ─── 6) رابط المشتري (Z5.7) ───

/**
 * `GET /api/invoices/:id/einvoice/share` — الرابط العلنيّ لهذا المستند كي يُرسل للمشتري.
 *
 * الرمز **مشتقّ** لا مخزَّن (compliance/zatca/publicView.ts): نداءان لنفس الفاتورة يعطيان الرابط نفسه، فلا
 * يتكاثر رابطٌ لكلّ فتحة شاشة ولا يحتاج المخطّط عموداً. ومستندٌ لم يصر نهائياً يردّ `available:false` بسببٍ
 * مقروء — لا رابط يُصدَر لفاتورةٍ قد ترفضها الهيئة بعد ساعة.
 */
router.get('/:id/einvoice/share', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const doc = await prisma.zatcaDocument.findFirst({
      where: { tenantId: tid, invoiceId: req.params.id, ...relScope(scope) },
      orderBy: { attemptNo: 'desc' },
      select: {
        id: true, status: true, typeName: true,
        invoice: { select: { number: true, einvoiceStatus: true, zatcaPhase: true } },
      },
    }) as unknown as {
      id: string; status: string; typeName: string;
      invoice: { number: string; einvoiceStatus: string | null; zatcaPhase: number | null } | null;
    } | null;
    if (!doc) { res.status(404).json({ success: false, message: 'لا يوجد مستند ضريبي لهذه الفاتورة' }); return; }

    const mirror = doc.invoice?.einvoiceStatus ?? null;
    const base = { invoiceId: req.params.id, number: doc.invoice?.number ?? null, status: doc.status, mirror };
    const shareable = isShareableDocument({
      status: doc.status, mirror, subtype: subtypeOfTypeName(doc.typeName), phase: doc.invoice?.zatcaPhase ?? null,
    });
    if (!shareable) {
      res.json({ success: true, data: { ...base, available: false, reason: 'NOT_FINAL', token: null, url: null } });
      return;
    }
    const token = makeShareToken(doc.id, shareSecretFrom(process.env.JWT_SECRET));
    if (!token) {
      // سرّ الخادم غير مضبوط: الميزة مغلقة كلّها (الرابط لا يُصدَر ولا يُقبل) — يُقال صراحةً لا يُخفى
      res.json({ success: true, data: { ...base, available: false, reason: 'NOT_CONFIGURED', token: null, url: null } });
      return;
    }
    const site = (process.env.PUBLIC_SITE_URL || 'https://fieldsa.net').replace(/\/+$/, '');
    res.json({ success: true, data: { ...base, available: true, reason: null, token, url: shareUrlOf(site, token) } });
  } catch (e) { next(e); }
});

export default router;

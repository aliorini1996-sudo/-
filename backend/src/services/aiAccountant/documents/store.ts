/**
 * «المحاسب الذكي AI» — مستندات المحادثة: التخزين (طلب المالك ١٨ نوفمبر ٢٠٢٦، التصميم §2 بعد القرارات D1–D8).
 *
 * الملف في جداول مرفقات الدفاتر نفسها (GlAttachment + GlAttachmentBlob، بايتات خام): يُخزَّن أولاً entityType 'AI_DOC'
 * ومعرّفه entityId = معرّف المستند، ثم يُعاد توجيه الصفّ نفسه إلى 'MOVE'/<moveId> داخل معاملة الترحيل بعد postMove
 * (relinkDocAttachment) — بلا نسخ بايتات، فيظهر في لوحة مرفقات القيد كما هو. لا يُربط بمسودة أبداً (حذف المسودة يحذف مرفقاتها).
 * الحقائق والحالة في AiAccountantDocument. لا قارئ ذكاء اصطناعي (D4): الحقائق من QR الزكوي أو إدخال المستخدم (facts.ts).
 *
 * الرفع (uploadDocument): النوع من البايتات ⇒ سقف الملف ⇒ معاملة بقفل 'gl-attach:'+tenantId: جمع المهمَل (≤ ٥٠) ⇒ عدم
 * التكرار (الشركة + الرافع + البصمة ⇒ الصفّ القائم deduped) ⇒ الحصة الشهرية والكلية (حساب moves.ts نفسه، مشتركة مع
 * مرفقات الدفاتر) ⇒ المرفق والمستند. عدم التكرار قبل الحصة: إعادة رفع ملفٍ قائم لا تكلّف شيئاً فلا يردّها سقفٌ بلغته الشركة.
 * العزل: الشركة من الجلسة وحدها في كل استعلام، وغير المرحّل لرافعه وحده (actorRef = adminId | OWNER:<id>).
 * البقاء بالنشاط لا بالإنشاء: الجمع على updatedAt (gc.ts)، والتصحيح يجدّده (@updatedAt) وإعادة رفع الملف نفسه تلمسه.
 * ترتيب الأقفال واحد في الترحيل والجمع والحذف: صفّ المرفق ثم صفّ المستند (لا تعارض أقفال بين نافذتين).
 * «مرحَّل» مشتقّ: moveId مضبوط وقيده POSTED بلا قيد عاكس (postedStates) — العكس من الدفاتر لا يحتاج خطّافاً.
 * القاعدة تُحقن (أدنى شكل) فيُختبر الملف بمخزن مزيّف.
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { appendAudit, SYSTEM_ACTOR, type GlActor } from '../../gl/audit';
import { DEFAULT_TIMEZONE, startOfMonth, todayLocal, zonedStartOfDay } from '../../gl/dates';
import type { GlDb } from '../../gl/resolve';
import { AiPostRefusal } from '../posting';
import {
  GC_BATCH, docCapViolation, docCaps, docFileCapViolation, docFileNameOf, qrHeaderOf, sniffDocMime, assetThresholdMilli,
  type DocCaps,
} from './caps';
import { gcTenantDocs, lockDocAttachments } from './gc';
import { refreshDateChecks, refreshedStatus } from './checks';
import { AcctDocPatchError, applyUserPatch, factsFromQrWithEnv, recheckWithEnv, suggestWithEnv } from './facts';
import {
  ACCT_ASSET_CODES, ACCT_DOC_CODES, emptyFacts,
  type AcctAccountOption, type AcctDocChartAccount, type AcctDocCheck, type AcctDocDuplicate, type AcctDocEnv, type AcctDocFacts,
  type AcctDocPatch, type AcctDocPosted, type AcctDocRecheck, type AcctDocStatus, type AcctDocView, type AcctFactsSource,
  type AcctPayOption,
} from './types';
import { DOC_ROW_SELECT, parseChecks, parseFacts, toView, type DocRow } from './view';

export { DOC_ROW_SELECT, type DocRow } from './view';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Q = (args: any) => Promise<any>;

/** أدنى شكل لمعاملة المستندات: Prisma.TransactionClient والمزيّف في الاختبارات */
export interface DocsTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  aiAccountantDocument: { findFirst: Q; findMany: Q; create: Q; updateMany: Q; deleteMany: Q };
  glAttachment: { findFirst: Q; findMany: Q; create: Q; updateMany: Q; deleteMany: Q; aggregate: Q };
  glSettings: { findUnique: Q };
}

/** أدنى شكل للقاعدة: PrismaClient والمزيّف */
export interface DocsDb extends DocsTx {
  $transaction<T>(fn: (tx: DocsTx) => Promise<T>, opts?: { maxWait?: number; timeout?: number }): Promise<T>;
  companySettings: { findUnique: Q };
  glAccount: { findMany: Q };
  glMove: { findMany: Q };
  aiAccountantPost: { findMany: Q };
}

/** كتابة حتى ٣ ميغابايت في bytea على قاعدة صغيرة — مهلةٌ فوق الافتراضي (نمط printForms) */
const UPLOAD_TX = { maxWait: 10_000, timeout: 30_000 } as const;

// ═══ الأخطاء ═══

/** رفضٌ للمسار: الحالة والرمز والرسالة العربية */
export interface DocFail {
  ok: false;
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export const DOC_MESSAGES = {
  type: 'نوع الملف غير مسموح والمسموح PDF أو JPEG أو PNG',
  empty: 'الملف فارغ',
  tooLarge: 'الملف أكبر من المسموح',
  monthly: 'بلغت مرفقات الشركة حدّها الشهري؛ احذف مستندات غير مرحّلة أو انتظر الشهر القادم',
  total: 'بلغت مرفقات الشركة حدّها الكلي؛ احذف مستندات غير مرحّلة',
  notFound: 'المستند غير موجود',
  posted: 'المستند مرحّل في قيد قائم؛ اعكس القيد من الدفاتر أولاً',
  changed: 'تغيّر المستند أثناء الحفظ؛ أعد فتحه وحاول مجدداً',
  fileGone: 'ملف المستند لم يعد موجوداً؛ ارفعه من جديد',
  patchInvalid: 'قيمة غير صالحة في بيانات المستند؛ صحّح الحقل المشار إليه',
} as const;

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): DocFail =>
  (details ? { ok: false, status, code, message, details } : { ok: false, status, code, message });

// ═══ محرّك الحقائق (facts.ts) ═══

/** حالة المستند كما يحتاجها إعادة الفحص (نوع الملف: PDF بلا QR في الإصدار الأول) */
export interface DocQrState {
  mimeType: string;
  qrRaw: string | null;
  qrVerified: boolean;
  manualEntry: boolean;
}

/**
 * ما يقدّمه facts.ts (الحزمة P2) — يُحقن ليُختبر التخزين بمحاكٍ، والافتراضي الدوال الحقيقية:
 *   fromQr      نص QR ⇐ حقائق أولية؛ qrVerified=false ⇐ لم يُفكّ (إدخال يدوي بتنبيه QR_INVALID).
 *   applyPatch  تصحيح المستخدم فوق الحقائق (التوحيد والتنظيف هناك؛ القيمة غير الصالحة ترمي AcctDocPatchError ⇒ 400).
 *   recheck     الفحوص والحالة والاقتراح من الحقائق.
 *   options     خيارات الحساب و«مدفوع من» من دليل الشركة.
 */
export interface DocFactsEngine {
  fromQr(qr: string, env: AcctDocEnv): { facts: AcctDocFacts; qrVerified: boolean };
  applyPatch(facts: AcctDocFacts | null, patch: AcctDocPatch, env: AcctDocEnv): AcctDocFacts;
  recheck(facts: AcctDocFacts | null, env: AcctDocEnv, state: DocQrState): AcctDocRecheck;
  options(facts: AcctDocFacts | null, env: AcctDocEnv): { accountOptions: AcctAccountOption[]; payOptions: AcctPayOption[] };
}

export const defaultDocEngine: DocFactsEngine = {
  fromQr: (qr, env) => factsFromQrWithEnv(qr, env),
  applyPatch: (facts, patch, env) => applyUserPatch(facts, patch, { currency: env.currency, currencyDecimals: env.currencyDecimals }),
  recheck: (facts, env, state) => recheckWithEnv(facts, env, state),
  options: (facts, env) => {
    const r = suggestWithEnv(facts, env);
    return { accountOptions: r.accountOptions, payOptions: r.payOptions };
  },
};

/** فحوصٌ لا يعيدها حساب الحقائق وحده فتُحمل من الحالة السابقة: QR وصل ولم يُقرأ (ما دام لم يتحقق) */
const STICKY_CHECKS: readonly AcctDocCheck['code'][] = ['QR_INVALID'];

function withSticky(prev: readonly AcctDocCheck[], next: AcctDocCheck[], qrVerified: boolean): AcctDocCheck[] {
  if (qrVerified) return next;
  const out = [...next];
  for (const c of prev) {
    if (STICKY_CHECKS.includes(c.code) && !out.some((x) => x.code === c.code)) out.push(c);
  }
  return out;
}

/**
 * الحقائق + الفحوص ⇐ الحالة المخزّنة: بلا حقائق بعد ⇒ NEEDS_REVIEW دائماً (البطاقة تفتح للتحرير)، وفحصٌ محمول أُضيف
 * فوق نتيجةٍ خضراء ⇒ NEEDS_REVIEW.
 */
function computeState(engine: DocFactsEngine, facts: AcctDocFacts | null, env: AcctDocEnv, state: DocQrState, prevChecks: readonly AcctDocCheck[]): AcctDocRecheck {
  const r = engine.recheck(facts, env, state);
  const checks = withSticky(prevChecks, r.checks, state.qrVerified);
  const carried = checks.length > r.checks.length;
  const status = facts === null || (carried && r.status === 'EXTRACTED') ? 'NEEDS_REVIEW' : r.status;
  return { checks, status, suggestion: r.suggestion };
}

/** عمود JSON اختياري: null ⇐ Prisma.DbNull (Prisma يرفض null الصريح لعمود Json) */
const jsonOrNull = (v: unknown): unknown => (v === null || v === undefined ? Prisma.DbNull : v);

// ═══ سياق الشركة لحساب الحقائق ═══

/** رموز الدليل التي تحتاجها البطاقة: الدفع والمدفوع مقدماً والأصول والضريبة والمستحقات (+ كل المصروفات والصناديق والبنوك) */
const ENV_ACCOUNT_CODES: readonly string[] = [
  '111001', '111002', '111101', ACCT_DOC_CODES.accrued, ACCT_DOC_CODES.prepaidOther, ACCT_DOC_CODES.prepaidRent,
  ACCT_DOC_CODES.inputVat, ...Object.values(ACCT_ASSET_CODES), '121001', '121002',
];

/** ما يُبنى منه السياق دون إعادة قراءته (من AcctCtx في المسار) */
export interface DocEnvBase {
  tenantId: string;
  currency: string;
  tz: string;
  todayLocal: string;
  taxDisabled: boolean;
}

/**
 * سياق حساب الحقائق للشركة: منازل العملة ودليلها (SA_6D فيه مربّع ضريبة المدخلات) من إعداد الدفاتر، ورقمها الضريبي،
 * وحسابات البطاقة من دليلها — ثلاث قراءات بشركة الجلسة.
 */
export async function loadDocEnv(db: Pick<DocsDb, 'glSettings' | 'companySettings' | 'glAccount'>, base: DocEnvBase, env: NodeJS.ProcessEnv = process.env): Promise<AcctDocEnv> {
  const tenantId = base.tenantId;
  const [gl, company, accounts] = await Promise.all([
    db.glSettings.findUnique({ where: { tenantId }, select: { templateKey: true, currencyDecimals: true } }) as Promise<{ templateKey?: string | null; currencyDecimals?: number | null } | null>,
    db.companySettings.findUnique({ where: { tenantId }, select: { taxNumber: true } }) as Promise<{ taxNumber?: string | null } | null>,
    db.glAccount.findMany({
      where: { tenantId, OR: [{ code: { in: [...ENV_ACCOUNT_CODES] } }, { type: { startsWith: 'expense' } }, { type: 'asset_cash' }] },
      select: { code: true, name: true, type: true, isActive: true, controlKind: true }, orderBy: { code: 'asc' }, take: 1000,
    }) as Promise<AcctDocChartAccount[]>,
  ]);
  const dec = gl?.currencyDecimals;
  return {
    tenantId,
    currency: base.currency,
    currencyDecimals: typeof dec === 'number' && Number.isInteger(dec) && dec >= 0 && dec <= 3 ? dec : 2,
    taxDisabled: base.taxDisabled,
    companyVat: (company?.taxNumber ?? '').trim() || null,
    todayLocal: base.todayLocal,
    tz: base.tz,
    vatBox: gl?.templateKey === 'SA_6D',
    assetThresholdMilli: assetThresholdMilli(env),
    accounts: (accounts ?? []).map((a) => ({ code: a.code, name: a.name, type: a.type, isActive: a.isActive === true, controlKind: a.controlKind ?? null })),
  };
}

// ═══ الحالة المرحّلة ═══

/**
 * حالة القيود لمعرّفاتها: الرقم، والحياة (POSTED بلا قيد عاكس — كـliveMovesOf في posting.ts)، ونوع صفّ المحاسب الذكي.
 * القيد الذي لم يعد موجوداً (تصفير الدفاتر) يُعاد غير حيّ بلا رقم.
 */
export async function postedStates(db: Pick<DocsDb, 'glMove' | 'aiAccountantPost'>, tenantId: string, moveIds: readonly (string | null)[]): Promise<Map<string, AcctDocPosted>> {
  const ids = [...new Set(moveIds.filter((x): x is string => !!x))];
  const out = new Map<string, AcctDocPosted>();
  if (!ids.length) return out;
  const [moves, reversals, posts] = await Promise.all([
    db.glMove.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, number: true, state: true } }) as Promise<{ id: string; number: string | null; state: string }[]>,
    db.glMove.findMany({ where: { tenantId, reversedMoveId: { in: ids } }, select: { reversedMoveId: true } }) as Promise<{ reversedMoveId: string | null }[]>,
    db.aiAccountantPost.findMany({ where: { tenantId, moveId: { in: ids } }, select: { moveId: true, kind: true }, orderBy: { createdAt: 'desc' } }) as Promise<{ moveId: string; kind: string }[]>,
  ]);
  const reversed = new Set(reversals.map((r) => r.reversedMoveId).filter((x): x is string => !!x));
  const byId = new Map(moves.map((m) => [m.id, m]));
  const kindOf = new Map<string, string>();
  for (const p of posts) if (!kindOf.has(p.moveId)) kindOf.set(p.moveId, p.kind);
  for (const id of ids) {
    const m = byId.get(id);
    out.set(id, {
      moveId: id,
      moveNumber: m?.number ?? null,
      live: !!m && m.state === 'POSTED' && !reversed.has(id),
      kind: kindOf.get(id) ?? '',
    });
  }
  return out;
}

/** حالة قيدٍ واحد (null بلا معرّف) */
export async function liveMoveOf(db: Pick<DocsDb, 'glMove' | 'aiAccountantPost'>, tenantId: string, moveId: string | null | undefined): Promise<AcctDocPosted | null> {
  if (!moveId) return null;
  return (await postedStates(db, tenantId, [moveId])).get(moveId) ?? null;
}

// ═══ القراءة ═══

/** أقصى معرّفات تُحمَّل لسياق المحادثة (١٢ رسالة × ٣ مستندات) */
export const MAX_CTX_DOCS = 36;

/**
 * مستندات سياق المحادثة: معرّفات docIds من الرسائل ⇐ صفوف الشركة والرافع نفسه وحدها (معرّف شركة أخرى أو رافع آخر يسقط
 * بصمت)، بترتيب أول ظهور، بلا تكرار، وبحدّ MAX_CTX_DOCS.
 */
export async function loadDocsForCtx(db: Pick<DocsDb, 'aiAccountantDocument'>, input: { tenantId: string; actorRef: string; ids: readonly unknown[] }): Promise<DocRow[]> {
  const ids = [...new Set(input.ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, MAX_CTX_DOCS);
  if (!ids.length || !input.tenantId || !input.actorRef) return [];
  const rows: DocRow[] = await db.aiAccountantDocument.findMany({
    where: { tenantId: input.tenantId, actorRef: input.actorRef, id: { in: ids } }, select: DOC_ROW_SELECT,
  });
  const byId = new Map(rows.filter((r) => r.tenantId === input.tenantId && r.actorRef === input.actorRef).map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/**
 * مستندٌ يقرؤه مستخدم الشركة (GET): شركة الجلسة دائماً؛ وغير المرتبط بقيد لرافعه وحده (المرتبط بقيد صار من الدفاتر
 * فيراه من يرى الدفاتر — المسار يشترط canViewLedger).
 */
export async function findDocForViewer(db: Pick<DocsDb, 'aiAccountantDocument'>, input: { tenantId: string; actorRef: string; id: string }): Promise<DocRow | null> {
  if (!input.id || !input.tenantId) return null;
  const doc: DocRow | null = await db.aiAccountantDocument.findFirst({ where: { id: input.id, tenantId: input.tenantId }, select: DOC_ROW_SELECT });
  if (!doc || doc.tenantId !== input.tenantId) return null;
  if (!doc.moveId && doc.actorRef !== input.actorRef) return null;
  return doc;
}

/** مستندٌ يعدّله أو يحذفه رافعه وحده (الشركة والرافع) */
export async function findOwnDoc(db: Pick<DocsTx, 'aiAccountantDocument'>, input: { tenantId: string; actorRef: string; id: string }): Promise<DocRow | null> {
  if (!input.id || !input.tenantId || !input.actorRef) return null;
  const doc: DocRow | null = await db.aiAccountantDocument.findFirst({
    where: { id: input.id, tenantId: input.tenantId, actorRef: input.actorRef }, select: DOC_ROW_SELECT,
  });
  return doc && doc.tenantId === input.tenantId && doc.actorRef === input.actorRef ? doc : null;
}

/**
 * مستندٌ آخر في الشركة نفسها بالبصمة نفسها مرحّلٌ في قيد حيّ (رفعه مديرٌ آخر) ⇒ duplicateOf SHA؛ أو برقم الفاتورة نفسه
 * (والمورد نفسه إن عُرف) ⇒ INVOICE_NO. فحص الترحيل الحاسم تحت قفل الترحيل في post.ts — هذا تنبيه البطاقة.
 */
async function duplicatesOf(db: Pick<DocsDb, 'aiAccountantDocument' | 'glMove' | 'aiAccountantPost'>, tenantId: string, docs: readonly DocRow[]): Promise<Map<string, AcctDocDuplicate>> {
  const out = new Map<string, AcctDocDuplicate>();
  const open = docs.filter((d) => !d.moveId);
  if (!open.length) return out;
  const shas = [...new Set(open.map((d) => d.sha256))];
  const invoiceNos = [...new Set(open.map((d) => parseFacts(d.facts)?.invoiceNo).filter((x): x is string => !!x))];
  const others: DocRow[] = await db.aiAccountantDocument.findMany({
    where: {
      tenantId, moveId: { not: null },
      OR: [{ sha256: { in: shas } }, ...invoiceNos.map((no) => ({ facts: { path: ['invoiceNo'], equals: no } }))],
    },
    select: DOC_ROW_SELECT, orderBy: { updatedAt: 'desc' }, take: 50,
  });
  if (!others.length) return out;
  const states = await postedStates(db, tenantId, others.map((o) => o.moveId));
  const live = others.filter((o) => o.tenantId === tenantId && o.moveId && states.get(o.moveId)?.live);
  for (const d of open) {
    const sha = live.find((o) => o.id !== d.id && o.sha256 === d.sha256);
    if (sha) { out.set(d.id, { moveNumber: states.get(sha.moveId!)?.moveNumber ?? null, reason: 'SHA' }); continue; }
    const f = parseFacts(d.facts);
    if (!f?.invoiceNo) continue;
    const vendorKey = (x: AcctDocFacts | null) => (x?.vendorVat || x?.vendorName || '').trim();
    const inv = live.find((o) => {
      if (o.id === d.id) return false;
      const of = parseFacts(o.facts);
      if (!of || of.invoiceNo !== f.invoiceNo) return false;
      const a = vendorKey(f);
      const b = vendorKey(of);
      return !a || !b || a === b;
    });
    if (inv) out.set(d.id, { moveNumber: states.get(inv.moveId!)?.moveNumber ?? null, reason: 'INVOICE_NO' });
  }
  return out;
}

/**
 * صفوف المستندات ⇐ AcctDocView بحالتها الحيّة: القيد (حيّ/معكوس)، والملف (مفقود ⇒ FILE_GONE)، والمكرّر، وخيارات
 * الحساب والدفع من دليل الشركة. refs: 'D1'… لكل معرّف في المحادثة.
 */
export async function docViewsFor(
  db: Pick<DocsDb, 'aiAccountantDocument' | 'glAttachment' | 'glMove' | 'aiAccountantPost'>,
  tenantId: string, docs: readonly DocRow[], env: AcctDocEnv, refs: ReadonlyMap<string, string> = new Map(),
  engine: Pick<DocFactsEngine, 'options'> = defaultDocEngine,
): Promise<AcctDocView[]> {
  if (!docs.length) return [];
  const [states, files, dups] = await Promise.all([
    postedStates(db, tenantId, docs.map((d) => d.moveId)),
    db.glAttachment.findMany({ where: { tenantId, id: { in: docs.map((d) => d.attachmentId) } }, select: { id: true } }) as Promise<{ id: string }[]>,
    duplicatesOf(db, tenantId, docs),
  ]);
  const have = new Set(files.map((f) => f.id));
  return docs.map((d) => {
    const facts = parseFacts(d.facts);
    const opts = engine.options(facts, env);
    // فحوص التاريخ النسبية بيوم الشركة الحالي لا بيوم الرفع/التصحيح (المخزَّن يشيخ: «مستقبلي» أمس صار اليوم)
    const fresh = refreshDateChecks(parseChecks(d.checks), facts, env.todayLocal);
    return toView(d, {
      ref: refs.get(d.id) ?? '',
      posted: d.moveId ? states.get(d.moveId) ?? null : null,
      duplicateOf: dups.get(d.id) ?? null,
      accountOptions: opts.accountOptions,
      payOptions: opts.payOptions,
      fileGone: !have.has(d.attachmentId),
      ...(fresh.changed ? { checks: fresh.checks, status: refreshedStatus(statusOf(d.status), fresh.checks, facts) } : {}),
    });
  });
}

/** حالة الصفّ المخزّنة بأمان (المجهول NEEDS_REVIEW كـtoView) */
const statusOf = (s: string): AcctDocStatus =>
  (s === 'UPLOADED' || s === 'EXTRACTED' || s === 'NEEDS_REVIEW' || s === 'FAILED' ? s : 'NEEDS_REVIEW');

/** المحتوى للعرض (GET /documents/:id/content): البايتات بنوعها المكتشَف واسمها — من صفّ المرفق بشركته */
export async function docContent(db: Pick<DocsDb, 'glAttachment'>, tenantId: string, doc: DocRow): Promise<{ bytes: Buffer; mimeType: string; fileName: string } | null> {
  const att: { id: string; tenantId: string; mimeType: string; fileName: string; blob: { bytes: Uint8Array } | null } | null = await db.glAttachment.findFirst({
    where: { id: doc.attachmentId, tenantId },
    select: { id: true, tenantId: true, mimeType: true, fileName: true, blob: { select: { bytes: true } } },
  });
  if (!att?.blob || att.tenantId !== tenantId) return null;
  return { bytes: Buffer.from(att.blob.bytes), mimeType: att.mimeType, fileName: att.fileName };
}

// ═══ الرفع ═══

export interface UploadInput {
  tenantId: string;
  actorRef: string;
  bytes: Buffer;
  /** Content-Type المعلَن */
  contentType: string | null | undefined;
  /** ترويسة X-File-Name (مرمّزة URI) */
  fileNameHeader: unknown;
  /** ترويسة X-Zatca-Qr (اختيارية) */
  qrHeader: unknown;
  now?: Date;
}

export type UploadOutcome = { ok: true; doc: DocRow; deduped: boolean } | DocFail;

/**
 * الحقائق الأولى للمستند الجديد: من QR إن قُرئ، وإلا إدخال يدوي (QR_INVALID إن وصل ولم يُقرأ — ونصّه المخزَّن يعيد الفحص
 * تنبيهه). PDF بلا QR في الإصدار الأول (D4): ترويسته تُهمل.
 */
function initialFacts(engine: DocFactsEngine, qr: string | null | 'INVALID', env: AcctDocEnv, mimeType: string): {
  facts: AcctDocFacts | null; factsSource: AcctFactsSource | null; qrRaw: string | null; qrVerified: boolean; manualEntry: boolean; prevChecks: AcctDocCheck[];
} {
  if (mimeType === 'application/pdf') qr = null;
  if (qr && qr !== 'INVALID') {
    const r = engine.fromQr(qr, env);
    if (r.qrVerified) return { facts: r.facts, factsSource: 'QR', qrRaw: qr, qrVerified: true, manualEntry: false, prevChecks: [] };
  }
  const invalid: AcctDocCheck[] = qr ? [{ code: 'QR_INVALID', severity: 'warn' }] : [];
  return { facts: null, factsSource: null, qrRaw: qr && qr !== 'INVALID' ? qr : null, qrVerified: false, manualEntry: true, prevChecks: invalid };
}

/**
 * يرفع مستنداً: الفحص والسقوف ثم معاملة القفل (جمع المهمَل، عدم التكرار، الحصة، المرفق والمستند). لا يرمي لأخطاء
 * المستخدم (DocFail برمزه وحالته)، ويرمي لأخطاء القاعدة.
 */
export async function uploadDocument(
  db: DocsDb, input: UploadInput, env: AcctDocEnv, engine: DocFactsEngine = defaultDocEngine, caps: DocCaps = docCaps(),
): Promise<UploadOutcome> {
  const { tenantId, actorRef } = input;
  const now = input.now ?? new Date();
  const bytes = input.bytes;
  const sniff = sniffDocMime(bytes, input.contentType);
  if (bytes.length === 0) return fail(400, 'EMPTY_FILE', DOC_MESSAGES.empty);
  if (!sniff.mime) {
    return fail(415, 'ATTACHMENT_TYPE_NOT_ALLOWED', DOC_MESSAGES.type, {
      declaredMime: sniff.declared, detectedMime: sniff.detected, allowed: ['application/pdf', 'image/jpeg', 'image/png'],
    });
  }
  const mimeType = sniff.mime;
  const sizeBytes = bytes.length;
  const fileCap = docFileCapViolation(mimeType, sizeBytes, caps);
  if (fileCap) {
    return fileCap.reason === 'EMPTY_FILE'
      ? fail(400, 'EMPTY_FILE', DOC_MESSAGES.empty)
      : fail(413, 'FILE_TOO_LARGE', DOC_MESSAGES.tooLarge, { capBytes: fileCap.capBytes, sizeBytes });
  }
  const fileName = docFileNameOf(input.fileNameHeader, mimeType);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  // الحقائق قبل المعاملة (صرفة) فتقصر المعاملة على الكتابة
  const init = initialFacts(engine, qrHeaderOf(input.qrHeader), env, mimeType);
  const state = computeState(engine, init.facts, env, {
    mimeType, qrRaw: init.qrRaw, qrVerified: init.qrVerified, manualEntry: init.manualEntry,
  }, init.prevChecks);

  type TxOut = { kind: 'ok'; doc: DocRow; deduped: boolean } | { kind: 'fail'; fail: DocFail };
  const out = await db.$transaction(async (tx): Promise<TxOut> => {
    // رفعان متزامنان لا يتجاوزان الحصة معاً ولا يُنشئان المستند نفسه مرتين (قفل مرفقات الدفاتر نفسه)
    await lockDocAttachments(tx, tenantId);
    // جمع المهمَل أولاً: يحرّر الحصة قبل حسابها (نمط printForms)
    await gcTenantDocs(tx, tenantId, now, { limit: GC_BATCH });
    const same: DocRow | null = await tx.aiAccountantDocument.findFirst({ where: { tenantId, actorRef, sha256 }, select: DOC_ROW_SELECT });
    if (same) {
      const file = await tx.glAttachment.findFirst({ where: { id: same.attachmentId, tenantId }, select: { id: true } });
      // مستندٌ مرتبط بقيد لا يُحذف أبداً — يُعاد كما هو (العرض يُظهر FILE_GONE إن فُقد ملفه)
      if (same.moveId) return { kind: 'ok', doc: same, deduped: true };
      if (file) {
        // إعادة رفعه نشاط: يُلمس updatedAt فلا يجمعه الكنس (على updatedAt) والمستخدم يراجع بطاقته الآن
        await tx.aiAccountantDocument.updateMany({ where: { id: same.id, tenantId, actorRef, moveId: null }, data: { updatedAt: now } });
        const touched: DocRow | null = await tx.aiAccountantDocument.findFirst({ where: { id: same.id, tenantId, actorRef }, select: DOC_ROW_SELECT });
        return { kind: 'ok', doc: touched ?? same, deduped: true };
      }
      // ملفه حُذف (تصفير الدفاتر) ولم يُرحَّل: صفٌّ يتيم يُستبدل بالرفع الجديد
      await tx.aiAccountantDocument.deleteMany({ where: { id: same.id, tenantId, moveId: null } });
    }
    const settings = await tx.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } });
    const tz = settings?.timezone || DEFAULT_TIMEZONE;
    const monthStart = zonedStartOfDay(startOfMonth(todayLocal(now, tz)), tz);
    const [month, total] = await Promise.all([
      tx.glAttachment.aggregate({ where: { tenantId, createdAt: { gte: monthStart } }, _sum: { sizeBytes: true } }),
      tx.glAttachment.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
    ]);
    const quota = docCapViolation({
      mimeType, sizeBytes, monthUsedBytes: month?._sum?.sizeBytes ?? 0, totalUsedBytes: total?._sum?.sizeBytes ?? 0,
    }, caps);
    if (quota) {
      const msg = quota.reason === 'MONTHLY_QUOTA' ? DOC_MESSAGES.monthly : quota.reason === 'TOTAL_QUOTA' ? DOC_MESSAGES.total : DOC_MESSAGES.tooLarge;
      return { kind: 'fail', fail: fail(quota.reason === 'FILE_TOO_LARGE' ? 413 : 429, quota.reason, msg, { ...quota }) };
    }
    const docId = crypto.randomUUID();
    const att: { id: string } = await tx.glAttachment.create({
      data: {
        tenantId, entityType: 'AI_DOC', entityId: docId, fileName, mimeType, sizeBytes, sha256, uploadedBy: actorRef,
        blob: { create: { tenantId, bytes } },
      },
      select: { id: true },
    });
    const doc: DocRow = await tx.aiAccountantDocument.create({
      data: {
        id: docId, tenantId, actorRef, attachmentId: att.id, sha256, fileName, mimeType, sizeBytes,
        status: state.status, manualEntry: init.manualEntry, factsSource: init.factsSource,
        facts: jsonOrNull(init.facts), qrRaw: init.qrRaw, qrVerified: init.qrVerified,
        checks: state.checks, suggestion: jsonOrNull(state.suggestion),
      },
      select: DOC_ROW_SELECT,
    });
    return { kind: 'ok', doc, deduped: false };
  }, UPLOAD_TX);
  return out.kind === 'fail' ? out.fail : { ok: true, doc: out.doc, deduped: out.deduped };
}

// ═══ التصحيح والحذف ═══

export type DocOutcome = { ok: true; doc: DocRow } | DocFail;

/**
 * تصحيح المستخدم (PATCH): رافعه وحده، ولا تعديل لمستند في قيد حيّ (409 DOC_ALREADY_POSTED — يُعكس القيد أولاً). الحقائق
 * الجديدة = التصحيح فوق القائمة، ومصدرها USER أو QR+USER، ثم إعادة الفحص. الكتابة مقارنة وتبديل على moveId وupdatedAt:
 * ترحيلٌ أو تصحيحٌ متزامن ⇒ 409 بلا كتابة.
 */
export async function patchDocument(
  db: Pick<DocsDb, 'aiAccountantDocument' | 'glMove' | 'aiAccountantPost'>,
  input: { tenantId: string; actorRef: string; id: string; patch: AcctDocPatch }, env: AcctDocEnv, engine: DocFactsEngine = defaultDocEngine,
): Promise<DocOutcome> {
  const doc = await findOwnDoc(db, input);
  if (!doc) return fail(404, 'DOC_NOT_FOUND', DOC_MESSAGES.notFound);
  const posted = await liveMoveOf(db, input.tenantId, doc.moveId);
  if (posted?.live) return fail(409, 'DOC_ALREADY_POSTED', DOC_MESSAGES.posted, { moveNumber: posted.moveNumber });
  let facts: AcctDocFacts;
  try {
    facts = engine.applyPatch(parseFacts(doc.facts), input.patch, env);
  } catch (err) {
    if (err instanceof AcctDocPatchError) {
      return fail(400, 'DOC_PATCH_INVALID', DOC_MESSAGES.patchInvalid, { field: err.field, reason: err.reason });
    }
    throw err;
  }
  const factsSource: AcctFactsSource = doc.factsSource === 'QR' || doc.factsSource === 'QR+USER' ? 'QR+USER' : 'USER';
  const qrState: DocQrState = { mimeType: doc.mimeType, qrRaw: doc.qrRaw, qrVerified: doc.qrVerified === true, manualEntry: doc.manualEntry === true };
  const { checks, status, suggestion } = computeState(engine, facts, env, qrState, parseChecks(doc.checks));
  const upd: { count: number } = await db.aiAccountantDocument.updateMany({
    where: { id: doc.id, tenantId: input.tenantId, actorRef: input.actorRef, moveId: doc.moveId, updatedAt: doc.updatedAt },
    data: { facts: facts as unknown as Prisma.InputJsonValue, factsSource, checks, status, suggestion: jsonOrNull(suggestion) },
  });
  if (upd.count !== 1) return fail(409, 'DOC_CHANGED', DOC_MESSAGES.changed);
  const fresh = await findOwnDoc(db, input);
  return fresh ? { ok: true, doc: fresh } : fail(404, 'DOC_NOT_FOUND', DOC_MESSAGES.notFound);
}

/** يُرمى داخل معاملة الحذف حين ترحّل المستند بالتوازي — فتسقط المعاملة كلها (والملف معها) ثم يُعاد 409 */
class DocDeleteRaced extends Error {
  constructor() { super('DOC_DELETE_RACED'); this.name = 'DocDeleteRaced'; }
}

/**
 * حذف المستند (DELETE): رافعه وحده، ولا حذف لمستند في قيد حيّ (409). تحت قفل الحصة وبترتيب أقفال الترحيل والجمع نفسه
 * (صفّ المرفق ثم صفّ المستند — فلا تعارض أقفال 40P01 مع «سجّل القيد» من نافذة أخرى): مرفقه 'AI_DOC' أولاً فيتحرّر من
 * الحصة، ثم الصفّ بمقارنة وتبديل على moveId — ترحيلٌ متزامن ⇒ ترمي فتسقط المعاملة كلها (الملف باقٍ) ثم 409. مستندٌ عُكس
 * قيده يُحذف صفّه ويبقى ملفه دليلاً على القيد المعكوس في الدفاتر (مرفقات القيود المرحّلة لا تُحذف).
 */
export async function deleteDocument(
  db: DocsDb, input: { tenantId: string; actorRef: string; id: string },
): Promise<{ ok: true; freedBytes: number } | DocFail> {
  const doc = await findOwnDoc(db, input);
  if (!doc) return fail(404, 'DOC_NOT_FOUND', DOC_MESSAGES.notFound);
  const posted = await liveMoveOf(db, input.tenantId, doc.moveId);
  if (posted?.live) return fail(409, 'DOC_ALREADY_POSTED', DOC_MESSAGES.posted, { moveNumber: posted.moveNumber });
  try {
    return await db.$transaction(async (tx) => {
      await lockDocAttachments(tx, input.tenantId);
      const files: { count: number } = await tx.glAttachment.deleteMany({
        where: { id: doc.attachmentId, tenantId: input.tenantId, entityType: 'AI_DOC', entityId: doc.id },
      });
      const del: { count: number } = await tx.aiAccountantDocument.deleteMany({
        where: { id: doc.id, tenantId: input.tenantId, actorRef: input.actorRef, moveId: doc.moveId },
      });
      if (del.count !== 1) throw new DocDeleteRaced();
      return { ok: true as const, freedBytes: files.count > 0 ? doc.sizeBytes : 0 };
    }, UPLOAD_TX);
  } catch (err) {
    if (err instanceof DocDeleteRaced) return fail(409, 'DOC_ALREADY_POSTED', DOC_MESSAGES.posted);
    throw err;
  }
}

// ═══ ما تحتاجه معاملة الترحيل (documents/post.ts) ═══

/** التدقيق يُحقن للاختبار */
export interface RelinkDeps {
  appendAudit: typeof appendAudit;
}

/**
 * داخل معاملة الترحيل بعد postMove: يعيد توجيه صفّ مرفق المستند نفسه إلى القيد ('MOVE'/<moveId>) — من 'AI_DOC' (أول
 * ترحيل) أو من قيده السابق المعكوس (إعادة ترحيل) — بمعرّفه وشركته، ويشترط صفّاً واحداً بالضبط وإلا DOC_FILE_GONE فتسقط
 * المعاملة كلها. ثم تدقيق ATTACHMENT_ADD على القيد (relinkedFrom عند إعادة الترحيل). لا يأخذ قفل 'gl-attach:' (لا يغيّر
 * الحصة) فلا دورة أقفال مع رفع مرفقات القيود (gl-post ثم gl-attach).
 */
export async function relinkDocAttachment(
  tx: GlDb,
  input: { tenantId: string; doc: Pick<DocRow, 'id' | 'attachmentId' | 'moveId' | 'sha256' | 'fileName' | 'mimeType' | 'sizeBytes'>; moveId: string; moveNumber?: string | null; actor?: GlActor },
  deps: RelinkDeps = { appendAudit },
): Promise<{ relinkedFrom: string | null }> {
  const { tenantId, doc, moveId } = input;
  if (doc.moveId && doc.moveId === moveId) {
    // المستند مرتبط بهذا القيد أصلاً (نداءٌ معاد): لا كتابة ولا تدقيق ثانٍ — والملف يجب أن يكون عليه
    const same = await tx.glAttachment.findFirst({ where: { id: doc.attachmentId, tenantId, entityType: 'MOVE', entityId: moveId }, select: { id: true } });
    if (!same) throw new AiPostRefusal({ code: 'DOC_FILE_GONE', message: DOC_MESSAGES.fileGone, details: { docId: doc.id } });
    return { relinkedFrom: null };
  }
  const prev = doc.moveId ?? null;
  const r = await tx.glAttachment.updateMany({
    where: {
      id: doc.attachmentId, tenantId,
      OR: [{ entityType: 'AI_DOC', entityId: doc.id }, ...(prev ? [{ entityType: 'MOVE', entityId: prev }] : [])],
    },
    data: { entityType: 'MOVE', entityId: moveId },
  });
  if (r.count !== 1) {
    throw new AiPostRefusal({ code: 'DOC_FILE_GONE', message: DOC_MESSAGES.fileGone, details: { docId: doc.id } });
  }
  await deps.appendAudit(tx, {
    tenantId, actor: input.actor ?? SYSTEM_ACTOR, action: 'ATTACHMENT_ADD', entityType: 'MOVE', entityId: moveId,
    summary: `إرفاق ${doc.fileName} بالقيد ${input.moveNumber ?? ''} من «المحاسب الذكي»`.replace(/\s+/g, ' ').trim(),
    after: {
      attachmentId: doc.attachmentId, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, sha256: doc.sha256,
      docId: doc.id, via: 'AI_ACCOUNTANT', ...(prev ? { relinkedFrom: prev } : {}),
    },
  });
  return { relinkedFrom: prev };
}

/**
 * داخل معاملة الترحيل بعد relinkDocAttachment: يسجّل القيد على المستند بمقارنة وتبديل على moveId السابق وupdatedAt
 * المقروء (الحقائق التي بُنيت منها الخطة): ترحيلان متزامنان للمستند نفسه ⇒ الثاني DOC_ALREADY_POSTED، وتصحيحٌ (PATCH من
 * نافذة أخرى) بين القراءة والترحيل ⇒ DOC_CHANGED — فتسقط المعاملة كلها والقيد معها، ولا يُربط مستندٌ بحقائق غير ما رُحّل.
 */
export async function markDocPosted(
  tx: GlDb, input: { tenantId: string; doc: Pick<DocRow, 'id' | 'moveId' | 'updatedAt'>; moveId: string; postId: string | null },
): Promise<void> {
  const r = await tx.aiAccountantDocument.updateMany({
    where: { id: input.doc.id, tenantId: input.tenantId, moveId: input.doc.moveId, updatedAt: input.doc.updatedAt },
    data: { moveId: input.moveId, postId: input.postId },
  });
  if (r.count !== 1) {
    // أيّهما تغيّر؟ (قراءةٌ داخل المعاملة نفسها لرسالةٍ صحيحة — والرمي يُسقطها في الحالتين)
    const cur: { moveId: string | null } | null = await tx.aiAccountantDocument.findFirst({
      where: { id: input.doc.id, tenantId: input.tenantId }, select: { moveId: true },
    });
    if (!cur) throw new AiPostRefusal({ code: 'DOC_NOT_FOUND', message: `${DOC_MESSAGES.notFound}؛ لم يُرحَّل شيء.`, details: { docId: input.doc.id } });
    if ((cur.moveId ?? null) === (input.doc.moveId ?? null)) {
      throw new AiPostRefusal({ code: 'DOC_CHANGED', message: `${DOC_MESSAGES.changed}؛ لم يُرحَّل شيء.`, details: { docId: input.doc.id } });
    }
    throw new AiPostRefusal({ code: 'DOC_ALREADY_POSTED', message: DOC_MESSAGES.posted, details: { docId: input.doc.id } });
  }
}

export { emptyFacts };

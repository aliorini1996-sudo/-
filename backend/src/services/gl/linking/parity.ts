/**
 * مطابقة «ربط الدفاتر» R1..R13 (L2 — العقد §13، الخطة §3 «Parity suite»).
 *
 * - `loadOperationalFacts`: حقائق التشغيل المقابلة، قراءة فقط على عميل يمرّره المُستدعي (العميل الحارس في المعاينة،
 *   والقاعدة لاحقاً للتشغيل الليلي). **كل مبلغ Float يُقرَّب لكل مستند** (`toMilli` لكل صفّ) ثم يُجمع بالملّي — لا
 *   `groupBy`/`aggregate` على Float ثم تقريب المجموع (1.005 + 2.005 + 3.125 بمنزلتين = 6150 ملّي في القيود و6140 في
 *   المجموع ⇒ فرق كاذب). ولذا لا تُستعمل `CheckStore.accountEntryTotals`/`settlementBalance` هنا. المجاميع على BigInt
 *   (`supplier_ledger_entries.amountMilli`) دقيقة فتُجمع في القاعدة. الصفوف بصفحات بمؤشّر (createdAt, id) على فهرس
 *   (tenantId, createdAt, id)، والمعرّفات بدفعات — بلا N+1 (إلا عهدة المندوب: انظر أدناه).
 * - `runParity`: صرفة، R1..R13 بالترتيب. **التسامح صفر**: فرق ملّي واحد ⇒ MISMATCH. ما لا يحمله الأستاذ بعد (تكلفة
 *   المبيعات، حركات المخزون، المشتريات…) ⇒ NOT_AVAILABLE بمرحلته وسببه، والمتوقَّع محسوب مع تعمّقه (D10).
 * - `compareByPartner`: التعمّق لكل شريك — فرز |الفرق| تنازلياً ثم المعرّف، والقصّ عند PREVIEW_LIST_CAPS.drillRows.
 *
 * إشارة كل رقم: «مدين − دائن» كالأستاذ، فالفرق = الفعلي − المتوقَّع بالمعنى نفسه في كل فحص (الموردون والوارد غير المصنَّف
 * دائنون في الأستاذ ⇒ متوقَّعهما سالب).
 */
import type { Prisma } from '@prisma/client';
import { openingEntryGroupsFromRows, openingEntryTotalsFromGroups, type OpeningEntryGroup, type OpeningEntryRow } from '../checks/rules';
import { createPrismaCheckStore } from '../checks/store.prisma';
import { custodyComponentsForRep } from '../custody';
import { formatMilli, toMilli, unitMilli } from '../money';
import { includedInOpening, openingCutoff, openingRowRole } from '../opening';
import { SETTLEMENT_HAS_REP } from '../settlementRep';
import { siblingPostKey } from '../sync/keys';
import { IMPORT_AFTER_CUTOVER_ATTENTION_REASON } from '../sync/types';
import type { LocalDate, Milli } from '../types';
import { baseQtyOf } from '../../units';
import { UNKNOWN_VAN, WH_LOCATION, repOfLocation, vanLocation, type LocationKey, type LocationTotals } from '../../costing/types';
import {
  PREVIEW_LIST_CAPS,
  type GlBalanceQuery, type GlBalanceView, type OperationalFacts, type ParityCheck, type ParityCode, type ParityContext, type ParityDrillRow,
  type ParityPartnerType, type ParityScope,
} from './types';

// ═══ الثوابت ═══

/** صفوف كل صفحة قراءة (account_entries، settlement_entries، أسطر الوارد) */
export const PARITY_PAGE_SIZE = 5_000;
/** معرّفات كل استعلام `in` (الأسماء وأنواع الفواتير) */
export const PARITY_ID_CHUNK = 1_000;
/** مراجع الأحداث المحجوزة في صفّ التعمّق الواحد (الباقي يُعدّ في الملاحظة) */
export const PARITY_REFS_PER_ROW = 20;
/** سطور 319002 المقروءة لتصنيف R1 — الحساب نادر السطور (الافتتاح والاستيراد)، والتجاوز يُعلَن في info */
export const R1_EQUITY_LINES_LIMIT = 100_000;

export const PARITY_TITLES: Readonly<Record<ParityCode, string>> = {
  R1: 'توازن القيود وفرق الأرصدة الافتتاحية 319002',
  R2: 'ذمم العملاء 113001 لكل عميل = كشف حسابه',
  R3: 'عهدة المناديب 111003 لكل مندوب = عهدته الدفترية',
  R4: 'عهدة مستخدمي الشركة 111004',
  R5: 'أمانات الدفع الإلكتروني 112005 = دفتر الأمانات',
  R6: 'صافي المبيعات الشهري = تقرير صافي المبيعات',
  R7: 'ضريبة المخرجات 212001 بالفترة والمربع = المستندات',
  R8: 'المخزون 114001 و114002 = تقييم المستودع والسيارات',
  R9: 'تكلفة المبيعات 511001 = لقطات التكلفة',
  R10: 'الذمم الدائنة 211001 لكل مورّد = كشف المورّد',
  R11: 'بضاعة مستلمة بلا فاتورة 211002 = الوارد المسعَّر غير المصنَّف',
  R12: 'ضريبة المدخلات 116001 بالفترة',
  R13: 'اكتمال الترحيل وخلوّ الحساب المعلّق 911001',
};

/** ما لا يحمله الأستاذ في هذه المرحلة: المرحلة التي تضيفه وسببه (D10 — نصوص العقد §13) */
export const PARITY_NOT_AVAILABLE: Readonly<Partial<Record<ParityCode, { availableIn: 'L4' | 'L5' | 'L6' | 'L7'; reason: string }>>> = {
  R4: { availableIn: 'L5', reason: 'عهدة المستخدمين 111004 تُضاف في L5' },
  R6: { availableIn: 'L4', reason: 'مطابقة صافي المبيعات الشهري تُضاف في L4' },
  R7: { availableIn: 'L4', reason: 'ضريبة المخرجات بالفترة والمربع من المستندات تُضاف في L4' },
  R8: { availableIn: 'L6', reason: 'قيود حركات المخزون تُضاف في L6' },
  R9: { availableIn: 'L4', reason: 'قيد تكلفة المبيعات يُضاف في L4' },
  R10: { availableIn: 'L6', reason: 'قيود المشتريات والموردين تُضاف في L6' },
  R11: { availableIn: 'L6', reason: 'قيود الوارد غير المصنَّف على 211002 تُضاف في L6' },
  R12: { availableIn: 'L6', reason: 'سجلّ ضريبة المشتريات يُضاف في L6' },
  R13: { availableIn: 'L7', reason: 'اكتمال الترحيل وخلوّ 911001 يُحسم عند الاعتماد' },
};

/** المخزون الدوري (OD7): لا رصيد مخزون مستمرّ في الدفاتر فلا مطابقة له في أي مرحلة */
export const R8_PERIODIC_REASON = 'المخزون الدوري (PERIODIC): لا تحمل الدفاتر رصيد مخزون مستمرّاً — لا مطابقة 114001/114002';
export const R8_NO_COSTING_REASON = 'لا ملخّص لمحرّك التكلفة — قيود حركات المخزون تُضاف في L6';

// ═══ مساعدات ═══

type Info = Record<string, string | number | null>;

const absMilli = (v: Milli): Milli => (v < 0n ? -v : v);
const milliText = (v: Milli): string => v.toString();
/** مبلغ للملاحظات بمنازل العملة، وبثلاث حين لا يكون مضاعفاً لأصغر وحدة (فرق ملّي لا يختفي بالتقريب في النص) */
const amountText = (v: Milli, dec: number): string => formatMilli(v, v % unitMilli(dec) === 0n ? dec : 3);
const addTo = (m: Map<string, Milli>, k: string, v: Milli): void => { m.set(k, (m.get(k) ?? 0n) + v); };

function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function negate(m: ReadonlyMap<string, Milli>): Map<string, Milli> {
  const out = new Map<string, Milli>();
  for (const [k, v] of m) out.set(k, -v);
  return out;
}

/** ترتيب التعمّق: |الفرق| تنازلياً، ثم المعرّف (نقاط الرموز لا اللغة — حتمي)، ثم الملاحظة (صفّا الشريك نفسه في R2/R8) */
export function compareDrillRows(a: ParityDrillRow, b: ParityDrillRow): number {
  const da = absMilli(a.diffMilli);
  const db = absMilli(b.diffMilli);
  if (da !== db) return da > db ? -1 : 1;
  const ia = a.partnerId ?? '';
  const ib = b.partnerId ?? '';
  if (ia !== ib) return ia < ib ? -1 : 1;
  const na = a.note ?? '';
  const nb = b.note ?? '';
  if (na !== nb) return na < nb ? -1 : 1;
  return a.partnerType < b.partnerType ? -1 : a.partnerType > b.partnerType ? 1 : 0;
}

/** يرتّب ويقصّ: drillTruncated = ما زاد على السقف */
export function capDrill(rows: readonly ParityDrillRow[], cap: number = PREVIEW_LIST_CAPS.drillRows): { drill: ParityDrillRow[]; truncated: number } {
  const c = Math.max(0, Math.floor(cap));
  const sorted = [...rows].sort(compareDrillRows);
  return { drill: sorted.slice(0, c), truncated: Math.max(0, sorted.length - c) };
}

export interface CompareByPartnerOptions {
  partnerType: ParityPartnerType;
  /** أسماء الشركاء بالمعرّف */
  names?: ReadonlyMap<string, string> | null;
  /** اسم بديل لشريك بلا اسم معروف (مثل «سيارة — …» للمواقع) */
  nameOf?: (partnerKey: string) => string | null;
  /** اسم صفّ السطور بلا شريك (المفتاح '') */
  blankName?: string;
  /** مفاتيح أحداث محجوزة لكل شريك: تُرفق مراجعَ لصفّ بفرق ≠ 0 («يفسّره حدث محجوز») */
  heldByPartner?: ReadonlyMap<string, readonly string[]> | null;
  /** صفّ بفرق ≠ 0 بلا حدث محجوز يُعلَّم «لا يفسّره حدث محجوز» — للفحوص الكاملة وحدها (لا لغير المتاح) */
  explainDiffs?: boolean;
  /** بادئة ملاحظة كل صفّ (صفوف الفحص الفرعي «القيد الافتتاحي») */
  notePrefix?: string | null;
  /** ملاحظة إضافية للصفّ */
  noteOf?: (partnerKey: string, expectedMilli: Milli, actualMilli: Milli) => string | null;
  cap?: number;
}

export interface PartnerRows {
  /** صفّ لكل شريك قيمته غير صفرية في أحد الجانبين (غير مرتّبة ولا مقصوصة) */
  rows: ParityDrillRow[];
  expectedMilli: Milli;
  actualMilli: Milli;
  diffMilli: Milli;
  /** شركاء بفرق ≠ 0 */
  mismatches: number;
}

/** صفوف التعمّق لكل شريك: اتحاد المفاتيح، والغائب صفر، والفرق = الفعلي − المتوقَّع */
export function partnerRows(
  expected: ReadonlyMap<string, Milli>, actual: ReadonlyMap<string, Milli>, opts: CompareByPartnerOptions,
): PartnerRows {
  const keys = new Set<string>([...expected.keys(), ...actual.keys()]);
  const rows: ParityDrillRow[] = [];
  let e = 0n;
  let a = 0n;
  let mismatches = 0;
  for (const k of keys) {
    const ev = expected.get(k) ?? 0n;
    const av = actual.get(k) ?? 0n;
    e += ev;
    a += av;
    const diff = av - ev;
    if (diff !== 0n) mismatches++;
    if (ev === 0n && av === 0n) continue;
    const held = diff !== 0n && k !== '' ? opts.heldByPartner?.get(k) : undefined;
    const notes: string[] = [];
    if (opts.notePrefix) notes.push(opts.notePrefix);
    if (k === '') notes.push('سطور في الأستاذ بلا شريك');
    if (held && held.length) {
      notes.push(held.length > PARITY_REFS_PER_ROW
        ? `يفسّره ${held.length} حدث محجوز (أول ${PARITY_REFS_PER_ROW} مرجعاً)`
        : `يفسّره ${held.length} حدث محجوز`);
    } else if (diff !== 0n && opts.explainDiffs) {
      notes.push('فرق لا يفسّره حدث محجوز');
    }
    const extra = opts.noteOf?.(k, ev, av);
    if (extra) notes.push(extra);
    const name = k === '' ? (opts.blankName ?? null) : (opts.names?.get(k) ?? opts.nameOf?.(k) ?? null);
    const row: ParityDrillRow = {
      partnerType: opts.partnerType, partnerId: k === '' ? null : k, name, expectedMilli: ev, actualMilli: av, diffMilli: diff,
      note: notes.length ? notes.join(' — ') : null,
    };
    if (held && held.length) row.refs = held.slice(0, PARITY_REFS_PER_ROW);
    rows.push(row);
  }
  return { rows, expectedMilli: e, actualMilli: a, diffMilli: a - e, mismatches };
}

/** مقارنة لكل شريك مع التعمّق المرتّب المقصوص (العقد §13) */
export function compareByPartner(
  expected: ReadonlyMap<string, Milli>, actual: ReadonlyMap<string, Milli>, opts: CompareByPartnerOptions,
): { drill: ParityDrillRow[]; truncated: number; expectedMilli: Milli; actualMilli: Milli; diffMilli: Milli; mismatches: number } {
  const r = partnerRows(expected, actual, opts);
  const { drill, truncated } = capDrill(r.rows, opts.cap);
  return { drill, truncated, expectedMilli: r.expectedMilli, actualMilli: r.actualMilli, diffMilli: r.diffMilli, mismatches: r.mismatches };
}

/** فحص «غير متاح بعد» بمرحلته وسببه؛ المتوقَّع والفعلي (إن حُسبا) للعرض، والفرق null — لا مقارنة في هذه المرحلة */
function notAvailable(
  code: ParityCode, scope: ParityScope,
  over: Partial<Pick<ParityCheck, 'expectedMilli' | 'actualMilli' | 'drill' | 'drillTruncated' | 'info' | 'reason' | 'reasonCode' | 'availableIn'>> = {},
): ParityCheck {
  const na = PARITY_NOT_AVAILABLE[code];
  return {
    code, titleAr: PARITY_TITLES[code], status: 'NOT_AVAILABLE', scope,
    availableIn: over.availableIn !== undefined ? over.availableIn : na?.availableIn ?? null,
    reason: over.reason ?? na?.reason ?? null,
    // الرمز الآلي لما لا ينطبق أصلاً — غائب في غيره فلا يتغيّر شكل بقية الفحوص
    ...(over.reasonCode ? { reasonCode: over.reasonCode } : {}),
    expectedMilli: over.expectedMilli ?? null, actualMilli: over.actualMilli ?? null, diffMilli: null,
    drill: over.drill ?? [], drillTruncated: over.drillTruncated ?? 0,
    ...(over.info ? { info: over.info } : {}),
  };
}

function fullCheck(code: ParityCode, ok: boolean, expectedMilli: Milli, actualMilli: Milli, drill: ParityDrillRow[], drillTruncated: number, info: Info): ParityCheck {
  return {
    code, titleAr: PARITY_TITLES[code], status: ok ? 'OK' : 'MISMATCH', scope: 'FULL', availableIn: null, reason: null,
    expectedMilli, actualMilli, diffMilli: actualMilli - expectedMilli, drill, drillTruncated, info,
  };
}

/** حسابات مفاتيح الربط المفقودة (info.accountMissing) — الحساب الغائب رصيده صفر */
function accountIds(gl: GlBalanceView, keys: readonly string[]): { ids: Map<string, string | null>; missing: string | null } {
  const ids = new Map<string, string | null>();
  const missing: string[] = [];
  for (const k of keys) {
    const id = gl.accountIdByKey(k);
    ids.set(k, id);
    if (!id) missing.push(k);
  }
  return { ids, missing: missing.length ? missing.join(',') : null };
}

const byPartner = (gl: GlBalanceView, id: string | null | undefined, partner: 'customerId' | 'salesRepId' | 'vendorId', q?: GlBalanceQuery): Map<string, Milli> =>
  (id ? gl.balanceByPartner([id], partner, q) : new Map<string, Milli>());
const totalOf = (gl: GlBalanceView, id: string | null | undefined, q?: GlBalanceQuery): Milli => (id ? gl.total([id], q) : 0n);

const OPENING_ONLY: GlBalanceQuery = { moveTypes: ['OPENING'] };
const OPENING_NOTE = 'القيد الافتتاحي';

// ═══ R1: التوازن و319002 ═══

type EquityLine = ReturnType<GlBalanceView['linesOn']>[number];

const isMarkedImport = (l: EquityLine): boolean => l.needsAttention && l.attentionReason === IMPORT_AFTER_CUTOVER_ATTENTION_REASON;

function checkR1(gl: GlBalanceView, ctx: ParityContext): ParityCheck {
  const unbalanced = gl.unbalancedMoves();
  const grand = gl.grandTotals();
  const { ids, missing } = accountIds(gl, ['OPENING_EQUITY']);
  const eq = ids.get('OPENING_EQUITY');
  const actual = totalOf(gl, eq);
  const openingLedger = totalOf(gl, eq, OPENING_ONLY);
  const lines = eq ? gl.linesOn(eq, R1_EQUITY_LINES_LIMIT) : [];
  const later = lines.filter((l) => l.moveType !== 'OPENING');
  // «استيراد بعد البدء» المعلَّم (markImportAfterCutover في poster.ts) ومعه عكوسه — عكس القيد لا يحمل العلامة (reverse.ts)
  // فيُعرف بشقيقه: REVERSE/REPOST_REV ⇐ POST المعلَّم (مرآة importMovesAfterCutover في فحص C9)
  const marked = new Set(later.filter(isMarkedImport).map((l) => l.sourceKey).filter((k): k is string => !!k));
  let importMilli = 0n;
  const importMoves = new Set<string>();
  const others = new Map<string, { net: Milli; sourceKey: string | null; moveType: string; reason: string | null }>();
  for (const l of later) {
    const net = l.debitMilli - l.creditMilli;
    const sibling = l.sourceKey ? siblingPostKey(l.sourceKey) : null;
    if (isMarkedImport(l) || (sibling !== null && marked.has(sibling))) {
      importMilli += net;
      importMoves.add(l.moveRef);
      continue;
    }
    const o = others.get(l.moveRef);
    if (o) o.net += net;
    else others.set(l.moveRef, { net, sourceKey: l.sourceKey, moveType: l.moveType, reason: l.attentionReason });
  }
  // الفرق الافتتاحي الموقَّع: موجب = دائن 319002 ⇒ رصيده (مدين − دائن) = −الفرق
  const expectedOpening = -ctx.openingEquityDiffMilli;
  const expected = expectedOpening + importMilli;
  const otherMilli = actual - openingLedger - importMilli;
  const balanced = unbalanced.length === 0 && grand.debitMilli === grand.creditMilli;
  const ok = balanced && actual === expected;

  const rows: ParityDrillRow[] = [];
  for (const u of unbalanced) {
    rows.push({
      partnerType: 'MOVE', partnerId: u.moveRef, name: u.sourceKey, expectedMilli: u.debitMilli, actualMilli: u.creditMilli,
      diffMilli: u.creditMilli - u.debitMilli, note: 'قيد غير متوازن: المدين ≠ الدائن', ...(u.sourceKey ? { refs: [u.sourceKey] } : {}),
    });
  }
  if (grand.debitMilli !== grand.creditMilli) {
    rows.push({
      partnerType: 'ACCOUNT', partnerId: null, name: 'ميزان المراجعة', expectedMilli: grand.debitMilli, actualMilli: grand.creditMilli,
      diffMilli: grand.creditMilli - grand.debitMilli, note: 'Σ المدين ≠ Σ الدائن',
    });
  }
  if (openingLedger !== expectedOpening) {
    rows.push({
      partnerType: 'ACCOUNT', partnerId: 'OPENING', name: 'القيد الافتتاحي — فرق 319002', expectedMilli: expectedOpening, actualMilli: openingLedger,
      diffMilli: openingLedger - expectedOpening, note: 'سطر 319002 في القيد الافتتاحي ≠ فرق الأرصدة الافتتاحية',
    });
  }
  // قيود أخرى على 319002 (وصول متأخر لاستيراد، قيد لا يحمل العلامة…): تُعدَّد حين لا يتصافى مجموعها وحده
  if (otherMilli !== 0n) {
    for (const [moveRef, o] of others) {
      if (o.net === 0n) continue;
      // استيراد بلا علامة = وصل متأخراً (أثره قبل البدء وأُنشئ بعد T0): مكانه الافتتاح، فإعادة المعاينة تُدخله فيه
      const lateImport = o.moveType === 'IMPORT' && !!o.sourceKey && o.sourceKey.startsWith('AR_ENTRY:');
      rows.push({
        partnerType: 'MOVE', partnerId: moveRef, name: o.sourceKey ?? o.moveType, expectedMilli: 0n, actualMilli: o.net, diffMilli: o.net,
        note: lateImport
          ? 'رصيد مستورد وصل متأخراً (أثره قبل البدء) — أعد المعاينة ليدخل القيد الافتتاحي'
          : `قيد ${o.moveType} على 319002 خارج الافتتاح والاستيراد المعلَّم${o.reason ? ` — ${o.reason}` : ''}`,
        ...(o.sourceKey ? { refs: [o.sourceKey] } : {}),
      });
    }
  }
  const { drill, truncated } = capDrill(rows);
  const info: Info = {
    unbalancedMoves: unbalanced.length,
    grandDebitMilli: milliText(grand.debitMilli),
    grandCreditMilli: milliText(grand.creditMilli),
    openingEquityDiffMilli: milliText(ctx.openingEquityDiffMilli),
    openingLedgerMilli: milliText(openingLedger),
    importAfterCutoverMilli: milliText(importMilli),
    importAfterCutoverMoves: importMoves.size,
    otherMilli: milliText(otherMilli),
    otherMoves: [...others.values()].filter((o) => o.net !== 0n).length,
    equityLinesScanned: lines.length,
    equityLinesTruncated: lines.length >= R1_EQUITY_LINES_LIMIT ? 1 : 0,
    accountMissing: missing,
  };
  return fullCheck('R1', ok, expected, actual, drill, truncated, info);
}

// ═══ R2: الذمم لكل عميل ═══

function checkR2(gl: GlBalanceView, ops: OperationalFacts, ctx: ParityContext): ParityCheck {
  const { ids, missing } = accountIds(gl, ['AR_CONTROL']);
  const ar = ids.get('AR_CONTROL');
  const base: CompareByPartnerOptions = {
    partnerType: 'CUSTOMER', names: ops.names.customers, blankName: 'سطور ذمم بلا عميل', heldByPartner: ctx.heldByPartner, explainDiffs: true,
  };
  const main = partnerRows(ops.arByCustomer, byPartner(gl, ar, 'customerId'), base);
  // الفرعي: سطور القيد الافتتاحي لكل عميل = صفوفه المشمولة بالافتتاح (لا أحداث تفسّره: الافتتاح ليس حدثاً)
  const opening = partnerRows(ops.arOpeningByCustomer, byPartner(gl, ar, 'customerId', OPENING_ONLY), {
    ...base, heldByPartner: null, notePrefix: OPENING_NOTE,
  });
  const { drill, truncated } = capDrill([...main.rows, ...opening.rows.filter((r) => r.diffMilli !== 0n)]);
  const info: Info = {
    customers: main.rows.filter((r) => r.partnerId !== null).length,
    mismatches: main.mismatches,
    openingExpectedMilli: milliText(opening.expectedMilli),
    openingActualMilli: milliText(opening.actualMilli),
    openingDiffMilli: milliText(opening.diffMilli),
    openingMismatches: opening.mismatches,
    accountMissing: missing,
  };
  return fullCheck('R2', main.mismatches === 0 && opening.mismatches === 0, main.expectedMilli, main.actualMilli, drill, truncated, info);
}

// ═══ R3: العهدة لكل مندوب ═══

function checkR3(gl: GlBalanceView, ops: OperationalFacts, ctx: ParityContext): ParityCheck {
  const { ids, missing } = accountIds(gl, ['REP_CUSTODY']);
  const expected = new Map<string, Milli>();
  let opsOutstanding = 0n;
  for (const [rep, c] of ops.custodyByRep) {
    expected.set(rep, c.ledgerCustodyMilli);
    opsOutstanding += c.opsOutstandingMilli;
  }
  const r = compareByPartner(expected, byPartner(gl, ids.get('REP_CUSTODY'), 'salesRepId'), {
    partnerType: 'REP', names: ops.names.reps, blankName: 'سطور عهدة بلا مندوب', heldByPartner: ctx.heldByPartner, explainDiffs: true,
  });
  const info: Info = {
    reps: ops.custodyByRep.size,
    mismatches: r.mismatches,
    opsOutstandingMilli: milliText(opsOutstanding),
    ledgerCustodyMilli: milliText(r.expectedMilli),
    // C4b: الشاشة التشغيلية (السندات النشطة − الاستلامات) − رصيد الأستاذ؛ يفسّره الإلكتروني غير المصفّى والموجّه خارج العهدة
    screenMinusLedgerMilli: milliText(opsOutstanding - r.actualMilli),
    accountMissing: missing,
  };
  return fullCheck('R3', r.mismatches === 0, r.expectedMilli, r.actualMilli, r.drill, r.truncated, info);
}

// ═══ R5: الأمانات ═══

function checkR5(gl: GlBalanceView, ops: OperationalFacts): ParityCheck {
  const { ids, missing } = accountIds(gl, ['PAYLINK_CLEARING']);
  const actual = totalOf(gl, ids.get('PAYLINK_CLEARING'));
  return fullCheck('R5', actual === ops.settlementBalanceMilli, ops.settlementBalanceMilli, actual, [], 0, { accountMissing: missing });
}

// ═══ R8: المخزون لكل موقع ═══

function locationName(loc: string, reps: ReadonlyMap<string, string>): string {
  if (loc === WH_LOCATION) return 'المستودع';
  if (loc === UNKNOWN_VAN) return 'سيارات غير معروفة';
  const rep = repOfLocation(loc as LocationKey);
  if (!rep) return loc;
  return `سيارة — ${reps.get(rep) ?? `مندوب ${rep}`}`;
}

function byLocation(totals: readonly LocationTotals[]): Map<string, Milli> {
  const out = new Map<string, Milli>();
  for (const t of totals) addTo(out, t.location, t.valueMilli);
  return out;
}

/** أرصدة الأستاذ لكل موقع: 114001 كله للمستودع، و114002 بالمندوب لكل سيارة (بلا مندوب ⇒ VAN:_) */
function ledgerByLocation(gl: GlBalanceView, wh: string | null | undefined, van: string | null | undefined, q?: GlBalanceQuery): Map<string, Milli> {
  const out = new Map<string, Milli>();
  if (wh) addTo(out, WH_LOCATION, gl.total([wh], q));
  if (van) for (const [rep, v] of gl.balanceByPartner([van], 'salesRepId', q)) addTo(out, rep ? vanLocation(rep) : UNKNOWN_VAN, v);
  return out;
}

function checkR8(gl: GlBalanceView, ops: OperationalFacts, ctx: ParityContext): ParityCheck {
  const costing = ctx.costing;
  const { ids, missing } = accountIds(gl, ['INVENTORY_WAREHOUSE', 'INVENTORY_VAN']);
  const wh = ids.get('INVENTORY_WAREHOUSE');
  const van = ids.get('INVENTORY_VAN');
  const actual = ledgerByLocation(gl, wh, van);
  const reps = ops.names.reps;
  const opts: CompareByPartnerOptions = { partnerType: 'LOCATION', nameOf: (k) => locationName(k, reps) };
  if (!costing) {
    const r = partnerRows(new Map(), actual, opts);
    const { drill, truncated } = capDrill(r.rows);
    return notAvailable('R8', 'NONE', { reason: R8_NO_COSTING_REASON, actualMilli: r.actualMilli, drill, drillTruncated: truncated, info: { accountMissing: missing } });
  }
  const now = partnerRows(byLocation(costing.nowByLocation), actual, opts);
  if (ctx.inventoryMode !== 'PERPETUAL') {
    const { drill, truncated } = capDrill(now.rows);
    // لا ينطبق في أي مرحلة: availableIn = null ورمز السبب، فلا تعرض الواجهة «يُضاف في L6» ولا تقرأ التعمّق فروقاً
    return notAvailable('R8', 'NONE', {
      availableIn: null, reason: R8_PERIODIC_REASON, reasonCode: 'INVENTORY_PERIODIC',
      expectedMilli: now.expectedMilli, actualMilli: now.actualMilli, drill, drillTruncated: truncated,
      info: { locations: now.rows.length, openingTie: null, accountMissing: missing },
    });
  }
  // المتاح الآن (OPENING_ONLY): سطور الافتتاح لكل موقع = Σ لقطات الافتتاح (CostingSummary.openingByLocation)
  const dec = ctx.currencyDecimals;
  const opening = partnerRows(byLocation(costing.openingByLocation), ledgerByLocation(gl, wh, van, OPENING_ONLY), {
    ...opts, notePrefix: OPENING_NOTE,
    noteOf: (_k, e, a) => `المتوقَّع ${amountText(e, dec)} والأستاذ ${amountText(a, dec)}`,
  });
  const { drill, truncated } = capDrill([...now.rows, ...opening.rows.filter((r) => r.diffMilli !== 0n)]);
  return notAvailable('R8', 'OPENING_ONLY', {
    expectedMilli: now.expectedMilli, actualMilli: now.actualMilli, drill, drillTruncated: truncated,
    info: {
      locations: now.rows.length,
      openingTie: opening.mismatches === 0 ? 'OK' : 'MISMATCH',
      openingExpectedMilli: milliText(opening.expectedMilli),
      openingActualMilli: milliText(opening.actualMilli),
      openingDiffMilli: milliText(opening.diffMilli),
      openingMismatches: opening.mismatches,
      accountMissing: missing,
    },
  });
}

// ═══ R9–R11: المتوقَّع محسوباً ═══

function checkR9(gl: GlBalanceView, ctx: ParityContext): ParityCheck {
  const { ids, missing } = accountIds(gl, ['COGS']);
  const c = ctx.costing;
  return notAvailable('R9', 'NONE', {
    expectedMilli: c ? c.fyCogsMilli : null,
    actualMilli: totalOf(gl, ids.get('COGS')),
    info: c
      ? { fyVarianceMilli: milliText(c.fyVarianceMilli), fyWriteOffMilli: milliText(c.fyWriteOffMilli), moveCount: c.moveCount, accountMissing: missing }
      : { accountMissing: missing },
  });
}

function checkR10(gl: GlBalanceView, ops: OperationalFacts): ParityCheck {
  const { ids, missing } = accountIds(gl, ['AP_CONTROL']);
  // كشف المورّد موجبه «مستحقّ له» = دائن 211001 ⇒ المتوقَّع بإشارة الأستاذ = −Σ amountMilli
  const r = partnerRows(negate(ops.supplierByVendor), byPartner(gl, ids.get('AP_CONTROL'), 'vendorId'), {
    partnerType: 'VENDOR', names: ops.names.vendors, blankName: 'سطور ذمم دائنة بلا مورّد',
  });
  const { drill, truncated } = capDrill(r.rows);
  return notAvailable('R10', 'NONE', {
    expectedMilli: r.expectedMilli, actualMilli: r.actualMilli, drill, drillTruncated: truncated,
    info: { vendors: ops.supplierByVendor.size, accountMissing: missing },
  });
}

function checkR11(gl: GlBalanceView, ops: OperationalFacts): ParityCheck {
  const { ids, missing } = accountIds(gl, ['GRNI']);
  return notAvailable('R11', 'NONE', {
    // الوارد غير المصنَّف يُقيَّد دائناً على 211002 (D4) ⇒ المتوقَّع بإشارة الأستاذ سالب
    expectedMilli: -ops.unclassifiedPricedReceiptsFyMilli,
    actualMilli: totalOf(gl, ids.get('GRNI')),
    info: { unclassifiedPricedReceiptsFyMilli: milliText(ops.unclassifiedPricedReceiptsFyMilli), accountMissing: missing },
  });
}

function checkR13(gl: GlBalanceView, ctx: ParityContext): ParityCheck {
  const { ids, missing } = accountIds(gl, ['POSTING_SUSPENSE']);
  let held = 0;
  for (const v of ctx.heldByPartner.values()) held += v.length;
  return notAvailable('R13', 'NONE', {
    info: { suspenseMilli: milliText(totalOf(gl, ids.get('POSTING_SUSPENSE'))), heldWithPartner: held, accountMissing: missing },
  });
}

// ═══ التشغيل ═══

/** R1..R13 بالترتيب (PARITY_CODES) — صرفة وحتمية: الإدخال نفسه بأي ترتيب للخرائط ⇒ الناتج نفسه حرفياً */
export function runParity(gl: GlBalanceView, ops: OperationalFacts, ctx: ParityContext): ParityCheck[] {
  return [
    checkR1(gl, ctx),
    checkR2(gl, ops, ctx),
    checkR3(gl, ops, ctx),
    notAvailable('R4', 'NONE'),
    checkR5(gl, ops),
    notAvailable('R6', 'NONE'),
    notAvailable('R7', 'NONE'),
    checkR8(gl, ops, ctx),
    checkR9(gl, ctx),
    checkR10(gl, ops),
    checkR11(gl, ops),
    notAvailable('R12', 'NONE'),
    checkR13(gl, ctx),
  ];
}

// ═══ حقائق التشغيل ═══

export interface OperationalFactsInput {
  /** T0 — حدّ «المشمول بالافتتاح» (createdAt ≤ T0) */
  snapshotAt: Date;
  /** ساعة القاعدة داخل اللقطة — حدّ كل الصفوف (createdAt ≤ dbNow) */
  dbNow: Date;
  linkedFrom: LocalDate;
  /** zonedStartOfDay(linkedFrom) */
  cutoverStart: Date;
  timezone: string;
  currencyDecimals: number;
}

export interface OperationalFactsOptions {
  /** صفوف كل صفحة (الاختبارات تثبت أن أي حجم يعطي النتيجة نفسها) */
  pageSize?: number;
}

type Db = Prisma.TransactionClient;
type KeysetAfter = { at: Date; id: string } | null;

const ROW_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** نافذة المؤشّر (createdAt, id) حصرياً وحدّ until شاملاً (null ⇒ بلا حدٍّ أعلى) — فهرس (tenantId, createdAt, id) */
function rowWindow(until: Date | null, after: KeysetAfter) {
  const upper = until ? { lte: until } : {};
  if (!after) return until ? { createdAt: upper } : {};
  return {
    createdAt: { gte: after.at, ...upper },
    OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }],
  };
}

// ═══ قراءات محمّل العهدة مجمَّعةً (لا N+1) ═══

/** سند مندوبٍ بالحقول التي يقرؤها محمّل العهدة (PrismaPostingTx.loadCustodyInputs) */
interface RepReceiptRow { id: string; salesRepId: string; amount: number; paymentMethod: string; receiptDate: Date; createdAt: Date; cancelRefundFrom: string | null }
/** صفّ دفترٍ بالحقول التي يقرؤها المحمّل لآثار الإلغاء — seq ترتيب المسح (createdAt, id) */
interface CustodyEntryRow { receiptId: string | null; invoiceId: string | null; type: string; entryDate: Date; description: string | null; seq: number }

const RECEIPT_FIELDS = ['id', 'amount', 'paymentMethod', 'receiptDate', 'createdAt', 'cancelRefundFrom'] as const;
const ENTRY_FIELDS = ['receiptId', 'invoiceId', 'type', 'entryDate', 'description'] as const;

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOf = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined).sort();
const strList = (v: unknown): string[] | null => {
  if (!isRec(v) || keysOf(v).join() !== 'in' || !Array.isArray(v.in) || v.in.some((x) => typeof x !== 'string')) return null;
  return v.in as string[];
};
function selectFields(args: Record<string, unknown>, allowed: readonly string[]): string[] | null {
  const sel = args.select;
  if (!isRec(sel)) return null;
  const ks = keysOf(sel);
  return ks.length > 0 && ks.every((k) => allowed.includes(k) && sel[k] === true) ? ks : null;
}
const project = (row: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, row[f]]));

/**
 * كل ما يقرؤه محمّل العهدة **بلا فهرس** (السندات بالمندوب، وقيود الإلغاء بالسند والفاتورة) مقروءاً مرةً واحدة للشركة:
 * المحمّل لكل مندوب كان يمسح سندات الشركة كلها (لا فهرس على receipts.salesRepId) ثم قيودها كلها (لا فهرس على
 * account_entries.receiptId/invoiceId) — مسحان كاملان لكل مندوبٍ منذ البداية (R × N). هنا: مسحٌ واحد للسندات، ومسحٌ للفواتير
 * النقدية بمندوب، وقيودها تُفهرس أثناء مسح الذمم نفسه (لا مسح إضافي) — ثم يجيب الوكيل استعلامَي المحمّل من الذاكرة **بشكلهما
 * الحرفي وحده** (وإلا يمرّ الاستعلام إلى القاعدة)، فالمحمّل نفسه (createPrismaCheckStore ⇒ PrismaPostingTx) يبقى الحَكَم.
 */
class CustodyPrefetch {
  readonly receiptsByRep = new Map<string, RepReceiptRow[]>();
  readonly receiptIds = new Set<string>();
  readonly cashInvoiceIds = new Set<string>();
  readonly cashInvoiceReps = new Set<string>();
  private readonly byReceipt = new Map<string, CustodyEntryRow[]>();
  private readonly byInvoice = new Map<string, CustodyEntryRow[]>();
  private seq = 0;

  constructor(readonly tenantId: string) {}

  addReceipt(r: RepReceiptRow): void {
    this.receiptIds.add(r.id);
    const list = this.receiptsByRep.get(r.salesRepId);
    if (list) list.push(r); else this.receiptsByRep.set(r.salesRepId, [r]);
  }

  /** صفّ دفترٍ من مسح الذمم: يُحفظ إن كان مما يسأل عنه المحمّل وحده (سند مندوب، أو فاتورة نقدية بمندوب بلا سند) */
  indexEntry(r: { receiptId: string | null; invoiceId: string | null; type: string; entryDate: Date; description?: string | null }): void {
    const row = (): CustodyEntryRow => ({ receiptId: r.receiptId, invoiceId: r.invoiceId, type: r.type, entryDate: r.entryDate, description: r.description ?? null, seq: this.seq++ });
    if (r.receiptId && this.receiptIds.has(r.receiptId)) {
      const list = this.byReceipt.get(r.receiptId);
      if (list) list.push(row()); else this.byReceipt.set(r.receiptId, [row()]);
    } else if (!r.receiptId && r.invoiceId && this.cashInvoiceIds.has(r.invoiceId)) {
      const list = this.byInvoice.get(r.invoiceId);
      if (list) list.push(row()); else this.byInvoice.set(r.invoiceId, [row()]);
    }
  }

  /** receipt.findMany({where:{tenantId, salesRepId, createdAt?:{gt}}, select}) ⇒ من الذاكرة، وإلا null */
  answerReceipts(args: unknown): Record<string, unknown>[] | null {
    if (!isRec(args) || keysOf(args).some((k) => k !== 'where' && k !== 'select')) return null;
    const w = args.where;
    if (!isRec(w)) return null;
    const wk = keysOf(w).join();
    if (wk !== 'salesRepId,tenantId' && wk !== 'createdAt,salesRepId,tenantId') return null;
    if (w.tenantId !== this.tenantId || typeof w.salesRepId !== 'string') return null;
    let gt: Date | null = null;
    if (w.createdAt !== undefined) {
      const c = w.createdAt;
      if (!isRec(c) || keysOf(c).join() !== 'gt' || !(c.gt instanceof Date)) return null;
      gt = c.gt;
    }
    const fields = selectFields(args, RECEIPT_FIELDS);
    if (!fields) return null;
    return (this.receiptsByRep.get(w.salesRepId) ?? [])
      .filter((r) => !gt || r.createdAt.getTime() > gt.getTime())
      .map((r) => project(r as unknown as Record<string, unknown>, fields));
  }

  /** accountEntry.findMany({where:{tenantId, OR:[{receiptId:{in}}, {invoiceId:{in}, receiptId:null}]}, select}) ⇒ من الذاكرة، وإلا null */
  answerEntries(args: unknown): Record<string, unknown>[] | null {
    if (!isRec(args) || keysOf(args).some((k) => k !== 'where' && k !== 'select')) return null;
    const w = args.where;
    if (!isRec(w) || keysOf(w).join() !== 'OR,tenantId' || w.tenantId !== this.tenantId || !Array.isArray(w.OR) || w.OR.length === 0) return null;
    const fields = selectFields(args, ENTRY_FIELDS);
    if (!fields) return null;
    const out: CustodyEntryRow[] = [];
    for (const b of w.OR as unknown[]) {
      if (!isRec(b)) return null;
      const bk = keysOf(b).join();
      if (bk === 'receiptId') {
        const ids = strList(b.receiptId);
        if (!ids || ids.some((id) => !this.receiptIds.has(id))) return null;
        for (const id of new Set(ids)) out.push(...(this.byReceipt.get(id) ?? []));
      } else if (bk === 'invoiceId,receiptId' && b.receiptId === null) {
        const ids = strList(b.invoiceId);
        if (!ids || ids.some((id) => !this.cashInvoiceIds.has(id))) return null;
        for (const id of new Set(ids)) out.push(...(this.byInvoice.get(id) ?? []));
      } else return null;
    }
    // ترتيب المسح (createdAt, id) — حتمي (الاستعلام الأصلي بلا orderBy)، وصفٌّ يطابق الفرعين معاً لا يتكرّر
    const seen = new Set<number>();
    const rows: Record<string, unknown>[] = [];
    for (const r of out.sort((a, b) => a.seq - b.seq)) {
      if (seen.has(r.seq)) continue;
      seen.add(r.seq);
      rows.push(project(r as unknown as Record<string, unknown>, fields));
    }
    return rows;
  }

  /** عميلٌ يجيب استعلامَي المحمّل من الذاكرة ويمرّر كل ما سواهما (الإعدادات وأحداث الاستلام إلى الظلّ، والبقية إلى القاعدة) */
  client(db: Db): Db {
    const wrap = (model: 'receipt' | 'accountEntry', answer: (a: unknown) => Record<string, unknown>[] | null): object => {
      const d = (db as unknown as Record<string, object>)[model];
      return new Proxy(d, {
        get(t, m) {
          const v = Reflect.get(t, m) as unknown;
          if (typeof v !== 'function') return v;
          const fn = v as (a: unknown) => unknown;
          if (m !== 'findMany') return fn.bind(t);
          return (args: unknown) => {
            const hit = answer(args);
            return hit ? Promise.resolve(hit) : fn.call(t, args);
          };
        },
      });
    };
    const receipt = wrap('receipt', (a) => this.answerReceipts(a));
    const accountEntry = wrap('accountEntry', (a) => this.answerEntries(a));
    return new Proxy(db as object, {
      get(t, p) {
        if (p === 'receipt') return receipt;
        if (p === 'accountEntry') return accountEntry;
        const v = Reflect.get(t, p) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as Db;
  }
}

/** يقرأ صفحات متتالية حتى صفحة ناقصة؛ fetch يأخذ المؤشّر الحصري */
async function forEachPage<T extends { id: string; createdAt: Date }>(
  pageSize: number, fetch: (after: KeysetAfter, take: number) => Promise<T[]>, each: (rows: T[]) => void,
): Promise<void> {
  let after: KeysetAfter = null;
  for (;;) {
    const rows = await fetch(after, pageSize);
    if (rows.length) each(rows);
    if (rows.length < pageSize) return;
    const last = rows[rows.length - 1];
    after = { at: last.createdAt, id: last.id };
  }
}

/** مؤشّر أسطر الوارد: (entry.createdAt, entry.id, item.id) — كـwhWhere في costing/streams.ts */
type ItemAfter = { at: Date; pid: string; iid: string } | null;

interface ReceiptItemRow {
  id: string;
  qty: number;
  unitFactor: number;
  baseQty: number | null;
  unitCost: number | null;
  entry: { id: string; createdAt: Date };
}

function receiptItemsWhere(tenantId: string, from: Date, until: Date, after: ItemAfter): Prisma.WarehouseEntryItemWhereInput {
  const entry: Prisma.WarehouseEntryWhereInput = {
    tenantId, type: 'RECEIVE', paymentMode: null, source: { not: 'OPENING_IMPORT' },
    createdAt: { gte: after && after.at.getTime() > from.getTime() ? after.at : from, lte: until },
  };
  const where: Prisma.WarehouseEntryItemWhereInput = { entry, unitCost: { gt: 0 } };
  if (!after) return where;
  return {
    ...where,
    OR: [
      { entry: { createdAt: { gt: after.at } } },
      { entry: { createdAt: after.at, id: { gt: after.pid } } },
      { entryId: after.pid, id: { gt: after.iid } },
    ],
  };
}

/**
 * حقائق التشغيل لمطابقة الأستاذ (العقد §13). قراءة فقط — ولا وصول gl* إلا ما يحتاجه محمّل العهدة القائم عبر العميل الحارس
 * (glSettings.findUnique وأحداث استلامات المندوب، القائمة المغلقة في shadowClient.ts).
 *
 *  - arByCustomer: Σ(toMilli(debit) − toMilli(credit)) لكل صفوف account_entries حتى dbNow (القيود تُرحَّل حتى dbNow: تمريرة الذيل).
 *  - arOpeningByCustomer: الصفوف نفسها المشمولة بالافتتاح (includedInOpening بـT0) بقاعدة computeDerivedOpening: صفّ إلغاء لمستند
 *    لا صفّ أثر له في النافذة يُسقط (openingRowRole) — بالدوالّ المختبرة openingEntryGroupsFromRows/openingEntryTotalsFromGroups.
 *  - custodyByRep: custodyComponentsForRep(createPrismaCheckStore(db).custodyInputs) — **المحمّل نفسه** الذي يقسم به المُرحِّل
 *    كل استلام (فالمقارنة مع الأستاذ لا مع نسخة مقاربة). لكل مندوب له سند أو فاتورة نقدية أو استلام فقط: استعلام تجميعي
 *    يحدّدهم، والمحمّل لكل واحد منهم (عددهم محدود بعدد المناديب لا بالصفوف) — المناديب المحذوفون فقدوا مندوبهم في الصفوف
 *    (SetNull) فلا أثر لهم في الأستاذ كذلك.
 *  - settlementBalanceMilli: Σ toMilli(amount) لكل صفّ settlement_entries حتى dbNow.
 *  - supplierByVendor: Σ amountMilli (BigInt دقيق ⇒ تجميع في القاعدة) لكل مورّد حتى dbNow.
 *  - unclassifiedPricedReceiptsFyMilli: Σ toMilli(qty × unitCost) لكل سطر وارد RECEIVE مسعَّر بكمية أساس موجبة، بلا نمط دفع
 *    (paymentMode null)، مسجَّل منذ cutoverStart حتى dbNow — بقيمة السطر نفسها التي يدخل بها محرّك التكلفة (streams.ts). يُستثنى
 *    المخزون الافتتاحي المستورد (source = OPENING_IMPORT): بعد بداية السنة يُقيَّد على 319002 لا على 211002 (الخطة D8).
 *  - names: أسماء العملاء (بدفعات) والمناديب والموردين.
 */
export async function loadOperationalFacts(
  db: Db, tenantId: string, input: OperationalFactsInput, options: OperationalFactsOptions = {},
): Promise<OperationalFacts> {
  const dec = input.currencyDecimals;
  toMilli(0, dec); // منازل غير مدعومة ⇒ يرمي قبل أي قراءة
  const pageSize = options.pageSize ?? PARITY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize غير صالح: ${pageSize}`);
  const until = input.dbNow;
  const cut = openingCutoff(input.linkedFrom, input.timezone, input.snapshotAt);

  // ── سندات المناديب وفواتيرهم النقدية: مسحٌ واحد لكلٍّ (محمّل العهدة يقرؤها لكل مندوبٍ بلا فهرس — CustodyPrefetch) ──
  // بلا حدٍّ أعلى كاستعلامات المحمّل نفسها (كل صفوف اللقطة)
  const custody = new CustodyPrefetch(tenantId);
  await forEachPage(pageSize, (after, take) => db.receipt.findMany({
    where: { tenantId, salesRepId: { not: null }, ...rowWindow(null, after) },
    orderBy: ROW_ORDER, take,
    select: { id: true, salesRepId: true, amount: true, paymentMethod: true, receiptDate: true, createdAt: true, cancelRefundFrom: true },
  }), (rows) => {
    for (const r of rows) if (r.salesRepId) custody.addReceipt(r as RepReceiptRow);
  });
  await forEachPage(pageSize, (after, take) => db.invoice.findMany({
    where: { tenantId, type: 'CASH', salesRepId: { not: null }, ...rowWindow(null, after) },
    orderBy: ROW_ORDER, take, select: { id: true, salesRepId: true, createdAt: true },
  }), (rows) => {
    for (const r of rows) {
      custody.cashInvoiceIds.add(r.id);
      if (r.salesRepId) custody.cashInvoiceReps.add(r.salesRepId);
    }
  });

  // ── الذمم (والمسح نفسه يفهرس قيود الإلغاء التي يسأل عنها محمّل العهدة — بلا حدٍّ أعلى، والذمم حتى dbNow في الذاكرة) ──
  const arByCustomer = new Map<string, Milli>();
  const groups = new Map<string, OpeningEntryGroup>();
  const untilMs = until.getTime();
  await forEachPage(pageSize, (after, take) => db.accountEntry.findMany({
    where: { tenantId, ...rowWindow(null, after) },
    orderBy: ROW_ORDER, take,
    select: { id: true, customerId: true, invoiceId: true, receiptId: true, type: true, debit: true, credit: true, entryDate: true, createdAt: true, description: true },
  }), (rows) => {
    const inOpening: OpeningEntryRow[] = [];
    for (const r of rows) {
      custody.indexEntry(r);
      if (r.createdAt.getTime() > untilMs) continue;
      addTo(arByCustomer, r.customerId, toMilli(r.debit ?? 0, dec) - toMilli(r.credit ?? 0, dec));
      if (includedInOpening({ effectAt: r.entryDate, createdAt: r.createdAt }, cut)) {
        inOpening.push({
          customerId: r.customerId, invoiceId: r.invoiceId, receiptId: r.receiptId, type: r.type, invoiceType: null,
          debit: r.debit ?? 0, credit: r.credit ?? 0,
        });
      }
    }
    if (inOpening.length) openingEntryGroupsFromRows(inOpening, dec, groups);
  });
  // نوع الفاتورة لمجموعات الافتتاح وحدها (المرتجع يقلب الأثر والإلغاء) — بدفعات
  const grouped = [...groups.values()];
  const invoiceIds = [...new Set(grouped.map((g) => g.invoiceId).filter((x): x is string => !!x))].sort();
  const invoiceType = new Map<string, string>();
  for (const ids of chunks(invoiceIds, PARITY_ID_CHUNK)) {
    for (const r of await db.invoice.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, type: true } })) invoiceType.set(r.id, r.type);
  }
  for (const g of grouped) g.invoiceType = g.invoiceId ? invoiceType.get(g.invoiceId) ?? null : null;
  const arOpeningByCustomer = openingEntryTotalsFromGroups(grouped, dec, openingRowRole);

  // ── العهدة ──
  const reps = await db.salesRep.findMany({ where: { tenantId }, select: { id: true, name: true } });
  // من له سند أو فاتورة نقدية (من المسحين أعلاه — بالشرطين نفسيهما) أو استلام
  const bySettlement = await db.repSettlement.groupBy({ by: ['salesRepId'], where: { tenantId, ...SETTLEMENT_HAS_REP } });
  const activeReps = new Set<string>([...custody.receiptsByRep.keys(), ...custody.cashInvoiceReps]);
  for (const g of bySettlement) if (g.salesRepId) activeReps.add(g.salesRepId);
  const custodyByRep = new Map<string, { ledgerCustodyMilli: Milli; opsOutstandingMilli: Milli }>();
  const checkStore = createPrismaCheckStore(custody.client(db), { custodyWindow: false });
  for (const rep of [...activeReps].sort()) {
    const c = custodyComponentsForRep(await checkStore.custodyInputs(tenantId, rep), rep);
    custodyByRep.set(rep, { ledgerCustodyMilli: c.ledgerCustody, opsOutstandingMilli: c.opsOutstanding });
  }

  // ── الأمانات ──
  let settlementBalanceMilli = 0n;
  await forEachPage(pageSize, (after, take) => db.settlementEntry.findMany({
    where: { tenantId, ...rowWindow(until, after) },
    orderBy: ROW_ORDER, take, select: { id: true, amount: true, createdAt: true },
  }), (rows) => {
    for (const r of rows) settlementBalanceMilli += toMilli(r.amount, dec);
  });

  // ── الموردون ──
  const supplier = await db.supplierLedgerEntry.groupBy({
    by: ['vendorId'], where: { tenantId, createdAt: { lte: until } }, _sum: { amountMilli: true },
  });
  const supplierByVendor = new Map<string, Milli>();
  for (const g of supplier) supplierByVendor.set(g.vendorId, g._sum?.amountMilli ?? 0n);
  // اسم المورّد من سجلّ الموردين التشغيلي (gl_vendors — L1، لا يمسحه ضبط الدفاتر) بالشكل الوحيد الذي يمرّره العميل الحارس
  // إلى القاعدة (أسماءٌ بمعرّفاتها — shadowClient.ts): اسمٌ للعرض لا رصيدٌ دفتري. والعلاقة المتداخلة `vendor` مرفوضة فيه
  const vendors = new Map<string, string>();
  for (const ids of chunks([...supplierByVendor.keys()].sort(), PARITY_ID_CHUNK)) {
    for (const v of await db.glVendor.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })) {
      if (v.name) vendors.set(v.id, v.name);
    }
  }

  // ── الوارد المسعَّر غير المصنَّف منذ بداية السنة ──
  let unclassifiedPricedReceiptsFyMilli = 0n;
  {
    let after: ItemAfter = null;
    for (;;) {
      const rows: ReceiptItemRow[] = await db.warehouseEntryItem.findMany({
        where: receiptItemsWhere(tenantId, input.cutoverStart, until, after),
        orderBy: [{ entry: { createdAt: 'asc' } }, { entry: { id: 'asc' } }, { id: 'asc' }],
        take: pageSize,
        select: { id: true, qty: true, unitFactor: true, baseQty: true, unitCost: true, entry: { select: { id: true, createdAt: true } } },
      });
      for (const r of rows) {
        if (r.unitCost === null || !(r.unitCost > 0) || !(baseQtyOf(r) > 0)) continue;
        // قيمة السطر بوحدته مقرّبة مرة واحدة — inValueMilli في costing/streams.ts حرفياً
        unclassifiedPricedReceiptsFyMilli += toMilli(r.qty * r.unitCost, dec);
      }
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1];
      after = { at: last.entry.createdAt, pid: last.entry.id, iid: last.id };
    }
  }

  // ── الأسماء ──
  const customerIds = [...new Set([...arByCustomer.keys(), ...arOpeningByCustomer.keys()])].sort();
  const customers = new Map<string, string>();
  for (const ids of chunks(customerIds, PARITY_ID_CHUNK)) {
    for (const c of await db.customer.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })) customers.set(c.id, c.name);
  }
  const repNames = new Map<string, string>();
  for (const r of reps) repNames.set(r.id, r.name);

  return {
    arByCustomer, arOpeningByCustomer, custodyByRep, settlementBalanceMilli, supplierByVendor, unclassifiedPricedReceiptsFyMilli,
    names: { customers, reps: repNames, vendors },
  };
}

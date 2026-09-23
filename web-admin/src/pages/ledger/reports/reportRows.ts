import { formatDayOnly } from '../../../utils/format';
import { ledgerName } from '../../../lib/ledger/format';
import { moveHref, toMilli } from './reportOptions';
import type { ReportResponse } from '../../../api/ledgerReports';
import type { ReportCell, ReportNode, ReportRenderContext, ReportTable, ReportTableColumn } from './ReportView';

/**
 * صفوف ميزان المراجعة ودفتر الأستاذ العام (M4، DESIGN.md §7.2 و§7.5) — تحويلات **صرفة**
 * من ردّ الخادم إلى جدول `ReportView`، بلا React وبلا شبكة، تُختبر وحدةً في `reportRows.test.ts`.
 *
 * **العقد مقروء من المصدر لا من الذاكرة**: الأنواع أدناه منسوخة حرفياً من
 * `backend/src/services/gl/reports/trialBalance.ts` (‏`TrialBalancePayload`) ومن
 * `backend/src/services/gl/reports/generalLedger.ts` (‏`GeneralLedgerSection`/`Totals`)
 * ومن `LedgerPageSection.nextCursor` و`responseBody` في `backend/src/routes/ledger/reports.ts`.
 *
 * **لا حساب هنا:** كل مفتاح ينتهي بـ`Milli` نصّ عدد صحيح بالملّي يُمرَّر كما هو إلى خلايا
 * `ReportView` فتقسمه على وحدة العرض (RPT‑06) وتقرّبه بمنازل العملة. الاستثناء الوحيد
 * `toMilli` للمقارنة بالصفر في شروط صف الإجمالي — مقارنة لا حساب.
 */

// ═══ عقد الردّ: ميزان المراجعة (§7.2) ═══

/** مبلغ الردّ: نصّ عدد صحيح بالملّي. */
export type MilliText = string;

export type TrialBalanceRowKind = 'group' | 'account' | 'unallocated';

/** خانة عمود واحد في صف: الأعمدة الأربعة، ومع المقارنة فرقٌ ونسبة على الرصيد النهائي (RPT‑04). */
export interface TrialCellJson {
  openingMilli: MilliText;
  debitMilli: MilliText;
  creditMilli: MilliText;
  /** = الافتتاحي + المدين − الدائن (§7.2) */
  endingMilli: MilliText;
  /** عمود المقارنة وحده (‏`null` في الأساسي) */
  deltaMilli: MilliText | null;
  percent: number | null;
}

export interface TrialRowJson {
  /** معرّف الحساب، أو `group:<بادئة>`، أو `unallocated-earnings` */
  id: string;
  kind: TrialBalanceRowKind;
  accountId: string | null;
  code: string;
  name: string;
  nameI18n: Record<string, string> | null;
  type: string | null;
  level: number;
  parentId: string | null;
  childIds: string[];
  hasChildren: boolean;
  /** حسابات `equity_unaffected` المدمجة في صف «أرباح سنوات سابقة» — للتعمّق */
  mergedAccountIds: string[];
  /** [0] الفترة الأساسية ثم أعمدة المقارنة، بترتيب `columns` */
  cells: TrialCellJson[];
}

export interface TrialColumnJson {
  from: string;
  to: string;
  fyStart: string;
  kind: 'base' | 'comparison';
  index: number;
}

/** شروط صف الإجمالي الثلاثة لكل عمود (§7.2). */
export interface TrialImbalanceJson {
  openingMilli: MilliText;
  movementMilli: MilliText;
  endingMilli: MilliText;
  balanced: boolean;
}

export interface TrialBalanceResponse extends ReportResponse<TrialRowJson, TrialCellJson[]> {
  columns: TrialColumnJson[];
  /** إجمالي المعروض بعد البحث و«إخفاء الصفري» (‏`totals` على كل الحسابات) */
  visibleTotals: TrialCellJson[];
  imbalance: TrialImbalanceJson[];
  balanced: boolean;
  unallocatedRowId: string;
  searchApplied: boolean;
  draftMoveCount: number;
}

// ═══ عقد الردّ: دفتر الأستاذ العام (§7.5) ═══

export interface LedgerAccountJson {
  id: string;
  code: string;
  name: string;
  nameI18n: Record<string, string> | null;
  type: string;
}

export interface GeneralLedgerLineJson {
  id: string;
  moveId: string;
  accountId: string;
  date: string;
  originalDate: string | null;
  lateArrival: boolean;
  seq: number;
  moveNumber: string | null;
  moveState: string;
  moveType: string;
  journalId: string;
  journalCode: string | null;
  journalName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  analyticAccountId: string | null;
  label: string | null;
  debitMilli: MilliText;
  creditMilli: MilliText;
  /** الرصيد الجارٍ بعد السطر — لا يتحرّك على بند إقفال مفصول */
  runningMilli: MilliText;
  draft: boolean;
  closing: boolean;
  /** بند إقفال مفصول عن أرقام الحساب (§7.2): معروضٌ وموسوم، ولا يدخل الحركة */
  excluded: boolean;
  /** ADR‑7: تاريخ القيد يخالف تاريخ الأثر */
  shifted: boolean;
}

export interface GeneralLedgerSectionJson {
  account: LedgerAccountJson;
  /** الافتتاحي بقاعدة الميزان §7.2 — بذرة الرصيد الجاري */
  openingMilli: MilliText;
  closingOpeningMilli: MilliText;
  openingBalanceMilli: MilliText;
  debitMilli: MilliText;
  creditMilli: MilliText;
  closingExcluded: boolean;
  closingDebitMilli: MilliText;
  closingCreditMilli: MilliText;
  closingMilli: MilliText;
  endingMilli: MilliText;
  endingBalanceMilli: MilliText;
  /** سطور الحساب كلها في الفترة قبل الترقيم */
  lineCount: number;
  page: number;
  pageSize: number | null;
  pageCount: number;
  /** كم سطراً قبل أوّل سطر في هذه الصفحة */
  offset: number;
  /** **رصيد مُرحَّل**: الرصيد الجاري قبل أوّل سطر في الصفحة */
  carriedForwardMilli: MilliText;
  carriedOutMilli: MilliText;
  hasMore: boolean;
  lines: GeneralLedgerLineJson[];
  /** مؤشّر keyset يحمّل صفحة هذا الحساب التالية، و`null` حين لا تالي */
  nextCursor: string | null;
}

export interface GeneralLedgerTotalsJson {
  accountCount: number;
  openingMilli: MilliText;
  debitMilli: MilliText;
  creditMilli: MilliText;
  closingMilli: MilliText;
  endingMilli: MilliText;
  openingBalanceMilli: MilliText;
  endingBalanceMilli: MilliText;
  lineCount: number;
  displayedLineCount: number;
}

export interface GeneralLedgerResponse extends ReportResponse<GeneralLedgerSectionJson, GeneralLedgerTotalsJson> {
  accountFilter: string[];
  partnerFilter: string[];
  cursorAccountId: string | null;
}

// ═══ ما تحتاجه التحويلات من سياق العرض ═══

/** جزء `ReportRenderContext` الذي تستعمله هذه التحويلات (فتُختبر بسياق صغير). */
export type ReportRowsContext = Pick<ReportRenderContext, 'tr' | 'lang' | 'periodLabel'>;

const EMPTY: ReportCell = { kind: 'empty' };

const text = (t: string, href?: string): ReportCell => (href ? { kind: 'text', text: t, href } : { kind: 'text', text: t });

const amount = (milli: MilliText, opts: { strong?: boolean; blankZero?: boolean } = {}): ReportCell => ({
  kind: 'amount',
  milli,
  ...(opts.strong ? { strong: true } : {}),
  ...(opts.blankZero ? { blankZero: true } : {}),
});

export function isZeroMilli(milli: MilliText | null | undefined): boolean {
  return toMilli(milli) === 0n;
}

// ═══ شروط صف الإجمالي الثلاثة (§7.2) ═══

/** الشرط المخروق: Σ الافتتاحي = 0، Σ المدين = Σ الدائن، Σ النهائي = 0. */
export type TrialImbalanceIssue = 'opening' | 'movement' | 'ending';

/** الشروط المخروقة في عمود واحد — فارغة حين يتوازن. صرفة. */
export function trialImbalanceIssues(x: TrialImbalanceJson | undefined): TrialImbalanceIssue[] {
  if (!x) return [];
  const out: TrialImbalanceIssue[] = [];
  if (!isZeroMilli(x.openingMilli)) out.push('opening');
  if (!isZeroMilli(x.movementMilli)) out.push('movement');
  if (!isZeroMilli(x.endingMilli)) out.push('ending');
  return out;
}

/**
 * خرقٌ في أيّ عمود (الأساسي أو المقارنة). لا يُقرأ `balanced` وحده: عمودُ مقارنةٍ واحد مختلّ
 * يكفي لإظهار الخرق أحمر بدل أن يُبتلع.
 */
export function trialBalanceBroken(imbalance: readonly TrialImbalanceJson[] | undefined): boolean {
  if (!imbalance || imbalance.length === 0) return false;
  return imbalance.some(x => trialImbalanceIssues(x).length > 0);
}

/** نصّ كل شرط مخروق (§7.2) — بنداءات `tr()` حرفية. */
export const trialImbalanceLabels = (tr: (ar: string) => string): Record<TrialImbalanceIssue, string> => ({
  opening: tr('مجموع الأرصدة الافتتاحية لا يساوي صفراً'),
  movement: tr('مجموع المدين لا يساوي مجموع الدائن'),
  ending: tr('مجموع الأرصدة النهائية لا يساوي صفراً'),
});

// ═══ جدول ميزان المراجعة (§7.2) ═══

/**
 * أعمدة الميزان: الأربعة لكل فترة (افتتاحي · مدين · دائن · نهائي)، وتتكرر مع كل عمود مقارنة
 * ومعه الفرق والنسبة على الرصيد النهائي (RPT‑04). العنوان الفرعي مدى العمود.
 */
export function trialBalanceColumns(
  columns: readonly TrialColumnJson[],
  ctx: ReportRowsContext,
): ReportTableColumn[] {
  const { tr } = ctx;
  const out: ReportTableColumn[] = [];
  for (const col of columns) {
    const span = ctx.periodLabel(col);
    const sub = col.kind === 'base' ? span : `${tr('مقارنة')}: ${span}`;
    out.push(
      { key: `${col.index}:opening`, label: tr('الرصيد الافتتاحي'), sub },
      { key: `${col.index}:debit`, label: tr('مدين'), sub },
      { key: `${col.index}:credit`, label: tr('دائن'), sub },
      { key: `${col.index}:ending`, label: tr('الرصيد النهائي'), sub },
    );
    if (col.index > 0) {
      out.push(
        { key: `${col.index}:delta`, label: tr('الفرق'), sub },
        { key: `${col.index}:percent`, label: tr('نسبة التغيّر'), sub },
      );
    }
  }
  return out;
}

/** خانات صفٍّ واحد بترتيب الأعمدة أعلاه. صرفة. */
export function trialRowCells(cells: readonly TrialCellJson[] | undefined, columnCount: number): ReportCell[] {
  const out: ReportCell[] = [];
  for (let i = 0; i < columnCount; i++) {
    const c = cells?.[i];
    out.push(
      amount(c?.openingMilli ?? '0'),
      amount(c?.debitMilli ?? '0', { blankZero: true }),
      amount(c?.creditMilli ?? '0', { blankZero: true }),
      amount(c?.endingMilli ?? '0', { strong: true }),
    );
    if (i > 0) {
      out.push(amount(c?.deltaMilli ?? '0'), { kind: 'percent', value: c?.percent ?? null });
    }
  }
  return out;
}

/**
 * حساب التعمّق لصفّ: حسابه، أو حسابه الوحيد المدموج في صفّ «أرباح سنوات سابقة».
 * صفٌّ يجمع أكثر من حساب لا يحمل رابطاً واحداً يدّعي أنه حسابه — فلا رابط.
 */
export function trialRowAccountId(row: TrialRowJson): string | null {
  if (row.accountId) return row.accountId;
  return row.mergedAccountIds.length === 1 ? row.mergedAccountIds[0] : null;
}

/**
 * صفوف الردّ المسطّحة (الأب قبل أبنائه، بترتيب `buildTrialBalance`) ⇒ شجرة عُقد `ReportView`.
 * صفٌّ أبوه مفقود يبقى في الجذر بدل أن يسقط صامتاً.
 */
export function trialBalanceNodes(rows: readonly TrialRowJson[], ctx: ReportRowsContext, columnCount: number): ReportNode[] {
  const nodes = new Map<string, ReportNode & { children: ReportNode[] }>();
  const roots: ReportNode[] = [];
  for (const row of rows) {
    const node: ReportNode & { children: ReportNode[] } = {
      id: row.id,
      label: ledgerName(row, ctx.lang),
      code: row.code || null,
      accountId: trialRowAccountId(row),
      emphasis: row.kind === 'account' ? 'normal' : 'section',
      cells: trialRowCells(row.cells, columnCount),
      children: [],
    };
    nodes.set(row.id, node);
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** ميزان المراجعة كاملاً: أعمدته وشجرته وصفّ الإجمالي بشروطه الثلاثة. صرفة. */
export function trialBalanceTable(data: TrialBalanceResponse, ctx: ReportRowsContext): ReportTable {
  const { tr } = ctx;
  const columns = data.columns ?? [];
  const columnCount = Math.max(1, columns.length);
  const broken = trialBalanceBroken(data.imbalance);
  const footer: ReportNode[] = [];

  // إجمالي المعروض يظهر حين يختلف عن الإجمالي (بحث أو إخفاء أصفار)، فلا يُقرأ جزءٌ على أنه كلّ
  if (data.searchApplied || data.options?.hideZero) {
    footer.push({
      id: 'visible-totals',
      label: tr('إجمالي المعروض'),
      emphasis: 'total',
      cells: trialRowCells(data.visibleTotals, columnCount),
    });
  }
  footer.push({
    id: 'totals',
    label: tr('الإجمالي على كل الحسابات'),
    emphasis: 'total',
    danger: broken,
    cells: trialRowCells(data.totals, columnCount),
  });

  return {
    columns: trialBalanceColumns(columns, ctx),
    nodes: trialBalanceNodes(data.rows ?? [], ctx, columnCount),
    footer,
    emptyText: tr('لا حسابات في هذه الفترة'),
  };
}

// ═══ صفحات دفتر الأستاذ: تحميل عند الطلب (§7.1) ═══

/**
 * صفحة سطورٍ واحدة لحساب (500 سطر). الخادم يعيد **سطور الصفحة وحدها** في `section.lines`
 * ومعها موضعها ورصيدها المُرحَّل، فتتراكم هنا دفعةً بعد دفعة بلا إعادة قراءة ما قُرئ.
 */
export interface LedgerPageChunk {
  accountId: string;
  offset: number;
  carriedForwardMilli: MilliText;
  lines: GeneralLedgerLineJson[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function chunkOfSection(section: GeneralLedgerSectionJson): LedgerPageChunk {
  return {
    accountId: section.account.id,
    offset: section.offset,
    carriedForwardMilli: section.carriedForwardMilli,
    lines: section.lines,
    nextCursor: section.nextCursor,
    hasMore: section.hasMore,
  };
}

/**
 * يضمّ صفحةً محمَّلة إلى الصفحات: مرتّبة بالحساب ثم الإزاحة، وبلا تكرار حين يُعاد الطلب نفسه
 * (زرٌّ نُقر مرتين أو إعادة محاولة) — فلا يتضاعف سطرٌ على الشاشة.
 */
export function appendLedgerChunk(chunks: readonly LedgerPageChunk[], next: LedgerPageChunk): LedgerPageChunk[] {
  const out = chunks.filter(c => !(c.accountId === next.accountId && c.offset === next.offset));
  out.push(next);
  return out.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.offset - b.offset));
}

export interface LedgerSectionView {
  /** صفحات الحساب بترتيبها؛ كل صفحة بعد الأولى تبدأ بصفّ «رصيد مُرحَّل» */
  chunks: LedgerPageChunk[];
  /** السطور المعروضة فعلاً */
  loadedCount: number;
  /** سطور الحساب كلها في الفترة */
  lineCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** حال قسم حساب بعد ضمّ ما حُمِّل عند الطلب إلى صفحته الأولى. صرفة. */
export function ledgerSectionView(
  section: GeneralLedgerSectionJson,
  extra: readonly LedgerPageChunk[] = [],
): LedgerSectionView {
  let chunks: LedgerPageChunk[] = [chunkOfSection(section)];
  for (const c of extra) {
    if (c.accountId !== section.account.id) continue;
    chunks = appendLedgerChunk(chunks, c);
  }
  const last = chunks[chunks.length - 1];
  const loadedCount = chunks.reduce((n, c) => n + c.lines.length, 0);
  return {
    chunks,
    loadedCount,
    lineCount: section.lineCount,
    hasMore: last.hasMore && loadedCount < section.lineCount,
    nextCursor: last.hasMore ? last.nextCursor : null,
  };
}

/** أقسام فيها سطور لم تُحمَّل بعد — مصدر أزرار «تحميل المزيد». صرفة. */
export function ledgerSectionsWithMore(
  sections: readonly GeneralLedgerSectionJson[],
  extra: readonly LedgerPageChunk[] = [],
): { section: GeneralLedgerSectionJson; view: LedgerSectionView }[] {
  const out: { section: GeneralLedgerSectionJson; view: LedgerSectionView }[] = [];
  for (const section of sections) {
    const view = ledgerSectionView(section, extra);
    if (view.hasMore && view.nextCursor) out.push({ section, view });
  }
  return out;
}

// ═══ جدول دفتر الأستاذ العام (§7.5) ═══

/** وسوم السطر: مسودة، بند إقفال، مفصول عن الحركة (§7.2)، مُزاح (ADR‑7). */
export type LedgerLineTag = 'draft' | 'closing' | 'excluded' | 'shifted';

export function ledgerLineTags(line: GeneralLedgerLineJson): LedgerLineTag[] {
  const out: LedgerLineTag[] = [];
  if (line.draft) out.push('draft');
  if (line.closing) out.push('closing');
  if (line.excluded) out.push('excluded');
  if (line.shifted) out.push('shifted');
  return out;
}

export const ledgerLineTagLabels = (tr: (ar: string) => string): Record<LedgerLineTag, string> => ({
  draft: tr('مسودة'),
  closing: tr('قيد إقفال السنة'),
  excluded: tr('منقول إلى أرباح سنوات سابقة'),
  shifted: tr('مُزاح'),
});

/**
 * أعمدة دفتر الأستاذ (§7.5). عمود «البيان» هو عمود الشجرة في `ReportView` (عنوانه ثابت هناك)،
 * فتأتي بقيّة أعمدة §7.5 بترتيبها: التاريخ · الرقم · الدفتر · الشريك · المندوب · مدين · دائن · رصيد جارٍ.
 */
export function generalLedgerColumns(ctx: ReportRowsContext): ReportTableColumn[] {
  const { tr } = ctx;
  return [
    { key: 'date', label: tr('التاريخ'), align: 'start' },
    { key: 'number', label: tr('الرقم'), align: 'start' },
    { key: 'journal', label: tr('الدفتر'), align: 'start' },
    { key: 'partner', label: tr('الشريك'), align: 'start' },
    { key: 'rep', label: tr('المندوب'), align: 'start' },
    { key: 'debit', label: tr('مدين') },
    { key: 'credit', label: tr('دائن') },
    { key: 'running', label: tr('رصيد جارٍ') },
  ];
}

/** صفّ لا يحمل إلا رصيداً في العمود الأخير (الافتتاحي والمُرحَّل). */
function balanceOnlyCells(milli: MilliText): ReportCell[] {
  return [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, amount(milli, { strong: true })];
}

/** سطر أستاذ ⇒ عقدة: التاريخ ورقم القيد (رابطاً إلى قيده) والدفتر والشريك والمندوب والمبالغ. */
export function generalLedgerLineNode(line: GeneralLedgerLineJson, ctx: ReportRowsContext): ReportNode {
  const { tr } = ctx;
  const tagLabels = ledgerLineTagLabels(tr);
  const tags = ledgerLineTags(line).map(t => tagLabels[t]);
  const label = [line.label ?? '', ...tags].filter(Boolean).join(' · ');
  const date = line.shifted && line.originalDate
    ? `${formatDayOnly(line.date)} (${tr('مُزاح من')} ${formatDayOnly(line.originalDate)})`
    : formatDayOnly(line.date);
  return {
    id: line.id,
    label: label || '—',
    accountId: null,
    cells: [
      text(date),
      text(line.moveNumber ?? tr('مسودة'), moveHref(line.moveId)),
      text(line.journalCode ?? ''),
      text(line.partnerName ?? ''),
      text(line.salesRepName ?? ''),
      amount(line.debitMilli, { blankZero: true }),
      amount(line.creditMilli, { blankZero: true }),
      amount(line.runningMilli),
    ],
  };
}

/**
 * قسم حساب ⇒ عقدة قابلة للطيّ: صفّ **رصيد افتتاحي**، ثم سطور كل صفحة مسبوقةً بصفّ
 * **رصيد مُرحَّل** (عدا الأولى، فافتتاحها هو الافتتاحي)، ثم صفّ بنود الإقفال المفصولة
 * (§7.2) إن وُجدت، ثم الإجمالي. `hasMore` يظهر صفّ عدٍّ صريح بدل نقصٍ صامت.
 */
export function generalLedgerSectionNode(
  section: GeneralLedgerSectionJson,
  ctx: ReportRowsContext,
  extra: readonly LedgerPageChunk[] = [],
): ReportNode {
  const { tr } = ctx;
  const view = ledgerSectionView(section, extra);
  const children: ReportNode[] = [{
    id: `${section.account.id}:opening`,
    label: tr('رصيد افتتاحي'),
    cells: balanceOnlyCells(section.openingMilli),
  }];

  view.chunks.forEach((chunk, i) => {
    if (i > 0) {
      children.push({
        id: `${section.account.id}:carried:${chunk.offset}`,
        label: tr('رصيد مُرحَّل'),
        emphasis: 'section',
        cells: balanceOnlyCells(chunk.carriedForwardMilli),
      });
    }
    for (const line of chunk.lines) children.push(generalLedgerLineNode(line, ctx));
  });

  if (section.closingExcluded && !isZeroMilli(section.closingMilli)) {
    children.push({
      id: `${section.account.id}:closing`,
      label: tr('بنود قيد إقفال السنة — منقولة إلى أرباح سنوات سابقة'),
      cells: [
        EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
        amount(section.closingDebitMilli, { blankZero: true }),
        amount(section.closingCreditMilli, { blankZero: true }),
        EMPTY,
      ],
    });
  }

  if (view.hasMore) {
    children.push({
      id: `${section.account.id}:more`,
      label: `${tr('لم تُعرض كل السطور')} — ${view.loadedCount} / ${view.lineCount}`,
      cells: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
    });
  }

  children.push({
    id: `${section.account.id}:total`,
    label: tr('الإجمالي'),
    emphasis: 'total',
    cells: [
      EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
      amount(section.debitMilli),
      amount(section.creditMilli),
      amount(section.endingMilli, { strong: true }),
    ],
  });

  return {
    id: `account:${section.account.id}`,
    label: ledgerName(section.account, ctx.lang),
    code: section.account.code,
    // التعمّق مغلق داخل دفتر الأستاذ نفسه (ReportView لا يربط مبالغ هذا التقرير)
    accountId: null,
    emphasis: 'section',
    cells: [
      EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
      amount(section.debitMilli),
      amount(section.creditMilli),
      amount(section.endingMilli, { strong: true }),
    ],
    children,
  };
}

/** دفتر الأستاذ العام كاملاً: قسمٌ لكل حساب، ومعه ما حُمِّل من صفحاته. صرفة. */
export function generalLedgerTable(
  data: GeneralLedgerResponse,
  ctx: ReportRowsContext,
  extra: readonly LedgerPageChunk[] = [],
): ReportTable {
  return {
    columns: generalLedgerColumns(ctx),
    nodes: (data.rows ?? []).map(s => generalLedgerSectionNode(s, ctx, extra)),
    emptyText: ctx.tr('لا حركة في هذه الفترة'),
  };
}

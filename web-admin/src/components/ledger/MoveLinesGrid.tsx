import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useDir, useLang } from '../../i18n/lang';
import { ledgerName, parseAmountToMilli, milliToDecimalString } from '../../lib/ledger/format';
import type { GlAccount, GlTax } from '../../api/ledgerConfig';
import { LedgerAmount } from './LedgerAmount';
import { AccountPickerDialog } from './AccountPickerDialog';
import {
  ACCOUNT_GROUP_ORDER, MAX_INLINE_MATCHES, accountGroupLabels, countByGroup, fillCount,
  filterAccounts, flatRows, pickerBuckets, pickerRows, type AccountGroupKey,
} from './accountPicker';
import { ACCOUNT_SYNONYMS } from './accountSynonyms';
import { anchorDropdown, anchorVisible, samePosition, type AnchorPosition } from './dropdownAnchor';
import type { GridLine } from '../../lib/ledger/moveLines';
import { newGridLine } from '../../lib/ledger/moveLines';

/**
 * شبكة سطور القيد (§8.3): منتقي الحساب بالإكمال التلقائي (COA‑08) بالرمز أو الاسم، والضريبة،
 * ومربع الإقرار، والتحليلي، وصف الإجماليات، وتلوين عدم التوازن. الجمع بالمللي (bigint) لا بالعائم.
 *
 * السطور المولّدة آلياً (علم `generated` من الخادم، لا taxRole) للقراءة، وسطر الضريبة اليدوي قابل للتحرير؛ الشبكة متحكَّم بها بالكامل.
 */

export { newGridLine, type GridLine } from '../../lib/ledger/moveLines';

export interface GridTotals { debitMilli: bigint; creditMilli: bigint; diffMilli: bigint; invalidKeys: string[] }

/** إجماليات صرفة بالمللي — الفرق = مدين − دائن. */
export function gridTotals(lines: readonly GridLine[], decimals: number): GridTotals {
  let d = 0n; let c = 0n; const invalid: string[] = [];
  for (const l of lines) {
    const dm = parseAmountToMilli(l.debit, decimals);
    const cm = parseAmountToMilli(l.credit, decimals);
    if (dm === null || cm === null || dm < 0n || cm < 0n || (dm > 0n && cm > 0n)) { invalid.push(l.key); continue; }
    d += dm; c += cm;
  }
  return { debitMilli: d, creditMilli: c, diffMilli: d - c, invalidKeys: invalid };
}

export function MoveLinesGrid({
  lines, onChange, accounts, taxes = [], decimals, readOnly = false, vatBoxes = [], analyticOptions, warnings = {}, lineErrors = {},
}: {
  lines: GridLine[];
  onChange: (lines: GridLine[]) => void;
  accounts: GlAccount[];
  taxes?: Omit<GlTax, 'groupId'>[];
  decimals: number;
  readOnly?: boolean;
  /** مربعات الإقرار المتاحة (SA_1…) مع تسمياتها */
  vatBoxes?: { key: string; label: string }[];
  /** الحسابات التحليلية (M11)؛ غيابها يخفي العمود */
  analyticOptions?: { id: string; label: string }[];
  /** تحذير لكل سطر (مثل حساب دفتر بنك) */
  warnings?: Record<string, string>;
  /** خطأ من الخادم لكل سطر */
  lineErrors?: Record<string, string>;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const totals = useMemo(() => gridTotals(lines, decimals), [lines, decimals]);
  const balanced = totals.diffMilli === 0n && totals.invalidKeys.length === 0;
  const activeAccounts = useMemo(() => accounts.filter(a => a.isActive), [accounts]);
  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  const showTax = taxes.length > 0;
  const showVatBox = vatBoxes.length > 0;
  const showAnalytic = !!analyticOptions?.length;

  const patch = (key: string, p: Partial<GridLine>) => onChange(lines.map(l => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: string) => onChange(lines.filter(l => l.key !== key));
  const add = () => {
    // Odoo: السطر الجديد يقترح الفرق الموازن
    const diff = totals.diffMilli;
    const amount = diff === 0n ? '' : milliToDecimalString(diff < 0n ? -diff : diff).replace(/\.?0+$/, '');
    onChange([...lines, newGridLine(diff > 0n ? { credit: amount } : diff < 0n ? { debit: amount } : {})]);
  };

  const colCount = 4 + (showTax ? 1 : 0) + (showVatBox ? 1 : 0) + (showAnalytic ? 1 : 0) + (readOnly ? 0 : 1);

  return (
    <div className="table-wrapper overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th className="text-start min-w-[14rem]">{tr('الحساب')}</th>
            <th className="text-start min-w-[10rem]">{tr('البيان')}</th>
            {showAnalytic && <th className="text-start">{tr('التحليلي')}</th>}
            {showTax && <th className="text-start">{tr('الضريبة')}</th>}
            {showVatBox && <th className="text-start">{tr('مربع الإقرار')}</th>}
            <th className="text-end w-32">{tr('مدين')}</th>
            <th className="text-end w-32">{tr('دائن')}</th>
            {!readOnly && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {lines.map(l => {
            const ro = readOnly || !!l.generated;
            const bad = totals.invalidKeys.includes(l.key);
            const err = lineErrors[l.key];
            const warn = warnings[l.key];
            return (
              <tr key={l.key} className={`${l.generated ? 'bg-[#F7F2EA]/60' : ''} ${err ? 'bg-[#FBE3DF]/50' : ''}`}>
                <td>
                  {ro
                    ? <span className="text-sm"><bdi className="tabular-nums text-[#6E6557]">{accountById.get(l.accountId)?.code}</bdi> {ledgerName(accountById.get(l.accountId), lang)}</span>
                    : <AccountPicker value={l.accountId} accounts={activeAccounts} allAccounts={accountById} lang={lang} onChange={id => patch(l.key, { accountId: id })} />}
                  {(err || warn) && (
                    <p className={`mt-1 text-[11px] flex items-center gap-1 ${err ? 'text-[#C0392B]' : 'text-amber-700'}`}><AlertTriangle size={11} />{err ?? warn}</p>
                  )}
                </td>
                <td>
                  {ro ? <span className="text-sm">{l.label}</span>
                    : <input className="input !py-1 text-sm" value={l.label} onChange={e => patch(l.key, { label: e.target.value })} />}
                </td>
                {showAnalytic && (
                  <td>
                    <select className="input !py-1 text-sm" disabled={ro} value={l.analyticAccountId ?? ''} onChange={e => patch(l.key, { analyticAccountId: e.target.value || null })}>
                      <option value="">—</option>
                      {analyticOptions!.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </td>
                )}
                {showTax && (
                  <td>
                    <select className="input !py-1 text-sm" disabled={ro} value={l.taxId ?? ''} onChange={e => patch(l.key, { taxId: e.target.value || null })}>
                      <option value="">—</option>
                      {taxes.filter(t => t.isActive || t.id === l.taxId).map(t => <option key={t.id} value={t.id}>{ledgerName(t, lang)}</option>)}
                    </select>
                  </td>
                )}
                {showVatBox && (
                  <td>
                    <select className="input !py-1 text-sm" disabled={ro} value={l.vatBox ?? ''} onChange={e => patch(l.key, { vatBox: e.target.value || null })}>
                      <option value="">—</option>
                      {vatBoxes.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                    </select>
                  </td>
                )}
                {(['debit', 'credit'] as const).map(side => (
                  <td key={side} className="text-end">
                    {ro
                      ? <LedgerAmount value={parseAmountToMilli(l[side], decimals) !== null ? milliToDecimalString(parseAmountToMilli(l[side], decimals)!) : 0} decimals={decimals} blankZero />
                      : <input dir="ltr" inputMode="decimal" className={`input !py-1 text-sm text-end tabular-nums ${bad ? '!border-[#C0392B]' : ''}`}
                        value={l[side]} onChange={e => patch(l.key, side === 'debit' ? { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) } : { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} />}
                  </td>
                ))}
                {!readOnly && (
                  <td>
                    {!l.generated && (
                      <button type="button" aria-label={tr('حذف السطر')} className="p-1 text-[#9A8F7E] hover:text-[#C0392B]" onClick={() => remove(l.key)}><Trash2 size={14} /></button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {!readOnly && (
            <tr>
              <td colSpan={colCount}>
                <button type="button" className="inline-flex items-center gap-1 text-sm text-[#E15A30] hover:underline" onClick={add}><Plus size={14} />{tr('إضافة سطر')}</button>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className={balanced ? 'bg-[#F7F2EA]' : 'bg-[#FBE3DF]'}>
            <td colSpan={2 + (showTax ? 1 : 0) + (showVatBox ? 1 : 0) + (showAnalytic ? 1 : 0)} className="font-semibold">
              {balanced ? tr('الإجمالي') : (
                <span className="text-[#C0392B] inline-flex items-center gap-1">
                  <AlertTriangle size={14} />{tr('القيد غير متوازن')}{' '}
                  {totals.invalidKeys.length === 0 && <>— {tr('الفرق')} <LedgerAmount value={milliToDecimalString(totals.diffMilli)} decimals={decimals} colored={false} /></>}
                </span>
              )}
            </td>
            <td className="text-end font-semibold"><LedgerAmount value={milliToDecimalString(totals.debitMilli)} decimals={decimals} colored={false} /></td>
            <td className="text-end font-semibold"><LedgerAmount value={milliToDecimalString(totals.creditMilli)} decimals={decimals} colored={false} /></td>
            {!readOnly && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * منتقي الحساب بالإكمال التلقائي (COA‑08) — أُعيد بناء عرضه في م‑1 من مراجعة الخبير
 * المحاسبي (`docs/accounting/expert-review-2026-09-18.md`).
 *
 * كان يعرض بلا كتابة `accounts.slice(0, 50)` مرتّبةً بالرمز، وأول ٥٠ حساباً في القالب
 * السعودي كلها أصول، فقال الخبير «كل الموجود هنا أصول فقط. دي مشكلة كبيرة جداً» وظنّ
 * أن لا حسابات مصروفات. صار الآن:
 * - **مجمَّعاً بالنوع** برؤوس مرئية وأوائل كل نوع، فترى المصروفات من أول نظرة؛
 * - بشريط فلاتر سريع بالنوع يفلتر بلا كتابة؛
 * - بسطر ثانٍ فيه وصف الحساب؛
 * - ببحثٍ متساهل (تطبيع الألف والهمزة والتاء المربوطة والتشكيل و«ال») يشمل الوصف
 *   و**مرادفات القالب** («بنزين» و«سولار» و«مرتبات» و«كهربا») من `accountSynonyms.ts`
 *   — نسخة مرآة لمرادفات الخادم يحرس تطابقها اختبارٌ يقرأ ملف القالب؛
 * - بعدّاد «يُعرض ن من م» وزرّ «عرض المزيد» يفتح نافذة البحث بالخادم (م‑4).
 * وبقي كما كان: التنقّل بالسهام وEnter وEsc، والحساب المؤرشف مشطوباً.
 *
 * والقائمة **مبوَّبة إلى `document.body`** (`createPortal`) بإحداثيات `position: fixed`
 * تحسبها `dropdownAnchor.ts`: كانت `absolute` داخل `div.table-wrapper.overflow-x-auto`،
 * وذلك الحاضن قاصٌّ على المحورين (المتصفّح يحوّل `overflow-y: visible` إلى `auto` متى كان
 * المحور الآخر غير `visible`)، فكانت القائمة (٣٦٦px) تُقصّ إلى ١٣٥px على جوال ٤٠٠px وإلى
 * ٢١٥px على ١٢٨٠px — فلا يُرى إلا رأس «الأصول» وحسابٌ واحد، وتسقط فائدة «المصروفات من
 * أول نظرة». ورفع `overflow` عن الحاضن لم يكن حلاً: يذهب معه التمرير الأفقي للشبكة.
 */
function AccountPicker({ value, accounts, allAccounts, lang, onChange }: {
  value: string;
  accounts: GlAccount[];
  allAccounts: Map<string, GlAccount>;
  lang: string;
  onChange: (id: string) => void;
}) {
  const tr = useTr();
  const dir = useDir();
  const groupLabels = accountGroupLabels(tr);
  const current = allAccounts.get(value);
  const display = current ? `${current.code} ${ledgerName(current, lang)}` : '';
  const [text, setText] = useState(display);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [group, setGroup] = useState<AccountGroupKey | null>(null);
  const [dialog, setDialog] = useState(false);
  const [pos, setPos] = useState<AnchorPosition | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { if (!open) setText(display); }, [display, open]);

  /**
   * القائمة مبوَّبة خارج الشبكة، فموضعها يُقاس من الحقل ويُعاد قياسه عند كل تمرير أو
   * تحجيم. التقاط (`capture`) حدث التمرير ضروريّ: `scroll` لا يصعد، وأقرب مُمرِّرٍ هنا
   * هو حاضن الشبكة نفسه. والقياس في `useLayoutEffect` كي يسبق الرسم فلا تومض القائمة.
   */
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const view = { width: window.innerWidth, height: window.innerHeight };
      if (!anchorVisible(rect, view)) { setPos(null); return; }
      const next = anchorDropdown(rect, view, { dir });
      setPos(prev => (samePosition(prev, next) ? prev : next));
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, dir]);

  const query = text.trim();
  const searching = !!query && query !== display;
  const counts = useMemo(() => countByGroup(accounts), [accounts]);

  /** نتائج البحث كاملةً (بلا سقف) — لأن العدّاد يخبر بالمحجوب لا بالمعروض وحده. */
  const found = useMemo(
    () => (searching ? filterAccounts(accounts, query, { lang, group, synonyms: ACCOUNT_SYNONYMS, limit: Number.MAX_SAFE_INTEGER }) : []),
    [searching, accounts, query, lang, group],
  );
  const buckets = useMemo(() => (searching ? [] : pickerBuckets(accounts, { group })), [searching, accounts, group]);
  const rows = useMemo(
    () => (searching ? flatRows(found.slice(0, MAX_INLINE_MATCHES)) : pickerRows(buckets)),
    [searching, found, buckets],
  );
  const items = useMemo(() => rows.flatMap(r => (r.kind === 'item' ? [r.account] : [])), [rows]);
  const total = searching ? found.length : group ? counts[group] : accounts.length;
  /** المميَّز محسوبٌ لا مخزَّن: قصر القائمة بعد الكتابة لا يترك التحديد خارجها */
  const active = items.length ? Math.min(hi, items.length - 1) : -1;

  // إبقاء الخيار المميَّز داخل مجال الرؤية عند التنقّل بالسهام
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[data-hi="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open, rows]);

  const choose = (a: GlAccount) => {
    onChange(a.id);
    setText(`${a.code} ${ledgerName(a, lang)}`);
    setOpen(false);
    setDialog(false);
  };

  return (
    <div
      ref={ref} className="relative"
      // القائمة خارج هذه الشجرة في DOM لكنها داخلها في شجرة React، فيصعد إليها فقدُ التركيز
      onBlur={e => {
        const to = e.relatedTarget as Node | null;
        if (!ref.current?.contains(to) && !panelRef.current?.contains(to)) setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        className={`input !py-1 text-sm ${current && !current.isActive ? 'line-through' : ''}`}
        placeholder={tr('ابحث بالرمز أو الاسم')}
        value={text}
        onFocus={e => { setOpen(true); e.currentTarget.select(); }}
        onChange={e => { setText(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(Math.min(active + 1, items.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(active - 1, 0)); }
          else if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); choose(items[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && pos && createPortal(
        <div
          ref={panelRef} dir={dir}
          className="fixed z-[55] flex flex-col overflow-hidden bg-white rounded-xl shadow-xl border border-[#E8E0D2]"
          style={{
            left: pos.left, width: pos.width, maxHeight: pos.maxHeight,
            ...(pos.placement === 'below' ? { top: pos.top ?? 0 } : { bottom: pos.bottom ?? 0 }),
          }}
        >
          <div className="flex gap-1 shrink-0 overflow-x-auto px-2 py-1.5 border-b border-[#F1EBDF]">
            <TypeChip active={group === null} onPick={() => { setGroup(null); setHi(0); }}>{tr('الكل')}</TypeChip>
            {ACCOUNT_GROUP_ORDER.filter(g => counts[g] > 0).map(g => (
              <TypeChip key={g} active={group === g} onPick={() => { setGroup(group === g ? null : g); setHi(0); }}>{groupLabels[g]}</TypeChip>
            ))}
          </div>
          {/* `min-h-0` كي تنكمش القائمة داخل السقف المحسوب فيبقى الشريطان مرئيين */}
          <ul ref={listRef} className="flex-1 min-h-0 max-h-72 overflow-auto py-1">
            {rows.length === 0 && <li className="px-3 py-2 text-sm text-[#9A8F7E]">{tr('لا نتائج')}</li>}
            {rows.map(r => (r.kind === 'head' ? (
              <li key={`h-${r.key}`} className="px-3 pt-2 pb-1 text-[11px] font-bold text-[#9A8F7E] bg-[#FBF7F0]">
                {groupLabels[r.key]} <span className="tabular-nums font-normal">({r.total})</span>
              </li>
            ) : (
              <li key={r.account.id} data-hi={r.index === active}>
                <button type="button" tabIndex={-1}
                  className={`w-full text-start px-3 py-1.5 text-sm ${r.index === active ? 'bg-[#FBEBE2]' : 'hover:bg-[#FBF7F0]'}`}
                  onMouseDown={e => { e.preventDefault(); choose(r.account); }}>
                  <span className={`flex gap-2 items-baseline ${r.account.isActive ? '' : 'line-through'}`}>
                    <bdi className="tabular-nums text-[#6E6557] w-16 shrink-0">{r.account.code}</bdi>
                    <span className="truncate min-w-0">{ledgerName(r.account, lang)}</span>
                    {r.account.controlKind && <span className="ms-auto text-[10px] text-amber-700 shrink-0">{tr('حساب رئيسي')}</span>}
                  </span>
                  {/* الوصف عربيّ في القالب ويمرّ بالقاموس ليُترجَم حين تُضاف ترجمته (عقد الدفعة أ) */}
                  {r.account.description && (
                    <span className="block ps-[4.5rem] text-[11px] text-[#9A8F7E] truncate">{tr(r.account.description)}</span>
                  )}
                </button>
              </li>
            )))}
          </ul>
          <div className="flex items-center gap-2 shrink-0 px-3 py-1.5 border-t border-[#F1EBDF]">
            <span className="text-[11px] text-[#6E6557] flex-1">
              {fillCount(tr('يُعرض {shown} من {total} حساباً'), { shown: items.length, total })}
            </span>
            <button type="button" tabIndex={-1} className="text-xs text-[#E15A30] hover:underline shrink-0"
              onMouseDown={e => { e.preventDefault(); setOpen(false); setDialog(true); }}>
              {tr('عرض المزيد')}
            </button>
          </div>
        </div>,
        document.body,
      )}
      {dialog && (
        <AccountPickerDialog initialSearch={searching ? query : ''} onPick={choose} onClose={() => setDialog(false)} />
      )}
    </div>
  );
}

/** رقاقة فلتر النوع فوق القائمة — تفلتر بلا كتابة ولا تُفقد تركيز حقل البحث. */
function TypeChip({ active, onPick, children }: { active: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" tabIndex={-1} aria-pressed={active}
      onMouseDown={e => { e.preventDefault(); onPick(); }}
      className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
        active ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#44403a] border-[#DED5C4] hover:bg-[#FAF7F0]'}`}
    >
      {children}
    </button>
  );
}

export default MoveLinesGrid;

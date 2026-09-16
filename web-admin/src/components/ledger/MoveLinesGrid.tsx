import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useLang } from '../../i18n/lang';
import { ledgerName, parseAmountToMilli, milliToDecimalString } from '../../lib/ledger/format';
import type { GlAccount, GlTax } from '../../api/ledgerConfig';
import { LedgerAmount } from './LedgerAmount';
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

/** منتقي الحساب بالإكمال التلقائي (COA‑08): يطابق بداية الرمز أو أي جزء من الاسم بلغة العرض أو العربية. */
function AccountPicker({ value, accounts, allAccounts, lang, onChange }: {
  value: string;
  accounts: GlAccount[];
  allAccounts: Map<string, GlAccount>;
  lang: string;
  onChange: (id: string) => void;
}) {
  const tr = useTr();
  const current = allAccounts.get(value);
  const display = current ? `${current.code} ${ledgerName(current, lang)}` : '';
  const [text, setText] = useState(display);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!open) setText(display); }, [display, open]);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q || q === display.toLowerCase()) return accounts.slice(0, 50);
    return accounts.filter(a =>
      a.code.startsWith(q) || ledgerName(a, lang).toLowerCase().includes(q) || a.name.includes(text.trim()) || (a.nameEn ?? '').toLowerCase().includes(q),
    ).slice(0, 50);
  }, [text, accounts, lang, display]);

  const choose = (a: GlAccount) => { onChange(a.id); setText(`${a.code} ${ledgerName(a, lang)}`); setOpen(false); };

  return (
    <div ref={ref} className="relative" onBlur={e => { if (!ref.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input
        className={`input !py-1 text-sm ${current && !current.isActive ? 'line-through' : ''}`}
        placeholder={tr('ابحث بالرمز أو الاسم')}
        value={text}
        onFocus={e => { setOpen(true); e.currentTarget.select(); }}
        onChange={e => { setText(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && open && matches[hi]) { e.preventDefault(); choose(matches[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && (
        <ul className="absolute z-30 mt-1 w-full min-w-[18rem] max-h-64 overflow-auto bg-white rounded-xl shadow-xl border border-[#E8E0D2] py-1">
          {matches.length === 0 && <li className="px-3 py-2 text-sm text-[#9A8F7E]">{tr('لا نتائج')}</li>}
          {matches.map((a, i) => (
            <li key={a.id}>
              <button type="button" tabIndex={-1}
                className={`w-full text-start px-3 py-1.5 text-sm flex gap-2 ${i === hi ? 'bg-[#FBEBE2]' : 'hover:bg-[#FBF7F0]'}`}
                onMouseDown={e => { e.preventDefault(); choose(a); }}>
                <bdi className="tabular-nums text-[#6E6557] w-16 shrink-0">{a.code}</bdi>
                <span className="truncate">{ledgerName(a, lang)}</span>
                {a.controlKind && <span className="ms-auto text-[10px] text-amber-700">{tr('حساب رئيسي')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default MoveLinesGrid;

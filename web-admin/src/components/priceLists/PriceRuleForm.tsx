import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { priceListApi, productApi } from '../../api/client';
import type { PriceListRule, PriceRuleInput, Product } from '../../types';
import { useTr } from '../../i18n/strings';
import { primaryUnitOf } from '../../lib/units';
import {
  emptyRuleDraft, fillText, ruleDraftOf, ruleFixedShown, ruleInputOf, type RuleDraft, type RuleFormKind, type RuleProductRef,
} from '../../lib/priceListEditor';
import type { PriceRuleScope } from '../../lib/priceRules';
import SearchableSelect from '../SearchableSelect';
import { priceListItemsQuery } from './PriceListItemsTab';

/**
 * نموذج قاعدة في «قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦): يطبق على صنف أو فئة أو كل الأصناف، سعرٌ ثابت أو خصم/زيادة بنسبة
 * (المستخدم يكتب النسبة موجبةً والزيادة تُخزَّن سالبة)، وحدٌّ أدنى للكمية بالوحدة الرئيسية، وفترة صلاحية «من/إلى» شاملة.
 * التحقّق priceRuleProblem نفسه الذي يحكم به الخادم (عبر ruleInputOf) ورسالته بـtr. والسعر الثابت لصنفٍ يُكتب بالوحدة الرئيسية
 * ويُرسل معه أساس الصنف ورئيسيّته كما عرضهما النموذج — تحويلٌ أو تبديل رئيسيةٍ بعد فتحه يُردّ 409 فيُعاد الصنف ويُراجَع السعر.
 * لا <form>: Enter في بحث منتقي الصنف لا يحفظ القاعدة.
 */
type Err = { response?: { data?: { message?: string; code?: string } } };
const serverMsg = (e: unknown): string | undefined => (e as Err)?.response?.data?.message;
const serverCode = (e: unknown): string | undefined => (e as Err)?.response?.data?.code;

/** الصنف كما يحتاجه النموذج من بطاقته (أساسه ورئيسيّته الحاليّان) */
const productRefOf = (p: Product): RuleProductRef => {
  const prim = primaryUnitOf(p);
  return {
    id: p.id, name: p.name, code: p.code, unit: p.unit,
    primaryUnit: prim?.id ? { id: prim.id, name: prim.name, factor: Number(prim.factor) } : null,
  };
};

export default function PriceRuleForm({ listId, rule, categories, onSaved, onCancel }: {
  listId: string;
  /** null = قاعدةٌ جديدة */
  rule: PriceListRule | null;
  categories: { id: string; name: string }[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  const initialDraft = rule ? ruleDraftOf(rule) : emptyRuleDraft(categories.length > 0 ? 'category' : 'product');
  const [draft, setDraft] = useState<RuleDraft>(initialDraft);
  // صنف القاعدة المحفوظة من صفّها (أساسه ورئيسيّته)، وصفٌّ بلا أساسه يُكمَل من بطاقة الصنف
  const [productRef, setProductRef] = useState<RuleProductRef | null>(() => (
    rule?.scope === 'product' && rule.productId && rule.unit
      ? { id: rule.productId, name: rule.productName ?? '', code: rule.productCode ?? null, unit: rule.unit, primaryUnit: rule.primaryUnit ?? null }
      : null
  ));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<RuleDraft>) => { setDraft(d => ({ ...d, ...patch })); setProblem(null); };

  /** أساس الصنف ورئيسيّته من بطاقته — وسعرٌ ثابتٌ لم يُلمس يُعاد عرضه بمعامل الرئيسية الحالي */
  const loadProduct = (productId: string, reshowFixed: boolean) => {
    productApi.get(productId).then((res) => {
      const ref = productRefOf(res.data.data as Product);
      setProductRef(cur => (cur && cur.id !== productId ? cur : ref));
      if (reshowFixed && rule && rule.kind === 'fixed' && rule.scope === 'product') {
        setDraft(d => (d.productId === productId && d.kind === 'fixed' && d.value === initialDraft.value
          ? { ...d, value: ruleFixedShown(rule, ref.primaryUnit?.factor ?? 1) } : d));
      }
    }).catch(() => { /* يبقى بلا أساس: الحفظ يطلب اختيار الصنف ثانيةً */ });
  };
  useEffect(() => {
    if (rule?.scope === 'product' && rule.productId && !rule.unit) loadProduct(rule.productId, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // منتقي الصنف: بحثٌ من الخادم في كل أصناف الشركة (طلب أصناف القائمة نفسه بنطاق «كل الأصناف»)
  const [pSearch, setPSearch] = useState('');
  const [pDebounced, setPDebounced] = useState('');
  useEffect(() => {
    const v = pSearch.trim();
    if (v === pDebounced) return;
    const t = setTimeout(() => setPDebounced(v), 300);
    return () => clearTimeout(t);
  }, [pSearch, pDebounced]);
  const pickQ = useQuery({
    ...priceListItemsQuery(listId, 'all', pDebounced, '', 1),
    enabled: draft.scope === 'product',
    placeholderData: keepPreviousData,
  });
  const pickRows = pickQ.data?.rows ?? [];
  const productOptions = [
    ...(productRef && !pickRows.some(r => r.productId === productRef.id)
      ? [{ value: productRef.id, label: productRef.name || productRef.code || productRef.id, hint: productRef.code ?? undefined }] : []),
    ...pickRows.map(r => ({ value: r.productId, label: r.name, hint: [r.code, r.primaryUnit?.name ?? r.unit].filter(Boolean).join(' · ') })),
  ];
  const pickProduct = (v: string) => {
    const r = pickRows.find(x => x.productId === v);
    if (r) setProductRef({ id: r.productId, name: r.name, code: r.code, unit: r.unit, primaryUnit: r.primaryUnit });
    set({ productId: v });
  };

  const save = useMutation({
    mutationFn: (input: PriceRuleInput) => (rule ? priceListApi.updateRule(rule.id, input) : priceListApi.createRule(listId, input)),
    onSuccess: () => { toast.success(tr('تم الحفظ')); onSaved(); },
    onError: (e) => {
      const m = serverMsg(e);
      setProblem(m ? tr(m) : tr('تعذر الحفظ'));
      const code = serverCode(e);
      // وحدات الصنف تغيّرت بعد فتح النموذج: يُعاد أساسه ورئيسيّته ويُراجع المستخدم السعر قبل الحفظ ثانيةً
      if ((code === 'BASE_UNIT_CHANGED' || code === 'PRIMARY_UNIT_CHANGED' || code === 'PRODUCT_UNITS_CHANGED') && draft.productId) {
        loadProduct(draft.productId, false);
      }
      // قاعدةٌ حذفها غيره: تُعاد القائمة
      if (code === 'PRICE_RULE_NOT_FOUND') onSaved();
    },
  });
  const submit = () => {
    if (save.isPending) return;
    const res = ruleInputOf(draft, productRef);
    if (res.input === null) { setProblem(tr(res.problem)); return; }
    setProblem(null);
    save.mutate(res.input);
  };

  const setScope = (scope: PriceRuleScope) => set({ scope, ...(scope === 'all' && draft.kind === 'fixed' ? { kind: 'discount' as const } : {}) });
  const seg = (on: boolean) => `py-2 px-2 rounded-xl border text-xs sm:text-sm font-semibold transition-colors disabled:opacity-40 ${on
    ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:border-[#D8CDB9]'}`;
  const unitName = productRef ? productRef.primaryUnit?.name ?? productRef.unit : null;
  const valueLabel = draft.kind === 'fixed' ? tr('السعر قبل الضريبة') : draft.kind === 'discount' ? tr('نسبة الخصم %') : tr('نسبة الزيادة %');
  const valueHint = draft.kind !== 'fixed'
    ? tr('نسبة من السعر الافتراضي للصنف تكتب موجبة')
    : draft.scope === 'product'
      ? (unitName ? fillText(tr('لكل {unit}'), { unit: unitName }) : tr('بالوحدة الرئيسية للصنف'))
      : tr('لكل وحدة رئيسية من كل صنف في الفئة');
  const qtyHint = draft.scope === 'product' && unitName
    ? fillText(tr('مجموع كمية الصنف في الفاتورة بوحدة {unit} والفارغ بلا حد'), { unit: unitName })
    : tr('مجموع كمية كل صنف في الفاتورة بوحدته الرئيسية والفارغ بلا حد');
  const kinds: Array<[RuleFormKind, string]> = [['fixed', tr('سعر ثابت')], ['discount', tr('خصم بنسبة')], ['markup', tr('زيادة بنسبة')]];

  return (
    <div className="rounded-2xl border-2 border-[#F4C7B5] bg-white p-4 space-y-4" data-price-rule-form="">
      <h3 className="font-bold text-[#1F1A13] text-sm">{rule ? tr('تعديل القاعدة') : tr('إضافة قاعدة')}</h3>

      <div>
        <label className="label">{tr('يطبق على')}</label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={tr('يطبق على')}>
          {([['product', tr('صنف')], ['category', tr('فئة')], ['all', tr('كل الأصناف')]] as Array<[PriceRuleScope, string]>).map(([s, label]) => (
            <button key={s} type="button" role="radio" aria-checked={draft.scope === s} className={seg(draft.scope === s)} onClick={() => setScope(s)}>{label}</button>
          ))}
        </div>
      </div>

      {draft.scope === 'product' && (
        <div>
          <label className="label">{tr('الصنف')}</label>
          <SearchableSelect options={productOptions} value={draft.productId} onChange={pickProduct} onSearchChange={setPSearch}
            loading={pickQ.isFetching && !pickQ.data} placeholder={tr('اختر الصنف')} searchPlaceholder={tr('بحث بالاسم أو الكود أو الباركود')} />
        </div>
      )}
      {draft.scope === 'category' && (
        <div>
          <label className="label">{tr('الفئة')}</label>
          <select className="input" value={draft.categoryId} onChange={e => set({ categoryId: e.target.value })}>
            <option value="">{tr('اختر الفئة')}</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {categories.length === 0 && <p className="text-[11px] text-amber-700 mt-1">{tr('لا توجد فئات بعد وتضاف من بطاقة الصنف')}</p>}
        </div>
      )}

      <div>
        <label className="label">{tr('نوع السعر')}</label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={tr('نوع السعر')}>
          {kinds.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={draft.kind === k} className={seg(draft.kind === k)}
              disabled={k === 'fixed' && draft.scope === 'all'} title={k === 'fixed' && draft.scope === 'all' ? tr('كل الأصناف تقبل نسبة خصم أو زيادة فقط لا سعرا ثابتا') : undefined}
              onClick={() => set({ kind: k })}>{label}</button>
          ))}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="label">{valueLabel}</label>
          <input type="text" inputMode="decimal" dir="ltr" autoComplete="off" className="input" value={draft.value}
            onChange={e => set({ value: e.target.value })} data-rule-value="" />
          <p className="text-[11px] text-gray-400 mt-1 leading-snug">{valueHint}</p>
        </div>
        <div>
          <label className="label">{tr('الحد الأدنى للكمية (بالوحدة الرئيسية)')}</label>
          <input type="text" inputMode="decimal" dir="ltr" autoComplete="off" className="input" placeholder="0" value={draft.minQty}
            onChange={e => set({ minQty: e.target.value })} />
          <p className="text-[11px] text-gray-400 mt-1 leading-snug">{qtyHint}</p>
        </div>
        <div>
          <label className="label">{tr('من تاريخ')}</label>
          <input type="date" className="input" dir="ltr" value={draft.startsOn} max={draft.endsOn || undefined}
            onChange={e => set({ startsOn: e.target.value })} />
        </div>
        <div>
          <label className="label">{tr('إلى تاريخ')}</label>
          <input type="date" className="input" dir="ltr" value={draft.endsOn} min={draft.startsOn || undefined}
            onChange={e => set({ endsOn: e.target.value })} />
        </div>
      </div>
      <p className="text-[11px] text-gray-400 -mt-2">{tr('التاريخان شاملان والفارغ يعني قاعدة دائمة')}</p>

      {problem && <p className="text-sm text-red-600 font-medium" role="alert">{problem}</p>}

      <div className="flex gap-2 justify-end flex-wrap">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={save.isPending}>{tr('إلغاء')}</button>
        <button type="button" className="btn-primary disabled:opacity-60" onClick={submit} disabled={save.isPending}>
          {save.isPending ? tr('جار الحفظ') : tr('حفظ')}
        </button>
      </div>
    </div>
  );
}

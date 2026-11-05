import { useEffect, useId, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { priceListApi, productApi } from '../../api/client';
import type { PriceListRule, PriceRuleInput, Product } from '../../types';
import { useTr } from '../../i18n/strings';
import { primaryUnitOf } from '../../lib/units';
import {
  emptyRuleDraft, fillText, isUnitsChangedCode, ruleDraftDirty, ruleDraftOf, ruleDraftPatch, ruleFixedShown, ruleInputOf,
  type RuleDraft, type RuleFormKind, type RuleProductRef,
} from '../../lib/priceListEditor';
import { listPriceInput } from '../../lib/priceLists';
import type { PriceRuleScope } from '../../lib/priceRules';
import SearchableSelect from '../SearchableSelect';
import { priceListItemsQuery } from './PriceListItemsTab';

/**
 * نموذج قاعدة في «قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦): يطبق على صنف أو فئة أو كل الأصناف، سعرٌ ثابت أو خصم/زيادة بنسبة
 * (المستخدم يكتب النسبة موجبةً والزيادة تُخزَّن سالبة)، وحدٌّ أدنى للكمية بالوحدة الرئيسية، وفترة صلاحية «من/إلى» شاملة.
 * التحقّق priceRuleProblem نفسه الذي يحكم به الخادم (عبر ruleInputOf) ورسالته بـtr. والسعر الثابت لصنفٍ يُكتب بالوحدة الرئيسية
 * ويُرسل معه أساس الصنف ورئيسيّته كما عرضهما النموذج — تحويلٌ أو تبديل رئيسيةٍ بعد فتحه يُردّ 409: الرقم المكتوب بالوحدة القديمة
 * يُمسح (لا يُحفظ بالجديدة بنقرة «حفظ» ثانية)، ويُعاد الصنف وقواعد القائمة، وسعرٌ محفوظٌ لم يُلمس يُعاد عرضه بالوحدة الجديدة.
 * وتبديل النوع أو النطاق يمسح الرقم حين يتغيّر معناه (ruleDraftPatch)، وما لم يُحفظ يُبلَّغ به الأب (onDirtyChange) فيُسأل عنه
 * قبل الرجوع أو تبديل التبويب أو الإغلاق. والتركيز على عنوان النموذج حين يُفتح، ولكل خانةٍ اسمٌ مقروء.
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

/** الصنف من صفّ القاعدة (GET /price-lists/:id/rules بأساسه ورئيسيّته)، وصفٌّ بلا أساسه ⇒ null (يُكمَل من بطاقة الصنف) */
const productRefOfRule = (r: PriceListRule | null | undefined): RuleProductRef | null => (
  r?.scope === 'product' && r.productId && r.unit
    ? { id: r.productId, name: r.productName ?? '', code: r.productCode ?? null, unit: r.unit, primaryUnit: r.primaryUnit ?? null }
    : null
);

export default function PriceRuleForm({ listId, rule, categories, onSaved, onCancel, onStale, onDirtyChange }: {
  listId: string;
  /** null = قاعدةٌ جديدة */
  rule: PriceListRule | null;
  categories: { id: string; name: string }[];
  onSaved: () => void;
  onCancel: () => void;
  /** ٤٠٩ «تغيّرت وحدات الصنف»: يعيد قواعد القائمة من الخادم ويردّها (لإعادة عرض سعرٍ محفوظٍ لم يُلمس بالوحدة الجديدة) */
  onStale?: () => Promise<PriceListRule[]>;
  /** في النموذج ما لم يُحفظ (true) أو لا — وعند الفكّ false */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tr = useTr();
  const uid = useId();
  const ids = { head: `${uid}-head`, product: `${uid}-product`, category: `${uid}-category`, value: `${uid}-value`, valueHint: `${uid}-value-hint`,
    minQty: `${uid}-min`, minQtyHint: `${uid}-min-hint`, from: `${uid}-from`, to: `${uid}-to` };
  const initialRef = useRef<RuleDraft>(rule ? ruleDraftOf(rule) : emptyRuleDraft(categories.length > 0 ? 'category' : 'product'));
  const [draft, setDraft] = useState<RuleDraft>(initialRef.current);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // صنف القاعدة المحفوظة من صفّها (أساسه ورئيسيّته)، وصفٌّ بلا أساسه يُكمَل من بطاقة الصنف
  const [productRef, setProductRef] = useState<RuleProductRef | null>(() => productRefOfRule(rule));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<RuleDraft>) => { setDraft(d => ruleDraftPatch(d, patch)); setProblem(null); };

  // ما لم يُحفظ ⇒ الأب يسأل قبل الرجوع وتبديل التبويب والإغلاق؛ والفكّ (حفظٌ أو إلغاءٌ أو تركٌ مؤكَّد) ينهيه
  const dirty = ruleDraftDirty(draft, initialRef.current, !rule);
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);
  useEffect(() => () => dirtyCb.current?.(false), []);
  // التركيز على عنوان النموذج حين يُفتح (من «إضافة قاعدة» أو «تعديل» الذي يغيب بفتحه)
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headRef.current?.focus(); }, []);

  /** أساس الصنف ورئيسيّته من بطاقته — وسعرٌ ثابتٌ لم يُلمس يُعاد عرضه بمعامل الرئيسية الحالي */
  const loadProduct = (productId: string, reshowFixed: boolean) => {
    productApi.get(productId).then((res) => {
      const ref = productRefOf(res.data.data as Product);
      setProductRef(cur => (cur && cur.id !== productId ? cur : ref));
      const d = draftRef.current;
      if (reshowFixed && rule && rule.kind === 'fixed' && rule.scope === 'product'
        && d.productId === productId && d.kind === 'fixed' && d.value === initialRef.current.value) {
        const shown = ruleFixedShown(rule, ref.primaryUnit?.factor ?? 1);
        initialRef.current = { ...initialRef.current, value: shown };
        setDraft(x => (x.productId === productId && x.kind === 'fixed' ? { ...x, value: shown } : x));
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
    // سعرٌ ثابت كُتب لصنفٍ آخر بوحدته الرئيسية لا يبقى لصنفٍ غيره
    set({ productId: v, ...(draft.kind === 'fixed' && v !== draft.productId && { value: '' }) });
  };

  /**
   * ٤٠٩ «تغيّرت وحدات الصنف» (قرار D6): السعر الثابت المكتوب كان بالوحدة الرئيسية القديمة ⇒ يُمسح، ويُعاد الصنف (أساسه ورئيسيّته)
   * وقواعد القائمة — وسعر قاعدةٍ محفوظةٍ لم يُلمس يُعاد عرضه من الردّ الطازج بالوحدة الجديدة (السعر نفسه لكل وحدة أساس)
   */
  const unitsChanged = (productId: string) => {
    const d = draftRef.current;
    const fixedOfProduct = d.scope === 'product' && d.kind === 'fixed';
    const untouched = !!rule && d.value === initialRef.current.value;
    if (fixedOfProduct) setDraft(x => (x.productId === productId && x.kind === 'fixed' ? { ...x, value: '' } : x));
    loadProduct(productId, false);
    if (!onStale) return;
    void onStale().then((fresh) => {
      const fr = rule ? fresh.find(x => x.id === rule.id) : undefined;
      if (!fixedOfProduct || !untouched || !fr || fr.scope !== 'product' || fr.kind !== 'fixed' || fr.productId !== productId) return;
      const ref = productRefOfRule(fr);
      if (!ref) return;
      const shown = ruleFixedShown(fr, ref.primaryUnit?.factor ?? 1);
      setProductRef(ref);
      initialRef.current = { ...initialRef.current, value: shown };
      setDraft(x => (x.productId === productId && x.scope === 'product' && x.kind === 'fixed' && x.value === '' ? { ...x, value: shown } : x));
    }).catch(() => { /* تبقى الخانة فارغة برسالتها */ });
  };

  const save = useMutation({
    mutationFn: (input: PriceRuleInput) => (rule ? priceListApi.updateRule(rule.id, input) : priceListApi.createRule(listId, input)),
    onSuccess: () => { toast.success(tr('تم الحفظ')); onSaved(); },
    onError: (e) => {
      const m = serverMsg(e);
      setProblem(m ? tr(m) : tr('تعذر الحفظ'));
      const code = serverCode(e);
      if (isUnitsChangedCode(code) && draftRef.current.productId) unitsChanged(draftRef.current.productId);
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

  const setScope = (scope: PriceRuleScope) => set({ scope });
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
  // سعر الفئة والحدّ الأدنى بالوحدة الرئيسية لكل صنف: تغييرها لاحقاً يغيّر معناهما (والخادم يطلب إقراراً حينها — قرار D2)
  const minQ = listPriceInput(draft.minQty);
  const primaryDependent = (draft.scope === 'category' && draft.kind === 'fixed') || (minQ != null && !Number.isNaN(minQ) && minQ > 0);
  const kinds: Array<[RuleFormKind, string]> = [['fixed', tr('سعر ثابت')], ['discount', tr('خصم بنسبة')], ['markup', tr('زيادة بنسبة')]];

  return (
    <div className="rounded-2xl border-2 border-[#F4C7B5] bg-white p-4 space-y-4" data-price-rule-form="" role="group" aria-labelledby={ids.head}>
      <h3 id={ids.head} ref={headRef} tabIndex={-1} className="font-bold text-[#1F1A13] text-sm outline-none">{rule ? tr('تعديل القاعدة') : tr('إضافة قاعدة')}</h3>

      <div>
        <p className="label" id={`${uid}-scope`}>{tr('يطبق على')}</p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby={`${uid}-scope`}>
          {([['product', tr('صنف')], ['category', tr('فئة')], ['all', tr('كل الأصناف')]] as Array<[PriceRuleScope, string]>).map(([s, label]) => (
            <button key={s} type="button" role="radio" aria-checked={draft.scope === s} className={seg(draft.scope === s)} onClick={() => setScope(s)}>{label}</button>
          ))}
        </div>
      </div>

      {draft.scope === 'product' && (
        <div role="group" aria-labelledby={ids.product}>
          <p className="label" id={ids.product}>{tr('الصنف')}</p>
          <SearchableSelect options={productOptions} value={draft.productId} onChange={pickProduct} onSearchChange={setPSearch}
            loading={pickQ.isFetching && !pickQ.data} placeholder={tr('اختر الصنف')} searchPlaceholder={tr('بحث بالاسم أو الكود أو الباركود')} />
        </div>
      )}
      {draft.scope === 'category' && (
        <div>
          <label className="label" htmlFor={ids.category}>{tr('الفئة')}</label>
          <select id={ids.category} className="input" value={draft.categoryId} onChange={e => set({ categoryId: e.target.value })}>
            <option value="">{tr('اختر الفئة')}</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {categories.length === 0 && <p className="text-[11px] text-amber-700 mt-1">{tr('لا توجد فئات بعد وتضاف من بطاقة الصنف')}</p>}
        </div>
      )}

      <div>
        <p className="label" id={`${uid}-kind`}>{tr('نوع السعر')}</p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby={`${uid}-kind`}>
          {kinds.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={draft.kind === k} className={seg(draft.kind === k)}
              disabled={k === 'fixed' && draft.scope === 'all'} title={k === 'fixed' && draft.scope === 'all' ? tr('كل الأصناف تقبل نسبة خصم أو زيادة فقط لا سعرا ثابتا') : undefined}
              onClick={() => set({ kind: k })}>{label}</button>
          ))}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={ids.value}>{valueLabel}</label>
          <input id={ids.value} type="text" inputMode="decimal" dir="ltr" autoComplete="off" className="input" value={draft.value}
            aria-describedby={ids.valueHint} onChange={e => set({ value: e.target.value })} data-rule-value="" />
          <p id={ids.valueHint} className="text-[11px] text-gray-400 mt-1 leading-snug">{valueHint}</p>
        </div>
        <div>
          <label className="label" htmlFor={ids.minQty}>{tr('الحد الأدنى للكمية (بالوحدة الرئيسية)')}</label>
          <input id={ids.minQty} type="text" inputMode="decimal" dir="ltr" autoComplete="off" className="input" placeholder="0" value={draft.minQty}
            aria-describedby={ids.minQtyHint} onChange={e => set({ minQty: e.target.value })} />
          <p id={ids.minQtyHint} className="text-[11px] text-gray-400 mt-1 leading-snug">{qtyHint}</p>
        </div>
        <div>
          <label className="label" htmlFor={ids.from}>{tr('من تاريخ')}</label>
          <input id={ids.from} type="date" className="input" dir="ltr" value={draft.startsOn} max={draft.endsOn || undefined}
            onChange={e => set({ startsOn: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor={ids.to}>{tr('إلى تاريخ')}</label>
          <input id={ids.to} type="date" className="input" dir="ltr" value={draft.endsOn} min={draft.startsOn || undefined}
            onChange={e => set({ endsOn: e.target.value })} />
        </div>
      </div>
      <p className="text-[11px] text-gray-400 -mt-2">{tr('التاريخان شاملان والفارغ يعني قاعدة دائمة')}</p>
      {primaryDependent && (
        <p className="text-[11px] text-amber-700 -mt-2 leading-snug" data-rule-primary-note="">
          {tr('سعر الفئة والحد الأدنى للكمية بالوحدة الرئيسية لكل صنف، وتغيير الوحدة الرئيسية لصنف بعد ذلك يغير معناهما ويطلب تأكيدا')}
        </p>
      )}

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

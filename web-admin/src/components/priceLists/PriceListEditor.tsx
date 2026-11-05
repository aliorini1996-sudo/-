import { useRef, useState } from 'react';
import { ArrowRight, Package, SlidersHorizontal } from 'lucide-react';
import type { PriceList } from '../../types';
import { useTr } from '../../i18n/strings';
import { formatNumber } from '../../utils/format';
import { RULE_FORM_DISCARD_ASK } from '../../lib/priceListEditor';
import PriceListItemsTab from './PriceListItemsTab';
import PriceListRulesTab from './PriceListRulesTab';

/**
 * «الأسعار والقواعد» لقائمةٍ واحدة داخل نافذة «قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦، على نسق قوائم أسعار Odoo):
 *   • «أسعار الأصناف»: سعرٌ ثابت لكل صنف (PriceListItem) يُحرَّر في مكانه ويُحفظ سطراً سطراً.
 *   • «القواعد»: صنف/فئة/كل الأصناف — سعر ثابت أو خصم/زيادة بنسبة، بحدٍّ أدنى للكمية وفترة صلاحية.
 * «رجوع» يعيد قائمة القوائم؛ وتبديل التبويب أو الرجوع أو إغلاق النافذة يحفظ ما بقي مكتوباً في الجدول (PriceListItemsTab).
 * أمّا نموذج القاعدة فلا يُحفظ بلا «حفظ» (قاعدةٌ نصف مكتوبة ليست قاعدة): ما لم يُحفظ فيه يُسأل عنه قبل الرجوع وتبديل التبويب،
 * ويُبلَّغ به الأب (onDirtyChange) فتسأل النافذة قبل الإغلاق (قرار D6).
 */
export default function PriceListEditor({ list, onBack, onDirtyChange }: {
  list: PriceList;
  onBack: () => void;
  /** نموذج قاعدةٍ فيه ما لم يُحفظ (true) أو لا */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tr = useTr();
  const [tab, setTab] = useState<'items' | 'rules'>('items');
  const ruleDirty = useRef(false);
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  const rulesDirtyChange = (d: boolean) => { ruleDirty.current = d; dirtyCb.current?.(d); };
  /** ترك نموذج القاعدة: بلا ما يُحفظ يُترك، وإلا بسؤال */
  const leaveOk = () => !ruleDirty.current || window.confirm(tr(RULE_FORM_DISCARD_ASK));
  const goTab = (t: 'items' | 'rules') => { if (t !== tab && (tab !== 'rules' || leaveOk())) setTab(t); };
  const back = () => { if (leaveOk()) onBack(); };
  const tabBtn = (on: boolean) => `inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 -mb-px border-b-2 text-sm font-semibold transition-colors ${on
    ? 'border-[#E15A30] text-[#C94E28]' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'}`;
  const count = (n: number | undefined) => (n == null ? null : (
    <span className="rounded-full bg-[#F3EEE6] px-1.5 text-[10px] font-bold text-[#6E6557]">{formatNumber(n)}</span>
  ));
  return (
    <div className="space-y-4" data-price-list-editor="">
      <div className="flex items-center gap-2 min-w-0">
        <button type="button" onClick={back} className="btn-secondary !py-1.5 !px-3 text-xs shrink-0">
          <ArrowRight size={14} /> {tr('رجوع')}
        </button>
        <h2 className="font-bold text-[#1F1A13] truncate min-w-0">{list.name}</h2>
      </div>
      <div role="tablist" aria-label={list.name} className="flex gap-1 border-b border-[#E9E1D3] overflow-x-auto">
        <button type="button" role="tab" aria-selected={tab === 'items'} className={tabBtn(tab === 'items')} onClick={() => goTab('items')}>
          <Package size={15} /> {tr('أسعار الأصناف')} {count(list.itemsCount)}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'rules'} className={tabBtn(tab === 'rules')} onClick={() => goTab('rules')}>
          <SlidersHorizontal size={15} /> {tr('القواعد')} {count(list.rulesCount)}
        </button>
      </div>
      {tab === 'items'
        ? <PriceListItemsTab listId={list.id} itemsCount={list.itemsCount} />
        : <PriceListRulesTab listId={list.id} onDirtyChange={rulesDirtyChange} />}
    </div>
  );
}

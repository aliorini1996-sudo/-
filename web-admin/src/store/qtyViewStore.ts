import { create } from 'zustand';
import { QTY_VIEW_KEY, isQtyView, loadQtyView, saveQtyView, type QtyView } from '../lib/qtyView';

/**
 * «عرض الكميات» — تفضيلٌ واحد لكل مشاهد يتشاركه «مخزون الشركة» و«مخزون السيارات»: تبديله في إحداهما يسري في الأخرى
 * فوراً، ويبقى في التخزين المحلي (fs_qty_view). عرضٌ فقط، والافتراضي «الكبرى» (عرض اليوم).
 */
interface QtyViewState {
  view: QtyView;
  setView: (v: QtyView) => void;
}

export const useQtyViewStore = create<QtyViewState>(set => ({
  view: loadQtyView(),
  setView: v => {
    if (!isQtyView(v)) return;
    saveQtyView(v);
    set({ view: v });
  },
}));

/** العرض المحفوظ — والصفحة تمرّره من qtyViewFor (مبدّلٌ مخفيّ ⇒ «الكبرى») */
export function useQtyView(): QtyView {
  return useQtyViewStore(s => s.view);
}

// تبويبٌ آخر بدّل العرض (أو مُسح التخزين) — يتبعه هذا التبويب
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', e => {
      if (e.key === QTY_VIEW_KEY || e.key === null) useQtyViewStore.setState({ view: loadQtyView() });
    });
  } catch {
    /* بيئةٌ بلا أحداث تخزين: التبديل في هذا التبويب وحده */
  }
}

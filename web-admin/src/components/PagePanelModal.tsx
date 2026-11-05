import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';

/**
 * نافذة لوحةٍ داخل صفحتها — «قوائم الأسعار» في المنتجات و«فرق العمل» في المناديب (كانتا تبويبين في إعدادات الشركة، نقلهما
 * المالك ٢ نوفمبر ٢٠٢٦). اللوحة نفسها كما كانت: تحفظ كلُّ عمليةٍ بنفسها، فالإغلاق لا يضيّع شيئاً — وما لا يُحفظ بنفسه (نموذج
 * قاعدةٍ في «قوائم الأسعار») تسأل عنه `confirmClose` قبل الإغلاق بزرّ ✕ أو بالنقر خارج النافذة: false ⇒ تبقى مفتوحة.
 */
export default function PagePanelModal({ title, icon, onClose, confirmClose, children }: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  /** قبل الإغلاق: true يُغلق، false يُبقي النافذة (ما لم يُحفظ) — وبلاها يُغلق كما كان */
  confirmClose?: () => boolean;
  children: ReactNode;
}) {
  const tr = useTr();
  const close = () => { if (!confirmClose || confirmClose()) onClose(); };
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(close)}>
      <div className="bg-[#FBF8F3] rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col" role="dialog" aria-modal="true" aria-label={title}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[#E9E1D3] flex items-center gap-3 bg-white rounded-t-2xl">
          <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] flex items-center justify-center text-[#E15A30]">{icon}</span>
          <h2 className="flex-1 font-bold text-[#1F1A13]">{title}</h2>
          <button type="button" onClick={close} aria-label={tr('إغلاق')} className="p-2 rounded-lg text-[#6E6557] hover:bg-[#F3EEE6]"><X size={18} /></button>
        </div>
        <div className="p-4 sm:p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

import { AlertTriangle } from 'lucide-react';
import { useTr } from '../i18n/strings';

interface Props {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

// نافذة تأكيد عامة (بديل احترافي لـ confirm/alert) — بهوية FieldSales
export default function ConfirmDialog({
  title, message, confirmLabel, cancelLabel,
  danger = false, loading = false, onConfirm, onClose,
}: Props) {
  const tr = useTr();
  const t = title ?? tr('تأكيد');
  const cl = confirmLabel ?? tr('تأكيد');
  const cancel = cancelLabel ?? tr('إلغاء');
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3 ${danger ? 'bg-[#FBE3DF]' : 'bg-[#FBEBE2]'}`}>
            <AlertTriangle size={28} className={danger ? 'text-[#C0392B]' : 'text-[#E15A30]'} />
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13]">{t}</h2>
          <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">{message}</p>
        </div>
        <div className="flex gap-3 p-5 pt-0">
          <button onClick={onConfirm} disabled={loading}
            className={`flex-1 justify-center py-2.5 rounded-xl text-white font-semibold flex items-center gap-2 transition-colors ${danger ? 'bg-[#C0392B] hover:bg-[#a8311f]' : 'bg-[#E15A30] hover:bg-[#C94E28]'} disabled:opacity-60`}>
            {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {cl}
          </button>
          <button onClick={onClose} className="btn-secondary">{cancel}</button>
        </div>
      </div>
    </div>
  );
}

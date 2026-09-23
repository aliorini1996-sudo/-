import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { zatcaActionConfirm, type ZatcaActionKind } from '../../lib/zatca/docQueue';

/**
 * فوترة ZATCA المرحلة الثانية — حوار تأكيد إجراءات المستند الضريبي (إعادة إرسال، سحب، إعادة إصدار).
 *
 * **لماذا مكوّن مشترك:** الإجراء نفسه يُنفَّذ من شاشتين (شاشة المتابعة الكسولة وجدول الفواتير في اللوحة)، والسحب
 * يُبطل الفاتورة نهائياً ويعكس قيدها ولا رجعة فيه. فحارسان مختلفان للفعل الواحد يعني أنّ أضعفهما هو الذي يُبطل
 * فاتورة عميلٍ بالخطأ — ومصدر الحكم واحدٌ هنا: `zatcaActionConfirm`.
 *
 * و`tr` يأتي بالحقن لا بالاستيراد: الشاشة الكسولة تمرّر قاموس تبويبها، والجدول يمرّر القاموس العامّ — فلا يُسحب
 * قاموس التبويب الثقيل إلى حزمة اللوحة. ونصوص هذا الحوار في القاموس العامّ ليقرأها الطرفان (useZatcaTr يرجع إليه).
 */
export default function ZatcaActionDialog({ kind, subject, busy, tr, onConfirm, onClose }: {
  kind: ZatcaActionKind;
  /** ما يُنفَّذ عليه الإجراء — رقم الفاتورة، ليرى المستخدم أيَّ مستندٍ يُبطل. */
  subject: string;
  busy: boolean;
  tr: (s: string) => string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const c = zatcaActionConfirm(kind);
  const [typed, setTyped] = useState('');
  /* الكلمة المطلوبة بلغة الواجهة: مستخدمُ لوحةٍ إنجليزية أو صينية لا يملك لوحة مفاتيح عربية، وكان عليه نسخ
   * «سحب» من لافتة الإدخال وحدها. وتُقبل العربية أيضاً فلا ينكسر ما اعتاده المستخدم العربيّ. */
  const word = c.typed === null ? null : tr(c.typed);
  const ready = word === null || typed.trim() === word || typed.trim() === c.typed;
  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-3 ${c.danger ? 'bg-[#FBE3DF] text-[#C0392B]' : 'bg-[#FBEBE2] text-[#E15A30]'}`}>
          <AlertTriangle size={24} />
        </div>
        <h3 className="font-bold text-[#1F1A13]">{tr(c.title)}</h3>
        <p className="text-xs text-[#6E6557] mt-1 leading-relaxed">{tr(c.body)}</p>
        <p className="text-xs text-[#44403a] mt-2 font-mono" dir="ltr">{subject}</p>
        {word !== null && (
          <>
            {/* الكلمة مكتوبةٌ في متن الحوار لا في اللافتة وحدها — النصّ المترجَم لا يسمّيها */}
            <p className="text-xs text-[#6E6557] mt-3">
              {tr('اكتب هذه الكلمة للتأكيد')}: <b className="text-[#C0392B]">{word}</b>
            </p>
            <input
              autoFocus value={typed} onChange={e => setTyped(e.target.value)} aria-label={word}
              className="w-full mt-1.5 border border-[#E9E1D3] rounded-xl px-3 py-2 text-sm"
              placeholder={word}
            />
          </>
        )}
        <div className="flex gap-2 mt-4">
          <button type="button" disabled={!ready || busy} onClick={onConfirm}
            className={`flex-1 justify-center py-2.5 rounded-xl text-white font-semibold flex items-center gap-2 disabled:opacity-50 ${c.danger ? 'bg-[#C0392B]' : 'bg-[#E15A30]'}`}>
            {busy && <Loader2 size={15} className="animate-spin" />} {tr('تأكيد')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { isPhase2Company, returnLinkDefault, returnLinkRequired } from '../lib/returnPolicy';

/**
 * «اشتراط اختيار فاتورة البيع للمرتجع» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — لمدير الشركة غير المقيَّد وحده (الصفحة تُظهرها بـ
 * role === 'ADMIN' && !scopeEnabled، والخادم يحكم بالدور من القاعدة). تُحفظ فور التبديل بمسارها المستقل
 * (companyApi.returnPolicy → PUT /api/company/return-policy) لا مع زرّ «حفظ الإعدادات»، ثم يُبطَل ['company']: جهاز المندوب
 * ونموذج المرتجع يقرآن العمود من ردّ /company.
 *
 * ثلاث حالات في العمود: null = افتراضيّ المرحلة (الأولى حرّ والثانية مرتبط — سلوك اليوم)، true = كل مرتجع بفاتورة بيع، false =
 * لا اشتراط: في المرحلة الثانية إشعارٌ دائن «برقم فاتورةٍ من نظامٍ سابق» تكتبه الشركة ولا تتحقّق منه المنصّة — فإطفاؤه فيها
 * يمرّ بتأكيدٍ يقول من المسؤول. والخادم يحفظ ما يساوي الافتراضي null، فـ«استعادة الافتراضي» لا تظهر إلا لقيمةٍ مخصّصة.
 *
 * البطاقة داخل نموذج الإعدادات العامة (<form>): زرّها type="button"، والمفتاح خانة اختيار لا تُرسل النموذج.
 */
export type ReturnPolicyCompany = Parameters<typeof returnLinkRequired>[0];

/** نصّ التأكيد قبل الإطفاء في المرحلة الثانية — المسؤولية أمام الهيئة على الشركة */
const CONFIRM_OFF_PHASE2 = 'إطفاء الاشتراط يسمح بإشعار دائن برقم فاتورة من نظام سابق لا تتحقق منه المنصة — والشركة مسؤولة أمام الهيئة عن صحته وعن سبب الإرجاع. متابعة؟';

export default function ReturnPolicyCard({ company }: { company: ReturnPolicyCompany }) {
  const tr = useTr();
  const qc = useQueryClient();
  const phase2 = isPhase2Company(company);
  const phaseDefault = returnLinkDefault(company);
  const stored = company?.returnRequiresSaleInvoice;
  const custom = stored === true || stored === false;
  const save = useMutation({
    mutationFn: (requireSaleInvoice: boolean | null) => companyApi.returnPolicy.put(requireSaleInvoice),
    // الانتظار حتى يصل ردّ /company الجديد: المفتاح يبقى على ما أُرسل ولا يرتدّ لحظةً إلى القديم
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['company'] });
      toast.success(tr('تم حفظ إعداد المرتجع'));
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
      toast.error(typeof msg === 'string' && msg ? tr(msg) : tr('حدث خطأ في الحفظ'));
    },
  });
  // أثناء الحفظ: ما أُرسل (null = الافتراضي)، وإلا القاعدة الفعّالة من ردّ /company
  const effective = save.isPending && save.variables !== undefined
    ? (save.variables ?? phaseDefault)
    : returnLinkRequired(company);

  const toggle = (next: boolean) => {
    if (!next && phase2 && !window.confirm(tr(CONFIRM_OFF_PHASE2))) return;
    save.mutate(next);
  };

  return (
    <div className="card" data-return-policy="">
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-gray-100">
        <div className="w-11 h-11 bg-[#FBEBE2] rounded-xl flex items-center justify-center">
          <Undo2 size={22} className="text-[#E15A30]" />
        </div>
        <div>
          <p className="font-semibold text-gray-800">{tr('المرتجعات')}</p>
          <p className="text-xs text-gray-400">{tr('ربط المرتجع بفاتورة البيع')}</p>
        </div>
      </div>
      <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2.5">
        <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={effective} disabled={save.isPending}
          onChange={e => toggle(e.target.checked)} />
        {tr('اشتراط اختيار فاتورة البيع للمرتجع')}
      </label>
      <div className="flex items-center justify-between gap-2 flex-wrap mt-1.5">
        <p className="text-[11px] text-[#6E6557]">
          {tr('الافتراضي لشركتك')}: <b>{phaseDefault ? tr('مشترط في المرحلة الثانية') : tr('غير مشترط في المرحلة الأولى')}</b>
        </p>
        {custom && (
          <button type="button" className="text-[11px] font-semibold text-[#C94E28] hover:underline disabled:opacity-50" disabled={save.isPending}
            onClick={() => save.mutate(null)}>
            {tr('استعادة الافتراضي')}
          </button>
        )}
      </div>
      <p className="text-[11px] text-[#6E6557] mt-1.5 leading-relaxed">
        {effective
          ? tr('كل مرتجع تختار له فاتورة البيع من النظام')
          : phase2 ? tr('مرتجع برقم فاتورة من نظام سابق مسموح') : tr('مرتجع بلا فاتورة بيع مسموح')}
      </p>
      {/* المرحلة الأولى بالاشتراط: قائمة فواتير البيع تحتاج اتصالاً — فلا مرتجع دون اتصال */}
      {effective && !phase2 && (
        <p className="text-[11px] text-[#6E6557] mt-1 leading-relaxed">{tr('لا مرتجع دون اتصال — اختيار فاتورة البيع يحتاج اتصالا')}</p>
      )}
      {/* المرحلة الثانية بلا اشتراط: الرقم اليدويّ لا تتحقّق منه المنصّة — المسؤولية على الشركة، مكتوبةً حيث يُقرَّر */}
      {!effective && phase2 && (
        <div role="note" className="mt-2 flex items-start gap-2 border rounded-xl px-3 py-2 text-[11px] leading-relaxed bg-[#FEF3C7] border-[#FDE68A] text-[#92400E]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {tr('الشركة مسؤولة أمام الهيئة عن صحة رقم الفاتورة الأصلية وسبب الإرجاع — المنصة لا تتحقق من فاتورة خارجها')}
        </div>
      )}
      <p className="text-[10px] text-gray-400 mt-1.5">{tr('يحفظ فور التبديل ويصل أجهزة المناديب خلال دقائق')}</p>
    </div>
  );
}

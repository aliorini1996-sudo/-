// ============================================================================
// شاشات الحالة (بانتظار المراجعة / مرفوض / موقوف) وبوابة قبول الشروط الجديدة.
// شاشة الحالة بطاقةٌ وزرّ خروج فقط — لا بيانات برنامج قبل الاعتماد.
// ============================================================================
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Clock, XCircle, PauseCircle, MailWarning, FileText, LogOut } from 'lucide-react';
import { affiliateApi, errMessage, httpStatus, qk, shouldRetry } from '../api';
import type { AffiliateMe, MeResponse } from '../types';
import { AuthShell, CheckRow, ErrorBox, Loading, Spinner } from '../ui';

function LogoutButton({ onLogout }: { onLogout: () => void }) {
  return (
    <button type="button" className="btn-secondary w-full justify-center py-2.5 mt-5" onClick={onLogout}>
      <LogOut size={16} /> تسجيل الخروج
    </button>
  );
}

export function StatusScreen({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const { user } = me;
  const reason = user.statusReason?.trim();

  let icon = <Clock size={42} className="text-[#E0A02C]" />;
  let title = 'طلبك قيد المراجعة';
  let body = 'شكراً لانضمامك. يراجع فريق فيلد سيلز كل طلب يدوياً، وسيصلك بريد بالقرار. لا حاجة لأي إجراء منك الآن.';

  if (user.status === 'rejected') {
    icon = <XCircle size={42} className="text-[#C0392B]" />;
    title = 'لم يُقبل طلب الانضمام';
    body = 'نعتذر، لم نتمكن من قبول طلبك في البرنامج حالياً.';
  } else if (user.status === 'suspended') {
    icon = <PauseCircle size={42} className="text-[#C0392B]" />;
    title = 'حسابك موقوف';
    body = 'أُوقف حسابك في برنامج السفراء. للاستفسار راسل فريق فيلد سيلز من بريدك المسجّل.';
  } else if (user.status === 'pending_email') {
    icon = <MailWarning size={42} className="text-[#E0A02C]" />;
    title = 'أكّد بريدك أولاً';
    body = 'افتح رابط التأكيد المرسل إلى بريدك ثم عد لتسجيل الدخول.';
  }

  return (
    <AuthShell title={title}>
      <div className="flex flex-col items-center text-center gap-3">
        {icon}
        <p className="text-[15px] text-[#1F1A13] leading-relaxed">{body}</p>
        {reason && (user.status === 'rejected' || user.status === 'suspended') && (
          <div className="w-full rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3 text-right">
            <p className="text-[12px] font-bold text-[#6E6557] mb-1">السبب</p>
            <p className="text-sm text-[#1F1A13] leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>{reason}</p>
          </div>
        )}
        <p className="text-[12px] text-[#8A8072]" dir="ltr">{user.email}</p>
      </div>
      <LogoutButton onLogout={onLogout} />
    </AuthShell>
  );
}

/**
 * نُشر إصدار جديد من الشروط — لا وصول للبوابة قبل قبوله.
 * يُرسَل الإصدار **المعروض** (ما قرأه السفير فعلاً)، و409 يعني صدور إصدارٍ أحدث
 * بعد تحميل الصفحة فيُعاد التحميل.
 */
export function TermsGate({ me, onAccepted, onLogout }: { me: MeResponse; onAccepted: (u: AffiliateMe) => void; onLogout: () => void }) {
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry });
  const [agree, setAgree] = useState(false);
  const accept = useMutation({
    mutationFn: (version: string) => affiliateApi.acceptTerms(version),
    onSuccess: (r) => { toast.success('شكراً — تم تسجيل موافقتك'); onAccepted(r.user); },
    onError: (err) => {
      if (httpStatus(err) === 409) {
        setAgree(false);
        void terms.refetch();
        toast.error('صدر إصدار أحدث من الشروط — راجعه ثم وافق');
        return;
      }
      toast.error(errMessage(err, 'تعذّر تسجيل الموافقة'));
    },
  });

  return (
    <AuthShell wide title="تحديث على شروط البرنامج" subtitle="نشرنا إصداراً جديداً من شروط برنامج السفراء. اقرأه ووافق عليه للمتابعة.">
      {terms.isLoading ? <Loading /> : terms.isError || !terms.data ? (
        <ErrorBox err={terms.error} onRetry={() => void terms.refetch()} />
      ) : (
        <>
          <div className="flex items-center justify-between text-[12px] text-[#6E6557] mb-2">
            <span className="inline-flex items-center gap-1.5"><FileText size={14} /> الإصدار الجديد</span>
            <span dir="ltr">{terms.data.version}</span>
          </div>
          <div
            className="max-h-[50vh] overflow-y-auto rounded-xl border border-[#E0D7C6] bg-[#FAF7F0] p-3 text-[13px] leading-7 text-[#44403a]"
            style={{ whiteSpace: 'pre-wrap' }}
            tabIndex={0}
          >
            {terms.data.body}
          </div>
          <p className="text-[11.5px] text-[#8A8072] mt-2">
            إصدارك الحالي: <span dir="ltr">{me.user.termsVersion || '—'}</span>
          </p>
          <div className="mt-3">
            <CheckRow checked={agree} onChange={setAgree} required>قرأت الإصدار الجديد وأوافق عليه</CheckRow>
          </div>
          <button
            type="button" disabled={!agree || accept.isPending}
            className="btn-primary w-full justify-center py-3 mt-3 disabled:opacity-50"
            onClick={() => accept.mutate(terms.data!.version)}
          >
            {accept.isPending ? <Spinner /> : 'أوافق وأتابع'}
          </button>
        </>
      )}
      <LogoutButton onLogout={onLogout} />
    </AuthShell>
  );
}

// ============================================================================
// شاشات الحالة (بانتظار المراجعة / مرفوض / موقوف) وبوابة قبول الشروط الجديدة.
// شاشة الحالة بطاقةٌ وزرّ خروج فقط — لا بيانات برنامج قبل الاعتماد.
// ============================================================================
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Clock, XCircle, PauseCircle, MailWarning, FileText, LogOut } from 'lucide-react';
import { affiliateApi, httpStatus, qk, shouldRetry } from '../api';
import { errorText } from '../errors';
import { useAxT, type AxKey } from '../i18n';
import type { AffiliateMe, MeResponse } from '../types';
import { ArabicTermsBody, AuthShell, CheckRow, ErrorBox, Loading, Spinner } from '../ui';

function LogoutButton({ onLogout }: { onLogout: () => void }) {
  const { t } = useAxT();
  return (
    <button type="button" className="btn-secondary w-full justify-center py-2.5 mt-5" onClick={onLogout}>
      <LogOut size={16} /> {t('common.logout')}
    </button>
  );
}

export function StatusScreen({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const { t } = useAxT();
  const { user } = me;
  const reason = user.statusReason?.trim();

  let icon: ReactNode = <Clock size={42} className="text-[#E0A02C]" />;
  let title: AxKey = 'status.review.title';
  let body: AxKey = 'status.review.body';

  if (user.status === 'rejected') {
    icon = <XCircle size={42} className="text-[#C0392B]" />;
    title = 'status.rejected.title';
    body = 'status.rejected.body';
  } else if (user.status === 'suspended') {
    icon = <PauseCircle size={42} className="text-[#C0392B]" />;
    title = 'status.suspended.title';
    body = 'status.suspended.body';
  } else if (user.status === 'pending_email') {
    icon = <MailWarning size={42} className="text-[#E0A02C]" />;
    title = 'status.pendingEmail.title';
    body = 'status.pendingEmail.body';
  }

  return (
    <AuthShell title={t(title)}>
      <div className="flex flex-col items-center text-center gap-3">
        {icon}
        <p className="text-[15px] text-[#1F1A13] leading-relaxed">{t(body)}</p>
        {reason && (user.status === 'rejected' || user.status === 'suspended') && (
          <div className="w-full rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3 text-start">
            <p className="text-[12px] font-bold text-[#6E6557] mb-1">{t('status.reason')}</p>
            {/* السبب نصٌّ كتبه فريق فيلد سيلز — يُعرض كما هو */}
            <p className="text-sm text-[#1F1A13] leading-relaxed" dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{reason}</p>
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
  const { t, lang } = useAxT();
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry });
  const [agree, setAgree] = useState(false);
  const accept = useMutation({
    mutationFn: (version: string) => affiliateApi.acceptTerms(version),
    onSuccess: (r) => { toast.success(t('gate.thanks')); onAccepted(r.user); },
    onError: (err) => {
      if (httpStatus(err) === 409) {
        setAgree(false);
        void terms.refetch();
        toast.error(t('gate.newer'));
        return;
      }
      toast.error(errorText(err, lang, 'gate.failed'));
    },
  });

  return (
    <AuthShell wide title={t('gate.title')} subtitle={t('gate.subtitle')}>
      {terms.isLoading ? <Loading /> : terms.isError || !terms.data ? (
        <ErrorBox err={terms.error} onRetry={() => void terms.refetch()} />
      ) : (
        <>
          <div className="flex items-center justify-between text-[12px] text-[#6E6557] mb-2">
            <span className="inline-flex items-center gap-1.5"><FileText size={14} /> {t('gate.newVersion')}</span>
            <span dir="ltr">{terms.data.version}</span>
          </div>
          <ArabicTermsBody
            body={terms.data.body}
            className="max-h-[50vh] overflow-y-auto rounded-xl border border-[#E0D7C6] bg-[#FAF7F0] p-3 text-[13px] leading-7 text-[#44403a]"
          />
          <p className="text-[11.5px] text-[#8A8072] mt-2">
            {t('gate.currentVersion')} <span dir="ltr">{me.user.termsVersion || '—'}</span>
          </p>
          <div className="mt-3">
            <CheckRow checked={agree} onChange={setAgree} required>{t('gate.agree')}</CheckRow>
          </div>
          <button
            type="button" disabled={!agree || accept.isPending}
            className="btn-primary w-full justify-center py-3 mt-3 disabled:opacity-50"
            onClick={() => accept.mutate(terms.data!.version)}
          >
            {accept.isPending ? <Spinner /> : t('gate.submit')}
          </button>
        </>
      )}
      <LogoutButton onLogout={onLogout} />
    </AuthShell>
  );
}

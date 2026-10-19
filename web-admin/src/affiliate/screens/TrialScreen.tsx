// ============================================================================
// «افتح حساباً تجريبياً» + «حسابات فتحتها» — السفير يفتح حساباً تجريبياً لشركةٍ طلبته،
// فيُسند إليه مباشرةً (source = 'portal').
//
// · لا كلمة مرور هنا ولا رابط تفعيل ولا نسخ ولا مشاركة: مسؤول الشركة يختار كلمة مروره من
//   رابطٍ يصل بريده وحده، والسفير لا يرى الرابط ولا يدخل حساب الشركة أبداً — وعد العقد
//   «لا يدخل حسابك إلا مديره».
// · الردّ موحّد دائماً (202): لا يُكشف هل البريد أو الجوال أو السجل لعميلٍ قائم.
// · لا مسودّة محفوظة: النموذج يحمل بريد شخصٍ ثالث وجواله، فلا يبقى في المتصفّح بعد الإرسال.
// · إعادة الإرسال تذهب إلى البريد المخزَّن وحده — لا يُعدَّل بريدٌ ولا جوال من هنا؛ وخطأ
//   الكتابة يُصحَّح بسحب الحساب (قبل تفعيله) وفتحه من جديد.
// ============================================================================
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { MailPlus, ShieldCheck, Undo2 } from 'lucide-react';
import { affiliateApi, httpStatus, qk } from '../api';
import { errorText, isTermsOutdated, localizedServerText } from '../errors';
import { formatDay } from '../format';
import { useAxT } from '../i18n';
import { ACTIVATION, COMPANY_STATUS, labelOf } from '../labels';
import type { MeResponse } from '../types';
import {
  EMPTY_TRIAL, TRIAL_ADMIN_NAME_MAX, TRIAL_COMPANY_MAX, TRIAL_EMAIL_MAX, buildTrialBody, containsContactInfo,
  containsLinkLike, isSelfContact, trialError, trialPhone, type TrialForm,
} from '../validation';
import { supportedCountries } from '../../i18n/countries';
import { ALL_DIAL, ARAB_DIAL, WORLD_DIAL, flagOf } from '../../i18n/dialCodes';
import { Badge, CheckRow, Empty, ErrorBox, Field, Loading, SectionTitle, Spinner, ltrFieldAlign } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

const RED_INPUT = 'border-[#C0392B] focus:border-[#C0392B]';

export function TrialTab({ me, refreshMe }: TabProps) {
  const { t, m, lang, dir } = useAxT();
  const qc = useQueryClient();
  const countries = supportedCountries();
  const [form, setForm] = useState<TrialForm>(EMPTY_TRIAL);
  const set = <K extends keyof TrialForm>(k: K, v: TrialForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  // دولة الشركة تقترح مفتاح جوال مسؤولها، ويبقى قابلاً للتغيير — كما في صفحة تسجيل الشركات
  const setCountry = (c: string) => setForm((f) => ({
    ...f, country: c, phoneCountry: ALL_DIAL.some((d) => d.code === c) ? c : f.phoneCountry,
  }));

  // «حسابات فتحتها» = صفوف «شركاتي» التي مصدرها البوابة — لا مسار ولا مفتاح استعلام ثانٍ
  const list = useAxQuery(qk.companies, affiliateApi.companies, refreshMe);
  const mine = (list.data ?? []).filter((c) => c.source === 'portal');

  const companyBad = containsContactInfo(form.companyName) || containsLinkLike(form.companyName);
  const adminBad = containsContactInfo(form.adminName) || containsLinkLike(form.adminName);
  // بريد السفير أو جواله مكان المسؤول = رابط التفعيل يصل صندوقه هو — الخادم يرفضه، فننبّه قبله
  const emailIsMine = isSelfContact({ affiliateEmail: me.user.email, affiliatePhone: null, adminEmail: form.adminEmail, adminPhone: null });
  const phoneIsMine = !!form.adminPhone.trim()
    && isSelfContact({ affiliateEmail: null, affiliatePhone: me.user.phone, adminEmail: null, adminPhone: trialPhone(form) });
  const redHint = (key: 'val.linkLike' | 'val.selfContact') => <span className="text-[#C0392B]">{t(key)}</span>;

  const create = useMutation({
    mutationFn: () => affiliateApi.createTrial(buildTrialBody(form)),
    onSuccess: (message) => {
      toast.success(localizedServerText(lang, message, 'trial.accepted'), { duration: 6000 });
      setForm(EMPTY_TRIAL);
      void qc.invalidateQueries({ queryKey: qk.companies });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (err) => {
      // 403: تغيّرت حالة السفير أو أُطفئ المفتاح (portal_trial_disabled) — /me يحسم ويُخفي التبويب
      if (httpStatus(err) === 403) refreshMe();
      // شروطٌ جديدة: بوابة القبول تظهر بدل التبويب وتشرح السبب — لا خطأ فوقها
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'trial.failed'));
    },
  });

  const resend = useMutation({
    mutationFn: (id: string) => affiliateApi.resendActivation(id),
    onSuccess: (r) => { toast.success(localizedServerText(lang, r?.message, 'trial.resent')); },
    onError: (err) => {
      const s = httpStatus(err);
      if (s === 403) refreshMe();
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'trial.resendFailed'));
      // فُعّل أو سُحب في الأثناء: القائمة تتبع الخادم
      if (s === 404 || s === 409) void qc.invalidateQueries({ queryKey: qk.companies });
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => affiliateApi.withdrawTrial(id),
    onSuccess: () => {
      toast.success(t('trial.withdrawn'));
      void qc.invalidateQueries({ queryKey: qk.companies });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (err) => {
      const s = httpStatus(err);
      if (s === 403) refreshMe();
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'trial.withdrawFailed'));
      if (s === 404 || s === 409) void qc.invalidateQueries({ queryKey: qk.companies });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = trialError(form, me.user);
    if (err) { toast.error(m(err)); return; }
    create.mutate();
  };

  const dialOption = (c: { code: string; dial: string; ar: string; en: string }) => (
    <option key={c.code} value={c.code}>{flagOf(c.code)} {c.dial} {lang === 'ar' ? c.ar : c.en}</option>
  );

  return (
    <div className="space-y-5">
      <div className="card">
        <SectionTitle>{t('trial.title')}</SectionTitle>
        <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1 mb-4">{t('trial.intro')}</p>
        <form onSubmit={submit} className="space-y-3.5" noValidate>
          <Field label={t('trial.companyName')} required hint={companyBad ? redHint('val.linkLike') : undefined}>
            <input
              className={`input ${companyBad ? RED_INPUT : ''}`} autoComplete="off"
              value={form.companyName} onChange={(e) => set('companyName', e.target.value)} maxLength={TRIAL_COMPANY_MAX}
            />
          </Field>
          <Field label={t('trial.country')} required hint={t('trial.countryHint')}>
            <select className="input" value={form.country} onChange={(e) => setCountry(e.target.value)}>
              {countries.map((c) => <option key={c.code} value={c.code}>{lang === 'ar' ? c.nameAr : c.nameEn}</option>)}
            </select>
          </Field>
          <Field label={t('trial.adminName')} required hint={adminBad ? redHint('val.linkLike') : undefined}>
            <input
              className={`input ${adminBad ? RED_INPUT : ''}`} autoComplete="off"
              value={form.adminName} onChange={(e) => set('adminName', e.target.value)} maxLength={TRIAL_ADMIN_NAME_MAX}
            />
          </Field>
          {/* بيانات المسؤول لا تُملأ تلقائياً: الملء التلقائي يضع بريد السفير نفسه */}
          <Field label={t('trial.adminEmail')} required hint={emailIsMine ? redHint('val.selfContact') : t('trial.adminEmailHint')}>
            <input
              type="email" dir="ltr" inputMode="email" autoComplete="off"
              className={`input ${ltrFieldAlign(dir)} ${emailIsMine ? RED_INPUT : ''}`}
              value={form.adminEmail} onChange={(e) => set('adminEmail', e.target.value)} maxLength={TRIAL_EMAIL_MAX}
            />
          </Field>
          <Field label={t('trial.adminPhone')} required hint={phoneIsMine ? redHint('val.selfContact') : t('f.phoneHint')}>
            {/* مفتاح الدولة + الرقم المحلّي — منسوخٌ من تسجيل السفير */}
            <div className="flex gap-2" dir="ltr">
              <select aria-label={t('f.phoneCountry')} className="input font-semibold text-sm"
                style={{ width: 118, flex: '0 0 auto', paddingInline: '8px' }}
                value={form.phoneCountry} onChange={(e) => set('phoneCountry', e.target.value)}>
                <optgroup label={t('f.arabCountries')}>{ARAB_DIAL.map(dialOption)}</optgroup>
                <optgroup label={t('f.otherCountries')}>{WORLD_DIAL.map(dialOption)}</optgroup>
              </select>
              <input dir="ltr" className={`input flex-1 min-w-0 text-left ${phoneIsMine ? RED_INPUT : ''}`} value={form.adminPhone}
                onChange={(e) => set('adminPhone', e.target.value)} autoComplete="off" inputMode="tel"
                placeholder={form.phoneCountry === 'SA' ? '5XXXXXXXX' : ''} maxLength={16} />
            </div>
          </Field>
          <Field label={t('trial.cr')} hint={t('trial.crHint')}>
            <input
              dir="ltr" className={`input ${ltrFieldAlign(dir)} tracking-wider`} inputMode="numeric" maxLength={14} autoComplete="off"
              value={form.crNumber} onChange={(e) => set('crNumber', e.target.value)} placeholder="1010XXXXXX"
            />
          </Field>
          <CheckRow checked={form.consent} onChange={(v) => set('consent', v)} required>
            {t('trial.consent')}
          </CheckRow>
          <p className="flex gap-2 text-[11.5px] text-[#8A8072] leading-relaxed">
            <ShieldCheck size={14} className="shrink-0 mt-0.5 text-[#1E7A52]" />
            <span>{t('trial.privacy')}</span>
          </p>
          <button
            type="submit" disabled={create.isPending || companyBad || adminBad || emailIsMine || phoneIsMine}
            className="btn-primary w-full justify-center py-2.5 disabled:opacity-50"
          >
            {create.isPending ? <Spinner /> : t('trial.submit')}
          </button>
        </form>
      </div>

      <div>
        <SectionTitle>{t('trial.mine')}</SectionTitle>
        {list.isLoading ? <Loading /> : list.isError || !list.data ? (
          <ErrorBox err={list.error} onRetry={() => void list.refetch()} />
        ) : mine.length === 0 ? (
          <Empty title={t('trial.empty')} hint={t('trial.emptyHint')} />
        ) : (
          <div className="space-y-2.5">
            {mine.map((c) => {
              // المسحوب يبقى «بانتظار التفعيل» في الخادم (رابطه أُبطل) — فلا تُعرض حالة تفعيله
              const live = c.status !== 'void';
              const pending = live && c.activation === 'pending';
              return (
                <div key={c.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-[14.5px] text-[#1F1A13] break-words">{c.tenantName}</p>
                      <p className="text-[12px] text-[#6E6557] mt-0.5">{t('trial.openedOn', { date: formatDay(c.signedUpAt, lang) })}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {live && c.activation && <Badge value={labelOf(ACTIVATION, c.activation, lang)} />}
                      <Badge value={labelOf(COMPANY_STATUS, c.status, lang)} />
                    </div>
                  </div>
                  {pending && (
                    <div className="flex flex-wrap items-center justify-between gap-2 mt-2.5 text-[12px]">
                      <button
                        type="button" disabled={resend.isPending}
                        className="inline-flex items-center gap-1 text-[#E15A30] font-semibold hover:underline disabled:opacity-50"
                        onClick={() => resend.mutate(c.id)}
                      >
                        {resend.isPending && resend.variables === c.id ? <Spinner size={13} /> : <MailPlus size={13} />} {t('trial.resend')}
                      </button>
                      <button
                        type="button" disabled={withdraw.isPending}
                        className="inline-flex items-center gap-1 text-[#C0392B] font-semibold hover:underline disabled:opacity-50"
                        onClick={() => { if (window.confirm(t('trial.withdrawConfirm', { name: c.tenantName }))) withdraw.mutate(c.id); }}
                      >
                        <Undo2 size={13} /> {t('trial.withdraw')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

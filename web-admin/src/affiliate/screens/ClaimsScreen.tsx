// ============================================================================
// «رشّح شركة» + «ترشيحاتي» — بيانات المنشأة ورقم تواصلٍ إلزاميّ في خانته وحدها؛
// الاسم والمدينة والملاحظة لا تقبل بيانات اتصال (العقد §1 ق9).
// الردّ على الترشيح موحّد دائماً: لا يُكشف هل المنشأة عميلٌ قائم.
// ============================================================================
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldCheck, Undo2, Lock, Phone } from 'lucide-react';
import { affiliateApi, httpStatus, qk } from '../api';
import { errorText, isTermsOutdated, localizedServerText } from '../errors';
import { formatDay } from '../format';
import { contactPhoneDisplay } from '../../lib/contactPhone';
import { useAxT } from '../i18n';
import { CLAIM_HOW, CLAIM_HOW_ORDER, CLAIM_STATUS, labelOf, textOf } from '../labels';
import type { ClaimHow, MeResponse } from '../types';
import {
  CITY_MAX, CONTACT_PHONE_MAX, EMPTY_CLAIM, NOTE_MAX, buildClaimBody, claimError, containsContactInfo, type ClaimForm,
} from '../validation';
import { Badge, Empty, ErrorBox, Field, Loading, SectionTitle, Spinner, ltrFieldAlign } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

export function ClaimsTab({ refreshMe }: TabProps) {
  const { t, m, lang, dir } = useAxT();
  const qc = useQueryClient();
  const [form, setForm] = useState<ClaimForm>(EMPTY_CLAIM);
  const set = <K extends keyof ClaimForm>(k: K, v: ClaimForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const list = useAxQuery(qk.claims, affiliateApi.claims, refreshMe);
  const noteHasContact = containsContactInfo(form.note);
  const nameHasContact = containsContactInfo(form.companyName);
  const cityHasContact = containsContactInfo(form.city);
  const contactHint = t('claims.contactHint');

  const create = useMutation({
    mutationFn: () => affiliateApi.createClaim(buildClaimBody(form)),
    onSuccess: (r) => {
      toast.success(localizedServerText(lang, r?.message, 'claims.received'));
      setForm(EMPTY_CLAIM);
      void qc.invalidateQueries({ queryKey: qk.claims });
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      // شروطٌ جديدة: بوابة القبول تظهر بدل التبويب وتشرح السبب — لا خطأ فوقها
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'claims.submitFailed'));
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => affiliateApi.withdrawClaim(id),
    onSuccess: () => { toast.success(t('claims.withdrawn')); void qc.invalidateQueries({ queryKey: qk.claims }); },
    onError: (err) => {
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'claims.withdrawFailed'));
      if (httpStatus(err) === 409) void qc.invalidateQueries({ queryKey: qk.claims });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = claimError(form);
    if (err) { toast.error(m(err)); return; }
    create.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="card">
        <SectionTitle>{t('claims.formTitle')}</SectionTitle>
        <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1 mb-4">{t('claims.formIntro')}</p>
        <form onSubmit={submit} className="space-y-3.5" noValidate>
          <Field label={t('claims.companyName')} required hint={nameHasContact ? <span className="text-[#C0392B]">{contactHint}</span> : undefined}>
            <input
              className={`input ${nameHasContact ? 'border-[#C0392B] focus:border-[#C0392B]' : ''}`}
              value={form.companyName} onChange={(e) => set('companyName', e.target.value)} maxLength={120}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('claims.cr')} required hint={t('claims.crHint')}>
              <input
                dir="ltr" className={`input ${ltrFieldAlign(dir)} tracking-wider`} inputMode="numeric" maxLength={14}
                value={form.crNumber} onChange={(e) => set('crNumber', e.target.value)} placeholder="1010XXXXXX"
              />
            </Field>
            <Field label={t('f.city')} hint={cityHasContact ? <span className="text-[#C0392B]">{contactHint}</span> : undefined}>
              <input
                className={`input ${cityHasContact ? 'border-[#C0392B] focus:border-[#C0392B]' : ''}`}
                value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={CITY_MAX}
              />
            </Field>
          </div>
          <Field label={t('claims.contactPhone')} required hint={t('claims.contactPhoneHint')}>
            <input
              type="tel" dir="ltr" inputMode="tel" autoComplete="off" className={`input ${ltrFieldAlign(dir)}`}
              value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} maxLength={CONTACT_PHONE_MAX}
              placeholder="05XXXXXXXX"
            />
          </Field>
          <Field label={t('claims.how')} required>
            <select className="input" value={form.how} onChange={(e) => set('how', e.target.value as ClaimHow | '')}>
              <option value="" disabled>{t('claims.choose')}</option>
              {CLAIM_HOW_ORDER.map((h) => <option key={h} value={h}>{textOf(CLAIM_HOW, h, lang)}</option>)}
            </select>
          </Field>
          <Field
            label={t('claims.noteOptional')}
            hint={
              <span className={`flex justify-between gap-2 ${noteHasContact ? 'text-[#C0392B]' : ''}`}>
                <span>{noteHasContact ? t('claims.noteContact') : t('claims.noteHint')}</span>
                <span dir="ltr">{form.note.length}/{NOTE_MAX}</span>
              </span>
            }
          >
            <textarea
              className={`input min-h-[76px] ${noteHasContact ? 'border-[#C0392B] focus:border-[#C0392B]' : ''}`}
              value={form.note} onChange={(e) => set('note', e.target.value.slice(0, NOTE_MAX))} maxLength={NOTE_MAX}
            />
          </Field>
          <p className="flex gap-2 text-[11.5px] text-[#8A8072] leading-relaxed">
            <ShieldCheck size={14} className="shrink-0 mt-0.5 text-[#1E7A52]" />
            <span>{t('claims.privacy')}</span>
          </p>
          <button type="submit" disabled={create.isPending || noteHasContact || nameHasContact || cityHasContact} className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
            {create.isPending ? <Spinner /> : t('claims.submit')}
          </button>
        </form>
      </div>

      <div>
        <SectionTitle>{t('claims.mine')}</SectionTitle>
        {list.isLoading ? <Loading /> : list.isError || !list.data ? (
          <ErrorBox err={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <Empty title={t('claims.empty')} hint={t('claims.emptyHint')} />
        ) : (
          <div className="space-y-2.5">
            {list.data.map((c) => (
              <div key={c.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-[14.5px] text-[#1F1A13] break-words">{c.companyName}</p>
                    <p className="text-[12px] text-[#6E6557] mt-0.5">
                      {t('claims.crShort')} <bdi dir="ltr">{c.crNumber}</bdi>{c.city ? ` · ${c.city}` : ''} · {textOf(CLAIM_HOW, c.how, lang)}
                    </p>
                    {c.contactPhone && (
                      <p className="text-[12px] text-[#6E6557] mt-0.5 inline-flex items-center gap-1">
                        <Phone size={12} className="shrink-0" /> <bdi dir="ltr">{contactPhoneDisplay(c.contactPhone)}</bdi>
                      </p>
                    )}
                  </div>
                  <Badge value={labelOf(CLAIM_STATUS, c.status, lang)} />
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 text-[12px] text-[#8A8072]">
                  <span>{t('claims.sentOn', { date: formatDay(c.submittedAt, lang) })}</span>
                  {c.status === 'under_review' && (
                    <button
                      type="button" disabled={withdraw.isPending}
                      className="inline-flex items-center gap-1 text-[#C0392B] font-semibold hover:underline disabled:opacity-50"
                      onClick={() => { if (window.confirm(t('claims.withdrawConfirm', { name: c.companyName }))) withdraw.mutate(c.id); }}
                    >
                      <Undo2 size={13} /> {t('claims.withdraw')}
                    </button>
                  )}
                </div>
                {c.lockedUntil && (c.status === 'approved' || c.status === 'converted') && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[#1E7A52]">
                    <Lock size={12} /> {t('claims.lockedUntil', { date: formatDay(c.lockedUntil, lang) })}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

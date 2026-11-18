// ============================================================================
// «مطالبة بإحالة فائتة» (V2_SPEC §6.1 و§7) — شركةٌ عرّفها السفير بفيلد سيلز فسجّلت دون رابطه
// أو رمزه: يطالب بها خلال 30 يوماً من تسجيلها، ويراجعها المالك فيُسندها أو يرفض بسبب.
// غير «رشّح شركة» (الترشيح المسبق قبل التسجيل) — المصطلحان لا يختلطان في أيّ لغة.
// الاسم والملاحظة بلا بيانات اتصال، ورقم التواصل اختياريّ في خانته وحدها (العقد §1 ق9).
// ============================================================================
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldCheck, Undo2, Phone } from 'lucide-react';
import { affiliateApi, httpStatus, qk } from '../api';
import { errorText, isTermsOutdated } from '../errors';
import { formatDay } from '../format';
import { contactPhoneDisplay } from '../../lib/contactPhone';
import { useAxT } from '../i18n';
import { MISSED_CLAIM_STATUS, labelOf } from '../labels';
import type { MeResponse } from '../types';
import {
  COMPANY_NAME_MAX, CONTACT_PHONE_MAX, EMPTY_MISSED, NOTE_MAX, buildMissedClaimBody, containsContactInfo, missedClaimError,
  type MissedForm,
} from '../validation';
import { Badge, Empty, ErrorBox, Field, Loading, SectionTitle, Spinner, ltrFieldAlign } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

const RED = 'border-[#C0392B] focus:border-[#C0392B]';

export function MissedClaimsTab({ refreshMe }: TabProps) {
  const { t, m, lang, dir } = useAxT();
  const qc = useQueryClient();
  const [form, setForm] = useState<MissedForm>(EMPTY_MISSED);
  const set = <K extends keyof MissedForm>(k: K, v: MissedForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const list = useAxQuery(qk.missedClaims, affiliateApi.missedClaims, refreshMe);
  const nameHasContact = containsContactInfo(form.companyName);
  const noteHasContact = containsContactInfo(form.note);

  const create = useMutation({
    mutationFn: () => affiliateApi.createMissedClaim(buildMissedClaimBody(form)),
    onSuccess: () => {
      toast.success(t('missed.received'));
      setForm(EMPTY_MISSED);
      void qc.invalidateQueries({ queryKey: qk.missedClaims });
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      if (isTermsOutdated(err)) return; // بوابة قبول الشروط تتولّى الشرح
      toast.error(errorText(err, lang, 'missed.failed'));
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => affiliateApi.withdrawMissedClaim(id),
    onSuccess: () => { toast.success(t('missed.withdrawn')); void qc.invalidateQueries({ queryKey: qk.missedClaims }); },
    onError: (err) => {
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'missed.withdrawFailed'));
      if (httpStatus(err) === 409 || httpStatus(err) === 404) void qc.invalidateQueries({ queryKey: qk.missedClaims });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = missedClaimError(form);
    if (err) { toast.error(m(err)); return; }
    create.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="card">
        <SectionTitle>{t('tab.missed')}</SectionTitle>
        <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1 mb-4">{t('missed.intro')}</p>
        <form onSubmit={submit} className="space-y-3.5" noValidate>
          <Field label={t('claims.companyName')} required hint={nameHasContact ? <span className="text-[#C0392B]">{t('claims.contactHint')}</span> : undefined}>
            <input
              className={`input ${nameHasContact ? RED : ''}`}
              value={form.companyName} onChange={(e) => set('companyName', e.target.value)} maxLength={COMPANY_NAME_MAX}
            />
          </Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t('missed.contactPhoneOptional')} hint={t('claims.contactPhoneHint')}>
              <input
                type="tel" dir="ltr" inputMode="tel" autoComplete="off" className={`input ${ltrFieldAlign(dir)}`}
                value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} maxLength={CONTACT_PHONE_MAX}
                placeholder="05XXXXXXXX"
              />
            </Field>
            <Field label={t('trial.cr')} hint={t('claims.crHint')}>
              <input
                dir="ltr" className={`input ${ltrFieldAlign(dir)} tracking-wider`} inputMode="numeric" maxLength={14}
                value={form.crNumber} onChange={(e) => set('crNumber', e.target.value)} placeholder="1010XXXXXX"
              />
            </Field>
          </div>
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
              className={`input min-h-[76px] ${noteHasContact ? RED : ''}`}
              value={form.note} onChange={(e) => set('note', e.target.value.slice(0, NOTE_MAX))} maxLength={NOTE_MAX}
            />
          </Field>
          <p className="flex gap-2 text-[11.5px] text-[#8A8072] leading-relaxed">
            <ShieldCheck size={14} className="shrink-0 mt-0.5 text-[#1E7A52]" />
            <span>{t('claims.privacy')}</span>
          </p>
          <button type="submit" disabled={create.isPending || noteHasContact || nameHasContact} className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
            {create.isPending ? <Spinner /> : t('missed.submit')}
          </button>
        </form>
      </div>

      <div>
        <SectionTitle>{t('missed.mine')}</SectionTitle>
        {list.isLoading ? <Loading /> : list.isError || !list.data ? (
          <ErrorBox err={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <Empty title={t('missed.empty')} />
        ) : (
          <div className="space-y-2.5">
            {list.data.map((c) => (
              <div key={c.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-[14.5px] text-[#1F1A13] break-words">{c.companyName}</p>
                    {(c.crNumber || c.contactPhone) && (
                      <p className="text-[12px] text-[#6E6557] mt-0.5 flex flex-wrap items-center gap-x-2">
                        {c.crNumber && <span>{t('claims.crShort')} <bdi dir="ltr">{c.crNumber}</bdi></span>}
                        {c.contactPhone && (
                          <span className="inline-flex items-center gap-1"><Phone size={12} className="shrink-0" /> <bdi dir="ltr">{contactPhoneDisplay(c.contactPhone)}</bdi></span>
                        )}
                      </p>
                    )}
                    {c.note && <p className="text-[12px] text-[#44403a] mt-1" dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{c.note}</p>}
                  </div>
                  <Badge value={labelOf(MISSED_CLAIM_STATUS, c.status, lang)} />
                </div>
                {c.reasonNote && (c.status === 'rejected' || c.status === 'accepted') && (
                  <p className="mt-2 rounded-xl bg-[#FAF7F0] px-3 py-2 text-[12.5px] text-[#44403a] leading-relaxed">
                    <b className="text-[#6E6557]">{t('status.reason')}: </b>
                    {/* السبب كما كتبه فريق فيلد سيلز — يُعرض كما هو */}
                    <span dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{c.reasonNote}</span>
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 mt-2.5 text-[12px] text-[#8A8072]">
                  <span>
                    {t('claims.sentOn', { date: formatDay(c.submittedAt, lang) })}
                    {c.reviewedAt ? ` · ${t('missed.reviewedOn', { date: formatDay(c.reviewedAt, lang) })}` : ''}
                  </span>
                  {c.status === 'under_review' && (
                    <button
                      type="button" disabled={withdraw.isPending}
                      className="inline-flex items-center gap-1 text-[#C0392B] font-semibold hover:underline disabled:opacity-50"
                      onClick={() => { if (window.confirm(t('missed.withdrawConfirm', { name: c.companyName }))) withdraw.mutate(c.id); }}
                    >
                      <Undo2 size={13} /> {t('claims.withdraw')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// «رشّح شركة» + «ترشيحاتي» — بيانات منشأة فقط، لا بيانات أشخاص (العقد §1 ق9).
// الردّ على الترشيح موحّد دائماً: لا يُكشف هل المنشأة عميلٌ قائم.
// ============================================================================
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldCheck, Undo2, Lock } from 'lucide-react';
import { affiliateApi, errMessage, httpStatus, qk } from '../api';
import { isTermsOutdated } from '../errors';
import { formatDay } from '../format';
import { CLAIM_HOW, CLAIM_HOW_ORDER, CLAIM_STATUS, labelOf, textOf } from '../labels';
import type { ClaimHow, MeResponse } from '../types';
import {
  CITY_MAX, EMPTY_CLAIM, NOTE_MAX, buildClaimBody, claimError, containsContactInfo, type ClaimForm,
} from '../validation';
import { Badge, Empty, ErrorBox, Field, Loading, SectionTitle, Spinner } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

export function ClaimsTab({ refreshMe }: TabProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ClaimForm>(EMPTY_CLAIM);
  const set = <K extends keyof ClaimForm>(k: K, v: ClaimForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const list = useAxQuery(qk.claims, affiliateApi.claims, refreshMe);
  const noteHasContact = containsContactInfo(form.note);
  const nameHasContact = containsContactInfo(form.companyName);
  const cityHasContact = containsContactInfo(form.city);
  const CONTACT_HINT = 'احذف رقم الجوال أو البريد';

  const create = useMutation({
    mutationFn: () => affiliateApi.createClaim(buildClaimBody(form)),
    onSuccess: (r) => {
      toast.success(r?.message || 'استلمنا الترشيح وسيُراجع');
      setForm(EMPTY_CLAIM);
      void qc.invalidateQueries({ queryKey: qk.claims });
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      // شروطٌ جديدة: بوابة القبول تظهر بدل التبويب وتشرح السبب — لا خطأ فوقها
      if (isTermsOutdated(err)) return;
      toast.error(errMessage(err, 'تعذّر إرسال الترشيح'));
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => affiliateApi.withdrawClaim(id),
    onSuccess: () => { toast.success('سُحب الترشيح'); void qc.invalidateQueries({ queryKey: qk.claims }); },
    onError: (err) => {
      if (isTermsOutdated(err)) return;
      toast.error(errMessage(err, 'تعذّر سحب الترشيح'));
      if (httpStatus(err) === 409) void qc.invalidateQueries({ queryKey: qk.claims });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = claimError(form);
    if (err) { toast.error(err); return; }
    create.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="card">
        <SectionTitle>رشّح منشأة</SectionTitle>
        <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1 mb-4">
          عرّفت منشأةً بفيلد سيلز ولم تسجّل برابطك؟ رشّحها هنا. إن قُبل الترشيح تُحجز لك مدةً، وتُحتسب عمولتك إن اشتركت.
        </p>
        <form onSubmit={submit} className="space-y-3.5" noValidate>
          <Field label="اسم المنشأة" required hint={nameHasContact ? <span className="text-[#C0392B]">{CONTACT_HINT}</span> : undefined}>
            <input
              className={`input ${nameHasContact ? 'border-[#C0392B] focus:border-[#C0392B]' : ''}`}
              value={form.companyName} onChange={(e) => set('companyName', e.target.value)} maxLength={120}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="السجل التجاري" required hint="10 أرقام">
              <input
                dir="ltr" className="input text-right tracking-wider" inputMode="numeric" maxLength={14}
                value={form.crNumber} onChange={(e) => set('crNumber', e.target.value)} placeholder="1010XXXXXX"
              />
            </Field>
            <Field label="المدينة" hint={cityHasContact ? <span className="text-[#C0392B]">{CONTACT_HINT}</span> : undefined}>
              <input
                className={`input ${cityHasContact ? 'border-[#C0392B] focus:border-[#C0392B]' : ''}`}
                value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={CITY_MAX}
              />
            </Field>
          </div>
          <Field label="كيف عرّفتهم؟" required>
            <select className="input" value={form.how} onChange={(e) => set('how', e.target.value as ClaimHow | '')}>
              <option value="" disabled>اختر</option>
              {CLAIM_HOW_ORDER.map((h) => <option key={h} value={h}>{CLAIM_HOW[h]}</option>)}
            </select>
          </Field>
          <Field
            label="ملاحظة (اختياري)"
            hint={
              <span className={`flex justify-between gap-2 ${noteHasContact ? 'text-[#C0392B]' : ''}`}>
                <span>{noteHasContact ? 'احذف رقم الجوال أو البريد — لا نقبل بيانات أشخاص' : 'بلا أسماء أشخاص أو أرقام جوال أو بريد'}</span>
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
            <span>اسم المنشأة وسجلها التجاري يكفيان — لا تُدخل بيانات أي شخص.</span>
          </p>
          <button type="submit" disabled={create.isPending || noteHasContact || nameHasContact || cityHasContact} className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
            {create.isPending ? <Spinner /> : 'إرسال الترشيح'}
          </button>
        </form>
      </div>

      <div>
        <SectionTitle>ترشيحاتي</SectionTitle>
        {list.isLoading ? <Loading /> : list.isError || !list.data ? (
          <ErrorBox err={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <Empty title="لا ترشيحات بعد" hint="ترشيحاتك وحالاتها تظهر هنا." />
        ) : (
          <div className="space-y-2.5">
            {list.data.map((c) => (
              <div key={c.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-[14.5px] text-[#1F1A13] break-words">{c.companyName}</p>
                    <p className="text-[12px] text-[#6E6557] mt-0.5">
                      سجل <bdi dir="ltr">{c.crNumber}</bdi>{c.city ? ` · ${c.city}` : ''} · {textOf(CLAIM_HOW, c.how)}
                    </p>
                  </div>
                  <Badge value={labelOf(CLAIM_STATUS, c.status)} />
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 text-[12px] text-[#8A8072]">
                  <span>أُرسل {formatDay(c.submittedAt)}</span>
                  {c.status === 'under_review' && (
                    <button
                      type="button" disabled={withdraw.isPending}
                      className="inline-flex items-center gap-1 text-[#C0392B] font-semibold hover:underline disabled:opacity-50"
                      onClick={() => { if (window.confirm(`سحب ترشيح «${c.companyName}»؟`)) withdraw.mutate(c.id); }}
                    >
                      <Undo2 size={13} /> سحب
                    </button>
                  )}
                </div>
                {c.lockedUntil && (c.status === 'approved' || c.status === 'converted') && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[#1E7A52]">
                    <Lock size={12} /> محجوز لك حتى {formatDay(c.lockedUntil)}
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

// ============================================================================
// «الملف» (البيانات + بيانات الاستلام) و«الشروط».
// نموذج الآيبان يُفتح بعد أول عمولة معتمدة فقط (canSetPayout من الخادم)،
// والآيبان لا يُعرض كاملاً أبداً — صاحب الحساب وآخر أربعة أرقام.
// ============================================================================
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Landmark, Lock, Megaphone } from 'lucide-react';
import { affiliateApi, errMessage, httpStatus, qk, shouldRetry } from '../api';
import { isTermsOutdated } from '../errors';
import { formatDay, formatRate, formatSar, maskedIban, riyadhToday, toDateInput } from '../format';
import { USER_STATUS, labelOf } from '../labels';
import type { AffiliateMe, MeResponse } from '../types';
import {
  CITY_MAX, buildProfileBody, normIbanSA, payoutError, profileError, type ProfileForm,
} from '../validation';
import { Badge, CheckRow, ErrorBox, Field, Loading, SectionTitle, Spinner, Switch } from '../ui';

interface TabProps { me: MeResponse; refreshMe: () => void; onUserUpdated: (u: AffiliateMe) => void }

function toForm(u: AffiliateMe): ProfileForm {
  return {
    city: u.city ?? '',
    marketingConsent: u.marketingConsent,
    publicPromoter: u.publicPromoter,
    mawthooqNo: u.mawthooqNo ?? '',
    mawthooqExpiry: toDateInput(u.mawthooqExpiry),
    vatNumber: u.vatNumber ?? '',
  };
}

function ReadOnly({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-[#F1EBDF] last:border-0 text-[13px]">
      <span className="text-[#6E6557]">{k}</span>
      <span className="text-[#1F1A13] font-medium text-left break-all">{children}</span>
    </div>
  );
}

export function ProfileTab({ me, refreshMe, onUserUpdated }: TabProps) {
  const { user } = me;
  const initial = useMemo(() => toForm(user), [user]);
  const [form, setForm] = useState<ProfileForm>(initial);
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const today = riyadhToday();
  const body = buildProfileBody(form, initial);
  const dirty = Object.keys(body).length > 0;

  const save = useMutation({
    mutationFn: () => affiliateApi.updateMe(body),
    onSuccess: (r) => {
      toast.success('تم حفظ بياناتك');
      onUserUpdated(r.user);
      setForm(toForm(r.user));
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      toast.error(errMessage(err, 'تعذّر حفظ البيانات'));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = profileError(form, initial, today);
    if (err) { toast.error(err); return; }
    if (!dirty) { toast('لا تغييرات للحفظ'); return; }
    save.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="card">
        <SectionTitle action={<Badge value={labelOf(USER_STATUS, user.status)} />}>بياناتي</SectionTitle>
        <ReadOnly k="الاسم">{user.fullName}</ReadOnly>
        <ReadOnly k="البريد"><bdi dir="ltr">{user.email}</bdi></ReadOnly>
        <ReadOnly k="الجوال"><bdi dir="ltr">{user.phone ? (/^966\d+$/.test(user.phone) ? `+${user.phone}` : user.phone) : '—'}</bdi></ReadOnly>
        <ReadOnly k="رمز الإحالة"><bdi dir="ltr" className="tracking-widest font-bold">{user.code}</bdi></ReadOnly>
        <ReadOnly k="عضو منذ">{formatDay(user.createdAt)}</ReadOnly>
        <p className="text-[11.5px] text-[#8A8072] mt-2">لتعديل الاسم أو البريد أو الجوال راسل فريق فيلد سيلز من بريدك المسجّل.</p>
      </div>

      <form onSubmit={submit} className="card space-y-3.5" noValidate>
        <SectionTitle>تفضيلاتي</SectionTitle>
        <Field label="المدينة">
          <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={CITY_MAX} />
        </Field>
        <Field label="الرقم الضريبي" hint="إن كنت مسجّلاً في ضريبة القيمة المضافة — 15 رقماً">
          <input dir="ltr" className="input text-right" inputMode="numeric" maxLength={17} value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />
        </Field>
        <Switch
          checked={form.publicPromoter} onChange={(v) => set('publicPromoter', v)}
          label="سأنشر عن فيلد سيلز علناً" hint="في حساباتي على التواصل الاجتماعي أو أي منصة عامة"
        />
        {form.publicPromoter && (
          <div className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2]/50 p-3 space-y-3">
            <p className="flex gap-2 text-[12.5px] text-[#7A3A20] leading-relaxed">
              <Megaphone size={16} className="shrink-0 mt-0.5" />
              <span>النشر العلني يتطلب ترخيص «موثوق» ساري المفعول، ووضع وسم «إعلان» بوضوح على كل منشور.</span>
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="رقم ترخيص موثوق" required>
                <input dir="ltr" className="input text-right" value={form.mawthooqNo} onChange={(e) => set('mawthooqNo', e.target.value)} maxLength={40} />
              </Field>
              <Field label="تاريخ انتهاء الترخيص" required>
                <input type="date" dir="ltr" className="input text-right" min={today} value={form.mawthooqExpiry} onChange={(e) => set('mawthooqExpiry', e.target.value)} />
              </Field>
            </div>
          </div>
        )}
        <CheckRow checked={form.marketingConsent} onChange={(v) => set('marketingConsent', v)}>
          أوافق على تلقي رسائل عن البرنامج وتحديثاته
        </CheckRow>
        <button type="submit" disabled={save.isPending || !dirty} className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
          {save.isPending ? <Spinner /> : 'حفظ التغييرات'}
        </button>
      </form>

      <PayoutCard me={me} refreshMe={refreshMe} onUserUpdated={onUserUpdated} />
    </div>
  );
}

function PayoutCard({ me, refreshMe, onUserUpdated }: TabProps) {
  const { user, canSetPayout } = me;
  const [editing, setEditing] = useState(false);
  const [iban, setIban] = useState('');
  const [holderName, setHolderName] = useState('');
  const [bankName, setBankName] = useState('');
  const ibanOk = !iban.trim() || !!normIbanSA(iban);

  const save = useMutation({
    mutationFn: () => affiliateApi.setPayoutProfile({
      iban: normIbanSA(iban) ?? iban.replace(/\s+/g, '').toUpperCase(),
      holderName: holderName.trim(),
      ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
    }),
    onSuccess: (r) => {
      toast.success('تم حفظ بيانات الاستلام');
      onUserUpdated(r.user);
      setEditing(false);
      setIban(''); setHolderName(''); setBankName('');
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      if (isTermsOutdated(err)) return; // بوابة قبول الشروط تتولّى الشرح
      toast.error(errMessage(err, 'تعذّر حفظ بيانات الاستلام'));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = payoutError(iban, holderName, bankName);
    if (err) { toast.error(err); return; }
    save.mutate();
  };

  const showForm = canSetPayout && (editing || !user.payout);

  return (
    <div className="card space-y-3">
      <SectionTitle>بيانات الاستلام</SectionTitle>

      {user.payout && (
        <div className="flex items-center gap-3 rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3">
          <span className="w-9 h-9 rounded-lg bg-[#E4F1EA] text-[#1E7A52] flex items-center justify-center shrink-0"><Landmark size={17} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold text-[#1F1A13] break-words">{user.payout.holderName}</p>
            <p className="text-[12px] text-[#6E6557]">
              <bdi dir="ltr">{maskedIban(user.payout.ibanLast4)}</bdi>{user.payout.bankName ? ` · ${user.payout.bankName}` : ''}
            </p>
            <p className="text-[11px] text-[#8A8072]">آخر تحديث {formatDay(user.payout.updatedAt)}</p>
          </div>
          {canSetPayout && !editing && (
            <button type="button" className="btn-secondary shrink-0" onClick={() => setEditing(true)}>تحديث</button>
          )}
        </div>
      )}

      {!canSetPayout && (
        <p className="flex gap-2 text-[12.5px] text-[#6E6557] leading-relaxed">
          <Lock size={15} className="shrink-0 mt-0.5" />
          <span>
            {user.payout
              ? 'تحديث بيانات الاستلام غير متاح حالياً.'
              : 'يُفتح نموذج الحساب البنكي بعد اعتماد أول عمولة لك.'}
          </span>
        </p>
      )}

      {showForm && (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="الآيبان" required hint={ibanOk ? 'آيبان سعودي يبدأ بـSA ويتبعه 22 رقماً' : <span className="text-[#C0392B]">الآيبان غير صالح — راجع الأرقام</span>}>
            <input
              dir="ltr" className="input text-right tracking-wider uppercase" autoComplete="off" spellCheck={false} maxLength={34}
              value={iban} onChange={(e) => setIban(e.target.value)} placeholder="SA00 0000 0000 0000 0000 0000"
            />
          </Field>
          <Field label="اسم صاحب الحساب" required hint="كما هو مسجّل في البنك">
            <input className="input" value={holderName} onChange={(e) => setHolderName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="اسم البنك">
            <input className="input" value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={80} />
          </Field>
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
              {save.isPending ? <Spinner /> : 'حفظ بيانات الاستلام'}
            </button>
            {user.payout && (
              <button type="button" className="btn-secondary justify-center" onClick={() => setEditing(false)}>إلغاء</button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

export function TermsTab({ me }: { me: MeResponse }) {
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry, staleTime: 60_000 });
  const s = me.settings;
  return (
    <div className="space-y-4">
      <div className="card">
        <SectionTitle>ملخّص البرنامج</SectionTitle>
        <div className="space-y-1.5 text-[13px] text-[#44403a] leading-relaxed">
          <p>العمولة: {formatRate(s.rateBps)} من مبلغ الدفعة الأولى المؤكَّدة للمنشأة (شاملة الضريبة) — مرة واحدة لكل منشأة.</p>
          <p>فترة الحجز: {s.holdDays} يوماً من تاريخ الدفع قبل الاعتماد.</p>
          <p>الحد الأدنى للتحويل: {formatSar(s.minPayoutHalalas)}.</p>
        </div>
      </div>
      <div className="card">
        <SectionTitle action={terms.data ? <span className="text-[11.5px] text-[#8A8072]" dir="ltr">{terms.data.version}</span> : undefined}>
          شروط البرنامج
        </SectionTitle>
        {terms.isLoading ? <Loading /> : terms.isError || !terms.data ? (
          <ErrorBox err={terms.error} onRetry={() => void terms.refetch()} />
        ) : (
          <div className="text-[13.5px] leading-7 text-[#44403a]" style={{ whiteSpace: 'pre-wrap' }}>{terms.data.body}</div>
        )}
        <p className="text-[11.5px] text-[#8A8072] mt-3 pt-3 border-t border-[#F1EBDF]">
          وافقت على الإصدار <bdi dir="ltr">{me.user.termsVersion}</bdi>
        </p>
      </div>
    </div>
  );
}

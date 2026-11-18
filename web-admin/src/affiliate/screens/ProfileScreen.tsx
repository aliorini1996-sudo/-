// ============================================================================
// «ملفي» (V2_SPEC §3 و§7) و«الشروط».
//   · نسبة اكتمال الملف: النوع + الحساب البنكي + الهوية/الإقامة (+ السجل للشركة) — شرطٌ لدخول
//     دورة التسوية وحده، لا يحجب الحساب.
//   · بيانات الشراكة: النوع واسم الشركة والمدينة والرقم الضريبي والموافقة التسويقية.
//   · روابط التواصل: منصّة + رابط، إضافة وحذف (حتى ٨).
//   · الحساب البنكي متاحٌ دائماً (لا شرط «بعد أول عمولة» — قرار المالك ١٨ نوفمبر ٢٠٢٦)،
//     والآيبان لا يُعرض كاملاً أبداً — صاحب الحساب وآخر أربعة أرقام.
//   · المستندات بتصويرٍ أو من الاستديو، مع معاينةٍ واستبدالٍ وحذف — تُشفَّر في الخادم ولا
//     تُعاد إلا لصاحبها.
// ============================================================================
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Landmark, Camera, ImageUp, Eye, EyeOff, Trash2, RefreshCw, Plus, X, CheckCircle2, Circle, FileText, ShieldCheck,
} from 'lucide-react';
import { affiliateApi, httpStatus, qk, shouldRetry } from '../api';
import { errorText, isTermsOutdated } from '../errors';
import { openDataUrl, prepareDocument } from '../files';
import { daysLabel, formatBytes, formatDay, formatRate, formatSar, maskedIban, SETTLEMENT_EVERY_DAYS } from '../format';
import { useAxT } from '../i18n';
import { DOC_KIND, PROFILE_MISSING, SOCIAL_PLATFORM, SOCIAL_PLATFORM_ORDER, USER_STATUS, labelOf, textOf } from '../labels';
import { needsCommercialReg, profileProgress } from '../profile';
import type { AffiliateMe, DocKind, MeResponse, ProfileMissing, SocialPlatform } from '../types';
import {
  CITY_MAX, COMPANY_NAME_MAX, SOCIAL_MAX, SOCIAL_URL_MAX, buildProfileBody, buildSocialLinks, normIbanSA, payoutError,
  profileError, sameSocialLinks, socialLinksError, socialRowsOf, type ProfileForm, type SocialRow,
} from '../validation';
import {
  ArabicTermsBody, Badge, CheckRow, ErrorBox, Field, Loading, PartnerTypePicker, SectionTitle, Spinner, ltrFieldAlign,
} from '../ui';

interface TabProps { me: MeResponse; refreshMe: () => void; onUserUpdated: (u: AffiliateMe) => void }

function toForm(u: AffiliateMe): ProfileForm {
  return {
    partnerType: u.partnerType ?? '',
    companyName: u.companyName ?? '',
    city: u.city ?? '',
    marketingConsent: u.marketingConsent,
    vatNumber: u.vatNumber ?? '',
  };
}

function ReadOnly({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-[#F1EBDF] last:border-0 text-[13px]">
      <span className="text-[#6E6557]">{k}</span>
      <span className="text-[#1F1A13] font-medium text-end break-all">{children}</span>
    </div>
  );
}

/** نسبة اكتمال الملف وقائمة خطواته */
function CompletionCard({ me }: { me: MeResponse }) {
  const { t, lang } = useAxT();
  const p = profileProgress(me.user);
  const steps: ProfileMissing[] = ['partnerType', 'iban', 'national_id', ...(p.total === 4 ? ['commercial_reg' as ProfileMissing] : [])];
  return (
    <div className="card">
      <SectionTitle action={<bdi dir="ltr" className={`text-[15px] font-bold ${p.complete ? 'text-[#1E7A52]' : 'text-[#B7791F]'}`}>{p.percent}%</bdi>}>
        {t('profile.completeTitle')}
      </SectionTitle>
      <div className="h-2 rounded-full bg-[#F1EBDF] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent} aria-label={t('profile.completeTitle')}>
        <div className={`h-full rounded-full ${p.complete ? 'bg-[#1E7A52]' : 'bg-[#E0A02C]'}`} style={{ width: `${p.percent}%` }} />
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {steps.map((k) => {
          const done = !p.missing.includes(k);
          return (
            <li key={k} className={`flex items-center gap-1.5 text-[12.5px] ${done ? 'text-[#1E7A52]' : 'text-[#6E6557]'}`}>
              {done ? <CheckCircle2 size={15} className="shrink-0" /> : <Circle size={15} className="shrink-0" />}
              <span>{textOf(PROFILE_MISSING, k, lang)}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-[11.5px] text-[#8A8072] mt-2.5 leading-relaxed">{p.complete ? t('profile.completeDone') : t('profile.completeHint')}</p>
    </div>
  );
}

export function ProfileTab({ me, refreshMe, onUserUpdated }: TabProps) {
  const { t, m, lang, dir } = useAxT();
  const { user } = me;
  const initial = useMemo(() => toForm(user), [user]);
  const [form, setForm] = useState<ProfileForm>(initial);
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const body = buildProfileBody(form, initial);
  const dirty = Object.keys(body).length > 0;

  const save = useMutation({
    mutationFn: () => affiliateApi.updateMe(body),
    onSuccess: (r) => {
      toast.success(t('profile.saved'));
      onUserUpdated(r.user);
      setForm(toForm(r.user));
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'profile.saveFailed'));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = profileError(form);
    if (err) { toast.error(m(err)); return; }
    if (!dirty) { toast(t('profile.noChanges')); return; }
    save.mutate();
  };

  return (
    <div className="space-y-5">
      <CompletionCard me={me} />

      <div className="card">
        <SectionTitle action={<Badge value={labelOf(USER_STATUS, user.status, lang)} />}>{t('profile.mine')}</SectionTitle>
        <ReadOnly k={t('profile.name')}>{user.fullName}</ReadOnly>
        <ReadOnly k={t('profile.email')}><bdi dir="ltr">{user.email}</bdi></ReadOnly>
        <ReadOnly k={t('profile.phone')}><bdi dir="ltr">{user.phone ? (/^\d{8,15}$/.test(user.phone) ? `+${user.phone}` : user.phone) : '—'}</bdi></ReadOnly>
        <ReadOnly k={t('profile.code')}><bdi dir="ltr" className="tracking-widest font-bold">{user.code}</bdi></ReadOnly>
        <ReadOnly k={t('profile.memberSince')}>{formatDay(user.createdAt, lang)}</ReadOnly>
        <p className="text-[11.5px] text-[#8A8072] mt-2">{t('profile.editHint')}</p>
      </div>

      <form onSubmit={submit} className="card space-y-3.5" noValidate>
        <SectionTitle>{t('profile.details')}</SectionTitle>
        <Field label={t('missing.partnerType')} required>
          <PartnerTypePicker value={form.partnerType} onChange={(v) => set('partnerType', v)} label={t('missing.partnerType')} />
        </Field>
        {form.partnerType === 'company' && (
          <Field label={t('f.companyName')} required>
            <input className="input" value={form.companyName} onChange={(e) => set('companyName', e.target.value)} maxLength={COMPANY_NAME_MAX} autoComplete="organization" />
          </Field>
        )}
        <Field label={t('f.city')}>
          <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={CITY_MAX} />
        </Field>
        <Field label={t('f.vat')} hint={t('f.vatHint')}>
          <input dir="ltr" className={`input ${ltrFieldAlign(dir)}`} inputMode="numeric" maxLength={17} value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />
        </Field>
        <CheckRow checked={form.marketingConsent} onChange={(v) => set('marketingConsent', v)}>
          {t('profile.marketing')}
        </CheckRow>
        <button type="submit" disabled={save.isPending || !dirty} className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
          {save.isPending ? <Spinner /> : t('profile.save')}
        </button>
      </form>

      <SocialLinksCard me={me} refreshMe={refreshMe} onUserUpdated={onUserUpdated} />
      <PayoutCard me={me} refreshMe={refreshMe} onUserUpdated={onUserUpdated} />
      <DocumentsCard me={me} refreshMe={refreshMe} />
    </div>
  );
}

// ─────────────────────────── روابط التواصل ───────────────────────────

function SocialLinksCard({ me, refreshMe, onUserUpdated }: TabProps) {
  const { t, m, lang, dir } = useAxT();
  const saved = useMemo(() => socialRowsOf(me.user.socialLinks), [me.user.socialLinks]);
  const [rows, setRows] = useState<SocialRow[]>(saved);
  const links = buildSocialLinks(rows);
  const dirty = !sameSocialLinks(links, buildSocialLinks(saved));
  const setRow = (i: number, patch: Partial<SocialRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = useMutation({
    mutationFn: () => affiliateApi.updateMe({ socialLinks: links }),
    onSuccess: (r) => {
      toast.success(t('social.saved'));
      onUserUpdated(r.user);
      setRows(socialRowsOf(r.user.socialLinks));
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'profile.saveFailed'));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = socialLinksError(rows);
    if (err) { toast.error(m(err)); return; }
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="card space-y-3" noValidate>
      <SectionTitle>{t('social.title')}</SectionTitle>
      <p className="text-[12px] text-[#8A8072] -mt-2 leading-relaxed">{t('social.hint', { max: SOCIAL_MAX })}</p>
      {rows.length === 0 && <p className="text-[12.5px] text-[#6E6557]">{t('social.empty')}</p>}
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 items-start">
          <select
            aria-label={t('social.platform')} className="input text-sm shrink-0" style={{ width: 132, paddingInline: '8px' }}
            value={r.platform} onChange={(e) => setRow(i, { platform: e.target.value as SocialPlatform })}
          >
            {SOCIAL_PLATFORM_ORDER.map((p) => <option key={p} value={p}>{textOf(SOCIAL_PLATFORM, p, lang)}</option>)}
          </select>
          <input
            aria-label={t('social.url')} type="url" dir="ltr" inputMode="url" autoComplete="url" spellCheck={false}
            className={`input flex-1 min-w-0 ${ltrFieldAlign(dir)}`} placeholder="https://"
            value={r.url} onChange={(e) => setRow(i, { url: e.target.value })} maxLength={SOCIAL_URL_MAX}
          />
          <button
            type="button" aria-label={t('social.remove')} title={t('social.remove')}
            className="w-10 h-10 shrink-0 rounded-xl border border-[#E9E1D3] bg-white text-[#C0392B] flex items-center justify-center"
            onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        {rows.length < SOCIAL_MAX && (
          <button type="button" className="btn-secondary flex-1 justify-center py-2.5" onClick={() => setRows((rs) => [...rs, { platform: 'instagram', url: '' }])}>
            <Plus size={15} /> {t('social.add')}
          </button>
        )}
        <button type="submit" disabled={save.isPending || !dirty} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
          {save.isPending ? <Spinner /> : t('social.save')}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────── الحساب البنكي ───────────────────────────

function PayoutCard({ me, refreshMe, onUserUpdated }: TabProps) {
  const { t, m, lang, dir } = useAxT();
  const { user } = me;
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
      toast.success(t('payout.saved'));
      onUserUpdated(r.user);
      setEditing(false);
      setIban(''); setHolderName(''); setBankName('');
    },
    onError: (err) => {
      if (httpStatus(err) === 403) refreshMe();
      if (isTermsOutdated(err)) return; // بوابة قبول الشروط تتولّى الشرح
      toast.error(errorText(err, lang, 'payout.saveFailed'));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = payoutError(iban, holderName, bankName);
    if (err) { toast.error(m(err)); return; }
    save.mutate();
  };

  // v2: متاحٌ دائماً — بلا شرط «بعد أول عمولة» (409 مع تسويةٍ قيد المعالجة يأتي من الخادم)
  const showForm = editing || !user.payout;

  return (
    <div className="card space-y-3">
      <SectionTitle>{t('payout.title')}</SectionTitle>
      <p className="text-[12px] text-[#8A8072] -mt-2">{t('payout.hint')}</p>

      {user.payout && (
        <div className="flex items-center gap-3 rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3">
          <span className="w-9 h-9 rounded-lg bg-[#E4F1EA] text-[#1E7A52] flex items-center justify-center shrink-0"><Landmark size={17} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold text-[#1F1A13] break-words">{user.payout.holderName}</p>
            <p className="text-[12px] text-[#6E6557]">
              <bdi dir="ltr">{maskedIban(user.payout.ibanLast4)}</bdi>{user.payout.bankName ? ` · ${user.payout.bankName}` : ''}
            </p>
            <p className="text-[11px] text-[#8A8072]">{t('payout.updatedAt', { date: formatDay(user.payout.updatedAt, lang) })}</p>
          </div>
          {!editing && (
            <button type="button" className="btn-secondary shrink-0" onClick={() => setEditing(true)}>{t('payout.update')}</button>
          )}
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label={t('payout.iban')} required hint={ibanOk ? t('payout.ibanHint') : <span className="text-[#C0392B]">{t('payout.ibanInvalidHint')}</span>}>
            <input
              dir="ltr" className={`input ${ltrFieldAlign(dir)} tracking-wider uppercase`} autoComplete="off" spellCheck={false} maxLength={34}
              value={iban} onChange={(e) => setIban(e.target.value)} placeholder="SA00 0000 0000 0000 0000 0000"
            />
          </Field>
          <Field label={t('payout.holder')} required hint={t('payout.holderHint')}>
            <input className="input" value={holderName} onChange={(e) => setHolderName(e.target.value)} maxLength={120} />
          </Field>
          <Field label={t('payout.bank')}>
            <input className="input" value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={80} />
          </Field>
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
              {save.isPending ? <Spinner /> : t('payout.save')}
            </button>
            {user.payout && (
              <button type="button" className="btn-secondary justify-center" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

// ─────────────────────────── المستندات ───────────────────────────

function DocumentsCard({ me, refreshMe }: { me: MeResponse; refreshMe: () => void }) {
  const { t } = useAxT();
  const kinds: DocKind[] = ['national_id'];
  const hasCr = (me.user.documents ?? []).some((d) => d.kind === 'commercial_reg');
  if (needsCommercialReg(me.user) || hasCr) kinds.push('commercial_reg');
  return (
    <div className="card space-y-3">
      <SectionTitle>{t('docs.title')}</SectionTitle>
      <p className="flex gap-2 text-[12px] text-[#6E6557] -mt-2 leading-relaxed">
        <ShieldCheck size={15} className="shrink-0 mt-0.5 text-[#1E7A52]" />
        <span>{t('docs.hint')}</span>
      </p>
      {kinds.map((k) => <DocSlot key={k} kind={k} me={me} refreshMe={refreshMe} />)}
    </div>
  );
}

/**
 * خانة مستند: تصوير (`capture` — الكاميرا الخلفية مباشرةً على الجوال) أو من الاستديو/الملفات،
 * ثم معاينة واستبدال وحذف. الصورة الكبيرة تُصغَّر قبل الرفع (../files)، والمعاينة تُجلب عند
 * الطلب وحده — والمرفوع للتوّ يُعرض من الذاكرة بلا طلبٍ ثانٍ.
 */
function DocSlot({ kind, me, refreshMe }: { kind: DocKind; me: MeResponse; refreshMe: () => void }) {
  const { t, m, lang } = useAxT();
  const qc = useQueryClient();
  const doc = (me.user.documents ?? []).find((d) => d.kind === kind) ?? null;
  const required = kind === 'national_id' || needsCommercialReg(me.user);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const preview = useQuery({
    queryKey: qk.document(kind), queryFn: () => affiliateApi.documentFile(kind),
    enabled: showPreview && !!doc, retry: shouldRetry, staleTime: 5 * 60_000,
  });

  const upload = useMutation({
    mutationFn: (dataUrl: string) => affiliateApi.uploadDocument(kind, dataUrl).then(() => dataUrl),
    onSuccess: (dataUrl) => {
      toast.success(t('doc.saved'));
      qc.setQueryData(qk.document(kind), { dataUrl });
      setReplacing(false);
      refreshMe();
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (err) => {
      if (isTermsOutdated(err)) return;
      toast.error(httpStatus(err) === 413 ? t('val.docTooLarge', { max: 5 }) : errorText(err, lang, 'doc.failed'));
    },
  });

  const remove = useMutation({
    mutationFn: () => affiliateApi.deleteDocument(kind),
    onSuccess: () => {
      toast.success(t('doc.deleted'));
      qc.removeQueries({ queryKey: qk.document(kind) });
      setShowPreview(false);
      refreshMe();
    },
    onError: (err) => {
      if (isTermsOutdated(err)) return;
      toast.error(errorText(err, lang, 'doc.deleteFailed'));
    },
  });

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // اختيار الملف نفسه مرّةً ثانية يُطلق الحدث من جديد
    if (!file) return;
    setPreparing(true);
    try {
      const prepared = await prepareDocument(file);
      if (!prepared.ok) { toast.error(m(prepared.error)); return; }
      upload.mutate(prepared.dataUrl);
    } catch {
      toast.error(t('doc.failed'));
    } finally {
      setPreparing(false);
    }
  };

  const busy = preparing || upload.isPending || remove.isPending;
  const name = t(DOC_KIND[kind]);
  const pickers = (
    <div className="grid grid-cols-2 gap-2">
      <button type="button" disabled={busy} onClick={() => camera.current?.click()} className="btn-primary justify-center py-2.5 disabled:opacity-60">
        <Camera size={16} /> {t('doc.camera')}
      </button>
      <button type="button" disabled={busy} onClick={() => gallery.current?.click()} className="btn-secondary justify-center py-2.5 disabled:opacity-60">
        <ImageUp size={16} /> {t('doc.gallery')}
      </button>
    </div>
  );
  const dataUrl = preview.data?.dataUrl ?? '';
  const isPdf = (doc?.mime ?? '').includes('pdf') || dataUrl.startsWith('data:application/pdf');

  return (
    <div className="rounded-2xl border border-[#E9E1D3] bg-[#FAF7F0]/60 p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold text-[#1F1A13]">{name}</p>
          <p className="text-[11.5px] text-[#6E6557] mt-0.5">
            {doc
              ? t('doc.uploaded', { date: formatDay(doc.createdAt, lang), size: formatBytes(doc.sizeBytes) })
              : t('doc.notUploaded')}
          </p>
        </div>
        {doc ? <CheckCircle2 size={20} className="shrink-0 text-[#1E7A52]" /> : required && (
          <span className="shrink-0 text-[11px] font-bold text-[#B7791F] bg-[#FDF3DC] rounded-full px-2 py-0.5">{t('doc.required')}</span>
        )}
      </div>

      {/* الكاميرا الخلفية مباشرةً، والاستديو بالصور وPDF — `image/*` يقبل HEIC فيُحوَّل JPEG في المتصفّح */}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e)} />
      <input ref={gallery} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => void onFile(e)} />

      {busy && (
        <p className="flex items-center gap-2 text-[12px] text-[#6E6557]">
          <Spinner size={14} /> {preparing ? t('doc.preparing') : t('common.loading')}
        </p>
      )}

      {!doc ? pickers : (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary py-2 px-3 text-[12.5px]" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? <EyeOff size={14} /> : <Eye size={14} />} {showPreview ? t('doc.hide') : t('doc.view')}
            </button>
            <button type="button" disabled={busy} className="btn-secondary py-2 px-3 text-[12.5px] disabled:opacity-60" onClick={() => setReplacing((v) => !v)}>
              <RefreshCw size={14} /> {t('doc.replace')}
            </button>
            <button
              type="button" disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#F3C9C1] bg-white text-[#C0392B] font-semibold py-2 px-3 text-[12.5px] disabled:opacity-60"
              onClick={() => { if (window.confirm(t('doc.deleteConfirm', { name }))) remove.mutate(); }}
            >
              <Trash2 size={14} /> {t('doc.delete')}
            </button>
          </div>
          {replacing && pickers}
          {showPreview && (
            preview.isLoading ? <Loading /> : preview.isError || !dataUrl ? (
              <ErrorBox err={preview.error} fallback="doc.previewFailed" onRetry={() => void preview.refetch()} />
            ) : isPdf ? (
              <button type="button" className="w-full flex items-center gap-2 rounded-xl bg-white border border-[#E9E1D3] px-3 py-3 text-[13px] font-semibold text-[#1F1A13]" onClick={() => openDataUrl(dataUrl)}>
                <FileText size={18} className="text-[#C0392B]" /> {t('doc.pdf')}
              </button>
            ) : (
              <img src={dataUrl} alt={name} className="w-full max-h-72 object-contain rounded-xl bg-white border border-[#E9E1D3]" />
            )
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────── الشروط ───────────────────────────

export function TermsTab({ me }: { me: MeResponse }) {
  const { t, rich, lang } = useAxT();
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry, staleTime: 60_000 });
  const s = me.settings;
  return (
    <div className="space-y-4">
      <div className="card">
        <SectionTitle>{t('terms.summary')}</SectionTitle>
        <div className="space-y-1.5 text-[13px] text-[#44403a] leading-relaxed">
          <p>{rich('terms.commission', { rate: <bdi dir="ltr">{formatRate(s.rateBps)}</bdi> })}</p>
          <p>{t('terms.hold', { days: daysLabel(s.holdDays, lang) })}</p>
          <p>{t('terms.min', { every: daysLabel(s.settlementEveryDays || SETTLEMENT_EVERY_DAYS, lang), min: formatSar(s.minPayoutHalalas, lang) })}</p>
        </div>
      </div>
      <div className="card">
        <SectionTitle action={terms.data ? <span className="text-[11.5px] text-[#8A8072]" dir="ltr">{terms.data.version}</span> : undefined}>
          {t('terms.label')}
        </SectionTitle>
        {terms.isLoading ? <Loading /> : terms.isError || !terms.data ? (
          <ErrorBox err={terms.error} onRetry={() => void terms.refetch()} />
        ) : (
          <ArabicTermsBody body={terms.data.body} className="text-[13.5px] leading-7 text-[#44403a]" />
        )}
        <p className="text-[11.5px] text-[#8A8072] mt-3 pt-3 border-t border-[#F1EBDF]">
          {rich('terms.acceptedVersion', { version: <bdi dir="ltr">{me.user.termsVersion}</bdi> })}
        </p>
      </div>
    </div>
  );
}

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { companyApi } from '../api/client';
import { supportedCountries, getCountry } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { Building2, Save, Upload, Trash2, Image as ImageIcon, ShieldCheck, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { Header } from '../rep/RepDocuments';
import DataImportPanel from '../components/DataImportPanel';
import { useAccountingOn } from '../components/AccountingGate';
import { keepLocalEdits } from '../components/zatca/settingsMerge';
import { LOCKED_INPUT_CLASS, SELLER_LOCK_HINT_ID, companySaveErrorMessage, companySaveNeedsRefetch, withoutLockedSellerFields, zatcaCountryChoiceAllowed, zatcaSellerFieldsLocked, zatcaSellerLockHint, zatcaTabVisible } from '../components/zatca/zatcaAccess';
import ZatcaTabBoundary from '../components/zatca/ZatcaTabBoundary';
import { useAuthStore } from '../store/authStore';

// تبويب ربط فوترة المرحلة الثانية كسول: لا يُحمَّل (ولا عباراته) إلا لشركة فعّل لها المالك العلم وفتحت التبويب
const loadZatcaPhase2Tab = () => import('../components/zatca/ZatcaPhase2Tab');

interface CompanyForm {
  name: string;
  address?: string;
  taxNumber?: string;
  commercialReg?: string;
  phone?: string;
  email?: string;
}

interface IdentityState { logo: string; primaryColor: string; headerStyle: string; countryCode: string; currencyOverride: string; numerals: string }
interface EinvState { enabled: boolean; env: string; clientId: string; clientSecret: string; activityCode: string; branchCode: string; intermediaryUrl: string }
/** ما أُرسل في الحفظ — يصير خطّ الأساس بعد نجاحه (ما لم يُعدَّل بعده يأخذ قيمة الخادم عند التحديث، ومنها ما طبّعه).
 * sellerLocked: الرقم الضريبي والسجل والدولة للاطلاع وقت الإرسال ⇒ لا تُرسل (withoutLockedSellerFields). */
interface SaveSnapshot { form: CompanyForm; state: IdentityState; einv: EinvState; sellerLocked: boolean }

const PRESET_COLORS = ['#1e3a8a', '#0f766e', '#b91c1c', '#7c3aed', '#b45309', '#0e7490', '#15803d', '#374151'];
const STYLES = [
  { id: 'classic', label: 'كلاسيكي', desc: 'الشعار والاسم يمينا حد ملون' },
  { id: 'banner', label: 'بانر', desc: 'شريط ملون كامل بالأبيض' },
  { id: 'minimal', label: 'بسيط', desc: 'هادئ بخط رفيع' },
];

export default function CompanySettingsPage() {
  const qc = useQueryClient();
  // المحاسبة مطفأة ⇒ تختفي من الإعدادات: نسبة الضريبة والفوترة الإلكترونية
  // وعملة الفواتير ومعاينة «فاتورة ضريبية» واستيراد الأصناف والأسعار
  // (مساراه /import/products و/import/prices محروسان بالخادم فيردّان ٤٠٣).
  const { on: accountingFlag, ready: accountingReady } = useAccountingOn();
  const accountingOn = accountingReady && accountingFlag;
  const tr = useTr();
  const { register, handleSubmit, reset, getValues, formState: { errors } } = useForm<CompanyForm>();
  // الهوية البصرية تُدار بـ state عادي لضمان إرسالها بدقّة
  const [logo, setLogo] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#1e3a8a');
  const [headerStyle, setHeaderStyle] = useState('classic');
  const [countryCode, setCountryCode] = useState('SA'); // دولة الشركة (تُشتقّ منها العملة والضريبة)
  const [currencyOverride, setCurrencyOverride] = useState(''); // '' = عملة الدولة | USD | EUR
  const [numerals, setNumerals] = useState('arabic'); // شكل الأرقام: arabic ٠١٢٣ | latin 0123
  // بيانات ربط الفوترة الإلكترونية (السرّ لا يُعاد من الخادم — hasSecret يشير إن كان مضبوطاً)
  const [einv, setEinv] = useState<EinvState>({ enabled: false, env: 'preprod', clientId: '', clientSecret: '', activityCode: '', branchCode: '', intermediaryUrl: '' });
  const [hasSecret, setHasSecret] = useState(false);
  // تبويب ربط فوترة المرحلة الثانية — يظهر فقط بعلم المالك وللشركة السعودية ولمدير الشركة (ADMIN) وحده (الخادم يفرض الشروط نفسها).
  // جلسة دخول مالك المنصة تحمل دور الحساب الذي دخل به ونطاقه فتعمل كذلك الحساب (قرار المالك 17 سبتمبر 2026)
  const role = useAuthStore(s => s.user?.role);
  const scopeEnabled = useAuthStore(s => s.user?.scopeEnabled === true);
  const [tab, setTab] = useState<'general' | 'zatca'>('general');
  // يُركَّب عند أول فتح ثم يبقى مخفيّاً لا مُزالاً: التنقّل بين التبويبين لا يمحو ما لم يُحفظ في أيٍّ منهما
  const [zatcaMounted, setZatcaMounted] = useState(false);
  // «إعادة المحاولة» بعد فشل تحميل حزمة التبويب: React.lazy يحفظ الوعد المرفوض ⇒ مكوّن كسول جديد لكل محاولة
  const [zatcaAttempt, setZatcaAttempt] = useState(0);
  const ZatcaPhase2Tab = useMemo(() => lazy(loadZatcaPhase2Tab), [zatcaAttempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // خطّ الأساس لكل حقل (آخر قيم طُبّقت من الخادم، أو ما أُرسل بعد حفظ ناجح) — تحديث ['company'] (حفظ بيانات المنشأة من تبويب
  // الفوترة، أو إعادة جلب) يأخذ قيمة الخادم لكل حقل لم يعدّله المدير عن خطّ الأساس ويُبقي ما عدّله ولم يحفظه
  const appliedRef = useRef<{ data: unknown; form: CompanyForm; state: IdentityState; einv: EinvState } | null>(null);
  const setE = (k: keyof typeof einv, v: string | boolean) => setEinv(s => ({ ...s, [k]: v }));

  const { data, isLoading } = useQuery({
    queryKey: ['company'],
    queryFn: async () => {
      const res = await companyApi.get();
      return res.data.data as (CompanyForm & { logo?: string; primaryColor?: string; headerStyle?: string; countryCode?: string; currency?: string; defaultVatPct?: number;
        einvoiceEnabled?: boolean; einvoiceEnv?: string; einvoiceClientId?: string; einvoiceActivityCode?: string; einvoiceBranchCode?: string; einvoiceIntermediaryUrl?: string; einvoiceHasSecret?: boolean }) | null;
    },
  });

  useEffect(() => {
    if (!data) return;
    const applied = appliedRef.current;
    if (applied?.data === data) return; // التأثير نفسه مرة ثانية (StrictMode) بقيم محلية لم تُرسم بعد
    const nextForm: CompanyForm = {
      name: data.name || '', address: data.address || '', taxNumber: data.taxNumber || '',
      commercialReg: data.commercialReg || '', phone: data.phone || '', email: data.email || '',
    };
    // أول تحميل: كل القيم من الخادم. بعده دمج حقلاً بحقل ثم reset عادي — لا خيار keepDirtyValues (RHF يُبقي معه dirtyFields القديمة
    // بعد الحفظ فيرفض الحقلُ كل قيمة لاحقة من الخادم، ويعيد الحفظ التالي كتابة القيمة القديمة فوق تعديل تبويب الفوترة)
    reset(keepLocalEdits(applied?.form ?? null, nextForm, { ...nextForm, ...getValues() }));
    const nextState: IdentityState = {
      logo: data.logo || '',
      primaryColor: data.primaryColor || '#1e3a8a',
      headerStyle: data.headerStyle || 'classic',
      countryCode: data.countryCode || 'SA',
      currencyOverride: (data as { currencyOverride?: string | null }).currencyOverride || '',
      numerals: (data as { numerals?: string | null }).numerals || 'arabic',
    };
    const nextEinv: EinvState = {
      enabled: data.einvoiceEnabled || false,
      env: data.einvoiceEnv || 'preprod',
      clientId: data.einvoiceClientId || '',
      clientSecret: '', // لا يُعاد أبداً — يُترك فارغاً
      activityCode: data.einvoiceActivityCode || '',
      branchCode: data.einvoiceBranchCode || '',
      intermediaryUrl: data.einvoiceIntermediaryUrl || '',
    };
    appliedRef.current = { data, form: nextForm, state: nextState, einv: nextEinv };
    const st = keepLocalEdits(applied?.state ?? null, nextState, { logo, primaryColor, headerStyle, countryCode, currencyOverride, numerals });
    setLogo(st.logo);
    setPrimaryColor(st.primaryColor);
    setHeaderStyle(st.headerStyle);
    setCountryCode(st.countryCode);
    setCurrencyOverride(st.currencyOverride);
    setNumerals(st.numerals);
    setEinv(keepLocalEdits(applied?.einv ?? null, nextEinv, einv));
    setHasSecret(!!data.einvoiceHasSecret);
  }, [data, reset]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation({
    mutationFn: ({ form: values, state: st, einv: e, sellerLocked: locked }: SaveSnapshot) => companyApi.update(withoutLockedSellerFields({
      ...values, ...st,
      einvoiceEnabled: e.enabled, einvoiceEnv: e.env,
      einvoiceClientId: e.clientId, einvoiceActivityCode: e.activityCode,
      einvoiceBranchCode: e.branchCode, einvoiceIntermediaryUrl: e.intermediaryUrl,
      // السرّ يُرسَل فقط إن كُتب من جديد (فارغ = أبقِ الحالي)
      ...(e.clientSecret.trim() ? { einvoiceClientSecret: e.clientSecret.trim() } : {}),
    }, locked)),
    onSuccess: (_res, sent) => {
      // ما أُرسل وحُفظ صار خطّ الأساس: التحديث التالي يأخذ قيمة الخادم لكل حقل لم يُعدَّل بعد الإرسال (ومنها ما طبّعه الخادم أو
      // غيّره تبويب الفوترة لاحقاً)، ويُبقي ما كُتب أثناء الحفظ
      if (appliedRef.current) appliedRef.current = { ...appliedRef.current, form: sent.form, state: sent.state, einv: { ...sent.einv, clientSecret: '' } };
      setEinv(s => ({ ...s, clientSecret: '' })); // أُرسل وحُفظ — لا يبقى في الخانة (التحديث التالي يُبقي ما عُدِّل فقط)
      qc.invalidateQueries({ queryKey: ['company'] });
      // الرقم الضريبي والسجل والعملة تغذّي جاهزية تبويب الفوترة الإلكترونية
      qc.invalidateQueries({ queryKey: ['zatca', 'overview'] });
      toast.success(tr('تم حفظ بيانات الشركة'));
    },
    // رفض حارس حقول البائع (المدير وحده، النطاق، صيغة الرقم الضريبي) بعبارته مترجمة — وغيره كما كان.
    // رفض الصلاحية يعيد جلب ['company'] (تبقى تعديلات الحقول الأخرى) فلا يتكرّر 403 حتى إعادة تحميل الصفحة
    onError: (err: unknown) => {
      if (companySaveNeedsRefetch(err)) qc.invalidateQueries({ queryKey: ['company'] });
      const sellerError = companySaveErrorMessage(err);
      toast.error(sellerError ? tr(sellerError) : tr('حدث خطأ في الحفظ'));
    },
  });

  const onLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error(tr('الملف يجب أن يكون صورة')); return; }
    if (file.size > 600 * 1024) { toast.error(tr('حجم الشعار كبير الحد 600 كيلوبايت')); return; }
    const reader = new FileReader();
    reader.onload = () => setLogo(reader.result as string);
    reader.readAsDataURL(file);
  };

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const previewCompany = {
    name: data?.name || tr('اسم الشركة'), address: data?.address, taxNumber: data?.taxNumber,
    commercialReg: data?.commercialReg, phone: data?.phone, email: data?.email,
    logo, primaryColor, headerStyle,
  };

  const zatcaTabOn = zatcaTabVisible(data, role, scopeEnabled);
  const showZatca = zatcaTabOn && tab === 'zatca';
  // شركة سعودية (أو بلا دولة محفوظة) بعلم المالك: الرقم الضريبي والسجل والدولة لمدير الشركة غير المقيّد وحده (الخادم يرفض غيره
  // 403 SELLER_FIELDS_*)؛ وغير السعودية تبقى قابلة للتعديل بلا خيار السعودية (zatcaCountryChoiceAllowed)
  const sellerLocked = zatcaSellerFieldsLocked(data, role, scopeEnabled);
  // الحقل المقفل يبدو مقفلاً (لا حقلاً يتجاهل الكتابة صامتاً) ويُقرأ معه سبب القفل
  const lockedProps = sellerLocked ? { 'aria-describedby': SELLER_LOCK_HINT_ID, title: tr(zatcaSellerLockHint(role, scopeEnabled)) } : {};

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إعدادات الشركة')}</h1>
      </div>

      {zatcaTabOn && (
        <div className="flex gap-2 mb-5 overflow-x-auto pb-1" role="tablist">
          {([
            { id: 'general', label: tr('الإعدادات العامة') },
            { id: 'zatca', label: tr('الفوترة الإلكترونية — المرحلة الثانية (فاتورة)') },
          ] as const).map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); if (t.id === 'zatca') setZatcaMounted(true); }}
              className={`shrink-0 whitespace-nowrap rounded-xl border-2 px-4 py-2 text-sm font-semibold transition-colors ${tab === t.id ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a] hover:border-[#D8CDB9]'}`}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {zatcaTabOn && zatcaMounted && (
        <div hidden={!showZatca}>
          {/* فشل تحميل الحزمة أو خطأ داخل التبويب: لافتة وإعادة محاولة هنا — لا صفحة بيضاء تُسقط النموذج العام وتعديلاته */}
          <ZatcaTabBoundary onRetry={() => setZatcaAttempt(n => n + 1)}>
            <Suspense fallback={(
              <div className="flex items-center justify-center h-48">
                <div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
              </div>
            )}>
              <ZatcaPhase2Tab />
            </Suspense>
          </ZatcaTabBoundary>
        </div>
      )}

      <div hidden={showZatca}>
      <form onSubmit={handleSubmit(values => mutation.mutate({
        form: values, state: { logo, primaryColor, headerStyle, countryCode, currencyOverride, numerals }, einv, sellerLocked,
      }))} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* العمود الأيمن: البيانات + الهوية */}
        <div className="space-y-5">
          <div className="card">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-11 h-11 bg-[#FBEBE2] rounded-xl flex items-center justify-center">
                <Building2 size={22} className="text-[#E15A30]" />
              </div>
              <div>
                <p className="font-semibold text-gray-800">{tr('بيانات الشركة')}</p>
                <p className="text-xs text-gray-400">{tr('تظهر في ترويسة كل المطبوعات')}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="label">{tr('اسم الشركة')} *</label>
                <input className="input" {...register('name', { required: true })} />
                {errors.name && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
              </div>
              <div>
                <label className="label">{tr('العنوان')}</label>
                <input className="input" {...register('address')} placeholder={tr('المدينة - الحي - الشارع')} />
              </div>
              <div>
                <label className="label">{tr('الدولة تحدد العملة والضريبة والفوترة الإلكترونية')}</label>
                <select className={`input ${sellerLocked ? LOCKED_INPUT_CLASS : ''}`} value={countryCode} disabled={sellerLocked} {...lockedProps} onChange={e => setCountryCode(e.target.value)}>
                  {supportedCountries().filter(c => zatcaCountryChoiceAllowed(c.code, data, role, scopeEnabled)).map(c => (
                    <option key={c.code} value={c.code}>{c.nameAr} — {c.currency}</option>
                  ))}
                </select>
                {accountingOn && (() => { const c = getCountry(countryCode); return (
                  <p className="text-[11px] text-[#6E6557] mt-1.5 leading-relaxed bg-[#FAF7F0] rounded-lg px-3 py-2 border border-[#E9E1D3]">
                    {tr('العملة')}: <b>{currencyOverride ? (currencyOverride === 'USD' ? '$ (USD)' : '€ (EUR)') : `${c.symbolAr} (${c.currency})`}</b> · {tr('الضريبة الافتراضية')}: <b>{c.defaultVatPct}%</b><br />
                    {tr('الفوترة الإلكترونية')}: <b>{c.einvoiceNoteAr}</b>
                  </p>
                ); })()}
              </div>
              {accountingOn && (
              <div>
                <label className="label">{tr('عملة التشغيل')}</label>
                <select className="input" value={currencyOverride} onChange={e => setCurrencyOverride(e.target.value)}>
                  <option value="">{tr('عملة الدولة (الافتراضي)')} — {getCountry(countryCode).currency}</option>
                  <option value="USD">{tr('دولار امريكي')} — USD $</option>
                  <option value="EUR">{tr('يورو')} — EUR €</option>
                </select>
                <p className="text-[11px] text-[#6E6557] mt-1.5">{tr('تغير عملة الفواتير والسندات والتقارير كلها — الضريبة والفوترة الالكترونية تبقى حسب الدولة')}</p>
              </div>
              )}
              <div>
                <label className="label">{tr('شكل الارقام')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { v: 'arabic', label: tr('ارقام عربية'), sample: '١٢٣٤٥٦٫٧٨' },
                    { v: 'latin', label: tr('ارقام انجليزية'), sample: '123456.78' },
                  ] as const).map(o => (
                    <button key={o.v} type="button" onClick={() => setNumerals(o.v)}
                      className={`rounded-xl border-2 px-3 py-2 text-right transition-colors ${numerals === o.v ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white hover:border-[#D8CDB9]'}`}>
                      <span className="block text-[12.5px] font-bold text-[#1F1A13]">{o.label}</span>
                      <span className="block text-[12px] mt-0.5" dir="ltr" style={{ color: numerals === o.v ? '#E15A30' : '#9A8F7E' }}>{o.sample}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[#6E6557] mt-1.5">{tr('يسري على المبالغ والكميات والتواريخ في اللوحة وتطبيق المندوب والتقارير — الواجهة الانجليزية تبقى بارقام انجليزية دائما')}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">{tr('الرقم الضريبي')}</label>
                  <input className={`input ${sellerLocked ? LOCKED_INPUT_CLASS : ''}`} dir="ltr" readOnly={sellerLocked} {...lockedProps} {...register('taxNumber')} />
                </div>
                <div>
                  <label className="label">{tr('السجل التجاري')}</label>
                  <input className={`input ${sellerLocked ? LOCKED_INPUT_CLASS : ''}`} dir="ltr" readOnly={sellerLocked} {...lockedProps} {...register('commercialReg')} />
                </div>
                {sellerLocked && (
                  <p id={SELLER_LOCK_HINT_ID} className="col-span-2 -mt-2 text-[11px] text-[#6E6557] flex items-start gap-1.5">
                    <Lock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {tr(zatcaSellerLockHint(role, scopeEnabled))}
                  </p>
                )}
                <div>
                  <label className="label">{tr('رقم الهاتف')}</label>
                  <input className="input" dir="ltr" {...register('phone')} />
                </div>
                <div>
                  <label className="label">{tr('البريد الإلكتروني')}</label>
                  <input className="input" type="email" dir="ltr" {...register('email')} />
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-11 h-11 bg-purple-100 rounded-xl flex items-center justify-center">
                <ImageIcon size={22} className="text-purple-600" />
              </div>
              <div>
                <p className="font-semibold text-gray-800">{tr('هوية الشركة في المطبوعات')}</p>
                <p className="text-xs text-gray-400">{tr('الشعار واللون والشكل')}</p>
              </div>
            </div>

            {/* الشعار */}
            <div className="mb-5">
              <label className="label">{tr('شعار الشركة')}</label>
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 flex-shrink-0">
                  {logo
                    ? <img src={logo} alt={tr('شعار الشركة')} className="w-full h-full object-contain" />
                    : <ImageIcon size={22} className="text-gray-300" />}
                </div>
                <div className="flex flex-col gap-2">
                  <label className="btn-secondary cursor-pointer text-xs">
                    <Upload size={14} /> {tr('اختيار صورة')}
                    <input type="file" accept="image/*" className="hidden" onChange={onLogoChange} />
                  </label>
                  {logo && (
                    <button type="button" onClick={() => setLogo('')} className="text-red-500 text-xs flex items-center gap-1">
                      <Trash2 size={12} /> {tr('إزالة الشعار')}
                    </button>
                  )}
                  <span className="text-[10px] text-gray-400">PNG/JPG — 600KB</span>
                  <span className="text-[10px] text-gray-500">{tr('يظهر الشعار في رأس كل صفحات حسابك وتطبيق الإدارة وتطبيق المندوب وفي الفواتير والسندات')}</span>
                </div>
              </div>
            </div>

            {/* اللون */}
            <div className="mb-5">
              <label className="label">{tr('لون الترويسة')}</label>
              <div className="flex items-center gap-2 flex-wrap">
                <input type="color" className="w-10 h-9 rounded border border-gray-200 cursor-pointer p-0.5"
                  value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} />
                <span className="font-mono text-xs text-gray-500" dir="ltr">{primaryColor}</span>
                <div className="flex gap-1.5 mr-2">
                  {PRESET_COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setPrimaryColor(c)}
                      className={`w-6 h-6 rounded-full border-2 ${primaryColor === c ? 'border-gray-800' : 'border-white shadow'}`}
                      style={{ background: c }} title={c} />
                  ))}
                </div>
              </div>
            </div>

            {/* الشكل */}
            <div>
              <label className="label">{tr('شكل الترويسة')}</label>
              <div className="grid grid-cols-3 gap-2">
                {STYLES.map(s => (
                  <button key={s.id} type="button" onClick={() => setHeaderStyle(s.id)}
                    className={`text-right p-3 rounded-xl border-2 transition-all ${headerStyle === s.id ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-gray-100 hover:border-gray-200'}`}>
                    <p className="font-semibold text-sm text-gray-800">{tr(s.label)}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{tr(s.desc)}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* الفوترة الإلكترونية (الربط الحكومي) — بيانات الربط تُدخلها الشركة */}
          {accountingOn && (
          <div className="card">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-11 h-11 bg-[#E4F1EA] rounded-xl flex items-center justify-center">
                <ShieldCheck size={22} className="text-[#1E7A52]" />
              </div>
              <div>
                <p className="font-semibold text-gray-800">{tr('الفوترة الإلكترونية الربط الحكومي')}</p>
                <p className="text-xs text-gray-400">{tr('بيانات الربط تدخلها شركتك لا نطلع على السر')}</p>
              </div>
            </div>

            {(() => {
              const prov = getCountry(countryCode).einvoice;
              if (prov === 'zatca') return (
                <div className="text-sm text-[#1F5C3F] bg-[#E4F1EA] border border-[#C9E4D6] rounded-xl px-4 py-3 leading-relaxed">
                  {tr('نظام ZATCA السعودية يعمل تلقائيا برمز QR على كل فاتورة لا يحتاج بيانات ربط')}
                </div>
              );
              if (prov === 'none') return (
                <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 leading-relaxed">
                  {tr('لا توجد فوترة إلكترونية إلزامية في دولتك حاليا تصدر فواتير عادية بعملة وضريبة دولتك')}
                </div>
              );
              const provLabel = prov === 'eta' ? 'ETA مصر' : prov === 'peppol' ? 'Peppol الإمارات' : 'TTN تونس';
              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3 bg-[#FBEBE2] border border-[#E8C9BC] rounded-xl px-4 py-2.5 flex-wrap">
                    <span className="text-sm font-semibold text-[#C94E28]">{tr('المزود')}: {provLabel}</span>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={einv.enabled} onChange={e => setE('enabled', e.target.checked)} />
                      {tr('تفعيل الإرسال الحكومي')}
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">{tr('البيئة')}</label>
                      <select className="input" value={einv.env} onChange={e => setE('env', e.target.value)}>
                        <option value="preprod">{tr('اختبار Preprod')}</option>
                        <option value="production">{tr('إنتاج Production')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Client ID</label>
                      <input className="input" dir="ltr" value={einv.clientId} onChange={e => setE('clientId', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="label">Client Secret</label>
                      <input className="input" type="password" dir="ltr" autoComplete="new-password" value={einv.clientSecret}
                        onChange={e => setE('clientSecret', e.target.value)}
                        placeholder={hasSecret ? tr('•••••••• محفوظ اكتب قيمة جديدة لتغييره') : tr('السر من بوابة المزود')} />
                    </div>
                    <div>
                      <label className="label">{tr('كود النشاط')}</label>
                      <input className="input" dir="ltr" value={einv.activityCode} onChange={e => setE('activityCode', e.target.value)} />
                    </div>
                    <div>
                      <label className="label">{tr('كود الفرع')}</label>
                      <input className="input" dir="ltr" value={einv.branchCode} onChange={e => setE('branchCode', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="label">{tr('رابط الوسيط/المجمع اختياري')}</label>
                      <input className="input" dir="ltr" value={einv.intermediaryUrl} onChange={e => setE('intermediaryUrl', e.target.value)} placeholder="https://..." />
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400 leading-relaxed">
                    {tr('احصل على هذه البيانات بعد تسجيل شركتك في منظومة الفوترة الإلكترونية والحصول على الختم الإلكتروني أو عبر وسيط معتمد')}
                  </p>
                </div>
              );
            })()}
          </div>
          )}

          <button type="submit" disabled={mutation.isPending} className="btn-primary px-6 py-2.5">
            {mutation.isPending
              ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <Save size={16} />}
            {tr('حفظ الإعدادات')}
          </button>
        </div>

        {/* العمود الأيسر: المعاينة الحيّة — ترويسة فاتورة ضريبية، فتُحذف مع المحاسبة */}
        {accountingOn && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-gray-500">{tr('معاينة الترويسة كما ستظهر في المطبوعات')}</p>
          <div className="card bg-white p-0 overflow-hidden">
            <div style={{ width: 754, transformOrigin: 'top right', transform: 'scale(0.62)' }} className="p-5">
              <Header title={tr('فاتورة ضريبية')} company={previewCompany} />
            </div>
            <div style={{ height: 130 }} />
          </div>
          <p className="text-xs text-gray-400">{tr('التغييرات تظهر فورا هنا وتنعكس على الفواتير وسندات القبض وكشوف الحساب بعد الحفظ')}</p>
        </div>
        )}
      </form>

      {/* استيراد بيانات الشركة السابقة — أصنافٌ وأسعار: يختفي مع المحاسبة */}
      {accountingOn && (
        <div id="data-import" className="mt-6 scroll-mt-4">
          <DataImportPanel />
        </div>
      )}
      </div>
    </div>
  );
}

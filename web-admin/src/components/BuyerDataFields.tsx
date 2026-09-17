import { useTr } from '../i18n/strings';
import { useLang } from '../i18n/lang';
import { supportedCountries } from '../i18n/countries';
import { BUYER_ID_SCHEMES } from '../lib/zatca/validators';
import { BuyerField, BuyerRowLike, missingBuyerFormFields } from '../lib/zatca/buyerData';
import {
  BUYER_CLASSIFICATION_LABELS_AR, BUYER_FIELD_UI_LABELS_AR as BUYER_FIELD_LABELS_AR, BUYER_ID_SCHEME_LABELS_AR, BuyerFormValues, liveBuyerStatus,
} from '../lib/zatca/buyerForm';

/**
 * فوترة ZATCA المرحلة الثانية (Z5.1a، D2) — قسم «بيانات الفوترة الإلكترونية (المشتري)» في بطاقة العميل.
 *
 * مشترك بين لوحة الإدارة و/m وتطبيق المندوب (الأصناف `label`/`input` نفسها في الثلاثة). **لا يُرسم إلا حين
 * zatcaCollectOn(company)** — يقرّر ذلك المضيف، فغير المعلَّمين لا يرون حقلاً جديداً. لا يمنع الحفظ ولا البيع قبل التفعيل:
 * الحالة والنواقص إعلامية، والأخطاء صيغٌ فقط (يفحصها الخادم أيضاً).
 *
 * include='phase2': الحقول الجديدة وحدها (المضيف يعرض الاسم والرقم الضريبي والسجل والمدينة والحي في أقسامه).
 * include='all': كل حقول الفوترة (نموذج المندوب الضيّق — Q3).
 */
export default function BuyerDataFields({ values, onChange, stored, include = 'phase2', errors, title = true, locked }: {
  values: Partial<BuyerFormValues> & { name?: string; channel?: string };
  onChange: (field: BuyerField, value: string) => void;
  stored?: BuyerRowLike | null;
  include?: 'phase2' | 'all';
  errors?: Partial<Record<BuyerField, string>>;
  title?: boolean;
  /** حقل للعرض فقط (نموذج المندوب بلا صلاحية تعديل العملاء — Q3: repCompleteLocked). غيابه = كل الحقول قابلة للتعديل كما كانت. */
  locked?: (field: BuyerField) => boolean;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const status = liveBuyerStatus(stored, values);
  const missing = missingBuyerFormFields(status);
  const b2b = status.subtypeIfIssuedNow === '01';

  const errorOf = (f: BuyerField) => {
    const m = errors?.[f];
    if (!m) return null;
    // رسائل القواعد عربية (نسخة الخادم)؛ بغير العربية اسم الحقل وعبارة عامة مترجمة
    return <p className="text-red-500 text-[11px] mt-1">{lang === 'ar' ? m : `${tr(BUYER_FIELD_LABELS_AR[f])}: ${tr('قيمة غير صحيحة')}`}</p>;
  };
  const need = (f: BuyerField) => (b2b && missing.includes(f) ? <span className="text-[#B7791F]"> •</span> : null);
  const isLocked = (f: BuyerField) => locked?.(f) === true;
  const text = (f: BuyerField, o: { ltr?: boolean; numeric?: boolean; wide?: boolean } = {}) => (
    <div className={o.wide ? 'col-span-2' : undefined}>
      <label className="label">{tr(BUYER_FIELD_LABELS_AR[f])}{need(f)}</label>
      <input className="input" dir={o.ltr ? 'ltr' : undefined} inputMode={o.numeric ? 'numeric' : undefined} disabled={isLocked(f)}
        value={values[f] ?? ''} onChange={e => onChange(f, e.target.value)} />
      {errorOf(f)}
    </div>
  );

  return (
    <div data-zatca-buyer-section="">
      {title && <h3 className="text-sm font-semibold text-gray-500 mb-2">{tr('بيانات الفوترة الإلكترونية المشتري')}</h3>}
      <div className={`rounded-xl border px-3 py-2 mb-3 text-[12px] leading-relaxed ${b2b && !status.complete ? 'border-amber-200 bg-amber-50 text-amber-800' : status.classification === 'unclassified' ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-green-200 bg-green-50 text-green-800'}`}>
        <p className="font-semibold">{tr('التصنيف')}: {tr(BUYER_CLASSIFICATION_LABELS_AR[status.classification])}</p>
        {b2b ? (
          status.complete
            ? <p>{tr('بيانات الفاتورة الضريبية مكتملة')}</p>
            : <p>{tr('ناقص للفاتورة الضريبية')}: {missing.map(f => tr(BUYER_FIELD_LABELS_AR[f])).join('، ')}</p>
        ) : status.classification === 'unclassified' ? (
          <p>{tr('حدد نوع العميل هل هو منشأة أم فرد')}</p>
        ) : (
          <p>{tr('تصدر له فاتورة مبسطة')}</p>
        )}
        <p className="text-[11px] opacity-80">{tr('تجمع الآن استعدادا للربط مع هيئة الزكاة ولا تمنع الحفظ أو البيع')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{tr(BUYER_FIELD_LABELS_AR.buyerType)}</label>
          <select className="input" value={values.buyerType ?? ''} disabled={isLocked('buyerType')} onChange={e => onChange('buyerType', e.target.value)}>
            <option value="">{tr('غير محدد')}</option>
            <option value="BUSINESS">{tr('منشأة')}</option>
            <option value="INDIVIDUAL">{tr('فرد')}</option>
            <option value="GOVERNMENT">{tr('جهة حكومية')}</option>
          </select>
          {errorOf('buyerType')}
        </div>
        <div>
          <label className="label">{tr(BUYER_FIELD_LABELS_AR.countryCode)}</label>
          <select className="input" value={values.countryCode ?? ''} disabled={isLocked('countryCode')} onChange={e => onChange('countryCode', e.target.value)}>
            <option value="">{tr('السعودية افتراضي')}</option>
            {supportedCountries().map(c => (
              <option key={c.code} value={c.code}>{lang === 'ar' ? c.nameAr : c.nameEn}</option>
            ))}
            {values.countryCode && !supportedCountries().some(c => c.code === values.countryCode) && (
              <option value={values.countryCode}>{values.countryCode}</option>
            )}
          </select>
          {errorOf('countryCode')}
        </div>

        {include === 'all' && text('businessName', { wide: true })}
        {include === 'all' && text('taxNumber', { ltr: true, numeric: true })}
        {include === 'all' && text('commercialReg', { ltr: true })}

        <div>
          <label className="label">{tr(BUYER_FIELD_LABELS_AR.buyerIdScheme)}{need('buyerIdScheme')}</label>
          <select className="input" value={values.buyerIdScheme ?? ''} disabled={isLocked('buyerIdScheme')} onChange={e => onChange('buyerIdScheme', e.target.value)}>
            <option value="">{tr('بلا معرف آخر')}</option>
            {BUYER_ID_SCHEMES.map(s => <option key={s} value={s}>{`${s} — ${tr(BUYER_ID_SCHEME_LABELS_AR[s])}`}</option>)}
          </select>
          {errorOf('buyerIdScheme')}
        </div>
        {text('buyerIdValue', { ltr: true })}

        {text('addrStreet', { wide: true })}
        {include === 'all' && text('city')}
        {include === 'all' && text('district')}
        {text('addrBuildingNo', { ltr: true, numeric: true })}
        {text('addrAdditionalNo', { ltr: true, numeric: true })}
        {text('addrPostalCode', { ltr: true, numeric: true })}
      </div>
    </div>
  );
}

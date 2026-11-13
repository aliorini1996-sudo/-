import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { Customer } from '../../types';
import { useTr } from '../../i18n/strings';
import { priceListApi } from '../../api/client';
import { baseLabelOf, priceListsOf } from '../../lib/priceLists';
import { SALES_CHANNELS } from '../../lib/channels';
import { X, MapPin, Images } from 'lucide-react';
import CustomerDocsPicker from '../CustomerDocsPicker';
import { PickedDoc, docsPayload } from '../../lib/customerDocs';
import BuyerDataFields from '../BuyerDataFields';
import { BUYER_PHASE2_FIELDS, BuyerRowLike } from '../../lib/zatca/buyerData';
import { BuyerFormValues, buyerFormHints, buyerFormValues, buyerRelaxWarnings } from '../../lib/zatca/buyerForm';
import { CUSTOMER_PHONE_MAX, trimCustomerPhone } from '../../lib/customerPhoneField';

// locationUrl حقل إدخال فقط (يحلّه الخادم إلى lat/lng) — ليس حقلاً مخزّناً
type CustomerForm = Partial<Customer> & { locationUrl?: string; documents?: PickedDoc[] };

interface Props {
  customer: Customer | null;
  onClose: () => void;
  onSave: (data: CustomerForm) => void;
  loading: boolean;
  /** المحاسبة مفعّلة؟ افتراضه `true` — الغياب يعني «مفعّل» كما في العَلَم نفسه */
  accountingOn?: boolean;
  /** فوترة ZATCA (Z5.1a، D2): الشركة تجمع بيانات الفوترة؟ (zatcaCollectOn) — false ⇒ النموذج كما اليوم بلا قسم ولا فحص */
  zatcaCollect?: boolean;
  /** فكّ قيد الرقم الضريبي والعنوان الوطني (buyerRelaxOn — طلب المالك ٣١ أكتوبر ٢٠٢٦): صيغها تنبيهات لا تمنع الحفظ. غيابه = القيد قائم */
  buyerRelax?: boolean;
  /** «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): الشركة بلا ضريبة (isTaxOff) — لا خانة الرقم الضريبي، والمحفوظ يُرسل كما هو بلا تغيير */
  taxOff?: boolean;
  /** «استديو العميل» (١٣ نوفمبر ٢٠٢٦): في التعديل تُدار الوثائق من الاستديو — زرٌّ يفتحه */
  onOpenStudio?: () => void;
}

/** حقول المرحلة الثانية من الحالة المحكومة (الرقم الضريبي والسجل والمدينة والحي والاسم من حقول النموذج المسجّلة). */
const pickPhase2 = (b: BuyerFormValues): Partial<BuyerFormValues> =>
  Object.fromEntries(BUYER_PHASE2_FIELDS.map(f => [f, b[f]])) as Partial<BuyerFormValues>;

export default function CustomerModal({ customer, onClose, onSave: save, loading, onOpenStudio, accountingOn = true, buyerRelax = false, taxOff = false, zatcaCollect = false }: Props) {
  const tr = useTr();
  const { register, handleSubmit, watch } = useForm<CustomerForm>({
    defaultValues: customer || { status: 'ACTIVE', creditLimit: 0, paymentDays: 30 },
  });
  const hasLoc = customer?.lat != null && customer?.lng != null;
  // بيانات المشتري (Z5.1a): حالة محكومة تُدمج في الحمولة للشركة الجامعة وحدها (مع الرقم الضريبي والسجل والاسم والمدينة والحي من
  // النموذج نفسه). غير الجامعة: الحمولة كما اليوم حرفياً
  const [buyer, setBuyer] = useState<BuyerFormValues>(() => buyerFormValues(customer as BuyerRowLike | null));
  // «صور الوثائق» مع العميل الجديد (طلب المالك ١٣ نوفمبر ٢٠٢٦) — تُرسل في جسم الإنشاء نفسه فتُحفظ معه
  const [docs, setDocs] = useState<PickedDoc[]>([]);
  // الوثائق تُضاف عند الحفظ نفسه (العميل الجديد وحده) — فتبقى حمولة submit أدناه كما هي حرفياً لكل حالة
  // الصور تُضغط على الجهاز قبل أن تُضاف: «إضافة العميل» في أثنائه ينتظرها ثم يحفظ وحده — وإلا حُفظ العميل بلا ما لم يُجهَّز منها
  const [docsBusy, setDocsBusy] = useState(false);
  const [pendingSave, setPendingSave] = useState<CustomerForm | null>(null);
  const onSave = (d: CustomerForm) => {
    if (!customer && docsBusy) { setPendingSave(d); return; }
    save(customer ? d : { ...d, ...docsPayload(docs) });
  };
  useEffect(() => {
    if (docsBusy || !pendingSave) return;
    setPendingSave(null);
    save({ ...pendingSave, ...docsPayload(docs) });
  }, [docsBusy, pendingSave, docs, save]);
  const watched = zatcaCollect ? watch() : null;
  const buyerValues = watched ? { ...buyerFormValues(watched as BuyerRowLike), ...pickPhase2(buyer) } : null;
  // «بلا قيود على العميل» (أمر المالك ٩ نوفمبر ٢٠٢٦): قواعد الخادم تلميحٌ حيّ في القسم لا يمنع الإرسال — والخادم يُهمل حقل المرحلة
  // الثانية غير الصالح ويحفظ الباقي كما كُتب
  const buyerHints = buyerValues ? buyerFormHints(buyerValues, customer as BuyerRowLike | null, { relaxed: buyerRelax }) : {};
  const submit = (raw: CustomerForm) => {
    // الجوال يُرسل دائماً نصّاً مقصوصاً — والفارغ '' صريحاً فيُمسح المحفوظ متى أفرغه المدير (العمود لا يقبل null)
    const data: CustomerForm = { ...raw, phone: trimCustomerPhone(raw.phone) };
    // الموقع لا خانة له هنا إلا الرابط: lat/lng في القيم صدى صفّ القائمة كما حُمّل فلا يُرسلان — وإلا أعاد تعديلُ الاسم أو الجوال
    // من صفٍّ قديم الدبوسَ القديم فوق التقاطٍ أحدث من المندوب (تدقيق نطاق ٥٠ متراً). والرابط الملصوق يحدّث الموقع كما كان
    delete data.lat; delete data.lng;
    if (!zatcaCollect) { onSave(data); return; }
    onSave({ ...data, ...pickPhase2(buyer) } as CustomerForm);
  };
  /* «قوائم الأسعار»: قائمة العميل تُسعَّر بها فواتيره — تظهر لشركةٍ عرّفت قوائم (والمسار محروسٌ بالمحاسبة). والفارغ يُرسل null
   * صريحاً (setValueAs) فيعود العميل إلى القائمة الافتراضية للمندوب ثم السعر الافتراضي؛ وشركةٌ بلا قوائم: لا خانة ولا طلبٌ آخر،
   * والمحفوظ يُعاد كما هو */
  const { data: priceInfo } = useQuery({
    queryKey: ['price-lists'],
    queryFn: async () => priceListsOf((await priceListApi.list()).data.data),
    enabled: accountingOn,
  });
  // صفّ عميلٍ بلا المفتاح أصلاً (خادمٌ قبل الميزة) لا تُعرض له الخانة — وإلا أرسل حفظه null فوق قائمته
  const priceLists = accountingOn && (!customer || customer.priceListId !== undefined) ? priceInfo?.lists ?? [] : [];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-800">{customer ? tr('تعديل عميل') : tr('إضافة عميل جديد')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {/* «بلا قيود على العميل» (أمر المالك ٩ نوفمبر ٢٠٢٦): النموذج يُرسل دائماً — noValidate يُسقط منع المتصفح (البريد والأرقام
            وطول الخانة)، والخادم يصحّح أو يهمل غير الصالح: الاسم الفارغ يأخذ بديلاً (اسم المنشأة ثم الجوال ثم «عميل») في الإنشاء،
            ولا يمحو المحفوظ في التعديل */}
        <form noValidate onSubmit={handleSubmit(submit)} className="p-6 space-y-6">
          {/* Basic Info */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('البيانات الأساسية')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('اسم العميل')}</label>
                <input className="input" {...register('name')} />
              </div>
              <div>
                <label className="label">{tr('اسم المنشأة')}</label>
                <input className="input" {...register('businessName')} />
              </div>
              {/* الجوال حرّ (أمر المالك ٧ و٩ نوفمبر ٢٠٢٦): اختياريّ بلا نجمة ولا حدّ أدنى ولا صيغة ولا فحصٍ يمنع الحفظ —
                  طول الخانة بقدر ما يحفظه الخادم (CUSTOMER_PHONE_MAX) */}
              <div>
                <label className="label">{tr('رقم الجوال')}</label>
                <input className="input" dir="ltr" maxLength={CUSTOMER_PHONE_MAX} placeholder={tr('اختياري')}
                  {...register('phone')} />
              </div>
              <div>
                <label className="label">{tr('رقم بديل')}</label>
                <input className="input" dir="ltr" {...register('altPhone')} />
              </div>
              {/* البريد نصٌّ حرّ: خانة البريد الأصلية كان يمنع بها المتصفحُ الحفظ لصيغةٍ غير بريدية — inputMode يُبقي لوحة مفاتيح البريد */}
              <div>
                <label className="label">{tr('البريد الإلكتروني')}</label>
                <input className="input" type="text" inputMode="email" dir="ltr" {...register('email')} />
              </div>
              <div>
                <label className="label">{tr('السجل التجاري')}</label>
                <input className="input" {...register('commercialReg')} />
              </div>
              {!taxOff && (
                <div>
                  <label className="label">{tr('الرقم الضريبي')}</label>
                  <input className="input" {...register('taxNumber')} />
                </div>
              )}
              <div>
                <label className="label">{tr('الحالة')}</label>
                <select className="input" {...register('status')}>
                  <option value="ACTIVE">{tr('نشط')}</option>
                  <option value="INACTIVE">{tr('غير نشط')}</option>
                  <option value="BLOCKED">{tr('محظور')}</option>
                </select>
              </div>
              <div>
                <label className="label">{tr('قناة البيع')}</label>
                <select className="input" {...register('channel')}>
                  <option value="">{tr('غير محدد')}</option>
                  {SALES_CHANNELS.map((c) => (
                    <option key={c.code} value={c.code}>{tr(c.ar)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Address */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('العنوان')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('المدينة')}</label>
                <input className="input" {...register('city')} />
              </div>
              <div>
                <label className="label">{tr('الحي')}</label>
                <input className="input" {...register('district')} />
              </div>
              <div className="col-span-2">
                <label className="label">{tr('العنوان التفصيلي')}</label>
                <input className="input" {...register('address')} />
              </div>
            </div>
          </div>

          {/* فوترة ZATCA المرحلة الثانية (D2): للشركة التي تجمع بيانات الفوترة وحدها — لا تمنع الحفظ (تلميحات الحقول خارج القسم
              كالرقم الضريبي والسجل في قائمة تنبيهاته) */}
          {zatcaCollect && watched && (
            <BuyerDataFields
              values={{ ...buyerValues, name: watched.name ?? '', channel: watched.channel ?? '' }}
              stored={customer as BuyerRowLike | null}
              errors={buyerHints}
              dropsInvalid
              onChange={(f, v) => setBuyer(b => ({ ...b, [f]: v }))}
              {...(buyerRelax && {
                relaxed: true,
                warnings: buyerRelaxWarnings({ ...buyerFormValues(watched as BuyerRowLike), ...pickPhase2(buyer) }, customer as BuyerRowLike | null),
              })}
            />
          )}

          {/* Location — رابط موقع يظهر العميل على الخريطة */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase flex items-center gap-1.5"><MapPin size={15} /> {tr('الموقع على الخريطة')}</h3>
            <div>
              <label className="label">{tr('رابط الموقع خرائط Google')}</label>
              <input className="input" dir="ltr" placeholder="https://maps.app.goo.gl/ أو 24.7136 46.6753"
                {...register('locationUrl')} />
              <p className="text-[11px] text-gray-400 mt-1">
                {hasLoc
                  ? `${tr('الموقع الحالي محدد')} · ${customer!.lat!.toFixed(5)}, ${customer!.lng!.toFixed(5)} — ${tr('الصق رابطا جديدا لتحديثه')}`
                  : tr('من خرائط Google مشاركة ← نسخ الرابط ثم الصقه هنا ليظهر العميل على خريطة التتبع')}
              </p>
              {hasLoc && (
                <a href={`https://www.google.com/maps?q=${customer!.lat},${customer!.lng}`} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[#2563EB] font-semibold mt-1">
                  <MapPin size={12} /> {tr('عرض الموقع الحالي على الخريطة')}
                </a>
              )}
            </div>
          </div>

          {/* صور الوثائق: مع العميل الجديد تصويراً أو من الجهاز، وفي التعديل من «استديو العميل» */}
          {(!customer || onOpenStudio) && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase flex items-center gap-1.5"><Images size={15} /> {tr('صور الوثائق')}</h3>
            {customer ? (
              <button type="button" onClick={onOpenStudio}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#8A6D1F] border border-[#EDE3CF] bg-[#FBF7EF] rounded-lg px-3 py-2 hover:border-[#8A6D1F]/50">
                <Images size={15} /> {tr('فتح استديو العميل')}
              </button>
            ) : (
              <>
                <CustomerDocsPicker docs={docs} onChange={setDocs} taxOff={taxOff} onBusy={setDocsBusy} />
                {pendingSave && <p className="text-[11px] text-[#8A6D1F] mt-1">{tr('يحفظ العميل حين تجهز الصور')}</p>}
              </>
            )}
          </div>
          )}

          {/* Financial — الحد الائتماني ومدة السداد ماليّان: يُحذف القسم كلّه مع
              المحاسبة. وعدم تسجيل الحقلين يُبقي قيمتيهما المحفوظتين كما هما،
              لأن react-hook-form يرسل defaultValues لما لم يُسجَّل. */}
          {accountingOn && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('البيانات المالية')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('الحد الائتماني')}</label>
                <input className="input" type="number" min="0" step="0.01" {...register('creditLimit', { valueAsNumber: true })} />
              </div>
              <div>
                <label className="label">{tr('فترة السداد يوم')}</label>
                <input className="input" type="number" min="0" {...register('paymentDays', { valueAsNumber: true })} />
              </div>
              {priceLists.length > 0 && (
                <div data-customer-price-list="">
                  <label className="label">{tr('قائمة الأسعار')}</label>
                  <select className="input" {...register('priceListId', { setValueAs: (v: unknown) => (v ? String(v) : null) })}>
                    <option value="">{baseLabelOf(priceInfo, tr)}</option>
                    {priceLists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1">{tr('تسعر بها فواتير العميل تلقائيا')}</p>
                </div>
              )}
            </div>
          </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
              {customer ? tr('حفظ التعديلات') : tr('إضافة العميل')}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

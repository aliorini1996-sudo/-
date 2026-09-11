import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Users, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesRepApi, customerApi } from '../api/client';
import { SalesRep, Customer } from '../types';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';

/** سقف قائمة الاختيار — ما بعده يُوصَل إليه بالبحث لا بالتمرير */
const PICKER_LIMIT = 100;

interface Assigned { customerIds: string[]; autoIds: string[]; customers: Customer[] }

/** رسالة الخادم أولى من رسالتنا: هي وحدها التي تشرح سبب الرفض */
function errMsg(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

/**
 * إسناد العملاء لمندوب — نسخة الجوال من نافذة اللوحة.
 *
 * **تعمل بالفروقات (إضافة/إزالة) لا باستبدالٍ كامل:** الشاشة لا تحمّل كل عملاء
 * الشركة (مئة نتيجة لكل بحث)، فإرسال «القائمة الحاليّة» كاملةً كان سيحذف صامتاً
 * إسنادَ كل عميلٍ لم يظهر في الشاشة. الفروقات تجعل ذلك مستحيلاً.
 *
 * ومفتاح العزل هنا لأن الإسناد بلا عزلٍ رقمٌ لا أثر له — لكنّه مفتاح **الشركة**
 * كلّها لا هذا المندوب، فلا يُقلب إلا بتأكيدٍ ينصّ على ذلك.
 */
export default function MRepCustomers({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [onlyAssigned, setOnlyAssigned] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  // الحالة المطلوبة لمفتاح العزل بانتظار التأكيد (لا «مفتوح/مغلق» فحسب)
  const [confirmIso, setConfirmIso] = useState<boolean | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // الأساس: العملاء المُسنَدون حالياً بأسمائهم. لا يُحفظ شيء قبل نجاح هذا الطلب،
  // وإلا لظُنّ أن المندوب بلا إسناد فتُرسَل إزالات خاطئة تمحو إسناداته.
  const assignedQ = useQuery({
    queryKey: ['m-rep-customers', rep.id],
    queryFn: async () => {
      const d = expectObject<Record<string, unknown>>(
        (await salesRepApi.assignedCustomers(rep.id)).data?.data, 'العملاء المسندين');
      // كل حقلٍ محروسٌ على حدة: حقلٌ ناقص يصير خطأً ظاهراً بزرّ إعادة محاولة،
      // لا أساساً فارغاً يُبنى عليه حفظٌ يمحو ما لا نراه
      return {
        customerIds: expectArray<string>(d.customerIds, 'العملاء المسندين'),
        autoIds: expectArray<string>(d.autoIds, 'العملاء المسندين'),
        customers: expectArray<Customer>(d.customers, 'العملاء المسندين'),
      } as Assigned;
    },
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // البحث على الخادم — يصل لأي عميل مهما كبر عدد عملاء الشركة
  const searchQ = useQuery({
    queryKey: ['m-customers-picker', dq],
    queryFn: async () => expectArray<Customer>(
      (await customerApi.list({ search: dq, limit: PICKER_LIMIT })).data?.data, 'العملاء'),
    enabled: !onlyAssigned,
  });

  const isoQ = useQuery({
    queryKey: ['m-customer-isolation'],
    queryFn: async () => expectObject<{ enabled: boolean }>(
      (await salesRepApi.isolation()).data?.data, 'إعداد عزل العملاء'),
  });
  const isoOn = isoQ.data?.enabled === true;

  const baseline = new Set(assignedQ.data?.customerIds ?? []);
  const autoIds = new Set(assignedQ.data?.autoIds ?? []);
  const isAssigned = (id: string) => (baseline.has(id) && !removed.has(id)) || added.has(id);
  // العدّاد الحيّ: الأساس ناقصاً ما أُزيل منه زائداً ما أُضيف وليس فيه
  const count = baseline.size
    - [...removed].filter(id => baseline.has(id)).length
    + [...added].filter(id => !baseline.has(id)).length;

  const toggle = (id: string) => {
    if (isAssigned(id)) {
      if (baseline.has(id)) setRemoved(s => new Set(s).add(id));
      else setAdded(s => { const n = new Set(s); n.delete(id); return n; });
    } else {
      if (removed.has(id)) setRemoved(s => { const n = new Set(s); n.delete(id); return n; });
      else setAdded(s => new Set(s).add(id));
    }
  };

  const save = useMutation({
    mutationFn: () => salesRepApi.changeAssignedCustomers(rep.id, { add: [...added], remove: [...removed] }),
    onSuccess: async () => {
      toast.success(tr('تم حفظ إسناد العملاء'));
      // الترتيب مقصود: يُنتظر وصول الأساس الجديد **ثم** تُصفَّر الفروقات — فالعكس
      // يُظهر ما أُضيف للتوّ غير مُسنَد للحظة، إذ يُبقي react-query البيانات
      // القديمة أثناء إعادة الجلب
      await assignedQ.refetch();
      setAdded(new Set());
      setRemoved(new Set());
    },
    onError: (e: unknown) => toast.error(errMsg(e, tr('تعذر حفظ الإسناد'))),
  });

  const toggleIso = useMutation({
    mutationFn: (enabled: boolean) => salesRepApi.setIsolation(enabled),
    onSuccess: (_d, enabled) => {
      qc.invalidateQueries({ queryKey: ['m-customer-isolation'] });
      toast.success(enabled ? tr('تم تفعيل عزل العملاء') : tr('تم إيقاف عزل العملاء'));
      setConfirmIso(null);
    },
    onError: (e: unknown) => { toast.error(errMsg(e, tr('تعذر تغيير الإعداد'))); setConfirmIso(null); },
  });

  const list: Customer[] = onlyAssigned
    ? (assignedQ.data?.customers ?? []).filter(c => isAssigned(c.id))
    : (searchQ.data ?? []);

  const dirty = added.size > 0 || removed.size > 0;
  const baseReady = assignedQ.isSuccess;                 // نعرف الأساس ⇒ الحفظ آمن
  const listLoading = onlyAssigned ? assignedQ.isPending : searchQ.isPending;
  const listError = onlyAssigned ? assignedQ.isError : searchQ.isError;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('إسناد العملاء')} subtitle={rep.name} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {/* مفتاح الشركة أوّلاً — فبانرُ «مطفأ» أسفله يشير لمفتاحٍ يراه المستخدم فعلاً */}
        <MCard>
          {isoQ.isLoading ? (
            <p className="px-3.5 py-4 text-[11px] text-[#9A8F7E]">{tr('جاري قراءة الإعداد')}</p>
          ) : isoQ.isError || !isoQ.data ? (
            <button onClick={() => isoQ.refetch()} className="w-full text-start px-3.5 py-3.5 min-h-[56px]">
              <p className="text-[11px] text-[#C0392B]">{tr('تعذر قراءة إعداد العزل')}</p>
              <p className="text-xs font-bold text-[#C0392B] mt-1">{tr('إعادة المحاولة')}</p>
            </button>
          ) : (
            <button type="button" role="switch" aria-checked={isoOn}
              onClick={() => setConfirmIso(!isoOn)} disabled={toggleIso.isPending}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[56px] text-start active:bg-[#FAF7F0]">
              <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isoOn ? 'bg-[#E4F1EA] text-[#2F855A]' : 'bg-[#F1EBDF] text-[#9A8F7E]'}`}>
                <ShieldCheck size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[#1F1A13]">{tr('عزل عملاء المناديب')}</span>
                <span className="block text-[10px] text-[#9A8F7E] mt-0.5 leading-relaxed">
                  {isoOn
                    ? tr('مفعل كل مندوب يرى فقط العملاء المسندين له والعملاء الذين فتحهم بنفسه')
                    : tr('مطفأ كل مناديب الشركة يرون كل العملاء')}
                </span>
              </span>
              <Switch checked={isoOn} />
            </button>
          )}
        </MCard>

        {assignedQ.isError && (
          <div className="rounded-xl border border-[#F5C6C0] bg-[#FDF2F0] p-3 space-y-2">
            <p className="text-[11px] text-[#C0392B] leading-relaxed">
              {tr('تعذر تحميل العملاء المسندين حاليا الحفظ معطل حتى لا تفقد إسنادات')}
            </p>
            <button onClick={() => assignedQ.refetch()}
              className="w-full min-h-[44px] rounded-xl bg-[#C0392B] text-white text-xs font-bold">
              {tr('إعادة المحاولة')}
            </button>
          </div>
        )}

        {/* العزل مطفأ ⇒ الإسناد يُحفظ ولا يسري: يُقال صراحةً كي لا يُظنّ الحفظ بلا أثر */}
        {isoQ.isSuccess && !isoOn && (
          <div className="flex items-start gap-2 text-[11px] bg-[#FDF6E7] text-[#8A6D1F] border border-[#F0E2BE] rounded-xl px-3 py-2.5 leading-relaxed">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{tr('عزل العملاء مطفأ حاليا فكل المناديب يرون كل العملاء يحفظ الإسناد الآن ويسري فور تفعيل المفتاح أعلى الصفحة')}</span>
          </div>
        )}

        <div className="space-y-2">
          <div className="relative">
            <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
            <input className={`input ps-9 ${onlyAssigned ? 'opacity-50' : ''}`} value={q}
              onChange={e => setQ(e.target.value)} disabled={onlyAssigned}
              placeholder={tr('ابحث بالاسم أو الجوال أو الكود')} />
          </div>

          <MCard>
            <button type="button" role="switch" aria-checked={onlyAssigned}
              onClick={() => setOnlyAssigned(v => !v)}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[52px] text-start active:bg-[#FAF7F0]">
              <span className="min-w-0 flex-1 text-sm text-[#1F1A13]">{tr('عرض المسندين فقط')}</span>
              <Switch checked={onlyAssigned} />
            </button>
          </MCard>

          {!onlyAssigned && (
            <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
              {`${tr('يعرض أقرب')} ${PICKER_LIMIT} ${tr('نتيجة اكتب في البحث للوصول لأي عميل')}`}
            </p>
          )}
        </div>

        <section className="space-y-2.5">
          <div className="flex items-center justify-between gap-2 px-1">
            <h3 className="text-[11px] font-bold text-[#9A8F7E] uppercase tracking-wide">{tr('العملاء')}</h3>
            {/* «…» ما دام الأساس مجهولاً: رقمٌ قبل وصوله كذبٌ لا معلومة */}
            <span className="text-[11px] text-[#9A8F7E]">
              {tr('مسند')}: <b className="text-[#1F1A13]">{baseReady ? count : '…'}</b>
              {dirty && <span className="text-[#E15A30] font-semibold"> · +{added.size} / −{removed.size}</span>}
            </span>
          </div>

          {listLoading ? <div className="py-10"><MSpinner /></div>
            : listError ? (
              <div className="py-10">
                <MError onRetry={() => { if (onlyAssigned) assignedQ.refetch(); else searchQ.refetch(); }} />
              </div>
            ) : !list.length ? (
              <div className="py-10">
                <MEmpty icon={Users}
                  text={onlyAssigned ? tr('لا يوجد عملاء مسندون لهذا المندوب') : tr('لا يوجد عملاء مطابقون')} />
              </div>
            ) : (
              <MCard>
                {list.map(c => (
                  <MRow key={c.id}
                    // الصفّ كلّه هدف اللمس، ويُعطَّل ما لم يصل الأساس (حفظٌ أعمى = إزالات خاطئة)
                    onClick={baseReady ? () => toggle(c.id) : undefined}
                    title={c.name}
                    subtitle={c.businessName || c.phone || c.code}
                    trailing={
                      <span className="flex items-center gap-1.5 flex-shrink-0">
                        {autoIds.has(c.id) && (
                          <span className="text-[10px] bg-[#EAF1F9] text-[#2B6CB0] rounded-full px-1.5 py-0.5">
                            {tr('فتحه بنفسه')}
                          </span>
                        )}
                        <Switch checked={isAssigned(c.id)} muted={!baseReady} />
                      </span>
                    } />
                ))}
              </MCard>
            )}
        </section>

        <div className="h-2" />
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => save.mutate()} disabled={!baseReady || !dirty || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {save.isPending ? tr('جاري الحفظ') : tr('حفظ التغييرات')}
        </button>
      </div>

      {/* تأكيدٌ صريح: المفتاح للشركة كلّها — قلبُه من ملفّ مندوبٍ واحد يوهم بغير ذلك */}
      {confirmIso !== null && (
        <MConfirm
          title={confirmIso ? tr('تفعيل عزل العملاء للشركة') : tr('إيقاف عزل العملاء للشركة')}
          message={confirmIso
            ? tr('الأثر يشمل كل مناديب الشركة لا هذا المندوب وحده فلا يرى أي مندوب إلا العملاء المسندين له والذين فتحهم بنفسه')
            : tr('الأثر يشمل كل مناديب الشركة لا هذا المندوب وحده فيعود كل مندوب يرى كل عملاء الشركة والإسنادات تبقى محفوظة وتسري فور إعادة التفعيل')}
          confirmLabel={confirmIso ? tr('تفعيل العزل') : tr('إيقاف العزل')}
          loading={toggleIso.isPending}
          onConfirm={() => toggleIso.mutate(confirmIso)}
          onClose={() => setConfirmIso(null)} />
      )}
    </div>
  );
}

/* ═══════════════════════ لبنات داخلية ═══════════════════════ */

/** مظهر مفتاح — `span` لا `button`: يُركَّب داخل صفٍّ هو نفسه زرّ اللمس */
function Switch({ checked, muted }: { checked: boolean; muted?: boolean }) {
  return (
    <span className={`relative inline-block h-7 w-12 flex-shrink-0 rounded-full transition-colors ${muted ? 'bg-[#EFE9DE]' : checked ? 'bg-[#E15A30]' : 'bg-[#E0D7C6]'}`}>
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'start-6' : 'start-1'}`} />
    </span>
  );
}

/**
 * تأكيدٌ صريح لفعلٍ واسع الأثر — ورقة سفلية لا نافذة وسط الشاشة (الإبهام في
 * الأسفل). تُسجّل نفسها في مكدّس الرجوع لأنها لا تُركَّب إلا وهي مفتوحة.
 */
function MConfirm({ title, message, confirmLabel, loading, onConfirm, onClose }: {
  title: string; message: string; confirmLabel: string;
  loading?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const tr = useTr();
  useBackClose(true, onClose);
  return (
    // النقر على العتمة يُغلق — إلا والفعل جارٍ، فإغلاقٌ وقتها يُخفي نتيجته
    <div className="absolute inset-0 z-[700] bg-black/50 flex items-end"
      onClick={() => { if (!loading) onClose(); }}>
      <div className="w-full bg-white rounded-t-3xl p-4 space-y-3" onClick={e => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-[#1F1A13]">{title}</span>
            <span className="block text-[12px] text-[#6E6557] mt-1 leading-relaxed">{message}</span>
          </span>
        </div>
        <div className="flex gap-2.5 pt-1">
          <button onClick={onClose} disabled={loading}
            className="flex-1 min-h-[48px] rounded-xl border border-[#E9E1D3] bg-white font-bold text-sm text-[#1F1A13]">
            {tr('إلغاء')}
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="flex-1 min-h-[48px] rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 bg-[#E15A30] disabled:bg-[#E89B7E]">
            {loading && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

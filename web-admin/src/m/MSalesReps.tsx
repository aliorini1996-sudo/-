import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, ChevronLeft, Phone, Pencil, ShieldCheck, Banknote, Trash2, KeyRound,
  Loader2, Check, Copy, RefreshCw, Eye, EyeOff, UserRound, AlertTriangle, Wallet, Download,
  Users, Truck, Landmark, CreditCard, FileText, Paperclip, X, Image as ImageIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { salesRepApi } from '../api/client';
import { SalesRep } from '../types';
import { formatCurrency, formatDate, formatTime, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { compressImage } from '../rep/imageCompress';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MRow, MStat, MScreen, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { can } from './perms';
import { expectArray, expectObject } from './shape';

/* سند الاستلام في حزمة مستقلّة — يجرّ jspdf وhtml2canvas وqrcode معه */
const MSettlementDoc = lazy(() => import('./MSettlementDoc'));
/* شاشتا الإسناد والتحميل: لا تُفتحان في كل زيارةٍ لملفّ مندوب، فلا تدخلان حزمته */
const MRepCustomers = lazy(() => import('./MRepCustomers'));
const MRepLoad = lazy(() => import('./MRepLoad'));

const PAGE = 25;

interface Creds { name: string; username: string; password: string }
interface Collection { collected: number; settled: number; outstanding: number }
interface Settlement {
  id: string; amount: number; note?: string | null; createdBy?: string | null; settledAt: string;
  /** نوع الاستلام — يغيب في صفوفٍ سبقت العمود، وغيابه نقديٌّ كما يفترض الخادم */
  method?: string | null;
  /** مرفقات الاستلام كما يردّها الخادم — data URL لكلّ صورة */
  photos?: { id: string; data: string }[];
}

/**
 * قاموس نوع الاستلام — مطابقٌ لقاموس الخادم المغلق ولسند القبض حرفاً بحرف،
 * وأيّ قيمةٍ خارجه يردّها الخادم إلى `CASH`.
 */
const SETTLE_METHODS = [
  { v: 'CASH', label: 'نقدي', icon: Banknote },
  { v: 'BANK_TRANSFER', label: 'تحويل بنكي', icon: Landmark },
  { v: 'POS', label: 'شبكة', icon: CreditCard },
  { v: 'CHEQUE', label: 'شيك', icon: FileText },
] as const;
type SettleMethod = (typeof SETTLE_METHODS)[number]['v'];

/** سقف المرفقات — سقف الخادم نفسه، وسقف مرفقات سند القبض نفسه */
const MAX_PHOTOS = 4;

/** اسم نوع الاستلام للعرض؛ ما لا يُعرف نقديٌّ لأن الخادم يردّه كذلك */
function methodLabel(m?: string | null): string {
  return SETTLE_METHODS.find(x => x.v === m)?.label ?? SETTLE_METHODS[0].label;
}

/** رسالة الخادم أولى من رسالتنا: 409 «اسم المستخدم مستخدم مسبقا» تُصلح الخطأ، و«تعذر الحفظ» لا تُصلح شيئاً */
function errMsg(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

/**
 * شاشة المناديب في تطبيق الإدارة على الجوال — بكامل إجراءات نسختها على اللوحة:
 * إضافة وتعديل وإيقاف وإعادة تعيين كلمة مرور وصلاحيات وحذف واستلام تحصيل.
 *
 * التقسيم طبقاتٌ متعاقبة لا نوافذ متراكمة: قائمة ← ملفّ المندوب ← (نموذج |
 * صلاحيات | تحصيل)، كلٌّ ملء الشاشة ومربوطة بـ`useBackClose` — لأن نافذةً
 * منبثقة داخل ٤٠٠px تصير علبةً ضيقة يُمرَّر داخلها، وزرّ رجوع أندرويد كان
 * سيخرج من التطبيق بدل أن يغلقها.
 */
export default function MSalesReps({ onBack, company }: {
  onBack: () => void;
  /** إعدادات الشركة — لترويسة سند الاستلام وحدها */
  company?: unknown;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // بيانات دخول المندوب المُنشأ حديثاً — كلمة المرور لا تُعرض مرّة أخرى أبداً
  const [creds, setCreds] = useState<Creds | null>(null);

  // من الأعلى بصرياً إلى الأدنى (شرط ترتيب `useBackClose`)
  useBackClose(!!creds, () => setCreds(null));
  useBackClose(!creds && creating, () => setCreating(false));
  useBackClose(!creds && !creating && !!openId, () => setOpenId(null));

  const body = creating ? (
    <RepForm rep={null} onClose={() => setCreating(false)}
      onSaved={(res) => {
        setCreating(false);
        // نفتح ملفّه فوراً بعد الإنشاء: صلاحياته الآن هي الافتراضيّة، والأرجح
        // أن الإدارة أنشأته لتضبطها — لا لتبحث عنه في القائمة من جديد
        setOpenId(res.id);
        if (res.creds) setCreds(res.creds);
      }} />
  ) : openId ? (
    <RepDetail repId={openId} company={company} onBack={() => setOpenId(null)} />
  ) : (
    <RepList onBack={onBack} onAdd={() => setCreating(true)} onOpen={setOpenId} />
  );

  return (
    <>
      {body}
      {creds && <CredsSheet creds={creds} onClose={() => setCreds(null)} />}
    </>
  );
}

/* ═══════════════════════ القائمة ═══════════════════════ */

function RepList({ onBack, onAdd, onOpen }: {
  onBack: () => void; onAdd: () => void; onOpen: (id: string) => void;
}) {
  const tr = useTr();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => { setDq(q.trim()); setLimit(PAGE); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const listQ = useQuery({
    queryKey: ['m-sales-reps', dq, limit],
    queryFn: async () => expectArray<SalesRep>((await salesRepApi.list({ search: dq, limit })).data?.data, 'المناديب'),
  });

  const reps = listQ.data ?? [];

  // رصيد التحصيل ليس في ردّ القائمة، فيُجلب لكل مندوب على حدة. الطلبات محدودة
  // فعلاً لا نظرياً: باقات المنتج تسقّف المناديب بعشرين، والصفحة بخمسة وعشرين.
  // وتُستثنى مَن أُطفئ لهم «إظهار رصيد التحصيل» — مطابقةً للّوحة التي تخفي
  // زرّ الاستلام عنهم أصلاً، فلا معنى لطلبٍ لن يُعرض رقمه.
  const balanceReps = reps.filter(r => r.showCollectionBalance !== false);
  const balanceQs = useQueries({
    queries: balanceReps.map(r => ({
      queryKey: ['m-rep-collection', r.id],
      queryFn: async () => expectObject<Collection>((await salesRepApi.collection(r.id)).data?.data, 'رصيد التحصيل'),
      staleTime: 60000,
    })),
  });
  const balances = new Map<string, number>();
  balanceReps.forEach((r, i) => {
    const d = balanceQs[i]?.data;
    if (d) balances.set(r.id, Number(d.outstanding));
  });

  // تمرير قريب من القاع ⇒ صفحة أخرى (بلا ترقيم أرقام على الجوال)
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || listQ.isFetching) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160
      && (listQ.data?.length ?? 0) >= limit) setLimit(l => l + PAGE);
  }, [listQ.isFetching, listQ.data, limit]);

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      {/* العدد يُعرض حين نعرفه كاملاً فقط: ما دامت الصفحة ممتلئة فالقائمة ناقصة،
          و«٢٥ مندوب» وقتها رقمٌ كاذب لا معلومة */}
      <MHeader
        title={tr('المناديب')}
        subtitle={listQ.data && listQ.data.length < limit ? `${listQ.data.length} ${tr('مندوب')}` : undefined}
        onBack={onBack}
        action={
          <button onClick={onAdd}
            className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0"
            aria-label={tr('إضافة مندوب')}>
            <Plus size={20} />
          </button>
        } />

      {/* البحث على الخادم لا محلياً — يصل لمندوبٍ خارج الصفحة المحمّلة */}
      <div className="flex-shrink-0 p-3 pb-2">
        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9"
            placeholder={tr('ابحث بالاسم أو الجوال أو اسم المستخدم')} />
        </div>
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {listQ.isLoading ? <MSpinner />
          : listQ.isError ? <MError onRetry={() => listQ.refetch()} />
            : !reps.length ? <MEmpty text={dq ? tr('لا نتائج') : tr('لا يوجد مناديب بعد')} icon={UserRound} />
              : (
                <MCard>
                  {reps.map(r => (
                    <RepRow key={r.id} rep={r} balance={balances.get(r.id)} onOpen={() => onOpen(r.id)} />
                  ))}
                </MCard>
              )}
        {listQ.isFetching && !listQ.isLoading && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-3">{tr('جاري التحميل')}</p>
        )}
      </div>
    </div>
  );
}

function RepRow({ rep, balance, onOpen }: { rep: SalesRep; balance?: number; onOpen: () => void }) {
  const tr = useTr();
  return (
    <MRow
      onClick={onOpen}
      leading={
        <span className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${rep.isActive ? 'bg-[#FBEBE2] text-[#C94E28]' : 'bg-[#F1EBDF] text-[#9A8F7E]'}`}>
          {rep.name?.charAt(0) || <UserRound size={16} />}
        </span>
      }
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{rep.name}</span>
          {!rep.isActive && (
            <span className="text-[10px] font-semibold bg-[#FDF2F0] text-[#C0392B] rounded-full px-1.5 py-0.5 flex-shrink-0">
              {tr('موقوف')}
            </span>
          )}
        </span>
      }
      subtitle={[rep.phone, rep.username].filter(Boolean).join(' · ')}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          {balance != null && (
            <span className={`text-xs font-bold whitespace-nowrap ${balance > 0 ? 'text-[#B7791F]' : 'text-[#2F855A]'}`}>
              {formatCurrency(balance)}
            </span>
          )}
          <ChevronLeft size={15} className="text-[#C9BFB0]" />
        </span>
      } />
  );
}

/* ═══════════════════════ ملفّ المندوب ═══════════════════════ */

type Layer = 'form' | 'perms' | 'collect' | 'customers' | 'load' | null;

function RepDetail({ repId, company, onBack }: { repId: string; company?: unknown; onBack: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const role = user?.role;
  // حذف المندوب للأدمن الرئيسي وحده — والخادم يفرضه ثانيةً بقراءة الدور من
  // القاعدة؛ إخفاء الزرّ هنا كي لا يُعرض بابٌ سيُغلق في وجه من يفتحه
  const isMainAdmin = role === 'ADMIN';
  const [layer, setLayer] = useState<Layer>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  // تأكيد الحذف يُفتح من الجذر وحده (لا فوق طبقة)، فيسجّل نفسه أعلى هذه بلا تعارض
  useBackClose(layer !== null, () => setLayer(null));

  // ردّ PUT لا يحمل الصلاحيات (select مختصر) — فالمصدر دائماً هذا الاستعلام
  const repQ = useQuery({
    queryKey: ['m-rep', repId],
    queryFn: async () => expectObject<SalesRep>((await salesRepApi.get(repId)).data?.data, 'المندوب'),
  });

  const colQ = useQuery({
    queryKey: ['m-rep-collection', repId],
    queryFn: async () => expectObject<Collection>((await salesRepApi.collection(repId)).data?.data, 'رصيد التحصيل'),
  });

  const del = useMutation({
    mutationFn: () => salesRepApi.remove(repId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['m-sales-reps'] });
      toast.success(tr('تم حذف المندوب'));
      setConfirmDel(false);
      onBack();
    },
    onError: (e: unknown) => {
      // الخادم يردّ ٤٠٣/٤٠٩ برسالةٍ تشرح المانع — تُعرض كما هي
      toast.error(errMsg(e, tr('تعذر حذف المندوب')));
      setConfirmDel(false);
    },
  });

  // الترويسة تُرسم في كل الحالات: زرّ رجوعٌ حاضر ولو تعذّر تحميل المندوب نفسه
  if (repQ.isLoading || repQ.isError || !repQ.data) {
    return (
      <div className="h-full flex flex-col bg-[#FAF7F0]">
        <MHeader title={tr('المندوب')} onBack={onBack} />
        <div className="flex-1">
          {repQ.isLoading ? <MSpinner /> : <MError onRetry={() => repQ.refetch()} />}
        </div>
      </div>
    );
  }

  const rep = repQ.data;
  const canCollect = rep.showCollectionBalance !== false;
  /* تسجيل التحميل خلف حارسَي الخادم نفسيهما: عزل «النظام المحاسبي» ثمّ صلاحية
   * مخزون السيارة. إظهار بلاطةٍ تُفضي إلى ٤٠٣ أسوأ من إخفائها. */
  const accountingOn = (company as { accountingEnabled?: boolean } | null)?.accountingEnabled !== false;
  const canLoad = accountingOn && can(user, 'canManageVanStock');

  if (layer === 'form') {
    return (
      <RepForm rep={rep} onClose={() => setLayer(null)}
        onSaved={() => { setLayer(null); repQ.refetch(); }} />
    );
  }
  if (layer === 'perms') {
    return <RepPerms rep={rep} onClose={() => setLayer(null)} onSaved={() => { setLayer(null); repQ.refetch(); }} />;
  }
  if (layer === 'collect') {
    return <RepCollect rep={rep} company={company} onClose={() => setLayer(null)} />;
  }
  if (layer === 'customers') {
    return (
      <Suspense fallback={<MSpinner />}>
        <MRepCustomers rep={rep} onClose={() => setLayer(null)} />
      </Suspense>
    );
  }
  if (layer === 'load') {
    return (
      <Suspense fallback={<MSpinner />}>
        <MRepLoad rep={rep} company={company} onClose={() => setLayer(null)} />
      </Suspense>
    );
  }

  const col = colQ.data;

  return (
    <>
      <MScreen header={
        <MHeader title={rep.name} subtitle={rep.username} onBack={onBack}
          action={
            <button onClick={() => setLayer('form')} className="p-2 text-[#9A8F7E] hover:text-white"
              aria-label={tr('تعديل')}>
              <Pencil size={18} />
            </button>
          } />
      }>
        <div className="bg-[#FAF7F0] min-h-full p-3 space-y-3">
          {!rep.isActive && (
            <div className="flex items-center gap-2 text-[11px] bg-[#FDF2F0] text-[#C0392B] border border-[#F5C6C0] rounded-xl px-3 py-2.5">
              <AlertTriangle size={14} className="flex-shrink-0" />
              {tr('الحساب موقوف لا يستطيع المندوب الدخول للتطبيق')}
            </div>
          )}

          {/* رصيد التحصيل — ثلاث حالات صريحة، فلا بطاقة فارغة بلا تفسير */}
          {canCollect && (
            colQ.isLoading ? (
              <div className="rounded-2xl border border-[#F1EBDF] bg-white p-4 text-center text-[11px] text-[#9A8F7E]">
                {tr('جاري التحميل')}
              </div>
            ) : colQ.isError || !col ? (
              <button onClick={() => colQ.refetch()}
                className="w-full rounded-2xl border border-[#F5C6C0] bg-[#FDF2F0] p-3.5 text-start min-h-[56px]">
                <p className="text-[11px] text-[#C0392B]">{tr('تعذر تحميل رصيد التحصيل')}</p>
                <p className="text-xs font-bold text-[#C0392B] mt-1">{tr('إعادة المحاولة')}</p>
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                <div className="col-span-2">
                  <MStat icon={Wallet} label={tr('الرصيد المتبقي لدى المندوب')}
                    value={formatCurrency(col.outstanding)}
                    tone={Number(col.outstanding) > 0 ? 'warn' : 'good'} />
                </div>
                <MStat label={tr('إجمالي التحصيل')} value={formatCurrency(col.collected)} />
                <MStat label={tr('المستلم سابقا')} value={formatCurrency(col.settled)} />
              </div>
            )
          )}

          <MCard>
            <Info label={tr('الجوال')} value={rep.phone} icon={Phone} href={rep.phone ? `tel:${rep.phone}` : undefined} />
            <Info label={tr('اسم المستخدم')} value={rep.username} />
            {rep.email && <Info label={tr('البريد الإلكتروني')} value={rep.email} />}
            <Info label={tr('الحالة')} value={rep.isActive ? tr('نشط') : tr('موقوف')} />
            <Info label={tr('أقصى نسبة خصم')} value={`${rep.maxDiscountPct ?? 0}%`} />
          </MCard>

          <div className="grid grid-cols-2 gap-2.5">
            <Tile icon={Pencil} label={tr('تعديل البيانات')} onClick={() => setLayer('form')} />
            <Tile icon={ShieldCheck} label={tr('الصلاحيات')} onClick={() => setLayer('perms')} />
            {canCollect && (
              <Tile icon={Banknote} label={tr('استلام تحصيل')} color="#2F855A" onClick={() => setLayer('collect')} />
            )}
            <Tile icon={Users} label={tr('إسناد العملاء')} onClick={() => setLayer('customers')} />
            {canLoad && (
              <Tile icon={Truck} label={tr('تسجيل تحميل')} color="#2F855A" onClick={() => setLayer('load')} />
            )}
            {isMainAdmin && (
              <Tile icon={Trash2} label={tr('حذف المندوب')} color="#C0392B" onClick={() => setConfirmDel(true)} />
            )}
          </div>

          <div className="h-2" />
        </div>
      </MScreen>

      {/* خارج `MScreen` عمداً: ورقةٌ فوق الشاشة كلّها، لا داخل الجسم الممرَّر */}
      {confirmDel && (
        <MConfirm
          danger
          title={tr('حذف المندوب')}
          message={`${tr('سيحذف المندوب')} «${rep.name}» ${tr('نهائيا تحفظ فواتيره وسنداته كسجل مالي دون نسبتها إليه وتحذف بياناته التشغيلية ولا يمكن التراجع')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={del.isPending}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirmDel(false)} />
      )}
    </>
  );
}

function Info({ label, value, icon: Icon, href }: {
  label: string; value: string; icon?: React.ElementType; href?: string;
}) {
  const body = (
    <div className="flex items-center gap-3 px-3.5 py-2.5 min-h-[48px]">
      <span className="text-[11px] text-[#9A8F7E] w-24 flex-shrink-0">{label}</span>
      <span className={`text-sm flex-1 truncate flex items-center gap-1.5 ${href ? 'text-[#E15A30] font-semibold' : 'text-[#1F1A13]'}`} dir="auto">
        {Icon && <Icon size={13} />}{value}
      </span>
    </div>
  );
  if (href) {
    return <a href={href} className="block border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0]">{body}</a>;
  }
  return <div className="border-b border-[#F1EBDF] last:border-0">{body}</div>;
}

function Tile({ icon: Icon, label, color = '#E15A30', onClick }: {
  icon: React.ElementType; label: string; color?: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 min-h-[76px] flex flex-col items-center justify-center gap-1.5 active:bg-[#FAF7F0]">
      <Icon size={19} style={{ color }} />
      <span className="text-[11px] font-semibold text-[#1F1A13]">{label}</span>
    </button>
  );
}

/* ═══════════════════════ نموذج البيانات ═══════════════════════ */

/**
 * إضافة/تعديل مندوب — ومعه إعادة تعيين كلمة المرور (حقلٌ فارغ = لا تغيير).
 *
 * **لماذا يُرسَل البريد في كل حفظ ولو لم يُلمس:** الخادم يكتب في التعديل
 * `email: rest.email || null` بلا شرط، فإغفال الحقل من الحمولة يمسح بريد
 * المندوب صامتاً. نرسله دائماً كما هو في الحقل.
 */
function RepForm({ rep, onClose, onSaved }: {
  rep: SalesRep | null;
  onClose: () => void;
  onSaved: (res: { id: string; creds: Creds | null }) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [name, setName] = useState(rep?.name ?? '');
  const [phone, setPhone] = useState(rep?.phone ?? '');
  const [email, setEmail] = useState(rep?.email ?? '');
  const [username, setUsername] = useState(rep?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [isActive, setIsActive] = useState(rep?.isActive !== false);

  const genPassword = () => {
    // بلا أحرف متشابهة (l/1/O/0) — تُملى على المندوب شفهياً كثيراً
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let p = '';
    for (let i = 0; i < 8; i++) p += chars[Math.floor(Math.random() * chars.length)];
    setPassword(p);
    setShowPass(true);
  };

  const nameOk = name.trim().length > 0;
  const phoneOk = phone.trim().length >= 9;
  const userOk = username.trim().length >= 4;
  const passOk = rep ? (password.length === 0 || password.length >= 8) : password.length >= 8;
  const valid = nameOk && phoneOk && userOk && passOk;

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        phone: phone.trim(),
        username: username.trim(),
        email: email.trim(),   // دائماً — انظر تعليق الرأس
        isActive,
      };
      if (password) payload.password = password;
      const res = rep ? await salesRepApi.update(rep.id, payload) : await salesRepApi.create(payload);
      return expectObject<{ id: string }>(res.data?.data, 'المندوب');
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['m-sales-reps'] });
      if (rep) qc.invalidateQueries({ queryKey: ['m-rep', rep.id] });
      toast.success(rep
        ? (password ? tr('تم تحديث البيانات وكلمة المرور') : tr('تم تحديث بيانات المندوب'))
        : tr('تم إنشاء حساب المندوب'));
      onSaved({
        id: saved.id,
        // كلمة المرور لا يعيدها الخادم أبداً: تُسلَّم الآن أو لا تُسلَّم
        creds: rep ? null : { name: name.trim(), username: username.trim(), password },
      });
    },
    onError: (e: unknown) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={rep ? tr('تعديل مندوب') : tr('مندوب جديد')} subtitle={rep?.name} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        <Group title={tr('البيانات الأساسية')}>
          <Field label={tr('الاسم')} required value={name} onChange={setName} />
          {!nameOk && name.length > 0 && <Hint text={tr('مطلوب')} bad />}
          <Field label={tr('الجوال')} required dir="ltr" type="tel" value={phone} onChange={setPhone} />
          {phone.length > 0 && !phoneOk && <Hint text={tr('رقم غير صحيح')} bad />}
          <Field label={tr('البريد الإلكتروني')} dir="ltr" type="email" value={email} onChange={setEmail} />
          <Field label={tr('اسم المستخدم')} required dir="ltr" value={username} onChange={setUsername} />
          {username.length > 0 && !userOk && <Hint text={tr('4 أحرف على الأقل')} bad />}
        </Group>

        <Group title={rep ? tr('إعادة تعيين كلمة المرور') : tr('كلمة المرور')}>
          <div>
            <div className="flex items-center justify-between">
              <label className="label">{rep ? tr('كلمة مرور جديدة') : `${tr('كلمة المرور')} *`}</label>
              <button type="button" onClick={genPassword}
                className="text-[11px] text-[#E15A30] font-semibold flex items-center gap-1 mb-1 py-1 px-2 -mx-2">
                <RefreshCw size={11} /> {tr('توليد')}
              </button>
            </div>
            <div className="relative">
              <input className="input pe-10" dir="ltr" autoComplete="new-password"
                type={showPass ? 'text' : 'password'}
                placeholder={rep ? tr('اتركها فارغة لعدم التغيير') : ''}
                value={password} onChange={e => setPassword(e.target.value)} />
              <button type="button" onClick={() => setShowPass(s => !s)}
                className="absolute end-1 top-1/2 -translate-y-1/2 p-2 text-[#9A8F7E]"
                aria-label={tr('إظهار كلمة المرور')}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {password.length > 0 && password.length < 8
              ? <Hint text={tr('كلمة المرور 8 أحرف على الأقل')} bad />
              : <Hint text={rep ? tr('تغييرها يخرج المندوب من التطبيق حتى يدخل بالجديدة') : tr('8 أحرف على الأقل يسلمها الأدمن للمندوب')} />}
          </div>
        </Group>

        <Group title={tr('حالة الحساب')} flush>
          <MToggle label={tr('الحساب مفعل')} checked={isActive} onChange={setIsActive}
            hint={tr('الإيقاف يمنع دخول المندوب للتطبيق ويبقي بياناته كما هي')} />
        </Group>

        {!rep && (
          <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
            {tr('يبدأ المندوب بالصلاحيات الافتراضية اضبطها من ملفه بعد الإنشاء')}
          </p>
        )}

        <div className="h-2" />
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {rep ? tr('حفظ التعديلات') : tr('إضافة المندوب')}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════ الصلاحيات ═══════════════════════ */

/** الصلاحيات المانحة — سبع عشرة، ومعها القيد المعكوس أدناه = ثماني عشرة */
const GRANTS = [
  'canCreateInvoice', 'canSellOnCredit', 'canSellOnInstallment', 'canSellInCash',
  'canEditInvoice', 'canCancelInvoice', 'canDeleteInvoice',
  'canChangePrice', 'canSellBelowPrice',
  'canCreateReceipt', 'canEditReceipt', 'canCancelReceipt',
  'canManageVanStock',
  'canAddCustomer', 'canEditCustomer', 'canViewStatement',
  'showCollectionBalance',
] as const;

type Grant = typeof GRANTS[number];
type PermKey = Grant | 'requireCustomerProximity';
type PermState = Record<PermKey, boolean>;

/**
 * الافتراضات مطابقة لافتراضات قاعدة البيانات حرفياً.
 * ولماذا لا يُعامَل الغائب كـ`true`: «حذف فاتورة» غائبةً تعني مغلقة لا مفتوحة،
 * وتخمينُها فتحاً يمنح المندوبَ باباً لم تفتحه له الإدارة.
 */
const PERM_DEFAULTS: PermState = {
  canCreateInvoice: true, canSellOnCredit: true, canSellOnInstallment: false, canSellInCash: true,
  canEditInvoice: false, canCancelInvoice: false, canDeleteInvoice: false,
  canChangePrice: false, canSellBelowPrice: false,
  canCreateReceipt: true, canEditReceipt: false, canCancelReceipt: false,
  canManageVanStock: true,
  canAddCustomer: false, canEditCustomer: false, canViewStatement: true,
  showCollectionBalance: true,
  requireCustomerProximity: false,
};

const PERM_LABELS: Record<PermKey, string> = {
  canCreateInvoice: 'إنشاء فاتورة',
  canSellOnCredit: 'البيع الآجل',
  canSellOnInstallment: 'البيع بالتقسيط',
  canSellInCash: 'البيع النقدي',
  canEditInvoice: 'تعديل فاتورة',
  canCancelInvoice: 'إلغاء فاتورة',
  canDeleteInvoice: 'حذف فاتورة',
  canChangePrice: 'تغيير السعر',
  canSellBelowPrice: 'البيع أقل من السعر',
  canCreateReceipt: 'إصدار سند قبض',
  canEditReceipt: 'تعديل سند قبض',
  canCancelReceipt: 'إلغاء سند قبض',
  canManageVanStock: 'تحميل مخزون السيارة',
  canAddCustomer: 'إضافة عميل',
  canEditCustomer: 'تعديل بيانات العميل',
  canViewStatement: 'عرض كشف الحساب',
  showCollectionBalance: 'إظهار رصيد التحصيل المتراكم',
  requireCustomerProximity: 'البيع داخل نطاق العميل فقط',
};

const PERM_GROUPS: { title: string; keys: Grant[] }[] = [
  { title: 'صلاحيات المبيعات', keys: ['canCreateInvoice', 'canSellOnCredit', 'canSellOnInstallment', 'canSellInCash', 'canEditInvoice', 'canCancelInvoice', 'canDeleteInvoice'] },
  { title: 'صلاحيات التسعير', keys: ['canChangePrice', 'canSellBelowPrice'] },
  { title: 'صلاحيات التحصيل', keys: ['canCreateReceipt', 'canEditReceipt', 'canCancelReceipt', 'showCollectionBalance'] },
  { title: 'مخزون السيارة', keys: ['canManageVanStock'] },
  { title: 'صلاحيات العملاء', keys: ['canAddCustomer', 'canEditCustomer', 'canViewStatement'] },
];

function readPerms(rep: SalesRep): PermState {
  const out: PermState = { ...PERM_DEFAULTS };
  (Object.keys(out) as PermKey[]).forEach(k => {
    const v = rep[k];
    if (typeof v === 'boolean') out[k] = v;
  });
  return out;
}

function RepPerms({ rep, onClose, onSaved }: { rep: SalesRep; onClose: () => void; onSaved: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [perms, setPerms] = useState<PermState>(() => readPerms(rep));
  const [maxDisc, setMaxDisc] = useState(String(rep.maxDiscountPct ?? 0));

  const set = (k: PermKey, v: boolean) => setPerms(p => ({ ...p, [k]: v }));
  // «تحديد الكل» يمسّ المانحة وحدها: `requireCustomerProximity` قيدٌ معكوس
  // الدلالة، فتحديده ضمن «الكل» كان سيقفل البيع على كل عميل بلا إحداثيات
  // بينما يظنّ الضاغط أنه وسّع الصلاحيات.
  const setAllGrants = (v: boolean) => setPerms(p => {
    const next = { ...p };
    GRANTS.forEach(k => { next[k] = v; });
    return next;
  });

  const discNum = Number(maxDisc);
  const discOk = maxDisc.trim() !== '' && Number.isFinite(discNum) && discNum >= 0 && discNum <= 100;

  const save = useMutation({
    mutationFn: () => salesRepApi.update(rep.id, {
      ...perms,
      maxDiscountPct: discNum,
      email: rep.email ?? '', // وإلا مسحه الخادم (انظر تعليق نموذج البيانات)
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['m-sales-reps'] });
      qc.invalidateQueries({ queryKey: ['m-rep', rep.id] });
      toast.success(tr('تم حفظ الصلاحيات'));
      onSaved();
    },
    onError: (e: unknown) => toast.error(errMsg(e, tr('تعذر حفظ الصلاحيات'))),
  });

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('الصلاحيات')} subtitle={rep.name} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        <div className="flex gap-2">
          <button onClick={() => setAllGrants(true)}
            className="flex-1 min-h-[44px] rounded-xl border border-[#E9E1D3] bg-white text-xs font-bold text-[#1F1A13]">
            {tr('تحديد الكل')}
          </button>
          <button onClick={() => setAllGrants(false)}
            className="flex-1 min-h-[44px] rounded-xl border border-[#E9E1D3] bg-white text-xs font-bold text-[#1F1A13]">
            {tr('إلغاء الكل')}
          </button>
        </div>

        {PERM_GROUPS.map(g => (
          <Group key={g.title} title={tr(g.title)} flush>
            {g.keys.map(k => (
              <MToggle key={k} label={tr(PERM_LABELS[k])} checked={perms[k]} onChange={v => set(k, v)} />
            ))}
          </Group>
        ))}

        <Group title={tr('أقصى نسبة خصم')}>
          <div>
            <label className="label">{tr('أقصى نسبة خصم %')}</label>
            <input className="input" dir="ltr" type="number" inputMode="decimal" min={0} max={100} step="any"
              value={maxDisc} onChange={e => setMaxDisc(e.target.value)} />
            {!discOk
              ? <Hint text={tr('نسبة بين صفر ومئة')} bad />
              : <Hint text={tr('أعلى خصم يمنحه المندوب على سطر الفاتورة')} />}
          </div>
        </Group>

        <Group title={tr('قيود الموقع الميداني')} flush>
          <MToggle label={tr(PERM_LABELS.requireCustomerProximity)}
            checked={perms.requireCustomerProximity}
            onChange={v => set('requireCustomerProximity', v)}
            hint={tr('قيد لا صلاحية تفعيله يمنع فتح ملف العميل خارج خمسين مترا من موقعه والعميل بلا موقع يمنع تماما')} />
        </Group>

        <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
          {tr('تحديد الكل وإلغاء الكل لا يمسان قيد الموقع لأنه يسلب لا يمنح')}
        </p>

        <div className="h-2" />
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => save.mutate()} disabled={!discOk || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {tr('حفظ الصلاحيات')}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════ استلام التحصيل ═══════════════════════ */

function RepCollect({ rep, company, onClose }: { rep: SalesRep; company?: unknown; onClose: () => void }) {
  const tr = useTr();
  const role = useAuthStore(s => s.user?.role);
  const isMainAdmin = role === 'ADMIN'; // حذف استلام يرفع مطالبة المندوب — للأدمن الرئيسي وحده
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<SettleMethod>('CASH');
  /* مرفقات الاستلام — إيصال إيداعٍ أو صورة تحويل، تُمرَّر في حمولة الاستلام
   * نفسها لا في طلبٍ ثانٍ: مرفقٌ يُرفع بعد تسجيل الاستلام يضيع كلّما انقطع
   * الاتصال بين الطلبين، ويبقى الاستلام بلا سنده. */
  const [photos, setPhotos] = useState<string[]>([]);
  const [filled, setFilled] = useState(false);
  const [delRow, setDelRow] = useState<Settlement | null>(null);
  // سند استلامٍ واحد معروضٌ الآن — طبقةٌ فوق هذه الشاشة
  const [pdfRow, setPdfRow] = useState<Settlement | null>(null);

  useBackClose(!!pdfRow, () => setPdfRow(null));

  // المفتاح نفسه الذي تقرأه القائمة وملفّ المندوب — فالاستلام يحدّث الثلاثة معاً
  const colQ = useQuery({
    queryKey: ['m-rep-collection', rep.id],
    queryFn: async () => expectObject<Collection>((await salesRepApi.collection(rep.id)).data?.data, 'رصيد التحصيل'),
  });
  const logQ = useQuery({
    queryKey: ['m-rep-settlements', rep.id],
    queryFn: async () => expectArray<Settlement>((await salesRepApi.settlements(rep.id)).data?.data, 'سجل الاستلامات'),
  });

  // تعبئة الحقل بالرصيد المتبقّي (تسليمٌ كامل) — بخانات العملة الفعلية لا
  // بخانتين ثابتتين، وإلّا بقي كسرٌ معلّق على المندوب إلى الأبد
  useEffect(() => {
    if (!colQ.data || filled) return;
    const dec = currencyDecimals(getActiveCurrency());
    setAmount(String(Math.max(0, Number(Number(colQ.data.outstanding).toFixed(dec)))));
    setFilled(true);
  }, [colQ.data, filled]);

  // الترتيب مقصود: يُنتظر وصول الرصيد الجديد **ثم** يُفتح قفل التعبئة — فالعكس
  // يعيد ملء الحقل بالرقم السابق لأن react-query يُبقي البيانات القديمة أثناء الجلب
  const afterWrite = async () => {
    await Promise.all([colQ.refetch(), logQ.refetch()]);
    setFilled(false);
  };

  const settle = useMutation({
    mutationFn: () => salesRepApi.settle(rep.id, {
      amount: Number(amount),
      method,
      note: note.trim() || undefined,
      photos: photos.length ? photos : undefined,
    }),
    onSuccess: async () => {
      toast.success(tr('تم تسجيل الاستلام'));
      setNote('');
      // النوع والمرفقات يعودان إلى الصفر: الاستلام التالي حدثٌ آخر، وإبقاء صور
      // الأوّل معلّقةً كان يُرفقها بالثاني دون أن ينتبه المستلِم
      setMethod('CASH');
      setPhotos([]);
      await afterWrite();
    },
    onError: (e: unknown) => toast.error(errMsg(e, tr('تعذر التسجيل'))),
  });

  /* اختيار الصور: الضغط بالوحدة المشتركة وحدها (١٢٨٠px / ٠٫٧) — حدّاها مُعايَران
   * تحت سقف الخادم. وبلا `capture` عمداً: إيصال الإيداع لقطةُ شاشةٍ محفوظةٌ
   * غالباً، ففرضُ الكاميرا كان يحجب الحالة الأشيع. */
  const pickPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار الملفّ نفسه بعد حذفه
    let room = MAX_PHOTOS - photos.length;
    if (files.length > room) toast.error(tr('الحد الأقصى 4 صور'));
    for (const f of files) {
      if (room <= 0) break;
      try {
        const url = await compressImage(f);
        room -= 1;
        setPhotos(prev => (prev.length < MAX_PHOTOS ? [...prev, url] : prev));
      } catch { /* ملفٌ تالف أو غير صورة — يُتجاهل ولا يُسقط بقيّة الاختيار */ }
    }
  };

  const removeRow = useMutation({
    mutationFn: (s: Settlement) => salesRepApi.deleteSettlement(rep.id, s.id),
    onSuccess: async () => {
      toast.success(tr('تم حذف الاستلام'));
      setDelRow(null);
      await afterWrite();
    },
    onError: (e: unknown) => { toast.error(errMsg(e, tr('تعذر حذف الاستلام'))); setDelRow(null); },
  });

  const col = colQ.data;
  const amountNum = Number(amount);
  const amountOk = Number.isFinite(amountNum) && amountNum > 0;

  /* تصدير تسجيلٍ واحد: نعرض مستنده ملء الشاشة بدل شاشة الاستلام — مطابقةً
   * للوحة، ولأن عارض المستندات يحتاج الشاشة كلّها ليُخرج PDF بمقاس A4. */
  if (pdfRow) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MSettlementDoc repName={rep.name} settlement={pdfRow} company={company}
          onClose={() => setPdfRow(null)} />
      </Suspense>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('استلام تحصيل')} subtitle={rep.name} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        {colQ.isLoading ? <div className="py-10"><MSpinner /></div>
          : colQ.isError || !col ? <div className="py-10"><MError onRetry={() => colQ.refetch()} text={tr('تعذر تحميل رصيد التحصيل')} /></div>
            : (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="col-span-2">
                    <MStat icon={Wallet} label={tr('الرصيد المتبقي لدى المندوب')}
                      value={formatCurrency(col.outstanding)}
                      tone={Number(col.outstanding) > 0 ? 'warn' : 'good'} />
                  </div>
                  <MStat label={tr('إجمالي التحصيل')} value={formatCurrency(col.collected)} />
                  <MStat label={tr('المستلم سابقا')} value={formatCurrency(col.settled)} />
                </div>

                <Group title={tr('تسجيل استلام')}>
                  <div>
                    <label className="label">{tr('المبلغ المستلم من المندوب')}</label>
                    <input className="input" dir="ltr" type="number" inputMode="decimal" min={0} step="any"
                      value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
                    <Hint text={tr('معبأ بالرصيد المتبقي تسليم كامل عدله للتسليم الجزئي')} />
                  </div>

                  {/* شرائح لا قائمة منسدلة: الشاشة تُشغَّل بإبهامٍ واحد، والمنسدلة
                      تُخفي الخيارات الأربعة خلف لمستين ونافذة نظام */}
                  <div>
                    <label className="label">{tr('نوع الاستلام')}</label>
                    <div className="grid grid-cols-4 gap-2">
                      {SETTLE_METHODS.map(m => {
                        const Icon = m.icon;
                        const on = method === m.v;
                        return (
                          <button key={m.v} type="button" onClick={() => setMethod(m.v)}
                            aria-pressed={on}
                            className={`flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl border min-h-[60px] ${on ? 'bg-[#E9F6EF] border-[#2F855A] text-[#2F855A]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>
                            <Icon size={17} />
                            <span className="text-[10px] font-semibold leading-tight text-center">{tr(m.label)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* المرفقات: سند الاستلام ورقيّاً هو إيصال الإيداع أو صورة التحويل */}
                  <div>
                    <label className="label">{tr('مرفقات')}</label>
                    <div className="flex flex-wrap gap-2">
                      {photos.map((p, i) => (
                        <span key={i} className="relative w-[72px] h-[72px] rounded-xl overflow-hidden border border-[#E9E1D3] bg-[#FAF7F0]">
                          <img src={p} alt="" className="w-full h-full object-cover" />
                          {/* الدائرة ٢٤px كما في سند القبض، وهدف اللمس حولها ٤٠px
                              بحشوةٍ شفّافة — إبهامٌ يخطئ زرّ حذفٍ فوق صورةٍ يمسح غيرها */}
                          <button type="button" onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                            aria-label={tr('حذف الصورة')}
                            className="absolute top-0 start-0 p-2">
                            <span className="bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center">
                              <X size={13} />
                            </span>
                          </button>
                        </span>
                      ))}
                      {photos.length < MAX_PHOTOS && (
                        <label className="w-[72px] h-[72px] rounded-xl border-2 border-dashed border-[#E0D7C6] text-[#9A8F7E] flex flex-col items-center justify-center gap-1 active:bg-[#FAF7F0]">
                          {/* بلا `capture` عمداً: المعرض مطلوبٌ بقدر الكاميرا — إيصال
                              الإيداع لقطةُ شاشةٍ من تطبيق البنك محفوظةٌ سلفاً غالباً */}
                          <input type="file" accept="image/*" multiple className="hidden" onChange={pickPhotos} />
                          <ImageIcon size={18} />
                          <span className="text-[10px]">{tr('إضافة صورة')}</span>
                        </label>
                      )}
                    </div>
                    <Hint text={tr('الحد الأقصى 4 صور')} />
                  </div>

                  <div>
                    <label className="label">{tr('ملاحظة اختياري')}</label>
                    <input className="input" value={note} onChange={e => setNote(e.target.value)}
                      placeholder={tr('مثال رقم الإيصال أو اسم البنك')} />
                  </div>
                  <button onClick={() => settle.mutate()} disabled={!amountOk || settle.isPending}
                    className="w-full bg-[#2F855A] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:bg-[#9CC3AE]">
                    {settle.isPending ? <Loader2 size={16} className="animate-spin" /> : <Banknote size={16} />}
                    {tr('تسجيل الاستلام')}
                  </button>
                </Group>
              </>
            )}

        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('سجل الاستلامات')}</h3>
          {logQ.isLoading ? (
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-6 text-center text-[11px] text-[#9A8F7E]">
              {tr('جاري التحميل')}
            </div>
          ) : logQ.isError ? (
            <button onClick={() => logQ.refetch()}
              className="w-full rounded-2xl border border-[#F5C6C0] bg-[#FDF2F0] p-3.5 text-start min-h-[56px]">
              <p className="text-[11px] text-[#C0392B]">{tr('تعذر تحميل سجل الاستلامات')}</p>
              <p className="text-xs font-bold text-[#C0392B] mt-1">{tr('إعادة المحاولة')}</p>
            </button>
          ) : !logQ.data?.length ? (
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-6 text-center text-[11px] text-[#9A8F7E]">
              {tr('لا توجد استلامات بعد')}
            </div>
          ) : (
            <MCard>
              {logQ.data.map(s => (
                <MRow key={s.id}
                  title={(
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{formatCurrency(s.amount)}</span>
                      <span className="flex-shrink-0 rounded-full bg-[#F1EBDF] text-[#6E6557] text-[10px] font-semibold px-1.5 py-0.5">
                        {tr(methodLabel(s.method))}
                      </span>
                      {/* مؤشّر المرفقات لا صورها: الصفّ عرضه ٣٦٠px، ومصغّرةٌ فيه
                          لا تُقرأ — وعدد المرفقات وحده يقول إنّ للاستلام سنداً */}
                      {!!s.photos?.length && (
                        <span className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-[#9A8F7E]"
                          aria-label={tr('مرفقات')}>
                          <Paperclip size={11} />{s.photos.length}
                        </span>
                      )}
                    </span>
                  )}
                  subtitle={`${tr('استلمه')}: ${s.createdBy || '—'}${s.note ? ` · ${s.note}` : ''}`}
                  note={`${formatDate(s.settledAt)} · ${formatTime(s.settledAt)}`}
                  trailing={(
                    <span className="flex items-center gap-0.5 flex-shrink-0">
                      <button onClick={() => setPdfRow(s)} aria-label={tr('تصدير PDF')}
                        className="p-2.5 -m-1 rounded-xl text-[#6E6557] active:bg-[#F1EBDF]">
                        <Download size={16} />
                      </button>
                      {isMainAdmin && (
                        <button onClick={() => setDelRow(s)} aria-label={tr('حذف الاستلام')}
                          className="p-2.5 -m-1 rounded-xl text-[#C0392B] active:bg-[#FDF2F0]">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </span>
                  )} />
              ))}
            </MCard>
          )}
        </section>

        <div className="h-2" />
      </div>

      {delRow && (
        <MConfirm
          danger
          title={tr('حذف استلام تحصيل')}
          message={`${tr('سيحذف استلام بمبلغ')} ${formatCurrency(delRow.amount)} ${tr('ويعود المبلغ رصيدا مطلوبا من المندوب ولا يمكن التراجع')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={removeRow.isPending}
          onConfirm={() => removeRow.mutate(delRow)}
          onClose={() => setDelRow(null)} />
      )}
    </div>
  );
}

/* ═══════════════════════ لبنات داخلية ═══════════════════════ */

function Group({ title, children, flush }: { title: string; children: React.ReactNode; flush?: boolean }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{title}</h3>
      <div className={`bg-white rounded-2xl border border-[#F1EBDF] ${flush ? 'overflow-hidden' : 'p-3 space-y-3'}`}>
        {children}
      </div>
    </section>
  );
}

function Field({ label, value, onChange, required, dir, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  required?: boolean; dir?: 'ltr' | 'rtl'; type?: string;
}) {
  return (
    <div>
      <label className="label">{label}{required && ' *'}</label>
      <input className="input" type={type} dir={dir} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function Hint({ text, bad }: { text: string; bad?: boolean }) {
  return <p className={`text-[11px] mt-1 px-0.5 leading-relaxed ${bad ? 'text-[#C0392B]' : 'text-[#9A8F7E]'}`}>{text}</p>;
}

/** مفتاح تبديل — الصفّ كلّه هدف اللمس (٥٢px) لا المفتاح الصغير وحده */
function MToggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[52px] text-start border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0]">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-[#1F1A13]">{label}</span>
        {hint && <span className="block text-[10px] text-[#9A8F7E] mt-0.5 leading-relaxed">{hint}</span>}
      </span>
      <span className={`relative inline-block h-7 w-12 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-[#E15A30]' : 'bg-[#E0D7C6]'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'start-6' : 'start-1'}`} />
      </span>
    </button>
  );
}

/**
 * تأكيدٌ صريح لفعلٍ لا رجعة فيه — ورقة سفلية لا نافذة وسط الشاشة (الإبهام في
 * الأسفل). تُسجّل نفسها في مكدّس الرجوع لأنها لا تُركَّب إلا وهي مفتوحة.
 */
function MConfirm({ title, message, confirmLabel, loading, danger, onConfirm, onClose }: {
  title: string; message: string; confirmLabel: string;
  loading?: boolean; danger?: boolean; onConfirm: () => void; onClose: () => void;
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
          <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${danger ? 'bg-[#FDF2F0] text-[#C0392B]' : 'bg-[#FBEBE2] text-[#C94E28]'}`}>
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
            className={`flex-1 min-h-[48px] rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 ${danger ? 'bg-[#C0392B] disabled:bg-[#D98A80]' : 'bg-[#E15A30] disabled:bg-[#E89B7E]'}`}>
            {loading && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * بيانات دخول المندوب بعد إنشائه.
 *
 * تُعرض مرّة واحدة ولا تُسترجَع: الخادم يخزّن بصمة كلمة المرور لا نصّها. فإن
 * أُغلقت الورقة قبل تسليمها لم يبقَ إلا إعادة التعيين من ملفّ المندوب.
 */
function CredsSheet({ creds, onClose }: { creds: Creds; onClose: () => void }) {
  const tr = useTr();
  const [copied, setCopied] = useState(false);
  const copyAll = () => {
    const text = `${tr('بيانات الدخول لتطبيق المندوب')}\n${tr('الاسم')}: ${creds.name}\n${tr('اسم المستخدم')}: ${creds.username}\n${tr('كلمة المرور')}: ${creds.password}`;
    navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); toast.success(tr('تم النسخ')); },
      () => toast.error(tr('تعذر النسخ')),
    );
  };

  return (
    <div className="absolute inset-0 z-[700] bg-black/50 flex items-end">
      <div className="w-full bg-white rounded-t-3xl p-4 space-y-3"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-[#E4F1EA] text-[#2F855A] flex items-center justify-center flex-shrink-0">
            <KeyRound size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-[#1F1A13]">{tr('تم إنشاء حساب المندوب')}</span>
            <span className="block text-[12px] text-[#6E6557] mt-1 leading-relaxed">
              {tr('سلم هذه البيانات للمندوب كلمة المرور لن تظهر مرة أخرى')}
            </span>
          </span>
        </div>

        <div className="rounded-2xl border border-[#F1EBDF] overflow-hidden">
          <CredRow label={tr('الاسم')} value={creds.name} />
          <CredRow label={tr('اسم المستخدم')} value={creds.username} mono />
          <CredRow label={tr('كلمة المرور')} value={creds.password} mono />
        </div>

        <div className="flex gap-2.5 pt-1">
          <button onClick={copyAll}
            className="flex-1 min-h-[48px] rounded-xl border border-[#E9E1D3] bg-white font-bold text-sm text-[#1F1A13] flex items-center justify-center gap-2">
            {copied ? <Check size={16} className="text-[#2F855A]" /> : <Copy size={16} />}
            {tr('نسخ الكل')}
          </button>
          <button onClick={onClose}
            className="flex-1 min-h-[48px] rounded-xl bg-[#E15A30] font-bold text-sm text-white">
            {tr('تم')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CredRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 min-h-[48px] border-b border-[#F1EBDF] last:border-0">
      <span className="text-[11px] text-[#9A8F7E] w-24 flex-shrink-0">{label}</span>
      <span className={`text-sm font-semibold text-[#1F1A13] flex-1 truncate ${mono ? 'font-mono' : ''}`} dir="auto">
        {value}
      </span>
    </div>
  );
}

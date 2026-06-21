import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salesRepApi } from '../api/client';
import { SalesRep } from '../types';
import { Plus, Search, Edit, Check, X as XIcon, Copy, KeyRound, UserCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import SalesRepModal from '../components/forms/SalesRepModal';

interface Creds { name: string; username: string; password: string; }

export default function SalesRepsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<SalesRep | null>(null);
  const [createdCreds, setCreatedCreds] = useState<Creds | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sales-reps', search],
    queryFn: async () => {
      const res = await salesRepApi.list({ search, limit: 50 });
      return res.data.data as SalesRep[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: Partial<SalesRep> & { password?: string }) =>
      selected ? salesRepApi.update(selected.id, values) : salesRepApi.create(values),
    onSuccess: (_data, variables) => {
      const wasCreate = !selected;
      qc.invalidateQueries({ queryKey: ['sales-reps'] });
      setShowModal(false);
      setSelected(null);
      if (wasCreate) {
        // عرض بيانات الدخول لتسليمها للمندوب
        setCreatedCreds({ name: variables.name || '', username: variables.username || '', password: variables.password || '' });
      } else {
        toast.success('تم تحديث بيانات المندوب');
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ';
      toast.error(msg);
    },
  });

  const perm = (val: boolean) => val
    ? <Check size={14} className="text-green-500" />
    : <XIcon size={14} className="text-gray-300" />;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">إدارة المناديب</h1>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />إضافة مندوب</button>
      </div>

      <div className="card mb-4">
        <div className="relative max-w-sm">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pr-9" placeholder="بحث بالاسم أو الجوال..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>المندوب</th><th>الجوال</th><th>اسم المستخدم</th>
                <th className="text-center">فاتورة</th>
                <th className="text-center">تحصيل</th>
                <th className="text-center">تغيير سعر</th>
                <th className="text-center">خصم أقصى</th>
                <th className="text-center">إضافة عميل</th>
                <th>الحالة</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
              ) : data?.map(r => (
                <tr key={r.id}>
                  <td>
                    <p className="font-medium text-gray-800">{r.name}</p>
                    <p className="text-xs text-gray-400">{r.email || ''}</p>
                  </td>
                  <td className="font-mono text-sm text-gray-600">{r.phone}</td>
                  <td className="font-mono text-sm text-gray-500">{r.username}</td>
                  <td className="text-center">{perm(r.canCreateInvoice)}</td>
                  <td className="text-center">{perm(r.canCreateReceipt)}</td>
                  <td className="text-center">{perm(r.canChangePrice)}</td>
                  <td className="text-center text-sm text-gray-600">{r.maxDiscountPct}%</td>
                  <td className="text-center">{perm(r.canAddCustomer)}</td>
                  <td><span className={r.isActive ? 'badge-active' : 'badge-inactive'}>{r.isActive ? 'نشط' : 'غير نشط'}</span></td>
                  <td>
                    <button onClick={() => { setSelected(r); setShowModal(true); }} className="p-1.5 hover:bg-blue-50 rounded text-blue-600"><Edit size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <SalesRepModal
          rep={selected}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
          loading={saveMutation.isPending}
        />
      )}

      {createdCreds && (
        <CredentialsModal creds={createdCreds} onClose={() => setCreatedCreds(null)} />
      )}
    </div>
  );
}

// ============ شاشة بيانات الدخول بعد إنشاء المندوب ============
function CredentialsModal({ creds, onClose }: { creds: Creds; onClose: () => void }) {
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    });
  };
  const copyAll = () =>
    copy('all', `بيانات الدخول لتطبيق المندوب\nالاسم: ${creds.name}\nاسم المستخدم: ${creds.username}\nكلمة المرور: ${creds.password}`);

  const row = (label: string, value: string, key: string) => (
    <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5">
      <div>
        <p className="text-[11px] text-gray-400">{label}</p>
        <p className="font-mono font-semibold text-gray-800" dir="ltr">{value}</p>
      </div>
      <button onClick={() => copy(key, value)} className="p-1.5 hover:bg-white rounded text-blue-600" title="نسخ">
        {copied === key ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <UserCheck size={28} className="text-green-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">تم إنشاء حساب المندوب</h2>
          <p className="text-sm text-gray-500 mt-1">{creds.name}</p>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-blue-700 bg-blue-50 rounded-lg px-3 py-2 text-xs">
            <KeyRound size={14} />
            سلّم هذه البيانات للمندوب ليدخل بها على التطبيق — كلمة المرور لن تظهر مرة أخرى
          </div>
          {row('الاسم', creds.name, 'name')}
          {row('اسم المستخدم', creds.username, 'username')}
          {row('كلمة المرور', creds.password, 'password')}
        </div>

        <div className="flex gap-3 p-6 pt-0">
          <button onClick={copyAll} className="btn-secondary flex-1 justify-center">
            {copied === 'all' ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            نسخ الكل
          </button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center">تم</button>
        </div>
      </div>
    </div>
  );
}

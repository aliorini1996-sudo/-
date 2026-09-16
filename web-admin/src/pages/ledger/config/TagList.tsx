import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { ledgerConfigApi, ledgerKeys, isLedgerAccessError, type GlAccountTag } from '../../../api/ledgerConfig';
import { ConfigHeader, ConfigModal, Field, WriteButton, useConfigErrorText, useLedgerCan } from './parts/configUi';

/** علامات الحسابات (CFG‑06): اسم عربي وإنجليزي، ونطاق الاستعمال (الحسابات أو التقارير)، وعدد الحسابات الموسومة. */
export default function TagList() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const canWrite = useLedgerCan('canConfigureLedger');
  const [edit, setEdit] = useState<GlAccountTag | 'new' | null>(null);
  const q = useQuery({ queryKey: ledgerKeys.tags, queryFn: async () => (await ledgerConfigApi.tags.list()).data.data });
  const applicability = (a: string) => (a === 'REPORTS' ? tr('التقارير') : tr('الحسابات'));

  return (
    <div className="space-y-3">
      <ConfigHeader title={tr('علامات الحسابات')} subtitle={tr('وسوم تجمع الحسابات في التقارير والتحليل')}
        actions={<WriteButton allowed={canWrite} onClick={() => setEdit('new')} className="btn-primary inline-flex items-center gap-1.5"><Plus size={15} />{tr('جديد')}</WriteButton>} />
      {q.isError && <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>}
      <div className="table-wrapper overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="text-start">{tr('الاسم')}</th>
              <th className="text-start">{tr('الاستخدام')}</th>
              <th className="text-end">{tr('عدد الحسابات')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={3} className="text-center text-[#9A8F7E] py-8">{tr('جاري التحميل...')}</td></tr>}
            {!q.isLoading && (q.data ?? []).length === 0 && <tr><td colSpan={3} className="text-center text-[#9A8F7E] py-8">{tr('لا توجد بيانات')}</td></tr>}
            {(q.data ?? []).map(t => (
              <tr key={t.id} className={canWrite ? 'cursor-pointer hover:bg-[#FBF7F0]' : ''} onClick={() => canWrite && setEdit(t)}>
                <td className="font-medium">{ledgerName({ ...t, nameI18n: null }, lang)}</td>
                <td>{applicability(t.applicability)}</td>
                <td className="text-end tabular-nums">{t.accountCount ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TagDialog tag={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TagDialog({ tag, onClose }: { tag: GlAccountTag | null; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const [name, setName] = useState(tag?.name ?? '');
  const [nameEn, setNameEn] = useState(tag?.nameEn ?? '');
  const [applicability, setApplicability] = useState<string>(tag?.applicability ?? 'ACCOUNTS');
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), nameEn: nameEn.trim() || null, applicability };
      return tag ? ledgerConfigApi.tags.update(tag.id, body) : ledgerConfigApi.tags.create(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ledgerKeys.tags }); toast.success(tr('تم الحفظ')); onClose(); },
    onError: e => toast.error(errorText(e)),
  });
  return (
    <ConfigModal title={tag ? tr('تعديل العلامة') : tr('علامة جديدة')} onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        <WriteButton allowed onClick={() => save.mutate()} busy={save.isPending} reason={name.trim() ? null : tr('الاسم مطلوب')}>{tr('حفظ')}</WriteButton>
      </>}>
      <Field label={tr('الاسم')}><input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={100} autoFocus /></Field>
      <Field label={tr('الاسم الإنجليزي')}><input className="input" dir="ltr" value={nameEn} onChange={e => setNameEn(e.target.value)} maxLength={100} /></Field>
      <Field label={tr('الاستخدام')}>
        <select className="input" value={applicability} onChange={e => setApplicability(e.target.value)}>
          <option value="ACCOUNTS">{tr('الحسابات')}</option>
          <option value="REPORTS">{tr('التقارير')}</option>
        </select>
      </Field>
    </ConfigModal>
  );
}

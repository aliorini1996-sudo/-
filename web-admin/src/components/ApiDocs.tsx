import { useRef } from 'react';
import { Download, KeyRound, RefreshCw, ShieldAlert, Gauge, AlertTriangle, ListTree, Code2 } from 'lucide-react';
import { useTr } from '../i18n/strings';
import {
  API_BASE_URL, API_DENIED, API_SYNC_RESOURCES, SYNC_MODE_DOC, CURL_EXAMPLE, JS_SYNC_EXAMPLE, PY_SYNC_EXAMPLE, DELETE_RECONCILE_NOTE,
  API_MAX_PAGE,
} from '../lib/apiDocsData';
import { API_DOC_GROUPS, type DocEndpoint, type DocField } from '../lib/apiDocsCatalog';

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-blue-50 text-blue-700', POST: 'bg-green-50 text-green-700', PUT: 'bg-amber-50 text-amber-700',
  PATCH: 'bg-amber-50 text-amber-700', DELETE: 'bg-red-50 text-red-700',
};

function Code({ children }: { children: string }) {
  return <pre dir="ltr" className="api-code text-[11.5px] leading-relaxed bg-[#1F1A13] text-[#F6EFE3] rounded-xl p-3 overflow-x-auto whitespace-pre text-left">{children}</pre>;
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="api-section card p-5 space-y-3">
      <h2 className="font-bold text-[#1F1A13] flex items-center gap-2">{icon} {title}</h2>
      {children}
    </section>
  );
}

function FieldsTable({ title, fields }: { title: string; fields: DocField[] }) {
  if (!fields.length) return null;
  return (
    <div className="overflow-x-auto">
      <p className="text-[11px] font-semibold text-[#6E6557] mb-1">{title}</p>
      <table className="w-full text-xs border border-[#F1EBDF]">
        <tbody className="divide-y divide-[#F1EBDF]">
          {fields.map(f => (
            <tr key={f.name}>
              <td dir="ltr" className="px-2 py-1.5 font-mono text-[#1F1A13] whitespace-nowrap text-left">{f.name}{f.required ? ' *' : ''}</td>
              <td dir="ltr" className="px-2 py-1.5 font-mono text-[#9A8F7E] whitespace-nowrap text-left">{f.type}</td>
              <td className="px-2 py-1.5 text-[#6E6557]">{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Endpoint({ e }: { e: DocEndpoint }) {
  return (
    <div className="api-endpoint border border-[#E9E1D3] rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap" dir="ltr">
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${METHOD_TONE[e.method] ?? 'bg-gray-100 text-gray-700'}`}>{e.method}</span>
        <code className="text-xs font-mono text-[#1F1A13]">/api{e.path}</code>
      </div>
      <p className="text-sm text-[#1F1A13]">{e.purpose}</p>
      <p className="text-[11px] text-[#9A8F7E]">
        {e.permission && <>صلاحية: <code dir="ltr">{e.permission}</code></>}
        {e.gates.length > 0 && <> · {e.gates.join(' · ')}</>}
      </p>
      <FieldsTable title="معاملات الرابط (query)" fields={e.query} />
      <FieldsTable title="جسم الطلب (JSON body) — النجمة إلزامي" fields={e.body} />
      {e.response && <p className="text-xs text-[#6E6557]"><b>الرد:</b> {e.response}</p>}
      {e.rules.length > 0 && (
        <ul className="text-xs text-[#6E6557] list-disc ps-5 space-y-0.5">{e.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}
      {e.example && <Code>{e.example}</Code>}
    </div>
  );
}

/**
 * مستند API للمبرمج — يُقرأ هنا ويُحمَّل ملف HTML مستقلّاً يُسلَّم لمبرمج الشركة.
 * المحتوى تقنيّ للمبرمج فيُكتب بالعربية مع أسماء الحقول والمسارات كما هي في الكود.
 */
export default function ApiDocs({ ratePerMinute }: { ratePerMinute: number }) {
  const tr = useTr();
  const ref = useRef<HTMLDivElement>(null);

  /** ملف HTML مستقلّ بأنماط مضمّنة — يُفتح في أي متصفح ويُطبع PDF منه */
  const download = () => {
    if (!ref.current) return;
    const css = `body{font-family:'IBM Plex Sans Arabic','Noto Kufi Arabic',system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1F1A13;line-height:1.7}
h1{color:#E15A30}h2{border-bottom:2px solid #E15A30;padding-bottom:4px;margin-top:28px}
pre{background:#1F1A13;color:#F6EFE3;padding:12px;border-radius:8px;overflow:auto;direction:ltr;text-align:left;font-size:12px}
code{font-family:Consolas,monospace}table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0}
td,th{border:1px solid #E9E1D3;padding:4px 6px;vertical-align:top}.api-endpoint{border:1px solid #E9E1D3;border-radius:8px;padding:10px;margin:10px 0}
button{display:none}`;
    const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Field Sales API</title><style>${css}</style></head><body><h1>Field Sales — API</h1>${ref.current.innerHTML}</body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'FieldSales-API.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-[#9A8F7E]">{tr('هذا المستند يسلم لمبرمج نظامكم مع المفتاح ولا يحوي المفتاح نفسه')}</p>
        <button onClick={download} className="btn-primary"><Download size={16} /> {tr('تحميل المستند')}</button>
      </div>

      <div ref={ref} className="space-y-4" dir="rtl">
        <Section icon={<KeyRound size={18} className="text-[#E15A30]" />} title="١. المصادقة والعنوان">
          <p className="text-sm text-[#6E6557]">
            العنوان الأساسي: <code dir="ltr" className="font-mono">{API_BASE_URL}</code> — كل الطلبات والردود JSON بترميز UTF-8.
            المفتاح يعمل على حساب الشركة بصلاحيات المستخدم الذي أصدره: ما يستطيعه في لوحة التحكم يستطيعه المفتاح، قراءةً وكتابة (أو قراءة فقط إن أُصدر كذلك).
          </p>
          <Code>{`Authorization: Bearer fsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n# or\nX-API-Key: fsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`}</Code>
          <ul className="text-xs text-[#6E6557] list-disc ps-5 space-y-1">
            <li>استدعِ الواجهة من خادمكم فقط (server-to-server). لا تضع المفتاح في تطبيق جوال أو صفحة متصفح، ولا في رابط الطلب (الروابط تُسجَّل).</li>
            <li>لا ترسل ترويسة Origin — طلبات المتصفح من نطاقات أخرى تُرفض.</li>
            <li>إن تسرّب المفتاح ألغه فوراً من لوحة التحكم ← الربط البرمجي API، وأصدر غيره.</li>
          </ul>
        </Section>

        <Section icon={<Gauge size={18} className="text-[#E15A30]" />} title="٢. الحدود والأخطاء">
          <p className="text-sm text-[#6E6557]">
            {ratePerMinute} طلباً في الدقيقة لكل مفتاح. الرد يحمل <code dir="ltr">X-RateLimit-Limit</code> و<code dir="ltr">X-RateLimit-Remaining</code>،
            وعند التجاوز <code dir="ltr">429</code> مع <code dir="ltr">Retry-After</code> بالثواني.
            والطلبات المرفوضة تُحسب من الحد أيضاً. قوائم لوحة التحكم (مثل <code dir="ltr">GET /api/invoices</code>) أقصى <code dir="ltr">limit</code> فيها {API_MAX_PAGE} صفاً لطلبات المفتاح، وللسحب الكامل استعمل المزامنة في القسم ٣.
          </p>
          <Code>{`// success\n{ "success": true, "data": ... }\n// error\n{ "success": false, "code": "API_KEY_INVALID", "message": "..." }`}</Code>
          <table className="w-full text-xs border border-[#F1EBDF]">
            <tbody className="divide-y divide-[#F1EBDF] text-[#6E6557]">
              {[
                ['400', 'بيانات غير صحيحة (تفاصيل الحقول في errors) أو since/cursor غير صالح'],
                ['401', 'API_KEY_INVALID مفتاح غير صالح أو ملغى · API_KEY_OWNER_INACTIVE صاحب المفتاح معطل'],
                ['403', 'API_NOT_ALLOWED الميزة غير مفعلة · TENANT_BLOCKED الاشتراك موقوف أو منتهٍ · API_KEY_FORBIDDEN مسار ممنوع أو مفتاح قراءة فقط يكتب · نقص صلاحية'],
                ['404', 'غير موجود'],
                ['409', 'تعارض: تكرار أو حالة لا تسمح (مثل إلغاء فاتورة عليها سند)'],
                ['429', 'API_RATE_LIMIT تجاوزت الحد — انتظر Retry-After'],
              ].map(([c, d]) => <tr key={c}><td dir="ltr" className="px-2 py-1.5 font-mono font-bold text-left">{c}</td><td className="px-2 py-1.5">{d}</td></tr>)}
            </tbody>
          </table>
          <p className="text-xs text-[#6E6557]">
            <ShieldAlert size={13} className="inline text-amber-600" /> مسارات لا يبلغها المفتاح:{' '}
            {API_DENIED.map(d => <span key={d.prefix}><code dir="ltr">/api{d.prefix}</code> ({d.why}) </span>)}
          </p>
        </Section>

        <Section icon={<RefreshCw size={18} className="text-[#E15A30]" />} title="٣. المزامنة المباشرة — انعكاس البيانات في نظامكم">
          <p className="text-sm text-[#6E6557]">
            لكل مورد مسار يعيد ما أُنشئ أو تغيّر منذ لحظة، صفحةً صفحة. شغّل المزامنة كل دقيقة لكل مورد فتنعكس بيانات المنصة في نظامكم أولاً بأول.
          </p>
          <Code>{`GET /api/v1/me                                          # key, company and resources
GET /api/v1/sync/{resource}?since=ISO&limit=500&cursor=...  # created/changed since
GET /api/v1/sync/{resource}/ids?limit=5000&cursor=...       # all current ids`}</Code>
          <ol className="text-xs text-[#6E6557] list-decimal ps-5 space-y-1">
            <li>أول مرة بلا since: تصلك كل السجلات صفحةً صفحة (حتى ٥٠٠ في الصفحة).</li>
            <li>تابع nextCursor حتى يصير null، وأدرج كل صف في نظامك أو حدّثه حسب id.</li>
            <li>احفظ serverTime من أول صفحة، وفي المرة التالية أرسل since = serverTime ناقص ٣ دقائق. التداخل مقصود لئلا يفوتك شيء، والتكرار يُعالَج بالـ id.</li>
            <li>{DELETE_RECONCILE_NOTE}</li>
          </ol>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-[#F1EBDF]">
              <thead className="bg-[#FAF7F0] text-[#6E6557]"><tr>
                <th className="px-2 py-1.5 text-start">resource</th><th className="px-2 py-1.5 text-start">المحتوى</th>
                <th className="px-2 py-1.5 text-start">طريقة الالتقاط</th><th className="px-2 py-1.5 text-start">مضمّن</th>
                <th className="px-2 py-1.5 text-start">حذف فعلي</th><th className="px-2 py-1.5 text-start">صلاحية</th>
              </tr></thead>
              <tbody className="divide-y divide-[#F1EBDF] text-[#6E6557]">
                {API_SYNC_RESOURCES.map(r => (
                  <tr key={r.name}>
                    <td dir="ltr" className="px-2 py-1.5 font-mono text-[#1F1A13] text-left">{r.name}</td>
                    <td className="px-2 py-1.5">{r.what}</td>
                    <td className="px-2 py-1.5">{SYNC_MODE_DOC[r.mode]}</td>
                    <td dir="ltr" className="px-2 py-1.5 font-mono text-left">{r.includes ?? '—'}</td>
                    <td className="px-2 py-1.5">{r.hardDeletes ? 'نعم' : 'لا'}</td>
                    <td dir="ltr" className="px-2 py-1.5 font-mono text-left">{r.permission}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="text-xs text-[#6E6557] list-disc ps-5 space-y-1">
            <li>الحذف المنطقي يصلك تعديلاً: العميل status = DELETED، الصنف deletedAt أو status = INACTIVE، الفاتورة والسند status = CANCELLED، المندوب isActive = false.</li>
            <li>توزيعات السند الملغى (invoiceItems) تبقى في السجل — تجاهلها، فالمبالغ أُعيدت للفواتير.</li>
            <li>المبالغ أرقام عشرية والتواريخ ISO-8601 بتوقيت UTC. أسعار بنود الفاتورة شاملة الضريبة حين pricesIncludeTax = true، وsubtotal وdiscountAmt صافيان قبل الضريبة دائماً.</li>
            <li>رصيد مخزون السيارات والمستودع محسوب لا مخزَّن: اقرأه من مسارات المخزون أدناه، أو احسبه من van-loads وwarehouse-entries والفواتير.</li>
          </ul>
        </Section>

        <Section icon={<Code2 size={18} className="text-[#E15A30]" />} title="٤. أمثلة كود">
          <Code>{CURL_EXAMPLE}</Code>
          <Code>{JS_SYNC_EXAMPLE}</Code>
          <Code>{PY_SYNC_EXAMPLE}</Code>
        </Section>

        <Section icon={<ListTree size={18} className="text-[#E15A30]" />} title="٥. مسارات المنصة (قراءة وكتابة)">
          <p className="text-sm text-[#6E6557]">
            المفتاح يعمل على مسارات لوحة التحكم نفسها، بنفس قواعد التحقق والترقيم والمخزون وفوترة الزكاة. هذه أهمها بحقولها كما يقبلها الخادم.
          </p>
          {API_DOC_GROUPS.length === 0 && <p className="text-xs text-[#9A8F7E]"><AlertTriangle size={13} className="inline" /> —</p>}
          {API_DOC_GROUPS.map(g => (
            <div key={g.key} className="space-y-2">
              <h3 className="font-bold text-[#1F1A13] text-sm mt-3">{g.title}</h3>
              {g.overview && <p className="text-xs text-[#6E6557]">{g.overview}</p>}
              {g.endpoints.map(e => <Endpoint key={`${e.method} ${e.path}`} e={e} />)}
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

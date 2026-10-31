/**
 * مستند «الربط البرمجي API» — بياناتٌ يرسمها components/ApiDocs.tsx ويصدّرها ملفاً يُسلَّم لمبرمج الشركة.
 *
 * الثوابت هنا مرآةٌ لما في الخادم (backend/src/services/apiKeys.ts وapiSync.ts)، واختبار apiDocsData.test.ts
 * يقارنها بهما: موردٌ يُضاف للمزامنة أو بادئةٌ تُمنع على المفاتيح ولا تُذكر هنا تُفشل البناء.
 * فهرس مسارات اللوحة نفسها في apiDocsCatalog.ts (مستخرجٌ من مخططات zod في كل موجّه).
 */

export const API_BASE_URL = 'https://api.fieldsa.net/api';
export const API_RATE_PER_MINUTE = 120;

/** مسارات لا يبلغها المفتاح (مرآة API_KEY_DENIED_PREFIXES) — مع سبب يفهمه المبرمج */
export const API_DENIED: readonly { prefix: string; why: string }[] = [
  { prefix: '/auth', why: 'الدخول والتسجيل وكلمات المرور' },
  { prefix: '/api-keys', why: 'إصدار المفاتيح وإلغاؤها — من لوحة التحكم وحدها' },
  { prefix: '/company-users', why: 'مستخدمو الشركة وصلاحياتهم' },
  { prefix: '/tenants', why: 'أدوات مزود الخدمة' },
  { prefix: '/finance', why: 'أدوات مزود الخدمة' },
  { prefix: '/hunter', why: 'أدوات مزود الخدمة' },
  { prefix: '/affiliate-admin', why: 'أدوات مزود الخدمة' },
  { prefix: '/wa-inbox', why: 'أدوات مزود الخدمة' },
  { prefix: '/site-content', why: 'أدوات مزود الخدمة' },
  { prefix: '/profile-deck', why: 'أدوات مزود الخدمة' },
  { prefix: '/promo-videos', why: 'أدوات مزود الخدمة' },
  { prefix: '/leads-cron', why: 'أدوات مزود الخدمة' },
  { prefix: '/analytics', why: 'أدوات مزود الخدمة' },
  { prefix: '/payments', why: 'اشتراك الشركة في المنصة' },
  { prefix: '/live', why: 'بثّ لوحة التحكم اللحظي — للمزامنة استعمل /v1/sync' },
];

/** أقصى صفحة لقوائم لوحة التحكم عبر المفتاح (مرآة API_KEY_MAX_PAGE) */
export const API_MAX_PAGE = 200;

export type SyncModeDoc = 'updated' | 'created' | 'attendance' | 'snapshot';

/** موارد المزامنة (مرآة SYNC_RESOURCES) */
export const API_SYNC_RESOURCES: readonly {
  name: string; mode: SyncModeDoc; hardDeletes: boolean; what: string; includes?: string; permission: string;
}[] = [
  { name: 'customers', mode: 'updated', hardDeletes: true, what: 'العملاء ورصيد كل عميل وإجمالي مبيعاته وتحصيله', permission: 'canManageCustomers' },
  { name: 'customer-assignments', mode: 'snapshot', hardDeletes: true, what: 'إسناد العملاء للمناديب', permission: 'canManageCustomers' },
  { name: 'customer-prices', mode: 'updated', hardDeletes: true, what: 'أسعار خاصة لعميل بعينه', permission: 'canManageCustomers' },
  { name: 'products', mode: 'updated', hardDeletes: true, what: 'المنتجات (بلا الصورة) بوحدة الأساس unit وسعرها basePrice، ومعها primaryUnitId (الوحدة الرئيسية من units للعرض والإدخال الافتراضي وحده، وnull = بلا) وbaseConvertedAt (لحظة آخر إضافة وحدة فرعية أصغر، وnull = لم تحدث: إن تغيّر فكميات الصنف وأسعاره المخزَّنة عندك بالأساس القديم)، وlotTracked للشركة التي فعّلت «تتبّع LOT» وحدها', includes: 'priceTiers, units', permission: 'canManageProducts' },
  { name: 'categories', mode: 'snapshot', hardDeletes: true, what: 'تصنيفات المنتجات', permission: 'canManageProducts' },
  { name: 'sales-reps', mode: 'updated', hardDeletes: true, what: 'المناديب وصلاحياتهم وقيود الموقع والبصمة (proximityRadiusM وpunchRadiusM) وموقعه في «لوكيشن» locationId (الموقع اللحظي من /api/tracking/live بصلاحية التتبع)', permission: 'canManageSalesReps' },
  { name: 'locations', mode: 'updated', hardDeletes: true, what: 'مواقع الشركة في «لوكيشن» (الاسم والنقطة وisActive للمؤرشف) — تترجم locationId في المناديب والفواتير والتحميلات؛ تتطلب ألا يكون النظام المحاسبي مطفأً (403 ACCOUNTING_DISABLED أولاً) ثم تفعيل الميزة (403 LOCATIONS_DISABLED)', permission: 'canManageSalesReps' },
  { name: 'teams', mode: 'snapshot', hardDeletes: true, what: 'الفرق بأعضائها وأصنافها (isActive للمؤرشف) — تترجم teamId في الفواتير والسندات والزيارات والاستلامات', includes: 'members, products', permission: 'canManageSalesReps' },
  { name: 'invoices', mode: 'updated', hardDeletes: false, what: 'الفواتير والمرتجعات والإشعارات الدائنة والمدينة، ومعها locationId (ختم موقع المندوب وقت الإصدار) وteamId، وبند المرتجع من فاتورة بيع يحمل returnOfItemId', includes: 'items, installments', permission: 'canManageInvoices' },
  { name: 'receipts', mode: 'updated', hardDeletes: false, what: 'سندات القبض وتوزيعها على الفواتير: paymentMethod الأساس المحاسبي وpaymentMethodKey مفتاح طريقة الشركة (c_…) أو null للمدمجة، وteamId', includes: 'invoiceItems', permission: 'canManageReceipts' },
  { name: 'account-entries', mode: 'updated', hardDeletes: true, what: 'قيود كشف حساب العميل (مدين ودائن ورصيد)', permission: 'canManageCustomers' },
  { name: 'van-loads', mode: 'updated', hardDeletes: false, what: 'تحميل وتنزيل وتسوية مخزون السيارات وإزالة المنتهي والتالف (EXPIRED_OUT وDAMAGED_OUT)، ومعها locationId لحركات LOAD. ومع «تتبّع LOT» مفعّلاً يحمل كل بند id (يطابق vanLoadItemId في van-load-item-lots)', includes: 'items', permission: 'canManageVanStock' },
  { name: 'warehouse-entries', mode: 'created', hardDeletes: true, what: 'وارد وتسويات مخزون الشركة. ومع «تتبّع LOT» مفعّلاً يحمل كل بند id وlotId (تشغيلة السطر من product-lots، وnull = غير مسمّى أو صنف غير متتبَّع)', includes: 'items', permission: 'canManageVanStock' },
  { name: 'product-lots', mode: 'updated', hardDeletes: true, what: '«تتبّع LOT»: بطاقات التشغيلات (الرقم والتاريخان — يومان عند منتصف ليل UTC فخذ YYYY-MM-DD — والحالة والإيقاف والمصدر). تتطلب ألا يكون النظام المحاسبي مطفأً (403 ACCOUNTING_DISABLED أولاً) ثم تفعيل الميزة (403 LOTS_DISABLED) — كالأربعة التالية', permission: 'canManageVanStock' },
  { name: 'van-load-item-lots', mode: 'created', hardDeletes: false, what: '«تتبّع LOT»: توزيع بنود حركات السيارات على التشغيلات بالكمية الأساسية وبإشارة البند (lotId null = غير مسمّى) ويقينه، وviaWarehouse لما مرّ بالمستودع', permission: 'canManageVanStock' },
  { name: 'invoice-item-lots', mode: 'created', hardDeletes: false, what: '«تتبّع LOT»: توزيع بنود الفواتير والمرتجعات والإشعارات على التشغيلات بالكمية الأساسية (موجبة؛ الاتجاه من نوع الفاتورة)، ويقينه وأوسامه، وsourceItemLotId صفّ البيع الذي ورثه المرتجع', permission: 'canManageInvoices' },
  { name: 'lot-relabels', mode: 'created', hardDeletes: false, what: '«تتبّع LOT»: تسمية الرصيد القائم وإعادة تصنيفه بين التشغيلات (بُعد التشغيلة وحده بلا تغيير في رصيد الصنف)', permission: 'canManageVanStock' },
  { name: 'lot-events', mode: 'created', hardDeletes: false, what: '«تتبّع LOT»: سجل تدقيق التشغيلات وتبديل التتبّع، وbefore وafter كائنا JSON. صفوف التبديل (TRACKING_ON وTRACKING_OFF) بلا lotId: للصنف productId معرّفه وbefore/after من {lotTracked, lotTrackedSince}، ولتبديل الميزة على الشركة productId = "*" (ليس معرّف صنف) وbefore/after من {lotTrackingEnabled, lotTrackingSince}', permission: 'canManageVanStock' },
  { name: 'visits', mode: 'created', hardDeletes: true, what: 'الزيارات الميدانية (عدد الصور photoCount) — تُلتقط بطابع وصولها للخادم receivedAt فلا تفوت زيارة رُفعت متأخرة', permission: 'canManageTracking' },
  { name: 'attendance', mode: 'attendance', hardDeletes: true, what: 'بصمات الحضور والانصراف', permission: 'canManageTracking' },
  { name: 'settlements', mode: 'created', hardDeletes: true, what: 'توريد التحصيل من المناديب', permission: 'canManageSalesReps' },
  { name: 'routes', mode: 'updated', hardDeletes: true, what: 'خطوط السير ومحطاتها', includes: 'stops', permission: 'canManageTracking' },
];

export const SYNC_MODE_DOC: Record<SyncModeDoc, string> = {
  updated: 'يُلتقط الإنشاء والتعديل (updatedAt)',
  created: 'سجلات تُنشأ ولا تُعدَّل (createdAt)',
  attendance: 'يُلتقط بالبصمة أو بالانصراف',
  snapshot: 'قائمة كاملة في كل مرة (since يُتجاهل)',
};

export const CURL_EXAMPLE = `curl -s "${API_BASE_URL}/v1/sync/customers?since=2026-10-11T00:00:00Z&limit=200" \\
  -H "Authorization: Bearer fsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`;

export const JS_SYNC_EXAMPLE = `// Sync one resource — run it every minute for each resource
const BASE = '${API_BASE_URL}';
const KEY = process.env.FIELDSALES_API_KEY; // never in source code or in the URL

async function syncResource(resource, state) {
  const params = new URLSearchParams({ limit: '500' });
  if (state.since) params.set('since', state.since);
  let cursor = null, firstServerTime = null;
  do {
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(\`\${BASE}/v1/sync/\${resource}?\${params}\`, {
      headers: { Authorization: \`Bearer \${KEY}\` },
    });
    if (res.status === 429) { await sleep(Number(res.headers.get('Retry-After') || 5) * 1000); continue; }
    if (!res.ok) throw new Error(\`\${res.status} \${await res.text()}\`);
    const page = await res.json();
    firstServerTime ??= page.serverTime;
    for (const row of page.data) await upsertLocal(resource, row); // upsert by id
    cursor = page.nextCursor;
  } while (cursor);
  // next run: serverTime minus 3 minutes (overlap on purpose; dedupe by id)
  state.since = new Date(Date.parse(firstServerTime) - 3 * 60 * 1000).toISOString();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));`;

export const PY_SYNC_EXAMPLE = `import os, time, requests
from datetime import datetime, timedelta

BASE = "${API_BASE_URL}"
HEADERS = {"Authorization": f"Bearer {os.environ['FIELDSALES_API_KEY']}"}

def sync_resource(resource, since=None):
    params, cursor, first_server_time = {"limit": 500}, None, None
    while True:
        if since: params["since"] = since
        if cursor: params["cursor"] = cursor
        r = requests.get(f"{BASE}/v1/sync/{resource}", headers=HEADERS, params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", "5"))); continue
        r.raise_for_status()
        page = r.json()
        first_server_time = first_server_time or page["serverTime"]
        for row in page["data"]:
            upsert_local(resource, row)          # upsert by id
        cursor = page["nextCursor"]
        if not cursor: break
    t = datetime.fromisoformat(first_server_time.replace("Z", "+00:00")) - timedelta(minutes=3)
    return t.isoformat().replace("+00:00", "Z")   # next since`;

export const DELETE_RECONCILE_NOTE =
  'الموارد التي قد تُحذف حذفاً فعلياً (عمود «حذف فعلي») طابِقها مرة في اليوم: اجلب كل المعرّفات من /v1/sync/<المورد>/ids واحذف من نظامك ما ليس فيها.';

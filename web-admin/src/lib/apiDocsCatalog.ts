/**
 * فهرس مسارات المنصة في مستند «الربط البرمجي API» — مستخرجٌ من مخططات zod ومعالجات كل موجّه
 * (العملاء، المنتجات، الفواتير، السندات، المناديب، المخزون، الميدان، التقارير، لوكيشن، طرق الدفع، الفرق). يُرسم في
 * components/ApiDocs.tsx، ومعه في آخر الملف أدلّة ربط صفحات «لوكيشن» و«طرق الدفع» و«مخزون الشركة» خطوةً بخطوة (API_DOC_GUIDES).
 * يُحدَّث حين يتغيّر عقد مسار؛ واختبار apiDocsCatalog.test.ts يتحقّق أن كل مسار مذكور هنا مركَّب فعلاً في الخادم **في ملف
 * موجّهه** (ومنها الموجّهات المتداخلة تحت /company)، وأن كل مسار في موجّهات الميزات الحديثة موثّقٌ هنا أو مستثنى بسببه.
 */
import { API_BASE_URL } from './apiDocsData';

export interface DocField { name: string; type: string; required: boolean; desc: string }
export interface DocEndpoint {
  method: string; path: string; purpose: string; permission: string; gates: string[];
  query: DocField[]; body: DocField[]; response: string; rules: string[]; example: string;
}
export interface DocGroup { key: string; title: string; overview: string; endpoints: DocEndpoint[] }

// eslint-disable-next-line max-len
export const API_DOC_GROUPS: DocGroup[] = [
 {
  "key": "customers",
  "title": "العملاء",
  "overview": "مسارات العملاء تحت https://api.fieldsa.net/api/customers. ترسل المفتاح في الرأس Authorization: Bearer fsk_... أو في X-API-Key: fsk_... ويُعامل الطلب كأنه من مستخدم الشركة الذي أصدر المفتاح (ADMIN أو MANAGER أو ACCOUNTANT)\nكل مسارات المجموعة تمر بحارس requireAdminPermission('canManageCustomers') على مستوى الموجّه، ويُرفض الطلب بـ403 فقط إذا كانت هذه الصلاحية false صراحة لصاحب المفتاح. لا يوجد على هذه المجموعة حارس النظام المحاسبي requireAccounting\nإذا كان صاحب المفتاح مقيّد النطاق (Admin.scopeEnabled) فلا يرى ولا يعدّل إلا العملاء المسندين له، والعميل الذي خارج نطاقه يعود 404. أما شروط تطبيق المندوب (canAddCustomer وcanEditCustomer واشتراط الموقع) فلا تنطبق على المفتاح\nالمفتاح «للقراءة فقط» لا يقبل إلا GET وHEAD، وأي طريقة أخرى تعود 403 API_KEY_FORBIDDEN. الحد 120 طلباً في الدقيقة لكل مفتاح، وتصل معه الرؤوس X-RateLimit-Limit وX-RateLimit-Remaining، وعند التجاوز يعود 429 API_RATE_LIMIT مع Retry-After\nصيغة الأخطاء:\n- فشل zod يعود 400 بالشكل {success:false, message:'بيانات غير صحيحة <الحقول>', errors:{field:[...]}}\n- خطأ القيد الفريد يعود 409 بالرسالة 'السجل موجود مسبقا'\n- الأخطاء الأخرى تعود 500 ومعها رسالة الخطأ\nيُحذف من الجسم بصمت أي حقل غير معرَّف في مخطط zod، ولا يمكن كتابة code ولا balance ولا totalSales ولا totalCollected عبر هذه المسارات",
  "endpoints": [
   {
    "method": "GET",
    "path": "/customers",
    "purpose": "قائمة عملاء الشركة مع البحث والتصفية وترقيم الصفحات",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "نطاق المستخدم: صاحب المفتاح المقيّد النطاق يرى العملاء المسندين له فقط"
    ],
    "query": [
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "رقم الصفحة ويبدأ من 1 (الافتراضي 1). القيمة 0 أو النص غير الرقمي تُعامل كـ1، والقيمة السالبة تسبب خطأ 500"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "عدد الصفوف في الصفحة (الافتراضي 20، وأقصاه 200 لطلبات المفتاح). للسحب الكامل استعمل /api/v1/sync/customers"
     },
     {
      "name": "search",
      "type": "string",
      "required": false,
      "desc": "بحث جزئي في name وbusinessName وphone وcode، وهو حساس لحالة الأحرف اللاتينية"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE | BLOCKED",
      "required": false,
      "desc": "تصفية حسب الحالة بأحرف كبيرة. إذا لم تُرسل يعيد كل العملاء غير المحذوفين. القيمة تُمرَّر كما هي، فالقيمة DELETED تعيد المؤرشفين"
     },
     {
      "name": "channel",
      "type": "enum: MT | WHOLESALE | TT | DISCOUNTER | CASH_VAN | ECOMMERCE",
      "required": false,
      "desc": "تطابق تام مع قناة البيع"
     }
    ],
    "body": [],
    "response": "{success:true, data:[Customer], pagination:{total, page, limit, pages}}. صف العميل كامل ويشمل: id وcode وname وbusinessName وphone وaltPhone وemail وtaxNumber وcommercialReg وcity وdistrict وaddress وlat وlng وchannel وoutletType وaiPlaceId وstatus وcreditLimit وpaymentDays وbalance وtotalSales وtotalCollected وclientRef وclientCreatedAt وcreatedBySalesRepId وbuyerType وbuyerIdScheme وbuyerIdValue وaddrStreet وaddrBuildingNo وaddrAdditionalNo وaddrPostalCode وcountryCode وcreatedAt وupdatedAt",
    "rules": [
     "الترتيب حسب createdAt من الأحدث إلى الأقدم",
     "العملاء المؤرشفون (status=DELETED) مستبعدون ما لم تطلبهم صراحة عبر status",
     "balance هو المستحق على العميل (المدين ناقص الدائن)، تحدّثه الفواتير والسندات ويُقرأ فقط",
     "pages = ceil(total / limit)"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/customers/locations",
    "purpose": "مواقع العملاء الذين لديهم إحداثيات لعرضها على الخريطة",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, name, businessName, phone, city, district, address, lat, lng}]}",
    "rules": [
     "يعيد فقط العملاء غير المحذوفين الذين lat وlng لديهم غير فارغين",
     "حد أقصى 5000 صف، بلا ترقيم وبلا ترتيب محدد"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/customers/zatca-buyer-data",
    "purpose": "قائمة جاهزية بيانات المشتري لفوترة زاتكا المرحلة الثانية: من يحتاج فاتورة ضريبية، وهل بياناته مكتملة، وما الناقص فيها",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "zatcaCollectOn: يجب أن يتحقق (Tenant.zatcaPhase2Enabled = true أو settings.zatcaPhase2StartedAt موجود) مع settings.countryCode = SA، وإلا يعود 404 ZATCA_BUYER_DATA_NOT_ENABLED",
     "نطاق المستخدم"
    ],
    "query": [
     {
      "name": "bucket",
      "type": "enum: incomplete | unclassified | complete | all",
      "required": false,
      "desc": "الشريحة المطلوبة (الافتراضي incomplete). أي قيمة أخرى تُعامل كـincomplete"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE | BLOCKED | ALL",
      "required": false,
      "desc": "حالة العميل ولا يفرق بين الأحرف الكبيرة والصغيرة (الافتراضي ACTIVE). القيمة ALL تشمل المؤرشفين أيضاً"
     },
     {
      "name": "search",
      "type": "string",
      "required": false,
      "desc": "بحث في الاسم واسم المنشأة والجوال والكود، يُقص إلى 100 حرف"
     },
     {
      "name": "repId",
      "type": "string",
      "required": false,
      "desc": "يعيد فقط العملاء المسندين لهذا المندوب. يجب أن يطابق [A-Za-z0-9_-] بطول حتى 64، وإلا يُتجاهل"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة (الافتراضي 50، والحد الأقصى 200). يقبل أرقاماً من 0 إلى 9999، وأي قيمة أخرى تأخذ الافتراضي"
     },
     {
      "name": "cursor",
      "type": "string",
      "required": false,
      "desc": "قيمة nextCursor التي عادت في الصفحة السابقة"
     },
     {
      "name": "summary",
      "type": "string",
      "required": false,
      "desc": "أرسل 0 لإلغاء الملخص. الملخص يُحسب فقط في الصفحة الأولى، أي بلا cursor"
     }
    ],
    "body": [],
    "response": "{success:true, data:[row], nextCursor: string|null, summary?:{effectiveB2b, complete, incomplete, unclassifiedWithSignals, scanned, truncated}}\nحقول row:\n- id وcode وname وbusinessName وphone وcity وdistrict وchannel وstatus وtaxNumber وcommercialReg وbuyerType وbuyerIdScheme وbuyerIdValue وaddrStreet وaddrBuildingNo وaddrAdditionalNo وaddrPostalCode وcountryCode\n- classification: business أو government أو individual أو unclassified\n- subtypeIfIssuedNow: 01 للضريبية أو 02 للمبسطة\n- complete وbucket وsuggestedType وsuggestionSource وmissingFields[]\n- issues[{rule, field, messageAr, severity, formField}]",
    "rules": [
     "الترقيم بالمؤشر لا بالصفحات: أرسل nextCursor في cursor واستمر حتى يعود null",
     "الترتيب حسب name ثم id تصاعدياً",
     "القائمة لا تشمل إلا من لديه مؤشر منشأة: نوعه BUSINESS أو GOVERNMENT، أو غير مصنّف وله رقم ضريبي أو سجل تجاري أو معرّف منشأة أو قناة تجارية أو اسم منشأة",
     "مسح الصفحة الواحدة يتوقف عند 5000 صف، والملخص عند 20000 صف، وتصير summary.truncated=true عند التجاوز",
     "تصدر للعميل فاتورة ضريبية (01) إذا كان buyerType = BUSINESS أو GOVERNMENT، أو كان غير مصنّف وله taxNumber أو commercialReg، وإلا تصدر له مبسطة (02)"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/customers/zatca-buyer-data/apply-suggested",
    "purpose": "اعتماد التصنيف المقترح «منشأة» لمجموعة عملاء غير مصنّفين",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "الدور ADMIN أو MANAGER أو ACCOUNTANT، ويمر المفتاح دائماً",
     "zatcaCollectOn، وإلا يعود 404 ZATCA_BUYER_DATA_NOT_ENABLED",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [
     {
      "name": "ids",
      "type": "array<string>",
      "required": true,
      "desc": "معرّفات العملاء. تُزال المكررات، ويُتجاهل ما لا يطابق [A-Za-z0-9_-]{1,64}، ويؤخذ أول 200 فقط. إذا لم تُرسل مصفوفة يعود updated=0"
     }
    ],
    "response": "{success:true, data:{updated, skipped}}",
    "rules": [
     "يكتب buyerType=BUSINESS فقط لمن كان buyerType لديه فارغاً واقتراحه BUSINESS، ولا يمس من صُنّف من قبل",
     "skipped = عدد المعرّفات المقبولة ناقص عدد من حُدّثوا"
    ],
    "example": "{\"ids\":[\"3f2b8c1e-7a4d-4e9b-9c2a-1d5e6f7a8b90\",\"9a1c2d3e-4b5f-4a6b-8c7d-0e1f2a3b4c5d\"]}"
   },
   {
    "method": "PATCH",
    "path": "/customers/:id/buyer-data",
    "purpose": "تعديل حقول بيانات المشتري الخاصة بفوترة زاتكا وحدها لعميل واحد",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "zatcaCollectOn، وإلا يعود 404 ZATCA_BUYER_DATA_NOT_ENABLED",
     "نطاق المستخدم: العميل الذي خارج النطاق يعود 404 CUSTOMER_NOT_FOUND"
    ],
    "query": [],
    "body": [
     {
      "name": "buyerType",
      "type": "enum: INDIVIDUAL | BUSINESS | GOVERNMENT | null",
      "required": false,
      "desc": "نوع المشتري. null يعني غير مصنّف"
     },
     {
      "name": "buyerIdScheme",
      "type": "enum: TIN | CRN | MOM | MLS | 700 | SAG | NAT | GCC | IQA | PAS | OTH | null",
      "required": false,
      "desc": "نوع المعرّف الآخر، ويلزم معه buyerIdValue"
     },
     {
      "name": "buyerIdValue",
      "type": "string | null",
      "required": false,
      "desc": "رقم المعرّف بحروف لاتينية وأرقام فقط، حتى 64 حرفاً. يُقبل فارغاً مع CRN إذا كان commercialReg موجوداً"
     },
     {
      "name": "addrStreet",
      "type": "string | null",
      "required": false,
      "desc": "اسم الشارع، حتى 200 حرف"
     },
     {
      "name": "addrBuildingNo",
      "type": "string | null",
      "required": false,
      "desc": "رقم المبنى: 4 أرقام للسعودية، وحتى 16 حرفاً لغيرها"
     },
     {
      "name": "addrAdditionalNo",
      "type": "string | null",
      "required": false,
      "desc": "الرقم الإضافي حتى 16 حرفاً، ويصدر تنبيه إذا لم يكن 4 أرقام"
     },
     {
      "name": "addrPostalCode",
      "type": "string | null",
      "required": false,
      "desc": "الرمز البريدي: 5 أرقام للسعودية، وحتى 16 حرفاً لغيرها"
     },
     {
      "name": "countryCode",
      "type": "string | null",
      "required": false,
      "desc": "رمز الدولة من حرفين مثل SA، والقيمة null تعني السعودية"
     },
     {
      "name": "businessName",
      "type": "string | null",
      "required": false,
      "desc": "اسم المنشأة، حتى 1000 حرف"
     },
     {
      "name": "taxNumber",
      "type": "string | null",
      "required": false,
      "desc": "الرقم الضريبي: للعميل السعودي 15 رقماً يبدأ بـ3 وينتهي بـ3"
     },
     {
      "name": "commercialReg",
      "type": "string | null",
      "required": false,
      "desc": "السجل التجاري بحروف لاتينية وأرقام حتى 64، ويصدر تنبيه إذا لم يكن 10 أرقام"
     },
     {
      "name": "city",
      "type": "string | null",
      "required": false,
      "desc": "المدينة، حتى 200 حرف"
     },
     {
      "name": "district",
      "type": "string | null",
      "required": false,
      "desc": "الحي، حتى 200 حرف"
     }
    ],
    "response": "{success:true, data: row بنفس شكل صف القائمة zatca-buyer-data, changed:[أسماء الحقول التي تغيرت], warnings:[{field, messageAr}]}",
    "rules": [
     "الحقل الغائب لا يتغير، وnull أو النص الفارغ يمسحه، والقيمة التي ليست نصاً تعطي خطأ 400",
     "تطبيع القيم: قص المسافات، وتحويل الأرقام العربية والفارسية إلى لاتينية في الحقول الرقمية، وأحرف كبيرة لـbuyerType وbuyerIdScheme وcountryCode",
     "الفحص يشمل الحقول المتغيرة فقط، والخطأ يعود 400 CUSTOMER_ZATCA_INVALID مع fieldErrors[{field, messageAr}]",
     "يُكتب ما تغيّر فعلاً فقط، وأي حقل آخر في الجسم يُتجاهل",
     "تحويل العميل من ضريبية إلى مبسطة مسموح للإدارة، ويُسجَّل له سطر تدقيق ZATCA_BUYER_DOWNGRADE"
    ],
    "example": "{\"buyerType\":\"BUSINESS\",\"taxNumber\":\"310123456700003\",\"addrStreet\":\"طريق الملك فهد\",\"addrBuildingNo\":\"1234\",\"addrAdditionalNo\":\"5678\",\"addrPostalCode\":\"12345\",\"city\":\"الرياض\",\"district\":\"العليا\",\"countryCode\":\"SA\"}"
   },
   {
    "method": "GET",
    "path": "/customers/:id",
    "purpose": "تفاصيل عميل واحد مع أسعاره الخاصة",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data: Customer + customerPrices:[{id, customerId, productId, price, createdAt, updatedAt, product:{...}}]}. إذا لم يوجد العميل أو كان خارج النطاق يعود 404 {success:false, message:'العميل غير موجود'}",
    "rules": [
     "يعيد العميل حتى لو كانت حالته DELETED (مؤرشف)",
     "price في customerPrices صافٍ قبل الضريبة ولوحدة الأساس مثل basePrice للمنتج، وproduct يحمل units فسعر الكرتون للعميل = price × factor"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/customers",
    "purpose": "إنشاء عميل جديد مع منع التكرار عبر clientRef",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "حقول زاتكا (المرحلة الثانية) تُحفظ فقط إذا تحقق zatcaCollectOn"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": true,
      "desc": "اسم العميل، حرف واحد على الأقل"
     },
     {
      "name": "phone",
      "type": "string",
      "required": true,
      "desc": "الجوال، 9 أحرف على الأقل، بلا فحص للصيغة وبلا منع للتكرار"
     },
     {
      "name": "businessName",
      "type": "string | null",
      "required": false,
      "desc": "اسم المنشأة"
     },
     {
      "name": "commercialReg",
      "type": "string | null",
      "required": false,
      "desc": "السجل التجاري"
     },
     {
      "name": "taxNumber",
      "type": "string | null",
      "required": false,
      "desc": "الرقم الضريبي. في الشركة التي تجمع بيانات زاتكا يجب أن يكون 15 رقماً يبدأ وينتهي بـ3 للعميل السعودي"
     },
     {
      "name": "altPhone",
      "type": "string | null",
      "required": false,
      "desc": "جوال بديل"
     },
     {
      "name": "email",
      "type": "string (email) | '' | null",
      "required": false,
      "desc": "بريد إلكتروني صالح، والنص الفارغ يُحفظ null"
     },
     {
      "name": "city",
      "type": "string | null",
      "required": false,
      "desc": "المدينة"
     },
     {
      "name": "district",
      "type": "string | null",
      "required": false,
      "desc": "الحي"
     },
     {
      "name": "address",
      "type": "string | null",
      "required": false,
      "desc": "العنوان النصي"
     },
     {
      "name": "lat",
      "type": "number | null",
      "required": false,
      "desc": "خط العرض، من -90 إلى 90"
     },
     {
      "name": "lng",
      "type": "number | null",
      "required": false,
      "desc": "خط الطول، من -180 إلى 180"
     },
     {
      "name": "locationUrl",
      "type": "string",
      "required": false,
      "desc": "حتى 2000 حرف: إحداثيات نصية مثل \"24.71,46.67\" أو رابط خرائط Google، ويحوّله الخادم إلى lat وlng"
     },
     {
      "name": "channel",
      "type": "enum: MT | WHOLESALE | TT | DISCOUNTER | CASH_VAN | ECOMMERCE | '' | null",
      "required": false,
      "desc": "قناة البيع، والفارغ يعني غير محدد"
     },
     {
      "name": "outletType",
      "type": "enum: GROCERY | MINIMARKET | SUPERMARKET | HYPERMARKET | WHOLESALE | PHARMACY | CAFE | CAFETERIA | RESTAURANT | BAKERY | FUEL_SHOP | '' | null",
      "required": false,
      "desc": "نوع المنفذ الذي يستخدمه المندوب الذكي"
     },
     {
      "name": "aiPlaceId",
      "type": "string | null",
      "required": false,
      "desc": "معرّف المكان في Google، من 1 إلى 300 حرف، ويُرفض بـ409 إذا كان مسجلاً لعميل آخر"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE | BLOCKED",
      "required": false,
      "desc": "الحالة، والافتراضي ACTIVE"
     },
     {
      "name": "creditLimit",
      "type": "number >= 0",
      "required": false,
      "desc": "الحد الائتماني، والافتراضي 0"
     },
     {
      "name": "paymentDays",
      "type": "integer >= 0",
      "required": false,
      "desc": "مدة السداد بالأيام، والافتراضي 30"
     },
     {
      "name": "clientRef",
      "type": "string (UUID) | null",
      "required": false,
      "desc": "مفتاح منع التكرار تولّده أنت مرة واحدة لكل عميل"
     },
     {
      "name": "clientCreatedAt",
      "type": "string (ISO 8601) | null",
      "required": false,
      "desc": "لحظة إنشاء العميل في نظامك"
     },
     {
      "name": "buyerType",
      "type": "enum: INDIVIDUAL | BUSINESS | GOVERNMENT | null",
      "required": false,
      "desc": "زاتكا: نوع المشتري، ويُهمل إذا كانت الشركة لا تجمع بيانات الفوترة"
     },
     {
      "name": "buyerIdScheme",
      "type": "enum: TIN | CRN | MOM | MLS | 700 | SAG | NAT | GCC | IQA | PAS | OTH | null",
      "required": false,
      "desc": "زاتكا: نوع المعرّف الآخر"
     },
     {
      "name": "buyerIdValue",
      "type": "string | null",
      "required": false,
      "desc": "زاتكا: رقم المعرّف بحروف لاتينية وأرقام، حتى 64"
     },
     {
      "name": "addrStreet",
      "type": "string | null",
      "required": false,
      "desc": "زاتكا: اسم الشارع، حتى 200 حرف"
     },
     {
      "name": "addrBuildingNo",
      "type": "string | null",
      "required": false,
      "desc": "زاتكا: رقم المبنى، 4 أرقام للسعودية"
     },
     {
      "name": "addrAdditionalNo",
      "type": "string | null",
      "required": false,
      "desc": "زاتكا: الرقم الإضافي، حتى 16 حرفاً"
     },
     {
      "name": "addrPostalCode",
      "type": "string | null",
      "required": false,
      "desc": "زاتكا: الرمز البريدي، 5 أرقام للسعودية"
     },
     {
      "name": "countryCode",
      "type": "string | null",
      "required": false,
      "desc": "زاتكا: رمز الدولة من حرفين، والقيمة null تعني السعودية"
     }
    ],
    "response": "عند الإنشاء يعود 201 {success:true, data: Customer, warnings?:[{field, messageAr}]}، وإذا وُجد عميل بنفس clientRef يعود 200 {success:true, data: العميل القائم, idempotent:true}",
    "rules": [
     "code يولده الخادم تلقائياً (cuid، فريد داخل الشركة)، وbalance وtotalSales وtotalCollected تبدأ من 0 ولا تُقبل من الجسم",
     "clientRef: إذا وُجد في الشركة عميل بنفس القيمة يُعاد كما هو، حتى لو كان مؤرشفاً، ولا تُطبَّق عليه البيانات الجديدة. لا يوجد قيد فريد في القاعدة، فلا ترسل طلبين متوازيين بنفس clientRef",
     "locationUrl: إذا نجح تحويله إلى إحداثيات يحل محل lat وlng، وإذا فشل يُتجاهل بصمت. لا تُتبع إلا روابط Google",
     "email وchannel وoutletType الفارغة تُحفظ null",
     "حقول زاتكا وفحصها تعمل فقط إذا كانت الشركة تجمع بيانات الفوترة ((zatcaPhase2Enabled أو zatcaPhase2StartedAt) مع countryCode=SA)، وإلا تُهمل حقول المرحلة الثانية بصمت ويُحفظ taxNumber كما هو",
     "في الشركة التي تجمع البيانات: القيمة غير الصالحة تعود 400 CUSTOMER_ZATCA_INVALID مع fieldErrors، ولطلب المفتاح دائماً ولو أرسلت clientRef. التسامح (إسقاط حقول المرحلة الثانية الخاطئة مع warnings بدل الرفض) خاص بصندوق تطبيق المندوب حين يعيد رفع ما سُجّل دون اتصال، ولا يرثه المفتاح. وwarnings قد تعود مع 201 لنقصٍ لا يمنع الحفظ",
     "الاستيراد الجماعي POST /import/customers بالمفتاح يمرّ بالفحص نفسه صفاً صفاً في الشركة التي تجمع البيانات: صفٌّ رقمه الضريبي أو سجله التجاري أو نصوصه غير صالحة يعود في data.errors بالشكل {row, code:'CUSTOMER_ZATCA_INVALID', field, value, message} (row = موضع الصف في rows + 2)، ولا يُكتب حينئذٍ أي صف من الدفعة كأخطاء المخطط. والسليم يُحفظ مطبَّعاً (أرقام لاتينية) كما في الإنشاء المفرد",
     "aiPlaceId المسجل لعميل آخر في الشركة يعود 409 AI_PLACE_ALREADY_CUSTOMER لطلب المفتاح دائماً. ترويسة X-FS-Replay تُمحى من طلبات المفتاح فلا ترسلها",
     "إنشاء العميل لا يكتب أي قيد مالي ولا يغيّر أي رصيد"
    ],
    "example": "{\"name\":\"بقالة النخيل\",\"phone\":\"0551234567\",\"businessName\":\"مؤسسة النخيل التجارية\",\"taxNumber\":\"310123456700003\",\"commercialReg\":\"1010123456\",\"city\":\"الرياض\",\"district\":\"العليا\",\"address\":\"شارع التحلية\",\"lat\":24.7136,\"lng\":46.6753,\"channel\":\"TT\",\"creditLimit\":5000,\"paymentDays\":30,\"clientRef\":\"6f1c2a9e-3b7d-4c2e-9a51-2f0e8d7c4b10\"}"
   },
   {
    "method": "PUT",
    "path": "/customers/:id",
    "purpose": "تعديل جزئي لبيانات عميل",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "نطاق المستخدم: العميل الذي خارج النطاق أو غير الموجود يعود 404",
     "حقول زاتكا تُطبَّق فقط إذا تحقق zatcaCollectOn"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": false,
      "desc": "الاسم، حرف واحد على الأقل إذا أُرسل"
     },
     {
      "name": "phone",
      "type": "string",
      "required": false,
      "desc": "الجوال، 9 أحرف على الأقل إذا أُرسل"
     },
     {
      "name": "businessName / commercialReg / taxNumber / altPhone / city / district / address",
      "type": "string | null",
      "required": false,
      "desc": "null يمسح الحقل، وغيابه يتركه بلا تغيير"
     },
     {
      "name": "email",
      "type": "string (email) | '' | null",
      "required": false,
      "desc": "النص الفارغ يمسح البريد"
     },
     {
      "name": "lat / lng",
      "type": "number | null",
      "required": false,
      "desc": "الإحداثيات، وnull يمسحها"
     },
     {
      "name": "locationUrl",
      "type": "string",
      "required": false,
      "desc": "رابط خرائط Google أو إحداثيات نصية، ويُحوَّل إلى lat وlng"
     },
     {
      "name": "channel",
      "type": "enum: MT | WHOLESALE | TT | DISCOUNTER | CASH_VAN | ECOMMERCE | '' | null",
      "required": false,
      "desc": "القيمة الفارغة تمسح القناة"
     },
     {
      "name": "outletType",
      "type": "enum (نفس قيم الإنشاء) | '' | null",
      "required": false,
      "desc": "نوع المنفذ"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE | BLOCKED",
      "required": false,
      "desc": "حالة العميل، ولا يمكن ضبطها على DELETED من هنا"
     },
     {
      "name": "creditLimit",
      "type": "number >= 0",
      "required": false,
      "desc": "الحد الائتماني"
     },
     {
      "name": "paymentDays",
      "type": "integer >= 0",
      "required": false,
      "desc": "مدة السداد بالأيام"
     },
     {
      "name": "buyerType ... countryCode",
      "type": "string | null",
      "required": false,
      "desc": "حقول زاتكا الثمانية بنفس قيود الإنشاء، وتُهمل إذا كانت الشركة لا تجمع بيانات الفوترة"
     }
    ],
    "response": "{success:true, data: Customer بعد التعديل, warnings?:[{field, messageAr}]}",
    "rules": [
     "الحقل الغائب لا يتغير",
     "clientRef وclientCreatedAt وaiPlaceId تُتجاهل في التعديل، لكن clientRef ما زال يجب أن يكون بصيغة UUID إذا أُرسل",
     "زاتكا: الفحص يشمل الحقول المتغيرة مقارنة بالمحفوظ فقط، والخطأ يعود دائماً 400 CUSTOMER_ZATCA_INVALID بلا استثناء",
     "تحويل العميل من ضريبية إلى مبسطة (بمسح الرقم الضريبي أو السجل، أو بضبط buyerType=INDIVIDUAL) مسموح للإدارة ويُسجَّل له سطر تدقيق",
     "التعديل لا يغيّر code ولا balance، ولا يكتب أي قيد"
    ],
    "example": "{\"phone\":\"0559876543\",\"creditLimit\":8000,\"paymentDays\":45,\"status\":\"ACTIVE\",\"email\":\"\"}"
   },
   {
    "method": "GET",
    "path": "/customers/:id/statement",
    "purpose": "كشف حساب العميل: الحركات المالية مع رصيد جارٍ ورصيد افتتاحي وختامي",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "نطاق المستخدم: العميل خارج النطاق يعود 404"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية الفترة شاملة لليوم، بأيام الشركة"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية الفترة، ويُشمل اليوم كاملاً"
     }
    ],
    "body": [],
    "response": "{success:true, data:{customer, entries:[{id, type, debit, credit, balance, description, entryDate, createdAt, invoiceId, receiptId, invoice:{... items:[{... product:{name, unit}}]}|null, receipt|null}], openingBalance, closingBalance, timezone}}",
    "rules": [
     "حدود الفترة تُحسب بتوقيت الشركة المضبوط في إعدادات الدفاتر، وإذا لم يُضبط فبمنتصف ليل UTC. القيمة التي ليست بصيغة YYYY-MM-DD تُحلَّل بـnew Date، فالتزم بالصيغة",
     "openingBalance = مجموع (المدين ناقص الدائن) قبل from، ويكون 0 إذا لم يُرسل from",
     "balance في كل سطر يُحسب جارياً عند العرض (لا تُعرض القيمة المخزنة)، والموجب يعني أنه مستحق على العميل",
     "الترتيب: entryDate ثم createdAt ثم debit تنازلياً ثم id",
     "قيم type: INVOICE_DEBIT | INVOICE_CREDIT | RECEIPT_CREDIT | RECEIPT_DEBIT | ADJUSTMENT_DEBIT | ADJUSTMENT_CREDIT",
     "بلا ترقيم: يعيد كل حركات الفترة",
     "بنود الفواتير في الكشف بلقطة وحدة كل بند: qty بوحدته وunitName (null = وحدة الأساس، فاعرض product.unit) وunitFactor وbaseQty. والأرصدة من القيود بالمبالغ فلا تمسّها الوحدة"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/customers/:id/invoices",
    "purpose": "كل فواتير العميل مع بنودها",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "نطاق المستخدم على العميل والمندوب معاً"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[Invoice + salesRep:{name}|null + items:[InvoiceItem + product]]}، والأحدث أولاً",
    "rules": [
     "بلا ترقيم وبلا تصفية حسب الحالة أو النوع، فتشمل CANCELLED وDRAFT وRETURN",
     "المستخدم المقيّد النطاق يرى فقط الفواتير التي يكون عميلها ومندوبها معاً ضمن نطاقه",
     "للمستخدم غير المقيّد، المعرّف غير الموجود يعود data:[] وليس 404"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/customers/:id/prices",
    "purpose": "ضبط أسعار خاصة لعميل على أصناف محددة",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "requireAdmin: أي دور شركة، ويمر المفتاح دائماً"
    ],
    "query": [],
    "body": [
     {
      "name": "prices",
      "type": "array<object>",
      "required": true,
      "desc": "قائمة الأسعار حتى 5000 سطر. غيابها أو سعرٌ سالب يعطي 400 بخطأ التحقق، وصنفٌ ليس من الشركة يعطي 400 «صنف غير موجود في الشركة»"
     },
     {
      "name": "prices[].productId",
      "type": "string",
      "required": true,
      "desc": "معرّف الصنف"
     },
     {
      "name": "prices[].price",
      "type": "number",
      "required": true,
      "desc": "السعر الخاص صافياً قبل الضريبة ولوحدة الأساس للصنف (unit). سعر الكرتون للعميل = هذا السعر × factor الكرتون، فلسعر كرتون بعينه أرسل سعر الكرتون ÷ factor بست منازل على الأقل"
     }
    ],
    "response": "{success:true} بلا data. إذا لم يوجد العميل في الشركة يعود 404",
    "rules": [
     "لكل صنف upsert داخل معاملة واحدة، وفشل أي سطر يلغي الكل",
     "لا يحذف الأسعار التي لم تُرسل، ولا يوجد في هذه المجموعة مسار لحذف سعر خاص",
     "السعر صافٍ قبل الضريبة ولوحدة الأساس مثل basePrice، ويستخدم مرجعاً لسعر الفاتورة"
    ],
    "example": "{\"prices\":[{\"productId\":\"b7e4c2a1-5d3f-4a8e-9b6c-2f1e0d9c8b7a\",\"price\":11.5},{\"productId\":\"c8f5d3b2-6e4a-4b9f-8c7d-3a2b1c0d9e8f\",\"price\":24}]}"
   },
   {
    "method": "DELETE",
    "path": "/customers/:id",
    "purpose": "حذف عميل: حذف فعلي إذا لم يكن له أثر مالي، وأرشفة إذا كان له أثر",
    "permission": "canManageCustomers",
    "gates": [
     "requireAdminPermission('canManageCustomers')",
     "requireAdmin"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{archived:true, invoices, receipts, entries}} أو {success:true, data:{archived:false}}، وإذا لم يوجد العميل في الشركة يعود 404",
    "rules": [
     "إذا كان للعميل فاتورة أو سند أو حركة كشف: يُؤرشف (status=DELETED) فيختفي من القوائم، وتُحذف إسناداته ومحطاته في خطوط السير وأسعاره الخاصة، وتبقى فواتيره وسنداته",
     "إذا لم يكن له أثر مالي: يُحذف فعلياً مع إسناداته ومحطاته وأسعاره الخاصة وإشعاراته",
     "لا يوجد مسار للاسترجاع",
     "الحذف لا يغيّر أي رصيد ولا أي قيد"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "products",
  "title": "المنتجات والتصنيفات وشرائح الأسعار",
  "overview": "كل المسارات تحت /api/products وتعمل بمفتاح الشركة (Authorization: Bearer fsk_... أو X-API-Key) بهوية المستخدم الذي أصدره. على الموجّه كله ثلاثة حرّاس بالترتيب: authenticate ثم requireAccounting (403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأ للشركة) ثم requireAdminPermission('canManageProducts') (403 «لا تملك صلاحية الوصول لهذا القسم» إن كانت صلاحية إدارة المنتجات false لصاحب المفتاح) وهذا يشمل القراءة أيضاً. الكتابة (POST/PUT/DELETE) تشترط requireAdmin (دور ADMIN أو MANAGER أو ACCOUNTANT) ولا تمر بمفتاح «قراءة فقط» (403 API_KEY_FORBIDDEN). كل الأسعار هنا (basePrice وشرائح الأسعار وأسعار العملاء) مخزنة صافية قبل الضريبة. الحذف أرشفة إن كان للصنف أثر (فواتير أو تحميل سيارة أو وارد مستودع) والمؤرشف يختفي من القوائم ويبقى قابلاً للقراءة بمعرّفه. الصنف غير النشط (INACTIVE) أو المؤرشف يُرفض في إنشاء الفواتير. أخطاء التحقق من zod تعود 400 بالشكل {success:false, message:'بيانات غير صحيحة <الحقول>', errors:{field:[...]}} والحقول غير المعروفة تُسقط بصمت. حد المفتاح 120 طلباً في الدقيقة (429 API_RATE_LIMIT مع Retry-After)\nالوحدات المتعددة للصنف: unit هي وحدة الأساس، أي أصغر ما يُباع من الصنف (حبة)، وbasePrice سعرها. والوحدات الأكبر في units[] بالشكل {id, name, factor, price, unitCode, isActive, sortOrder}: factor عدد صحيح من 2 فأكثر هو عدد وحدات الأساس فيها (كرتون = 24 حبة)، وprice سعرها صافياً قبل الضريبة أو null فيُشتق عند البيع basePrice × factor. وأسعار العملاء الخاصة وأسعار الشرائح كلها لوحدة الأساس، فسعر الكرتون للعميل = سعره الخاص × factor، وحدود الشرائح baseMinQty وbaseMaxQty بوحدة الأساس (وminQty وmaxQty للعرض القديم). تُدار الوحدات بـPOST وPUT وDELETE على /products/:id/units، ويُحوَّل صنفٌ كان يُباع بالكرتون إلى الحبة بـPOST /products/:id/convert-base. صنفٌ بلا وحدات: units فارغة وكل شيء كما كان قبل الميزة. ومورد المزامنة /api/v1/sync/products يحمل units (النشطة والموقوفة) وحدود الشرائح بالأساس",
  "endpoints": [
   {
    "method": "GET",
    "path": "/products",
    "purpose": "قائمة أصناف الشركة مع التصنيف وشرائح الأسعار مرتبة بالاسم مع ترقيم صفحات",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting — 403 ACCOUNTING_NOT_ALLOWED حين النظام المحاسبي مطفأ للشركة",
     "requireAdminPermission('canManageProducts')"
    ],
    "query": [
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "رقم الصفحة يبدأ من 1 والافتراضي 1 (القيمة 0 أو غير الرقمية تُعامل 1)"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة (الافتراضي 50، وأقصاه 200 لطلبات المفتاح). الصنف قد يحمل صورة base64 كبيرة، وللسحب الكامل بلا صور استعمل /api/v1/sync/products"
     },
     {
      "name": "search",
      "type": "string",
      "required": false,
      "desc": "بحث جزئي (contains) في الاسم أو الكود أو الباركود — حساس لحالة الأحرف اللاتينية على PostgreSQL"
     },
     {
      "name": "categoryId",
      "type": "string (uuid)",
      "required": false,
      "desc": "تصفية بمعرّف التصنيف تطابقاً تاماً"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE",
      "required": false,
      "desc": "تصفية بالحالة وبدونها تعود الحالتان — أي قيمة أخرى تعيد قائمة فارغة"
     }
    ],
    "body": [],
    "response": "{success:true, data:[Product], pagination:{total, page, limit, pages}} — Product: id, tenantId, code, name, barcode, unit, basePrice, taxPct, image, itemCode, itemCodeType, unitCode, status, damagedReturnToStock, shelfLifeEnabled, shelfLifeValue, shelfLifeUnit, vatCategory, vatExemptionCode, vatExemptionReason, categoryId, deletedAt(دائماً null هنا), createdAt, updatedAt, category:{id, tenantId, name, createdAt}|null, priceTiers:[{id, productId, minQty, maxQty, baseMinQty, baseMaxQty, price, createdAt}] مرتبة تصاعدياً بـminQty، units:[{id, tenantId, productId, name, factor, price, unitCode, isActive, sortOrder, createdAt, updatedAt}] مرتبة بـsortOrder ثم factor",
    "rules": [
     "الأصناف المؤرشفة (deletedAt غير فارغ) مستبعدة دائماً من القائمة",
     "pages = ceil(total / limit)",
     "basePrice وأسعار الشرائح صافية قبل الضريبة ولوحدة الأساس unit وtaxPct نسبة مئوية مثل 15",
     "الحقل image قد يكون data URL بصيغة base64 فيكبر حجم الرد",
     "units وحدات البيع الأكبر من الأساس، النشطة والموقوفة معاً: الموقوفة (isActive=false) تبقى لأن مستندات صدرت بها، ولا يُباع بها جديد (بيعها يرجع 400 UNIT_INVALID). سعر الوحدة عند البيع: price إن حُدّد، وإلا basePrice × factor مقرّباً لمنزلتين",
     "«تتبّع اللوط»: الصف يحمل أيضاً lotTracked (الصنف يُتتبَّع بالتشغيلة) وlotTrackedSince (بداية حقبة تتبّعه). لا أثر لهما إلا حين lotTrackingEnabled للشركة في GET /company: الصنف المتتبَّع فعلياً = العلمان معاً"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/products/:id",
    "purpose": "تفاصيل صنف واحد بمعرّفه مع التصنيف وشرائح الأسعار",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:Product} بنفس حقول القائمة مع category وpriceTiers وunits (النشطة والموقوفة) — 404 {success:false, message:'الصنف غير موجود'} إن لم يوجد في الشركة",
    "rules": [
     "id في المسار = معرّف الصنف UUID",
     "هذا المسار لا يستبعد المؤرشف: يعيد الصنف المؤرشف وفيه deletedAt بتاريخ وstatus=INACTIVE — مفيد لعرض أسماء أصناف الفواتير القديمة"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/products",
    "purpose": "إنشاء صنف جديد",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN",
     "بوابة ZATCA للفئة الضريبية: حقول vat* لا تُقرأ إلا إن كانت دولة الشركة SA ومفعّلة لها المرحلة الثانية (zatcaPhase2Enabled أو بدأت zatcaPhase2StartedAt) وإلا تُتجاهل بصمت"
    ],
    "query": [],
    "body": [
     {
      "name": "code",
      "type": "string",
      "required": true,
      "desc": "كود الصنف حرفين فأكثر ليس شرطاً — يكفي حرف واحد ويجب أن يكون فريداً في الشركة بما فيها الأصناف المؤرشفة وإلا 409"
     },
     {
      "name": "name",
      "type": "string",
      "required": true,
      "desc": "اسم الصنف (حرف واحد على الأقل)"
     },
     {
      "name": "unit",
      "type": "string",
      "required": true,
      "desc": "وحدة الأساس: أصغر ما يُباع من الصنف، نص حر مثل حبة (حرف واحد على الأقل). الوحدات الأكبر (كرتون = 24 حبة) تُضاف بعد الإنشاء بـPOST /products/:id/units ولا تُقبل في هذا الجسم"
     },
     {
      "name": "basePrice",
      "type": "number",
      "required": true,
      "desc": "سعر وحدة الأساس صافٍ قبل الضريبة و≥ 0"
     },
     {
      "name": "taxPct",
      "type": "number | null",
      "required": false,
      "desc": "نسبة الضريبة من 0 إلى 100 — غيابها أو null يرث defaultVatPct من إعدادات الشركة (وإن غابت فـ15)"
     },
     {
      "name": "barcode",
      "type": "string | null",
      "required": false,
      "desc": "الباركود والنص الفارغ يُحفظ null"
     },
     {
      "name": "categoryId",
      "type": "string (uuid) | null",
      "required": false,
      "desc": "معرّف تصنيف من GET /products/categories والفارغ يُحفظ null"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE",
      "required": false,
      "desc": "حالة الصنف والافتراضي ACTIVE — غير النشط لا يُقبل في الفواتير"
     },
     {
      "name": "image",
      "type": "string | null",
      "required": false,
      "desc": "صورة الصنف بصيغة data URL base64 والفارغ يُحفظ null — حد جسم الطلب كله 10MB"
     },
     {
      "name": "damagedReturnToStock",
      "type": "boolean",
      "required": false,
      "desc": "سياسة قديمة للمرتجع التالف (الافتراضي false). منذ ١٥ أكتوبر ٢٠٢٦ يدخل كل مرتجعٍ تالف رصيد «المرتجع التالف» في السيارة ولا يُباع مهما كانت قيمتها"
     },
     {
      "name": "shelfLifeEnabled",
      "type": "boolean",
      "required": false,
      "desc": "تفعيل صلاحية الصنف (تُحسب من تاريخ البيع لوسم المرتجعات المنتهية) والافتراضي false"
     },
     {
      "name": "shelfLifeValue",
      "type": "integer > 0 | null",
      "required": false,
      "desc": "مدة الصلاحية — إلزامية عند التفعيل وحدها الأعلى DAY 36500 وMONTH 1200 وYEAR 100"
     },
     {
      "name": "shelfLifeUnit",
      "type": "enum: DAY | MONTH | YEAR | null",
      "required": false,
      "desc": "وحدة مدة الصلاحية — إلزامية عند التفعيل"
     },
     {
      "name": "itemCode",
      "type": "string | null",
      "required": false,
      "desc": "كود الصنف للفوترة الإلكترونية (EGS أو GS1) والفارغ يُحفظ null"
     },
     {
      "name": "itemCodeType",
      "type": "enum: EGS | GS1 | null",
      "required": false,
      "desc": "نوع كود الصنف وافتراض القاعدة EGS عند الغياب"
     },
     {
      "name": "unitCode",
      "type": "string | null",
      "required": false,
      "desc": "رمز وحدة الأساس حسب جدول مزود الفوترة الإلكترونية (مثل PCE) والفارغ يُحفظ null. لكل وحدة أكبر رمزها في units[].unitCode، وبند الفاتورة يحمل رمز وحدته هو"
     },
     {
      "name": "vatCategory",
      "type": "enum: S | Z | E | O | null",
      "required": false,
      "desc": "الفئة الضريبية لـZATCA (تُحوّل لأحرف كبيرة) — S تشترط taxPct 15 أو 5 وبلا رمز ولا سبب إعفاء وZ/E/O تشترط taxPct=0 مع رمز وسبب — null تعني S حين النسبة > 0"
     },
     {
      "name": "vatExemptionCode",
      "type": "string | null",
      "required": false,
      "desc": "رمز VATEX-SA-* مطابق للفئة: E ← VATEX-SA-29 و29-7 و30 · Z ← VATEX-SA-32 و33 و34-1..34-5 و35 و36 وEDU وHEA وMLTRY · O ← VATEX-SA-OOS"
     },
     {
      "name": "vatExemptionReason",
      "type": "string | null",
      "required": false,
      "desc": "نص سبب الإعفاء أو الصفرية — إلزامي لـZ/E/O وبحد 1000 حرف وبلا محارف تحكم"
     },
     {
      "name": "lotTracked",
      "type": "boolean | null",
      "required": false,
      "desc": "«تتبّع اللوط»: true ينشئ الصنف متتبَّعاً بالتشغيلة وتبدأ حقبته لحظة إنشائه. يتطلب lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED. غيابه أو false أو null = صنف غير متتبَّع كما قبل الميزة"
     }
    ],
    "response": "201 {success:true, data:Product مع category وunits (فارغة عند الإنشاء) (بدون priceTiers)} — 409 {success:false, message:'كود الصنف مستخدم من قبل'} أو رسالة «الكود مستخدم بصنف محذوف مؤرشف...» — 400 برسالة عربية لخطأ الصلاحية — 400 {success:false, code:'PRODUCT_ZATCA_INVALID', message, fieldErrors:[{field, messageAr}]} لخطأ الفئة الضريبية — 403 {success:false, code:'LOTS_NOT_ALLOWED', message} لـlotTracked=true والميزة مطفأة للشركة",
    "rules": [
     "الكود فريد لكل شركة (tenantId+code) ويُفحص مسبقاً بما فيه المؤرشف فيعود 409 برسالة واضحة",
     "taxPct غائب أو null ⇒ يرث نسبة دولة الشركة defaultVatPct",
     "basePrice صافٍ قبل الضريبة — الفواتير ذات pricesIncludeTax=true تحوّل السعر الشامل إلى صافٍ للمقارنة",
     "فحص الصلاحية: إن كان shelfLifeEnabled=true بلا وحدة صحيحة أو بمدة غير صحيحة أو تتجاوز الحد ⇒ 400",
     "حقول ZATCA الثلاثة ليست في مخطط zod بل تُقرأ من الجسم الخام وتُقص مسافاتها والنص الفارغ = null",
     "categoryId لا يُتحقق منه في الكود — معرّف غير موجود يفشل بقيد المفتاح الأجنبي فيعود 500",
     "لا يُنشأ مخزون ولا قيود عند إنشاء الصنف",
     "لبيعه بالكرتون أيضاً أضف بعد الإنشاء وحدة: POST /products/:id/units بالجسم {\"name\":\"كرتون\",\"factor\":40,\"price\":13.04}",
     "«تتبّع اللوط»: الصنف المنشأ بـlotTracked=true يُسجَّل له حدث TRACKING_ON في سجل التدقيق في معاملة الإنشاء نفسها. وإن كانت صلاحيته مفعّلة (shelfLifeEnabled) صار تاريخ انتهاء كل تشغيلة له إلزامياً (LOT_EXPIRY_REQUIRED)"
    ],
    "example": "{\"code\":\"P-1001\",\"name\":\"مياه 330 مل\",\"unit\":\"حبة\",\"basePrice\":0.35,\"taxPct\":15,\"barcode\":\"6281234567890\",\"categoryId\":\"3f2c1a9e-7b1d-4c2e-9a51-0d6e8f4b2c11\",\"status\":\"ACTIVE\",\"unitCode\":\"PCE\"}"
   },
   {
    "method": "PUT",
    "path": "/products/:id",
    "purpose": "تعديل جزئي لصنف — أرسل الحقول المراد تغييرها فقط",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN",
     "بوابة ZATCA للفئة الضريبية كما في الإنشاء وتُفحص على الحالة المدمجة مع المحفوظ"
    ],
    "query": [],
    "body": [
     {
      "name": "code",
      "type": "string",
      "required": false,
      "desc": "كود جديد فريد في الشركة — التكرار يعود 409 'السجل موجود مسبقا'"
     },
     {
      "name": "name",
      "type": "string",
      "required": false,
      "desc": "الاسم (حرف واحد على الأقل)"
     },
     {
      "name": "unit",
      "type": "string",
      "required": false,
      "desc": "اسم وحدة الأساس، وتغييره إعادة تسمية لا تحويل: الكميات المسجّلة لا تتغيّر. اسمٌ تحمله وحدة أكبر للصنف نفسه يرجع 400 «اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف». ولجعل صنفٍ يُباع بالكرتون يُباع بالحبة استعمل POST /products/:id/convert-base لا هذا الحقل"
     },
     {
      "name": "basePrice",
      "type": "number",
      "required": false,
      "desc": "سعر وحدة الأساس صافٍ قبل الضريبة و≥ 0. لا يغيّر سعر وحدة أكبر حُدّد سعرها (units[].price)، أما الوحدة بلا سعر محدد فتتبعه (basePrice × factor)"
     },
     {
      "name": "taxPct",
      "type": "number | null",
      "required": false,
      "desc": "0 إلى 100 — null أو الغياب يعني بلا تغيير ولا يمكن تصفيرها بـnull (أرسل 0 صراحة)"
     },
     {
      "name": "barcode",
      "type": "string | null",
      "required": false,
      "desc": "إرسال '' أو null يمسح الباركود"
     },
     {
      "name": "categoryId",
      "type": "string (uuid) | null",
      "required": false,
      "desc": "إرسال '' أو null يزيل التصنيف"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | INACTIVE",
      "required": false,
      "desc": "تفعيل أو إيقاف الصنف"
     },
     {
      "name": "image",
      "type": "string | null",
      "required": false,
      "desc": "data URL base64 — '' أو null يحذف الصورة"
     },
     {
      "name": "damagedReturnToStock",
      "type": "boolean",
      "required": false,
      "desc": "سياسة المرتجع التالف"
     },
     {
      "name": "shelfLifeEnabled",
      "type": "boolean",
      "required": false,
      "desc": "تفعيل الصلاحية — يُقبل وحده إن كانت المدة والوحدة محفوظتين من قبل"
     },
     {
      "name": "shelfLifeValue",
      "type": "integer > 0 | null",
      "required": false,
      "desc": "مدة الصلاحية و null يمسحها (مرفوض إن بقيت الصلاحية مفعّلة)"
     },
     {
      "name": "shelfLifeUnit",
      "type": "enum: DAY | MONTH | YEAR | null",
      "required": false,
      "desc": "وحدة المدة"
     },
     {
      "name": "itemCode",
      "type": "string | null",
      "required": false,
      "desc": "'' أو null يمسحه"
     },
     {
      "name": "itemCodeType",
      "type": "enum: EGS | GS1 | null",
      "required": false,
      "desc": "نوع كود الصنف"
     },
     {
      "name": "unitCode",
      "type": "string | null",
      "required": false,
      "desc": "رمز وحدة الأساس، و'' أو null يمسحه"
     },
     {
      "name": "vatCategory",
      "type": "enum: S | Z | E | O | null",
      "required": false,
      "desc": "الفئة الضريبية (لشركة ZATCA فقط)"
     },
     {
      "name": "vatExemptionCode",
      "type": "string | null",
      "required": false,
      "desc": "رمز VATEX-SA-* مطابق للفئة"
     },
     {
      "name": "vatExemptionReason",
      "type": "string | null",
      "required": false,
      "desc": "سبب الإعفاء بحد 1000 حرف"
     },
     {
      "name": "lotTracked",
      "type": "boolean | null",
      "required": false,
      "desc": "«تتبّع اللوط»: تشغيل تتبّع الصنف بالتشغيلة أو إطفاؤه. التشغيل يتطلب lotTrackingEnabled للشركة (وإلا 403 LOTS_NOT_ALLOWED) ويبدأ حقبة جديدة. القيمة المساوية للحالية أو null أو الغياب = لا تغيير. للتبديل الجماعي استعمل POST /lots/products/tracking"
     },
     {
      "name": "confirmLotBalances",
      "type": "boolean | null",
      "required": false,
      "desc": "تأكيد إطفاء تتبّع صنف ما زالت له أرصدة في تشغيلات مسمّاة. بدونه يرجع الإطفاء 409 LOT_TRACKING_HAS_BALANCE"
     }
    ],
    "response": "{success:true, data:Product مع category وunits (بدون priceTiers)} — 404 'الصنف غير موجود' — 400 لخطأ الصلاحية أو PRODUCT_ZATCA_INVALID — 409 'السجل موجود مسبقا' لتكرار الكود — «تتبّع اللوط»: 403 {code:'LOTS_NOT_ALLOWED'} للتشغيل والميزة مطفأة، و409 {success:false, code:'LOT_TRACKING_HAS_BALANCE', message, detail:{productId, updated:0, products:[{productId, name, warehouse, vans:[{salesRepId, qty}], qty}], count, lots:[{place:'WAREHOUSE'|'VAN', salesRepId, lotId, lotNumber, qty, raw:{SELLABLE, EXPIRED, DAMAGED}}]}} لإطفاءٍ بلا confirmLotBalances (أول 50 تشغيلة في lots وعددها كله في count)، و503 {code:'LOT_BUSY'} حين يكون الصنف مشغولاً بعملية تشغيلات أخرى",
    "rules": [
     "«تتبّع اللوط»: تبديل lotTracked يُكتب مع بقية حقول التعديل في معاملة واحدة تحت قفل الصنف، ويُسجَّل في سجل التدقيق (TRACKING_ON أو TRACKING_OFF). الإطفاء يُخفي ولا يحذف: التشغيلات وسجلّها باقية في شاشة التتبّع، وإعادة التشغيل حقبةٌ جديدة يصير فيها الرصيد المسمّى سابقاً «غير مسمّى» حتى يُسمّى من جديد بـPOST /lots/relabel",
     "id في المسار = معرّف الصنف",
     "فحص الصلاحية يجري على الدمج: القيمة المرسلة وإلا المحفوظة",
     "بوابة ZATCA لا تعمل إلا إن حمل الجسم أحد حقول vat* — تغيير taxPct وحده لا يعيد فحص الفئة المحفوظة فأرسل vatCategory معه عند تغيير النسبة",
     "الأصناف المؤرشفة قابلة للتعديل لكن التعديل لا يلغي الأرشفة (deletedAt يبقى) فتبقى مخفية من القوائم",
     "التعديل لا يمس شرائح الأسعار ولا أسعار العملاء ولا وحدات الصنف (لها مساراتها /products/:id/units) ولا الفواتير السابقة"
    ],
    "example": "{\"basePrice\":14.5,\"status\":\"INACTIVE\"}"
   },
   {
    "method": "DELETE",
    "path": "/products/:id",
    "purpose": "حذف صنف — يؤرشف إن كان له أثر مالي أو مخزني ويحذف فعلياً إن لم يكن",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, archived:true} عند الأرشفة أو {success:true, archived:false} عند الحذف الفعلي (لا يوجد data) — 404 'الصنف غير موجود'",
    "rules": [
     "إن وُجد للصنف أي بند فاتورة أو بند تحميل سيارة أو بند وارد مستودع أو تشغيلة («تتبّع اللوط») ⇒ أرشفة: deletedAt=الآن وstatus=INACTIVE في معاملة واحدة تحت قفل الصنف. وقد ينتظر القفل عملية تشغيلات جارية فيرجع 503 {code:'LOT_BUSY'}: أعد المحاولة",
     "في الحالتين تُحذف نهائياً شرائح أسعاره وأسعار العملاء الخاصة به ولا تعود",
     "المؤرشف يختفي من القوائم ولا يباع مجدداً ويبقى اسمه في الفواتير والتقارير القديمة ويُقرأ بـGET /products/:id",
     "كود الصنف المؤرشف يبقى محجوزاً فلا يمكن إنشاء صنف جديد بالكود نفسه",
     "وحدات الصنف (units) تبقى مع الصنف المؤرشف فتُقرأ بها مستنداته، وتُحذف معه في الحذف الفعلي"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/products/:id/price-tiers",
    "purpose": "استبدال كل شرائح أسعار الكمية لصنف",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "tiers",
      "type": "array",
      "required": true,
      "desc": "القائمة الكاملة للشرائح — مصفوفة فارغة تحذف كل الشرائح"
     },
     {
      "name": "tiers[].minQty",
      "type": "number",
      "required": true,
      "desc": "أقل كمية للشريحة بوحدة الأساس و≥ 0. يُكتب في baseMinQty أيضاً إن لم يُرسل baseMinQty"
     },
     {
      "name": "tiers[].maxQty",
      "type": "number",
      "required": false,
      "desc": "أعلى كمية بوحدة الأساس — اختياري للشريحة المفتوحة ولا يقبل null (احذفه بدلاً من null). يُكتب في baseMaxQty أيضاً إن لم يُرسل baseMaxQty"
     },
     {
      "name": "tiers[].baseMinQty",
      "type": "number ≥ 0",
      "required": false,
      "desc": "حد الشريحة الأدنى بوحدة الأساس صراحةً، وغيابه = minQty. به يُقارَن، أما minQty وmaxQty فللعرض القديم"
     },
     {
      "name": "tiers[].baseMaxQty",
      "type": "number | null",
      "required": false,
      "desc": "حد الشريحة الأعلى بوحدة الأساس، وغيابه = maxQty، وnull شريحة مفتوحة"
     },
     {
      "name": "tiers[].price",
      "type": "number",
      "required": true,
      "desc": "سعر وحدة الأساس في الشريحة صافٍ قبل الضريبة و≥ 0"
     }
    ],
    "response": "{success:true} بدون data — 404 'الصنف غير موجود' — 400 'بيانات غير صحيحة' إن غاب tiers أو لم يكن مصفوفة",
    "rules": [
     "العملية استبدال كامل: تحذف الشرائح القديمة وتنشئ المرسلة وتحدّث updatedAt للصنف في معاملة واحدة",
     "لا يتحقق الخادم من تداخل الشرائح ولا من أن minQty ≤ maxQty",
     "في الخادم تُستخدم الشرائح كحد أدنى لسعر المندوب في حارس الأسعار (أقل سعر شريحة، مضروباً بمعامل وحدة البند لبيع الكرتون) ولا تُطبّق تلقائياً على فواتير الإدارة",
     "تحديث updatedAt يجعل التغيير مرئياً لمزامنة ERP و/api/v1/sync"
    ],
    "example": "{\"tiers\":[{\"minQty\":1,\"maxQty\":49,\"price\":13.04},{\"minQty\":50,\"price\":12.5}]}"
   },
   {
    "method": "POST",
    "path": "/products/:id/units",
    "purpose": "إضافة وحدة بيع أكبر من وحدة الأساس لصنف (كرتون = 24 حبة)",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string ≤ 24",
      "required": true,
      "desc": "اسم الوحدة كما يُطبع. لا يساوي اسم وحدة الأساس ولا اسم وحدة أخرى للصنف"
     },
     {
      "name": "factor",
      "type": "integer 2..100000",
      "required": true,
      "desc": "عدد وحدات الأساس في هذه الوحدة. عدد صحيح، ولا يتكرر معامل وحدة أخرى للصنف (والمعامل 1 هو وحدة الأساس نفسها فيُرفض)"
     },
     {
      "name": "price",
      "type": "number ≥ 0 | '' | null",
      "required": false,
      "desc": "سعر الوحدة صافياً قبل الضريبة. فارغ أو null ⇒ يُشتق عند البيع basePrice × factor"
     },
     {
      "name": "unitCode",
      "type": "string ≤ 16 | null",
      "required": false,
      "desc": "رمز الوحدة الضريبي (UN/ECE مثل CT) لبند الفاتورة الإلكترونية بهذه الوحدة، ويغلب رمز الصنف"
     },
     {
      "name": "sortOrder",
      "type": "integer",
      "required": false,
      "desc": "ترتيب العرض، والافتراضي 0"
     }
    ],
    "response": "201 {success:true, data:{id, tenantId, productId, name, factor, price, unitCode, isActive, sortOrder, createdAt, updatedAt}} — 404 {success:false, code:'PRODUCT_NOT_FOUND', message:'الصنف غير موجود'} — 400 {success:false, code:'PRODUCT_UNITS_INVALID', message} — 409 {success:false, message:'اسم الوحدة مكرر لهذا الصنف'}",
    "rules": [
     "الكتابة داخل معاملة بقفل صفّ الصنف، وتحدّث updatedAt الصنف فيصل التغيير لمزامنة /api/v1/sync/products ولمزامنة ERP",
     "رسائل PRODUCT_UNITS_INVALID: «اسم الوحدة مطلوب»، «اسم الوحدة طويل»، «معامل التحويل رقم أكبر من صفر»، «معامل التحويل لا يتجاوز 100000»، «معامل التحويل عدد صحيح — وحدة الأساس هي الأصغر»، «سعر الوحدة رقم موجب»، «اسم الوحدة مكرر لهذا الصنف»، «يوجد وحدة بالمعامل نفسه لهذا الصنف»",
     "id الوحدة في الرد هو unitId الذي يُرسل في بنود الفواتير والتحميل والوارد وطلب البضاعة"
    ],
    "example": "{\"name\":\"كرتون\",\"factor\":40,\"price\":13.04,\"unitCode\":\"CT\"}"
   },
   {
    "method": "PUT",
    "path": "/products/:id/units/:unitId",
    "purpose": "تعديل وحدة: اسمها أو معاملها أو سعرها أو رمزها أو إيقافها أو ترتيبها",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string ≤ 24",
      "required": false,
      "desc": "الاسم الجديد، بالقيود نفسها في الإضافة"
     },
     {
      "name": "factor",
      "type": "integer 2..100000",
      "required": false,
      "desc": "المعامل الجديد. لا يمسّ الماضي (انظر القواعد)"
     },
     {
      "name": "price",
      "type": "number ≥ 0 | '' | null",
      "required": false,
      "desc": "السعر المحدد، و'' أو null يمسحه فيُشتق basePrice × factor"
     },
     {
      "name": "unitCode",
      "type": "string ≤ 16 | null | ''",
      "required": false,
      "desc": "الرمز الضريبي، و'' أو null يمسحه"
     },
     {
      "name": "isActive",
      "type": "boolean",
      "required": false,
      "desc": "false يوقفها: لا يُباع بها جديد (400 UNIT_INVALID)، ويبقى كل مستند صدر بها كما هو"
     },
     {
      "name": "sortOrder",
      "type": "integer",
      "required": false,
      "desc": "ترتيب العرض"
     }
    ],
    "response": "{success:true, data:{id, tenantId, productId, name, factor, price, unitCode, isActive, sortOrder, createdAt, updatedAt}} — 404 PRODUCT_NOT_FOUND أو {code:'UNIT_NOT_FOUND', message:'الوحدة غير موجودة'} — 400 PRODUCT_UNITS_INVALID — 409 'اسم الوحدة مكرر لهذا الصنف'",
    "rules": [
     "تغيير factor لا يعيد كتابة الماضي: كل بند كُتب بالوحدة يحمل لقطة اسمها ومعاملها (unitName وunitFactor) وكميته بالأساس (baseQty) لحظة كتابته، فكرتونٌ صار 12 بعد أن كان 24 لا يُنقص مخزوناً مضى",
     "التحقق على الوحدة بعد دمج المرسل مع المحفوظ، مقابل وحدة الأساس وبقية وحدات الصنف",
     "يتحرّك updatedAt للصنف فيصل التعديل لمزامنة products"
    ],
    "example": "{\"price\":12.5,\"isActive\":true}"
   },
   {
    "method": "DELETE",
    "path": "/products/:id/units/:unitId",
    "purpose": "حذف وحدة من وحدات الصنف نهائياً",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [],
    "response": "{success:true} — 404 PRODUCT_NOT_FOUND أو UNIT_NOT_FOUND",
    "rules": [
     "الحذف لا يكسر التاريخ: كل بند صدر بالوحدة يحمل لقطتها، والكمية بالأساس محفوظة في baseQty",
     "لإخفائها من البيع مع بقائها في units أوقفها بـPUT /products/:id/units/:unitId والجسم {\"isActive\":false} بدل الحذف",
     "بيعٌ جديد بمعرّف وحدة محذوفة يرجع 400 UNIT_INVALID",
     "يتحرّك updatedAt للصنف، فتصل مزامنة products بلا الوحدة المحذوفة"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/products/:id/convert-base",
    "purpose": "تحويل وحدة الأساس إلى وحدة أصغر لصنف له تاريخ (كان يُباع بالكرتون فصار يُباع بالكرتون والحبة) دون تغيير أي رقم مطبوع",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "newBaseName",
      "type": "string ≤ 24",
      "required": true,
      "desc": "اسم وحدة الأساس الجديدة (حبة). لا يساوي الحالية ولا اسم وحدة للصنف"
     },
     {
      "name": "factor",
      "type": "integer 2..100000",
      "required": true,
      "desc": "كم وحدة أساس جديدة في وحدة الأساس الحالية (كرتون = 24 حبة ⇒ 24)"
     },
     {
      "name": "expectedBaseName",
      "type": "string",
      "required": true,
      "desc": "اسم وحدة الأساس الحالية كما قرأته (product.unit). إن تغيّرت قبل التنفيذ رُدّ 409 BASE_UNIT_CHANGED فلا يُحوَّل الصنف مرتين"
     },
     {
      "name": "basePrice",
      "type": "number ≥ 0 | null",
      "required": false,
      "desc": "سعر وحدة الأساس الجديدة صافياً، وغيابه ⇒ السعر الحالي ÷ factor بأربع منازل"
     },
     {
      "name": "baseUnitCode",
      "type": "string ≤ 16 | null | ''",
      "required": false,
      "desc": "رمز وحدة الأساس الجديدة الضريبي (PCE). غيابه يُبقي unitCode الصنف كما هو، والرمز القديم تحمله الوحدة التي صارتها وحدة الأساس القديمة"
     }
    ],
    "response": "{success:true, data:Product مع category وpriceTiers وunits، converted:{factor, from, invoiceItems, vanLoadItems, warehouseEntryItems, stockRequestItems, customerPrices, priceTiers, vanLoadItemLots?, invoiceItemLots?, lotRelabels?}} وأعداد converted هي الصفوف المعاد كتابتها في كل جدول، والثلاثة الأخيرة (صفوف تشغيلات الصنف) تظهر حين يمسّ التحويل صفوفاً منها وحدها — 409 {success:false, code:'BASE_UNIT_CHANGED', message} — 400 {code:'PRODUCT_UNITS_INVALID', message} — 404 PRODUCT_NOT_FOUND — 503 {code:'LOT_BUSY'} لصنفٍ متتبَّع التشغيلات مشغولٍ بعملية أخرى: أعد المحاولة",
    "rules": [
     "كل الخطوات في معاملة واحدة بقفل صفّ الصنف: يتحوّل تاريخ الصنف كله أو لا شيء",
     "بنود الصنف في الفواتير والتحميلات والوارد وطلبات البضاعة: unitName يأخذ اسم الأساس القديم إن كان فارغاً، وunitFactor يُضرب بـfactor، وbaseQty يُعاد حسابه. أما qty وunitPrice وunitCost وlineTotal فلا تتغيّر: «2 كرتون» تبقى مطبوعة كما هي وأساسها 48 حبة. وsuggestedQty وexpectedQty في التحميلات تُضرب بـfactor (بالأساس دائماً)",
     "وحدات الصنف القائمة يُضرب معاملها بـfactor، وتُنشأ وحدة باسم الأساس القديم بمعامل factor وبسعره القديم ورمزه، أولى في الترتيب — فيبيع المندوب الكرتون بسعره كما كان",
     "أسعار العملاء الخاصة وأسعار الشرائح تُقسم على factor (فسعر الكرتون للعميل لا يتغيّر)، وحدود الشرائح بالأساس تُضرب بـfactor",
     "لنظامكم: التحويل يحرّك updatedAt للصنف وحده لا للفواتير ولا للتحميلات، فمزامنة invoices وvan-loads وwarehouse-entries لا تعيد إرسال البنود القديمة بلقطاتها الجديدة. من خزّن baseQty هذا الصنف قبل التحويل يضربه بـconverted.factor، أو يعيد سحب تلك الموارد من البداية (بلا since). وكميات تشغيلات الصنف بالأساس كذلك، فتُضرب بـfactor داخل التحويل نفسه (vanLoadItemLots وinvoiceItemLots وlotRelabels عددها). ومزامنة /v1/sync/van-load-item-lots و/v1/sync/invoice-item-lots و/v1/sync/lot-relabels بطابع الإنشاء فلا تعيد إرسال الصفوف المضروبة: من خزّنها يضرب qty (أو quantity) لصفوف هذا الصنف بـconverted.factor، أو يعيد سحب الموارد الثلاثة من البداية (بلا since)",
     "صنفٌ بلا تاريخ يكفيه تعديل unit بـPUT /products/:id ثم إضافة الوحدة بـPOST /products/:id/units"
    ],
    "example": "{\"newBaseName\":\"حبة\",\"factor\":24,\"expectedBaseName\":\"كرتون\",\"baseUnitCode\":\"PCE\"}"
   },
   {
    "method": "GET",
    "path": "/products/categories",
    "purpose": "كل تصنيفات أصناف الشركة مرتبة بالاسم",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, name, createdAt}]} بلا ترقيم صفحات",
    "rules": [
     "تعيد كل التصنيفات دفعة واحدة"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/products/categories",
    "purpose": "إنشاء تصنيف أصناف جديد",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "requireAdmin — الدور ADMIN أو MANAGER أو ACCOUNTANT",
     "مفتاح قراءة فقط يُرفض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": true,
      "desc": "اسم التصنيف (حرف واحد على الأقل)"
     }
    ],
    "response": "201 {success:true, data:{id, tenantId, name, createdAt}}",
    "rules": [
     "لا يوجد فحص تكرار للاسم فإرسال الاسم مرتين ينشئ تصنيفين — ابحث في GET /products/categories أولاً",
     "لا يوجد في هذا الموجّه مسار لتعديل التصنيف أو حذفه"
    ],
    "example": "{\"name\":\"مشروبات\"}"
   },
   {
    "method": "GET",
    "path": "/products/customer-prices/:customerId",
    "purpose": "الأسعار الخاصة المتفق عليها لعميل معيّن (معرّف الصنف والسعر)",
    "permission": "canManageProducts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageProducts')",
     "نطاق المستخدم: إن كان صاحب المفتاح مقيد النطاق (scopeEnabled) فلا يرى إلا العملاء المسندين له وإلا 403"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{productId, price}]} — 403 {success:false, message:'هذا العميل غير مسند لك'}",
    "rules": [
     "customerId في المسار = معرّف العميل",
     "price صافٍ قبل الضريبة ولوحدة الأساس، وهو السعر المرجعي للعميل بدل basePrice. سعر وحدة أكبر للعميل = price × factor",
     "تُستبعد أسعار الأصناف المؤرشفة",
     "عميل غير موجود يعيد قائمة فارغة لا 404 (للمستخدم غير المقيد)",
     "ضبط هذه الأسعار يتم عبر PUT /customers/:id/prices في مجموعة العملاء لا هنا"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "invoices",
  "title": "الفواتير والمرتجعات والإشعارات",
  "overview": "كل المسارات تحت /api/invoices وتعمل بمفتاح الشركة (Authorization: Bearer fsk_… أو X-API-Key) بهوية المستخدم الذي أصدره. كل طلب يمر أولاً بحارس النظام المحاسبي: إذا كان accountingEnabled=false للشركة يرجع 403 بالرمز ACCOUNTING_NOT_ALLOWED. بعده كل المسارات تحتاج صلاحية canManageInvoices ما عدا GET /invoices/open الذي يحتاج canManageReceipts. الصلاحية ترفض فقط إذا كانت قيمتها false في حساب المستخدم، والرفض يرجع 403. ولأن مسارات الفوترة الإلكترونية (/einvoice/*) مركبة على نفس البادئة بعد موجّه الفواتير، فهي تمر بنفس الحارسين وتضيف requireAdmin، أي أن الدور يجب أن يكون ADMIN أو MANAGER أو ACCOUNTANT. نطاق المستخدم المقيّد (قوائم عملاء ومناديب) يُطبَّق على كل قراءة وكتابة، وما يقع خارج النطاق يرجع 404 أو 403. المفتاح المحدد «قراءة فقط» لا يقبل إلا GET وHEAD، وأي طريقة أخرى ترجع 403 بالرمز API_KEY_FORBIDDEN. حد الطلبات 120 طلباً في الدقيقة لكل مفتاح، ويرجع 429 بالرمز API_RATE_LIMIT مع ترويسة Retry-After. المفتاح معفى من الحد العام لـ/api. الترقيم يتم تلقائياً: الفاتورة INV-YYMM-000001 والمرتجع أو الإشعار الدائن RET-YYMM-000001، والتسلسل منفصل لكل شركة. الشركات المربوطة بالمرحلة الثانية من زاتكا (zatcaPhase2StartedAt مضبوط): يجب أن ترسل الترويسة X-FS-Caps: zatca2 في الإصدار وفي قراءة أي صف zatcaPhase=2 وفي الإشعارات وفي إعادة الإصدار، وبدونها يرجع 426 بالرمز ZATCA_CLIENT_UPDATE_REQUIRED. الترويسة تعني أن نظامك يطبع QR المرحلة الثانية من data.einvoice.qr ويحترم الحقل printable. لا ترسل X-FS-Replay، فهي خاصة بصندوق تطبيق المندوب حين يعمل دون اتصال، والخادم يمحوها من طلبات المفتاح فيُحكم عليها حكم الطلب الحيّ دائماً. شكل الأخطاء: أخطاء التحقق ترجع 400 بالشكل {success:false, message, errors:{field:[...]}}. أخطاء زاتكا ترجع {success, code, message, issues?, errors?, data?, reason?, customerId?}، وsuccess=true فيها فقط عندما يكون الرمز 202. الأخطاء العامة ترجع {success:false, message}. ردود النجاح شكلها {success:true, data}، وتضاف pagination في القوائم المرقّمة\nالوحدات المتعددة: كمية كل بند qty بوحدة البند وunitPrice لوحدة البند، ووحدته items[].unitId من units[].id للصنف (GET /products). غياب unitId أو null = وحدة الأساس بمعامل 1، فالتكامل الذي لا يعرف الوحدات يبقى كما هو ويرسل الكمية بوحدة الأساس. وكل بند في الردود والمزامنة يحمل لقطة وحدته لحظة كتابته: unitName (null = وحدة الأساس) وunitFactor (عدد وحدات الأساس فيها، 1 للأساس) وbaseQty = qty × unitFactor، والجمع والمقارنة والمخزون بـbaseQty وحده. وحدةٌ لا تخصّ الصنف أو موقوفة ترجع 400 UNIT_INVALID\n«تتبّع اللوط» (حين lotTrackingEnabled للشركة وlotTracked للصنف، وإلا لا شيء مما يلي): الخادم يوزّع كل بند بيعٍ لصنف متتبَّع على تشغيلات سيارة المندوب تلقائياً بالأقرب انتهاءً (FEFO)، ثم من الرصيد «غير المسمّى» بعد نفاد التشغيلات الصالحة، ويحفظ التوزيع صفوفاً لكل بند بالكمية الأساسية. المنع دائم على مستوى التشغيلة لكل مُصدِر ومنه المفتاح: لا يُباع من تشغيلة موقوفة أو منتهية يوم الشركة، ولا فوق رصيدها، ولا يصير غير المسمّى سالباً، ولا يُعفي إذن canSellWithoutStock من ذلك (409 LOT_STOCK_INSUFFICIENT). المفتاح يجوز له تحديد التشغيلات بنفسه في items[].lots، والمرتجع المرتبط بفاتورة بيع يرث تشغيلاتها، والمرتجع الحرّ «غير معروف» ما لم ترسل تشغيلاته. اقرأ التوزيع بـwithLots=1 في GET /invoices/:id وby-client-ref وreturnable (بدونه الردود كما كانت)، أو من مزامنة /v1/sync/invoice-item-lots. أخطاء اللوط بالشكل {success:false, code, message, detail} ومنها 503 LOT_BUSY: أعد الإرسال بنفس clientRef. التفاصيل في مجموعة «تتبّع اللوط»",
  "endpoints": [
   {
    "method": "GET",
    "path": "/invoices",
    "purpose": "قائمة الفواتير والمرتجعات والإشعارات مع التصفية والترقيم، من الأحدث إنشاءً إلى الأقدم",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting (accountingEnabled != false)",
     "requireAdminPermission canManageInvoices",
     "نطاق المستخدم الإداري scopedRecordWhere"
    ],
    "query": [
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "رقم الصفحة، الافتراضي 1. القيمة 0 أو غير الرقمية تُعامل كـ1"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة (الافتراضي 20، وأقصاه 200 لطلبات المفتاح). للسحب الكامل استعمل /api/v1/sync/invoices"
     },
     {
      "name": "search",
      "type": "string",
      "required": false,
      "desc": "بحث جزئي في رقم الفاتورة أو اسم العميل (contains بلا تجاهل لحالة الأحرف)"
     },
     {
      "name": "status",
      "type": "string",
      "required": false,
      "desc": "DRAFT أو CONFIRMED أو CANCELLED. القيمة غير المعروفة ترجع قائمة فارغة"
     },
     {
      "name": "type",
      "type": "string",
      "required": false,
      "desc": "CASH أو CREDIT أو RETURN. الإشعار الدائن نوعه RETURN والإشعار المدين نوعه CREDIT"
     },
     {
      "name": "salesRepId",
      "type": "string",
      "required": false,
      "desc": "تصفية حسب المندوب"
     },
     {
      "name": "customerId",
      "type": "string",
      "required": false,
      "desc": "تصفية حسب العميل"
     },
     {
      "name": "from",
      "type": "date string",
      "required": false,
      "desc": "بداية فترة invoiceDate (أكبر من أو يساوي)، مثل 2026-10-01"
     },
     {
      "name": "to",
      "type": "date string",
      "required": false,
      "desc": "نهاية فترة invoiceDate وتشمل اليوم كاملاً حتى 23:59:59.999 بتوقيت الخادم"
     },
     {
      "name": "withItems",
      "type": "'1' | 'true'",
      "required": false,
      "desc": "تضمين بنود كل فاتورة مع product{name,unit}، وكل بند بلقطة وحدته unitName (تُملأ بوحدة الصنف للبند الذي بلا لقطة) وunitFactor وbaseQty"
     },
     {
      "name": "locationId",
      "type": "string (uuid) | none",
      "required": false,
      "desc": "تصفية بختم الموقع (ميزة «لوكيشن»): معرّف موقع من GET /locations، أو none للفواتير بلا موقع. يعمل ولو كانت الميزة مطفأة، والقيمة غير النصية (مثل locationId[not]=x) تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:[...], pagination:{total, page, limit, pages}}. كل صف فيه أعمدة الفاتورة: id وnumber وtype وstatus وinvoiceDate وdueDate وdeliveryDate وpaymentPlan وpricesIncludeTax وsubtotal وdiscountPct وdiscountAmt وtaxAmt وtotal وpaidAmt وremainingAmt وreturnReason وreturnToStock وeinvoiceProvider وeinvoiceStatus وeinvoiceQr وclientRef وzatcaPhase وdocumentKind وinvoiceSubtype وissuedAt وoriginalInvoiceId وcreatedAt وlocationId. ومعها customer{id,name,phone} وsalesRep{id,name} وlocation{id,name} (ختم موقع المندوب وقت الإصدار، أو null) و_count{items}، وitems عند طلب withItems. الحقل einvoiceSnapshot محذوف من صفوف القائمة",
    "rules": [
     "الترتيب حسب createdAt تنازلياً، والترقيم بالأسلوب skip=(page-1)*limit",
     "هذه القائمة لا تشترط X-FS-Caps حتى للصفوف المربوطة بالمرحلة الثانية، بخلاف GET /invoices/:id",
     "المبالغ subtotal وdiscountAmt صافية قبل الضريبة دائماً. أما unitPrice وlineTotal للبنود فتكون شاملة الضريبة إذا كان pricesIncludeTax=true",
     "لا ترسل قيماً سالبة لـpage أو limit، لأنها لا تُصحَّح وقد تسبب خطأ 500",
     "from وto هنا بمنتصف ليل UTC، بخلاف ملخّص لوكيشن وسجل التحميلات وتقرير طرق الدفع التي تُحسب بأيام الشركة المحلية — فقد يختلف مجموع يومٍ واحد بينهما بما وقع بين منتصف الليل والثالثة فجراً بتوقيت الرياض",
     "teamId (ميزة «الفرق») عمود في كل صف: الفريق الذي وُسمت به الفاتورة أو null، وأسماء الفرق من GET /company/teams"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/open",
    "purpose": "فواتير العميل الآجلة المفتوحة القابلة للتحصيل، من الأقدم إلى الأحدث، لتوزيع سند القبض عليها",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting",
     "requireAdminPermission canManageReceipts (لا canManageInvoices)",
     "canAccessCustomer ونطاق المستخدم"
    ],
    "query": [
     {
      "name": "customerId",
      "type": "string",
      "required": true,
      "desc": "معرّف العميل، وغيابه يرجع 400"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, number, remainingAmt, invoiceDate}]} بحد أقصى 200 صف، مرتبة حسب invoiceDate تصاعدياً",
    "rules": [
     "الشروط: status=CONFIRMED وtype=CREDIT وremainingAmt>0.004، ومرآة زاتكا يجب أن تسمح بالتحصيل. الفاتورة غير المعتمدة بعد من الهيئة لا تظهر",
     "هذا ترتيب FIFO نفسه الذي يكمل به الخادم التوزيع الناقص لسند القبض",
     "العميل خارج نطاق المستخدم يرجع 403"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/by-client-ref/:clientRef",
    "purpose": "جلب فاتورة بمفتاح منع التكرار clientRef، ويفيد إذا ضاع رد الإنشاء",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم",
     "X-FS-Caps: zatca2 إذا كان الصف zatcaPhase=2، وإلا 426"
    ],
    "query": [
     {
      "name": "withLots",
      "type": "1 | true",
      "required": false,
      "desc": "«تتبّع اللوط»: يضيف لكل بند lots:[{id, invoiceItemId, invoiceId, tenantId, productId, vanKey, lotId, quantity, certainty, expiryDate, sourceItemLotId, flags, createdAt, lot:{lotNumber, expiryDate}|null}] — صفوف توزيعه على التشغيلات بالكمية الأساسية، وlotId = null «غير معروف». بند صنف غير متتبَّع lots فارغة. يُهمل حين تكون الميزة مطفأة للشركة (الإطفاء يُخفي صفوف الحقبة السابقة). بدونه الرد كما هو"
     }
    ],
    "body": [],
    "response": "{success:true, data:{...invoice, items[], customer{...كامل}}}، ويضاف einvoice لصفوف المرحلة الثانية (phase, mode, status, documentStatus, subtype, icv, uuid, qr, printable, overdue, reportDeadline, warnings...)",
    "rules": [
     "قراءة فقط ولا تتصل بالهيئة",
     "إذا لم توجد الفاتورة أو كانت خارج النطاق يرجع 404 الفاتورة غير موجودة",
     "المرجع"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/returnable-sales",
    "purpose": "فواتير بيع العميل التي بقي فيها ما يُرجَع — الخطوة الأولى لإصدار مرتجع من فاتورة بيع",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageInvoices')",
     "نطاق المستخدم: فواتير في نطاق صاحب المفتاح وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "customerId",
      "type": "string",
      "required": true,
      "desc": "العميل. غيابه يرجع 400 «يجب تحديد العميل»"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, number, invoiceDate, total, type, itemsCount, returnableQty, productIds:[...]}]}",
    "rules": [
     "تُفحص أحدث 300 فاتورة بيع مؤكدة للعميل (CASH أو CREDIT، بلا الإشعارات الدائنة والمدينة)، ويُعاد منها ما بقي فيه ما يُرجَع، من الأحدث تاريخاً",
     "returnableQty مجموع ما بقي في كل بنود الفاتورة بعد المرتجعات السابقة، وproductIds الأصناف التي بقي منها شيء — للبحث بالصنف",
     "يعمل في المرحلتين، ولا يشترط ميزة لوكيشن ولا الفرق"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/:id/returnable",
    "purpose": "بنود فاتورة بيع مع المبيع والمُرجَع والمتاح لكل بند وسعر الاسترداد وصلاحيته — لبناء جسم المرتجع",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "requireAdminPermission('canManageInvoices')",
     "نطاق المستخدم",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "withLots",
      "type": "1 | true",
      "required": false,
      "desc": "«تتبّع اللوط»: يضيف لكل سطر lots:[{lotId, lotNumber, expiryDate, sold, returned, returnable, certainty}] — تشغيلات بند البيع بالكمية الأساسية، وما أُرجع من كل تشغيلة في مرتجعات وإشعارات غير ملغاة، والمتاح منها. lotId = null «غير معروف». للعرض: المرتجع المرتبط يرث التشغيلات في الخادم ولا يُرسل لها شيء. يُهمل حين تكون الميزة مطفأة للشركة"
     }
    ],
    "body": [],
    "response": "{success:true, data:{id, number, invoiceDate, customerId, lines:[{saleItemId, productId, name, code, unit, sold, returned, returnable, refundUnitPrice, qty, unitName, unitFactor, soldBase, returnedBase, returnableBase, lineTotal, refundPerBase, product:{unit, units:[{id, name, factor, price, unitCode, isActive, sortOrder}]}, taxPct, shelfLife, expiresAt, expiredToday, returnBlocked, lots?}]}}",
    "rules": [
     "saleItemId هو ما يُرسل في items[].invoiceItemId عند POST /invoices. وsold وreturned وreturnable بوحدة الأساس (unit = وحدة أساس الصنف)، وهي soldBase وreturnedBase وreturnableBase نفسها: بند «2 كرتون» من 24 يعطي sold = 48. وqty وunitName وunitFactor البند كما بيع (unitName null = الأساس)",
     "refundUnitPrice هو refundPerBase بأربع منازل: ما دفعه العميل لوحدة الأساس شاملاً الضريبة بعد خصمي البند والفاتورة (lineTotal ÷ soldBase). للعرض وحده: مبلغ المرتجع المرتبط يحسبه الخادم عند الإصدار",
     "shelfLife وexpiresAt (YYYY-MM-DD) وexpiredToday لصنف مفعّلة صلاحيته: المنتهي يُقبل ويدخل مخزون السيارة «منتهي الصلاحية» فلا يُباع",
     "returnBlocked نص سبب الرفض إن كان قيد المرتجع للصنف يمنعه اليوم بتوقيت الشركة، وإلا null. للقيد وضعان (returnRuleMode) بحدٍّ بالأيام أو بنسبة من مدة الصلاحية (returnRuleMetric وreturnRuleValue): NEAR_EXPIRY «قرب الانتهاء» يقبل المرتجع إذا بقي من صلاحية ما بيع الحدُّ أو أقل والمنتهي يُقبل، وSTILL_VALID «ما زال صالحاً» يقبله إذا بقي الحدُّ أو أكثر والمنتهي يُرفض. وهو إرشاد للعرض: القرار للخادم عند الإصدار في POST /invoices، فيرجع 422 RETURN_RULE_BLOCKED برسالة «اسم الصنف: السبب»، ويوم المرتجع لطلب المفتاح invoiceDate إن أُرسل وإلا اليوم (clientCreatedAt لا يُقرأ للمفتاح)",
     "فاتورة غير موجودة أو خارج النطاق 404، وفاتورة ليست بيعاً مؤكداً (مرتجع أو ملغاة أو إشعار) 422",
     "الإرجاع بوحدة: أرسل الكمية بوحدة الأساس بلا unitId، أو بوحدة من product.units بمعرّفها unitId، ومجموع ما يُرجَع من البند بالأساس لا يتجاوز returnableBase (وإلا 422 RETURN_LINK_INVALID). حبةٌ من بند كرتون = {invoiceItemId, qty:1} بلا unitId. وصنفٌ بلا وحدات: الأرقام كما كانت قبل الميزة (المعامل 1)"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/:id",
    "purpose": "تفاصيل فاتورة واحدة كاملة مع بنودها وعميلها وأقساطها وسندات القبض المرتبطة بها",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم",
     "X-FS-Caps: zatca2 إذا كان zatcaPhase=2، وإلا 426 ZATCA_CLIENT_UPDATE_REQUIRED"
    ],
    "query": [
     {
      "name": "withLots",
      "type": "1 | true",
      "required": false,
      "desc": "«تتبّع اللوط»: يضيف لكل بند lots:[{id, invoiceItemId, invoiceId, tenantId, productId, vanKey, lotId, quantity, certainty, expiryDate, sourceItemLotId, flags, createdAt, lot:{lotNumber, expiryDate}|null}] بالكمية الأساسية (Σ quantity = baseQty البند). lotId = null «غير معروف»، وcertainty: CONFIRMED أو ASSUMED أو UNKNOWN، وflags أوسام مفصولة بفاصلة أو null. يُهمل حين تكون الميزة مطفأة للشركة (الإطفاء يُخفي صفوف الحقبة السابقة). بدونه الرد كما هو"
     }
    ],
    "body": [],
    "response": "{success:true, data:{...أعمدة الفاتورة, customer{...كامل}, salesRep{id,name,phone}, installments[{seq,dueDate,amount,...}], items[{..., qty, unitName, unitFactor, baseQty, unitCode, product{id,name,code,unit}, lots?}], receiptItems[{...,receipt{...}}], signature{image,repImage,createdAt}|null, einvoice? }}. الحقل einvoice يظهر لصفوف المرحلة الثانية فقط، وitems[].lots مع withLots=1",
    "rules": [
     "الحقل signature يحمل صور التوقيع PNG بصيغة base64 وقد يكون حجمها كبيراً",
     "الحقل einvoice.qr هو رمز QR الذي يُطبع، والحقل printable يبين هل يجوز تسليم المستند فاتورةً ضريبية. القياسية لا تُطبع قبل اعتماد الهيئة",
     "المرجع",
     "البند يُعرض بلقطة وحدته «qty unitName»، وunitName null يعني وحدة الأساس لحظة كتابته فاعرض product.unit. وbaseQty = qty × unitFactor بوحدة الأساس"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/invoices",
    "purpose": "إنشاء فاتورة بيع نقدية أو آجلة أو بالتقسيط، أو مرتجع",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم: العميل والمندوب داخل نطاقه",
     "المرحلة الثانية من زاتكا: X-FS-Caps: zatca2 إجباري، والعملة SAR فقط",
     "invoiceSignatureEnabled لحفظ التواقيع فقط"
    ],
    "query": [],
    "body": [
     {
      "name": "customerId",
      "type": "string",
      "required": false,
      "desc": "معرّف العميل. يلزم هو أو customerClientRef"
     },
     {
      "name": "customerClientRef",
      "type": "string uuid",
      "required": false,
      "desc": "بديل customerId لعميل أُنشئ بمرجع clientRef. إذا لم يوجد يرجع 400"
     },
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "المندوب المنسوبة إليه الفاتورة. إجباري للمفتاح، وغيابه يرجع 400 يجب تحديد المندوب"
     },
     {
      "name": "teamId",
      "type": "string | null",
      "required": false,
      "desc": "ميزة «الفرق»: الفريق الذي يعمل له المندوب الآن، ويُهمل كله إن كانت الفرق مطفأة للشركة. الوسم بهذا الترتيب: ١) إن كان صاحب المفتاح مشرفاً على فريق فعّال يضمّ المندوب فالأولوية لإشرافه: يُقبل teamId إن كان من الفرق التي يشرف عليها، وإلا يُوسم بأولها، ولا يُقبل فريقٌ للمندوب لا يشرف عليه (وإن كانت الفرق المشتركة التي يشرف عليها مؤرشفة كلها فبلا فريق) ٢) وإلا يُقبل إن كان من فرق المندوب الفعّالة ٣) وإلا فريقه الوحيد إن كان له فريق فعّال واحد ٤) وإلا بلا فريق. لا رفض أبداً: القيمة غير الصالحة ترجع إلى هذا الترتيب بصمت. والمرتجع من فاتورة بيع يرث فريقها (ولو بلا فريق) أياً كان المرسل"
     },
     {
      "name": "type",
      "type": "enum CASH | CREDIT | RETURN",
      "required": false,
      "desc": "نوع المستند، الافتراضي CREDIT"
     },
     {
      "name": "items",
      "type": "array (min 1)",
      "required": true,
      "desc": "بنود الفاتورة"
     },
     {
      "name": "items[].productId",
      "type": "string",
      "required": true,
      "desc": "صنف نشط ACTIVE في الشركة، وغير ذلك يرجع 400"
     },
     {
      "name": "items[].qty",
      "type": "number > 0",
      "required": true,
      "desc": "الكمية بوحدة البند: كراتين لبند unitId وحدته كرتون، وبلا unitId بوحدة الأساس. والمخزون يتحرّك بـqty × factor"
     },
     {
      "name": "items[].unitId",
      "type": "string | null",
      "required": false,
      "desc": "وحدة البند من units[].id للصنف (GET /products أو مزامنة products). غيابه أو null = وحدة الأساس بمعامل 1. معرّفٌ لا يخصّ هذا الصنف (صنف آخر أو شركة أخرى) أو لوحدة موقوفة ⇒ 400 UNIT_INVALID. الخادم يحلّ المعامل والاسم ورمز الوحدة الضريبي من وحدات الصنف ولا يقبل معاملاً من الجسم"
     },
     {
      "name": "items[].unitName",
      "type": "string ≤ 64 | null",
      "required": false,
      "desc": "مع unitFactor وbaseUnitName: لقطة وحدة الجهاز لتطبيق المندوب حين يعيد رفع ما سجّله دون اتصال، فلا ترسلها من التكاملات. لطلب المفتاح لا تُكتب أبداً، وإن أرسلتها وخالفت ما يحلّه الخادم من unitId (الاسم أو المعامل أو اسم وحدة الأساس الحالية) رُدّ 400 UNIT_INVALID «تغيّرت وحدات الصنف — حدّث قائمة الأصناف»"
     },
     {
      "name": "items[].unitFactor",
      "type": "number | null",
      "required": false,
      "desc": "معامل وحدة الجهاز — انظر unitName: لا ترسله، والخادم يحلّ المعامل من unitId وحده"
     },
     {
      "name": "items[].baseUnitName",
      "type": "string ≤ 64 | null",
      "required": false,
      "desc": "اسم وحدة أساس الصنف على الجهاز لحظة الإصدار — انظر unitName: لا ترسله من التكاملات"
     },
     {
      "name": "items[].unitPrice",
      "type": "number >= 0",
      "required": true,
      "desc": "سعر وحدة البند (سعر الكرتون لبند بالكرتون). يكون صافياً قبل الضريبة إلا إذا كان pricesIncludeTax=true. في المرحلة الثانية السعر صفر يرجع 422"
     },
     {
      "name": "items[].discountPct",
      "type": "number 0-100",
      "required": false,
      "desc": "خصم البند بالنسبة المئوية، الافتراضي 0"
     },
     {
      "name": "items[].taxPct",
      "type": "number 0-100",
      "required": false,
      "desc": "ضريبة البند. عند الغياب يرث defaultVatPct من إعدادات الشركة (الافتراضي 15)"
     },
     {
      "name": "items[].invoiceItemId",
      "type": "string",
      "required": false,
      "desc": "للمرتجع من فاتورة بيع (في المرحلتين): معرّف بند البيع الذي يُرجَع منه، وهو saleItemId من GET /invoices/:id/returnable. والكمية لا تتجاوز returnable لذلك البند"
     },
     {
      "name": "items[].lots",
      "type": "array ≤ 20 of {lotId: string | null, qty: number > 0}",
      "required": false,
      "desc": "«تتبّع اللوط» للصنف المتتبَّع وحده (ويُهمل لغيره): تشغيلات البند صراحةً بالكمية الأساسية مهما كانت وحدة البند (2 كرتون من 24 = 48)، بأربع خانات عشرية على الأكثر، ومجموعها = qty × factor بالضبط وإلا 422 LOT_QTY_INVALID. lotId من GET /lots أو مزامنة product-lots، وnull = من الرصيد «غير المسمّى». في البيع: من تشغيلات سيارة المندوب نفسها، ولا تتجاوز رصيد كلٍّ منها (409 LOT_STOCK_INSUFFICIENT)، والموقوفة 422 LOT_BLOCKED، والمنتهية يوم الشركة 422 LOT_EXPIRED، ومن صنف آخر 422 LOT_PRODUCT_MISMATCH، وغير الموجودة 422 LOT_NOT_FOUND. في المرتجع الحرّ: التشغيلات التي عادت منها البضاعة بلا فحص رصيد، والموقوفة تُقبل بتحذير LOT_INTO_BLOCKED. في المرتجع المرتبط بفاتورة بيع (invoiceItemId) يُهمل: يرث الخادم تشغيلات البيع. غيابه أو مصفوفة فارغة = توزيع الخادم التلقائي"
     },
     {
      "name": "pricesIncludeTax",
      "type": "boolean",
      "required": false,
      "desc": "هل الأسعار المرسلة شاملة الضريبة، الافتراضي false"
     },
     {
      "name": "discountPct",
      "type": "number 0-100",
      "required": false,
      "desc": "خصم على إجمالي الفاتورة يوزَّع على البنود قبل الضريبة، الافتراضي 0. في المرحلة الثانية يُمنع مع pricesIncludeTax=true ويرجع 422"
     },
     {
      "name": "invoiceDate",
      "type": "date string",
      "required": false,
      "desc": "المرحلة الأولى: تاريخ المستند، ومنه تُشتق بادئة الرقم. المرحلة الثانية: تاريخ الإصدار هو لحظة الخادم، وهذا الحقل يُستعمل تاريخ توريد للقياسية فقط"
     },
     {
      "name": "dueDate",
      "type": "date string",
      "required": false,
      "desc": "تاريخ الاستحقاق. مع التقسيط يُستبدل تلقائياً بتاريخ آخر قسط"
     },
     {
      "name": "deliveryDate",
      "type": "date string",
      "required": false,
      "desc": "تاريخ التسليم للعرض. القيمة غير الصالحة تُهمل بصمت"
     },
     {
      "name": "notes",
      "type": "string",
      "required": false,
      "desc": "ملاحظات"
     },
     {
      "name": "paymentPlan",
      "type": "enum IMMEDIATE | INSTALLMENT",
      "required": false,
      "desc": "INSTALLMENT يتطلب type=CREDIT وinstallmentPlan"
     },
     {
      "name": "installmentPlan",
      "type": "object",
      "required": false,
      "desc": "إجباري مع INSTALLMENT وممنوع بدونه"
     },
     {
      "name": "installmentPlan.count",
      "type": "integer 2-60",
      "required": true,
      "desc": "عدد الأقساط"
     },
     {
      "name": "installmentPlan.firstDueDate",
      "type": "date string",
      "required": true,
      "desc": "تاريخ أول قسط"
     },
     {
      "name": "installmentPlan.period",
      "type": "enum MONTHLY | SEMI_MONTHLY | WEEKLY",
      "required": false,
      "desc": "دورية الأقساط، الافتراضي MONTHLY"
     },
     {
      "name": "returnReason",
      "type": "enum NORMAL | DAMAGED | EXCHANGE",
      "required": false,
      "desc": "سبب الإرجاع للمرتجع، الافتراضي NORMAL"
     },
     {
      "name": "returnToStock",
      "type": "boolean",
      "required": false,
      "desc": "هل تعود كميات المرتجع لمخزون سيارة المندوب. عند الغياب: يعود غير التالف. والتالف DAMAGED يدخل رصيد «المرتجع التالف» في السيارة (لا يُباع) مهما كانت هذه القيمة"
     },
     {
      "name": "originalInvoiceId",
      "type": "string",
      "required": false,
      "desc": "للمرتجع (type=RETURN): فاتورة البيع التي يُرجَع منها، في المرحلتين. في المرحلة الأولى اختياري: معه يتحقق الخادم من كل بند (من الفاتورة نفسها، بالصنف نفسه، والكمية ضمن المتاح)، ويرث المرتجع ختم موقعها وفريقها. وفي المرحلة الثانية إجباري، وغيابه يرجع 422 ZATCA_RETURN_NEEDS_ORIGINAL"
     },
     {
      "name": "noteReason",
      "type": "string max 1000",
      "required": false,
      "desc": "سبب الإشعار الدائن للمرتجع في المرحلة الثانية، من 3 أحرف على الأقل. إذا غاب يُستعمل notes"
     },
     {
      "name": "clientRef",
      "type": "string uuid",
      "required": false,
      "desc": "مفتاح منع التكرار وفريد لكل شركة. يُنصح به دائماً"
     },
     {
      "name": "clientCreatedAt",
      "type": "date-time string",
      "required": false,
      "desc": "لحظة الإنشاء على الجهاز، وهو حقل لتطبيق المندوب حين يعمل دون اتصال. لا ترسله من التكاملات: لطلب المفتاح لا يُخزَّن ولا يصير يوم المرتجع (قيد المرتجع للصنف ووسم صلاحية بنوده يُقاسان بـinvoiceDate وإلا اليوم)، لكنه يبقى يُشدّد إن أرسلته: في المرحلة الثانية يلزمه clientRef وإلا 426، وخلال تسليح التفعيل قد يُرفض به المستند 409"
     },
     {
      "name": "recipientSignature",
      "type": "string data:image/png;base64 (<=300000)",
      "required": false,
      "desc": "توقيع المستلم. يُحفظ فقط إذا كانت الميزة مفعلة وكان المستند ليس مرتجعاً"
     },
     {
      "name": "repSignature",
      "type": "string data:image/png;base64 (<=300000)",
      "required": false,
      "desc": "توقيع المندوب بنفس القيود"
     }
    ],
    "response": "المرحلة الأولى: 201 {success:true, data:{...invoice, items[], customer{...}, installments[], signature}}. تكرار clientRef يرجع 200 {success:true, data:<الفاتورة القائمة>, idempotent:true}. المرحلة الثانية: الشكل نفسه مضافاً إليه data.einvoice. المبسّطة (02) ترجع 201. القياسية (01) تُرسل للاعتماد داخل الطلب بمهلة تقارب 20 ثانية، وترجع 201 إذا اعتُمدت، أو 202 ZATCA_CLEARANCE_PENDING إذا بقيت بانتظار الاعتماد (success:true وdata موجودة)، أو 422 ZATCA_REJECTED إذا رُفضت وأُبطلت (data.status=CANCELLED)، أو 202 ZATCA_CLEARED_NO_XML. وكل بند في data.items يحمل لقطة وحدته: qty وunitName (null = الأساس) وunitFactor وbaseQty وunitCode. «تتبّع اللوط»: المستند الذي فيه صنف متتبَّع يحمل كل بند فيه lots (صفوف توزيعه كما في withLots=1)، ومعه warnings:[{code, productId, detail?}] بجوار data حين توجد تحذيرات (LOT_FROM_UNKNOWN بيعٌ من الرصيد غير المسمّى، LOT_SPLIT_UNIT وحدة بند انقسمت بين مصدرين detail:{unitFactor, idx}، LOT_INTO_BLOCKED مرتجع إلى تشغيلة موقوفة) — لا تمنع الإصدار. والرفض: 409 {success:false, code:'LOT_STOCK_INSUFFICIENT', message, detail:{productId, wanted, available, byLot:[{lotId, lotNumber, usable, status, expiryDate}], unknownUsable, lines}} و422 LOT_QTY_INVALID أو LOT_NOT_FOUND أو LOT_PRODUCT_MISMATCH أو LOT_BLOCKED أو LOT_EXPIRED (detail فيه productId وline فهرس البند)، و503 LOT_BUSY",
    "rules": [
     "الحساب: خصم الفاتورة يوزَّع على البنود قبل الضريبة، والإجمالي يساوي مجموع صافي البنود، والتقريب نصف لأعلى بعدد خانات عملة الشركة",
     "الأثر المحاسبي: CREDIT يرفع رصيد العميل بالإجمالي ويضع paidAmt=0 وremainingAmt=total. CASH يسجّل قيدين (مدين ثم تحصيل) فلا يتغير الرصيد، ويضع paidAmt=total وremainingAmt=0. RETURN ينقص رصيد العميل وtotalSales ويضع paid=0 وremaining=0",
     "الحد الائتماني لا يمنع الإنشاء. إذا كان creditLimit>0 وتجاوزه الرصيد مع الإجمالي يُنشأ تنبيه CREDIT_LIMIT_EXCEEDED فقط",
     "العميل المحظور BLOCKED يرجع 400، والعميل أو المندوب خارج النطاق يرجع 403 أو 404",
     "قيود المندوب (حد الخصم وتغيير السعر والبيع بلا مخزون والأذونات) لا تنطبق على المفتاح، لأنها مشروطة بالدور SALES_REP. لذلك المفتاح يستطيع البيع بأكثر من مخزون السيارة، إلا الصنف المتتبَّع بالتشغيلة («تتبّع اللوط» مفعّل للشركة والصنف): بيعه ممنوعٌ فوق رصيد تشغيلات السيارة الصالحة وغير المسمّى لكل مُصدِر ومنه المفتاح، ولا يُعفي منه إذن canSellWithoutStock (409 LOT_STOCK_INSUFFICIENT)",
     "«تتبّع اللوط» — التوزيع: بلا items[].lots يوزّع الخادم البيع على تشغيلات سيارة المندوب الصالحة يوم الشركة (غير الموقوفة وغير المنتهية) بالأقرب انتهاءً (FEFO)، ثم من الرصيد «غير المسمّى» بيقين UNKNOWN. البند بوحدة أكبر (كرتون) يُؤخذ من تشغيلة واحدة ما أمكن، وإلا يُقسم مع تحذير LOT_SPLIT_UNIT. والبندان للصنف نفسه يُفحصان معاً على رصيد واحد. كمية البند بالأساس بأكثر من أربع خانات عشرية ترجع 422 LOT_QTY_INVALID. وصلاحية البند (expiresAt) تُختم من أقرب تشغيلة مسمّاة له انتهاء",
     "«تتبّع اللوط» — المرتجع: المرتبط بفاتورة بيع يرث تشغيلات بندها (إن كان فيها ما انتهى يوم المرتجع يُوزَّع الأقرب انتهاءً أولاً، وإلا الأبعد انتهاءً، والزائد «غير معروف»)، وبندٌ فيه تشغيلة منتهية يدخل كله رصيد «منتهي الصلاحية» في السيارة. والحرّ «غير معروف» ما لم ترسل items[].lots. ويوم الشركة لطلب المفتاح بساعة الخادم دائماً، وX-FS-Replay تُمحى فلا ينال المفتاح تسامح صندوق المندوب ولا الحجز للمراجعة LOT_REPLAY_HELD",
     "«تتبّع اللوط» — الانشغال: 503 {success:false, code:'LOT_BUSY', message, detail:{cause|reason}} حين يكون صنفٌ في المستند مشغولاً بعملية تشغيلات أخرى، أو تبدّل تتبّعه أثناء الطلب (reason: 'TRACKING_CHANGED'). لا يُكتب شيء: أعد الإرسال بنفس clientRef. وفي المرحلة الثانية تبقى مهلة الإصدار 503 ZATCA_UNIT_BUSY كما هي",
     "مخزون السيارة يُحسب من الفواتير المؤكدة لكل مندوب بوحدة الأساس (qty × unitFactor): البيع ينقصه، والمرتجع الذي returnToStock=true له يعيده",
     "منع التكرار: إذا وُجدت فاتورة بنفس clientRef تُعاد كما هي مع idempotent:true ولا يُعاد الحساب، ولو اختلف الجسم. والطلبان المتزامنان يحسمهما القيد الفريد",
     "التقسيط: الخادم يبني الجدول من الإجمالي المحسوب، والفارق يحمله القسط الأخير، والمجموع يجب أن يساوي الإجمالي وإلا 400",
     "المرحلة الثانية: المرتجع يصبح إشعاراً دائناً مرتبطاً بالأصل. أسعاره وضريبته تؤخذ من بنود الأصل، ويُتجاهل unitPrice المرسل. البند يُطابَق بـinvoiceItemId أو بالصنف إذا لم يتكرر في الأصل، وإلا 422. والكمية محدودة بما لم يُرجَع بعد (المقارنة بوحدة الأساس، والكمية بوحدة unitId)",
     "المرحلة الثانية: العميل الذي لديه رقم ضريبي أو سجل تجاري أو نوع BUSINESS/GOVERNMENT تصدر له فاتورة قياسية (01) تحتاج بيانات مشترٍ كاملة، وإلا 422 ZATCA_BUYER_INCOMPLETE مع data.fields. وغيره تصدر له مبسّطة (02)",
     "المرحلة الثانية: إرسال clientCreatedAt دون clientRef يرجع 426. وخلال فترة تسليح التفعيل قد يرجع 409 ZATCA_GO_LIVE_ARMING لمستند يحمل clientCreatedAt",
     "أخطاء زاتكا الأخرى: 503 ZATCA_UNIT_UNAVAILABLE أو UNIT_BUSY أو STAMP_FAILED (أعد المحاولة بنفس clientRef)، و422 ZATCA_AMOUNTS أو PREFLIGHT أو CURRENCY",
     "مثال تقسيط: {\"customerId\":\"…\",\"salesRepId\":\"…\",\"type\":\"CREDIT\",\"paymentPlan\":\"INSTALLMENT\",\"installmentPlan\":{\"count\":3,\"firstDueDate\":\"2026-11-01\",\"period\":\"MONTHLY\"},\"items\":[{\"productId\":\"…\",\"qty\":10,\"unitPrice\":120}]}",
     "ختم الموقع (ميزة «لوكيشن»): الخادم يكتب locationId بموقع المندوب لحظة الإصدار إن كانت الميزة مفعّلة للشركة، والمرتجع من فاتورة بيع يرث ختمها. لا حقل له في الجسم",
     "المرتجع من فاتورة بيع (المرحلة الأولى): اختر الفاتورة من GET /invoices/returnable-sales?customerId=… ثم بنودها من GET /invoices/:id/returnable. أرسل لكل بند invoiceItemId = saleItemId والكمية بوحدة unitId (وبلا unitId بوحدة الأساس، فحبةٌ من بند كرتون تُرسل بلا unitId)، بحيث لا يتجاوز مجموع ما يُرجَع من البند بالأساس returnable. الخادم يسعّر المرتجع المرتبط بنفسه من بند البيع: ما دفعه العميل فعلاً شاملاً الضريبة بعد خصمي البند والفاتورة لما يُرجَع، والباقي لآخر حبة (فإرجاع 24 حبة فرادى من كرتون = قيمة الكرتون تماماً)، ويُكتب المستند شاملاً للضريبة بلا خصم فاتورة. لذلك يُهمل unitPrice وdiscountPct وpricesIncludeTax المرسلة للمرتجع المرتبط، ويبقى unitPrice إلزامياً في المخطط",
     "قيد المرتجع للصنف (منتج مفعّلة صلاحيته وقيد إرجاعه returnRuleEnabled): مرتجع فيه صنف يمنع قيدُه إرجاعه يرجع 422 RETURN_RULE_BLOCKED برسالة «اسم الصنف: السبب»، لأي مُصدِر ومنه المفتاح وفي المرحلتين، مرتبطاً بفاتورة بيع كان أو حرّاً. للقيد وضعان (returnRuleMode) بحدٍّ بالأيام أو بنسبة من مدة الصلاحية: NEAR_EXPIRY «قرب الانتهاء» يقبل المرتجع إذا بقي من صلاحية ما بيع الحدُّ أو أقل والمنتهي يُقبل، وSTILL_VALID «ما زال صالحاً» يقبله إذا بقي الحدُّ أو أكثر والمنتهي يُرفض. يُقاس على بند البيع المرتبط، وإلا آخر بيع للصنف لهذا العميل حتى invoiceDate. ويوم المرتجع لطلب المفتاح invoiceDate إن أُرسل وإلا اليوم بتوقيت الشركة، وclientCreatedAt لا يُقرأ للمفتاح هنا ولا في وسم صلاحية البنود ولا يُخزَّن (هو لحظة جهاز تطبيق المندوب حين يرفع ما سجّله دون اتصال). وبيع لا يُعرف انتهاؤه لا يُرفض به",
     "أخطاء الربط: 422 RETURN_LINK_INVALID (بند ليس من الفاتورة، أو صنف مختلف، أو كمية فوق المتاح، أو فاتورة ليست بيعاً مؤكداً للعميل نفسه)، و409 بالرمز نفسه حين يسبقك مرتجع متزامن على الكمية نفسها، و404 «فاتورة البيع الأصلية غير موجودة» لفاتورة خارج نطاق صاحب المفتاح",
     "مثال مرتجع حرّ بلا فاتورة بيع (المرحلة الأولى): {\"customerId\":\"…\",\"salesRepId\":\"…\",\"type\":\"RETURN\",\"returnReason\":\"DAMAGED\",\"returnToStock\":false,\"items\":[{\"productId\":\"…\",\"qty\":2,\"unitPrice\":5}]}",
     "مثال مرتجع من فاتورة بيع (المرحلة الأولى): {\"customerId\":\"…\",\"salesRepId\":\"…\",\"type\":\"RETURN\",\"returnReason\":\"NORMAL\",\"originalInvoiceId\":\"<id فاتورة البيع>\",\"pricesIncludeTax\":true,\"discountPct\":0,\"items\":[{\"productId\":\"…\",\"invoiceItemId\":\"<saleItemId>\",\"qty\":1,\"unitPrice\":103.5,\"discountPct\":0,\"taxPct\":15}]}. وحبّتان من بند بيع بالكرتون: البند نفسه بـ\"qty\":2 بلا unitId (والسعر يحسبه الخادم)",
     "مثال مرتجع في المرحلة الثانية: الجسم نفسه مع noteReason (3 أحرف على الأقل). الأسعار والضريبة تؤخذ من بنود الأصل ويُهمل unitPrice المرسل، لكنه يبقى إلزامياً في المخطط",
     "الوحدات: الخادم يحلّ وحدة كل بند من unitId ويكتب لقطتها (unitName وunitFactor وunitCode وbaseQty)، فبند {\"qty\":2,\"unitId\":\"<كرتون 24>\"} يخصم 48 حبة من مخزون السيارة. والكرتون والحبة من الصنف نفسه في فاتورة واحدة يُجمعان بالأساس",
     "رمز وحدة البند unitCode (للفوترة الإلكترونية): units[].unitCode للوحدة، وإلا رمز الصنف، وإلا PCE. والكمية والسعر في المستند الضريبي بوحدة البند",
     "سعر الوحدة الأكبر: units[].price المحدد، وإلا basePrice × factor. وفي حارس سعر المندوب (لا ينطبق على المفتاح) يُضرب سعر العميل الخاص وأقل سعر شريحة بمعامل البند",
     "400 {success:false, code:'UNIT_INVALID', message}: وحدة لا تخصّ الصنف أو موقوفة أو لقطة تخالف الخادم. لا يُكتب شيء، فأعد سحب الأصناف وصحّح البند ثم أعد الإرسال بنفس clientRef"
    ],
    "example": "{\"customerId\":\"8f1c2a4e-1b2c-4d5e-9f00-112233445566\",\"salesRepId\":\"2b7e9d10-3c4d-4e5f-8a90-aabbccddeeff\",\"type\":\"CASH\",\"pricesIncludeTax\":true,\"items\":[{\"productId\":\"a1d2c3b4-0000-4000-8000-000000000001\",\"qty\":12,\"unitPrice\":5.75},{\"productId\":\"a1d2c3b4-0000-4000-8000-000000000002\",\"qty\":2,\"unitId\":\"5e6f7a8b-0000-4000-8000-0000000000c6\",\"unitPrice\":34.5,\"discountPct\":5}],\"notes\":\"طلب من نظام ERP\",\"clientRef\":\"3f2b8c1e-6a4d-4e2b-9c7a-1d2e3f4a5b6c\"}"
   },
   {
    "method": "PATCH",
    "path": "/invoices/:id/cancel",
    "purpose": "إلغاء فاتورة أو مرتجع من المرحلة الأولى وعكس قيوده",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم",
     "ممنوع لصفوف zatcaPhase=2"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:<صف الفاتورة بعد التحديث status=CANCELLED بلا علاقات>}",
    "rules": [
     "لا يحتاج جسماً",
     "الفاتورة الملغاة مسبقاً ترجع 400",
     "صف المرحلة الثانية يرجع 409 ZATCA_CANCEL_NOT_ALLOWED مع data.creditable. البديل هو السحب قبل الاعتماد، أو إشعار دائن كامل lines:'FULL' بعده",
     "إذا صدر على الفاتورة إشعار دائن أو مدين يرجع 409 مع reason=HAS_NOTES",
     "الفاتورة الآجلة التي حُصّل جزء منها (paidAmt>0) ترجع 400، والفاتورة المرتبطة بسند قبض ترجع 400",
     "الأثر: status=CANCELLED، وعكس القيود حسب النوع (مرتجع أو نقدي أو آجل)، وتنبيه INVOICE_CANCELLED، وإبطال روابط الدفع الحية. مخزون السيارة يُستعاد تلقائياً لأن الحساب يعتمد على الفواتير المؤكدة فقط",
     "الفحوص تُعاد تحت قفل الصف لمنع الإلغاء المزدوج (services/docCancel.ts)",
     "«تتبّع اللوط»: إلغاء فاتورة بيع يعيد كمياتها إلى تشغيلاتها في السيارة تلقائياً. أما إلغاء مرتجعٍ فيه صنف متتبَّع فيُخرج بضاعته من السيارة، فيُرفض 409 {code:'LOT_STOCK_INSUFFICIENT', detail} إن كانت قد بيعت (لا تصير تشغيلة سالبة ولا ينقص الرصيد غير المسمّى تحت الصفر)، و503 LOT_BUSY حين يكون الصنف مشغولاً أو تبدّل تتبّعه أثناء الطلب: أعد المحاولة"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/:id/creditable",
    "purpose": "معاينة ما يمكن إرجاعه من الفاتورة بإشعار دائن، بنداً بنداً، قبل إصداره",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم والعميل",
     "الشركة يجب أن تكون في المرحلة الثانية، وإلا 409"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{invoiceId, number, subtype, documentKind, einvoiceStatus, total, remainingAmt, creditedTotal, legacyReturnsApplied, eligible, refusal, messageAr, lines:[{invoiceItemId, seq, productId, itemName, unitCode, qty, credited, legacyCredited, returnable, lineQty, unitPrice, discountPct, taxPct, vatCategory, vatExemptionCode, vatExemptionReason, damagedReturnToStock, unitName, unitFactor, baseUnitName, units:[{id, name, factor, unitCode, isActive}], soldBase, creditedBase, legacyCreditedBase, returnableBase}], permissions:{full, partial, debit}}}",
    "rules": [
     "الشركة في المرحلة الأولى ترجع 409 مع رسالة أن الإشعارات للشركات المربوطة، وعندها سجّل مرتجعاً عادياً عبر POST /invoices",
     "returnable = qty − credited − legacyCredited، وكلها بوحدة الأساس (وهي soldBase وcreditedBase وlegacyCreditedBase وreturnableBase نفسها). والبند كما بيع: lineQty بوحدته وunitPrice لوحدته وunitName وunitFactor (null و1 = الأساس)، وbaseUnitName اسم وحدة الأساس، وunits وحدات الصنف لإشعار بوحدة أخرى. المرتجعات القديمة غير المرتبطة تُخصم فقط لأصل من المرحلة الأولى",
     "استعمل lines[].invoiceItemId في POST /invoices/:id/credit-note",
     "المرجع"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/invoices/:id/credit-note",
    "purpose": "إصدار إشعار دائن (381) على فاتورة: مرتجع جزئي، أو كامل بديلاً عن الإلغاء بعد الربط",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم والعميل",
     "المرحلة الثانية فقط، وإلا 409",
     "X-FS-Caps: zatca2 إجباري، وإلا 426"
    ],
    "query": [],
    "body": [
     {
      "name": "reason",
      "type": "string 3-1000",
      "required": true,
      "desc": "سبب الإشعار ويظهر في المستند الضريبي"
     },
     {
      "name": "lines",
      "type": "'FULL' | array (min 1)",
      "required": true,
      "desc": "FULL يعني كل ما لم يُرجَع بعد، أو قائمة ببنود الأصل"
     },
     {
      "name": "lines[].invoiceItemId",
      "type": "string",
      "required": true,
      "desc": "معرّف بند الفاتورة الأصلية من creditable"
     },
     {
      "name": "lines[].qty",
      "type": "number > 0",
      "required": true,
      "desc": "الكمية المرتجعة بوحدة unitId، وبلا unitId بوحدة الأساس. مجموع ما يُطلب من البند بالأساس لا يتجاوز returnable (بالأساس)"
     },
     {
      "name": "lines[].unitId",
      "type": "string | null",
      "required": false,
      "desc": "وحدة الإرجاع من units[].id في creditable: وحدة البند نفسها تُرجَع بمعامل لقطته ولو تغيّر معاملها أو أُوقفت بعد البيع. غيابه أو null أو معرّف لا يخصّ الصنف = وحدة الأساس. البند الواحد يُطلب بوحدتين في سطرين («1 كرتون و3 حبة»)، والمكرر بالوحدة نفسها يرجع 422"
     },
     {
      "name": "reasonCode",
      "type": "enum NORMAL | DAMAGED | EXCHANGE",
      "required": false,
      "desc": "سبب الإرجاع، الافتراضي NORMAL"
     },
     {
      "name": "returnToStock",
      "type": "boolean",
      "required": false,
      "desc": "إعادة الكميات لمخزون السيارة. عند الغياب: غير التالف نعم. والتالف يدخل رصيد «المرتجع التالف» في السيارة (لا يُباع) مهما كانت هذه القيمة"
     },
     {
      "name": "clientRef",
      "type": "string uuid",
      "required": false,
      "desc": "مفتاح منع التكرار"
     },
     {
      "name": "clientCreatedAt",
      "type": "date-time string",
      "required": false,
      "desc": "لا ترسله، وإن أرسلته فـclientRef إجباري معه وإلا 426. ولطلب المفتاح لا يُخزَّن على الإشعار ولا يقيس به وسم صلاحية البنود يوم المرتجع (اليوم وحده)"
     }
    ],
    "response": "201 {success:true, data:{...صف الإشعار (type=RETURN, documentKind=CREDIT_NOTE, number=RET-YYMM-######, originalInvoiceId, items, customer), einvoice:{...}, original:{id, number, remainingAmt, customerCredit, creditedTotal}}}. إذا كان الأصل قياسياً (01) يُعتمد داخل الطلب: 201 أو 202 بانتظار الاعتماد أو 422 مرفوض ومُبطل. تكرار clientRef يرجع 200 مع idempotent:true",
    "rules": [
     "الأصل يجب أن يكون فاتورة CASH أو CREDIT مؤكدة، وليس إشعاراً (وإلا 409 ZATCA_NOTE_ON_NOTE). وإذا كان من المرحلة الثانية فيجب أن يكون معتمداً أو مبلغاً (وإلا 409 ZATCA_ORIGINAL_NOT_CLEARED). الإشعار مسموح على أصل من المرحلة الأولى",
     "الأسعار والضريبة والخصم الكلي من الأصل، ولا تُرسل أسعاراً. وسعر وحدة غير وحدة البند (حبة من بند كرتون) حصّتها من قيمة البند، فإرجاع الكرتون حبةً حبةً في إشعارات متفرقة يساوي قيمته تماماً، ورمز وحدة بند الإشعار رمز الوحدة المُرجَع بها",
     "الكمية الزائدة ترجع 422 ZATCA_CREDIT_QTY_EXCEEDED، وإذا كانت كل الكميات مرتجعة سابقاً يرجع 409 ZATCA_NOTHING_TO_CREDIT",
     "الأثر: ينقص remainingAmt للأصل بفرق نسبي بقيمة min(الإجمالي، المتبقي)، والزائد يصبح رصيداً دائناً للعميل. يُسجَّل قيد مرتجع فينقص رصيد العميل، وتُبطل روابط دفع الأصل",
     "الإشعار يُنسب لمندوب الأصل لأن المفتاح لا يملك هوية مندوب، والكميات تعود لمخزون ذلك المندوب حسب returnToStock",
     "المستخدم الإداري مسموح له بالكامل والجزئي",
     "«تتبّع اللوط»: لا حقل تشغيلة في الجسم — الإشعار يرث تشغيلات بنود الأصل كالمرتجع المرتبط (والزائد «غير معروف»)، وبنوده في الرد تحمل lots. والإشعار القياسي (01) قبل اعتماده «محجوز»: يدخل رصيد السيارة ولا يُباع ولا يُنزَّل حتى يُعتمد، فإن رُفض أو سُحب خرج دون أن يصير شيء سالباً. والرفض برموز اللوط بالشكل {success:false, code, message, detail}، و503 LOT_BUSY حين يكون الصنف مشغولاً: أعد بنفس clientRef"
    ],
    "example": "{\"reason\":\"إرجاع عبوات تالفة عند الاستلام\",\"reasonCode\":\"DAMAGED\",\"returnToStock\":false,\"lines\":[{\"invoiceItemId\":\"5c6d7e8f-1111-4222-8333-444455556666\",\"qty\":3}],\"clientRef\":\"7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d\"}"
   },
   {
    "method": "POST",
    "path": "/invoices/:id/debit-note",
    "purpose": "إصدار إشعار مدين (383) لزيادة على فاتورة صدرت، مثل فرق سعر أو بند سقط",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم والعميل",
     "المرحلة الثانية فقط، وإلا 409",
     "X-FS-Caps: zatca2 إجباري"
    ],
    "query": [],
    "body": [
     {
      "name": "reason",
      "type": "string 3-1000",
      "required": true,
      "desc": "سبب الإشعار"
     },
     {
      "name": "lines",
      "type": "array (min 1)",
      "required": true,
      "desc": "بنود وصفية بلا أصناف"
     },
     {
      "name": "lines[].description",
      "type": "string 1-300",
      "required": true,
      "desc": "وصف البند"
     },
     {
      "name": "lines[].qty",
      "type": "number > 0",
      "required": true,
      "desc": "الكمية"
     },
     {
      "name": "lines[].unitPrice",
      "type": "number > 0",
      "required": true,
      "desc": "سعر الوحدة. يتبع pricesIncludeTax للأصل: شامل إذا كان الأصل شاملاً، وإلا صافٍ"
     },
     {
      "name": "lines[].taxPct",
      "type": "number 0-100",
      "required": true,
      "desc": "نسبة الضريبة، إجبارية صراحةً"
     },
     {
      "name": "lines[].vatCategory",
      "type": "string <=4 (S|Z|E|O)",
      "required": false,
      "desc": "فئة ضريبة زاتكا"
     },
     {
      "name": "lines[].vatExemptionCode",
      "type": "string <=16",
      "required": false,
      "desc": "رمز الإعفاء"
     },
     {
      "name": "lines[].vatExemptionReason",
      "type": "string <=300",
      "required": false,
      "desc": "سبب الإعفاء"
     },
     {
      "name": "clientRef",
      "type": "string uuid",
      "required": false,
      "desc": "مفتاح منع التكرار"
     },
     {
      "name": "clientCreatedAt",
      "type": "date-time string",
      "required": false,
      "desc": "لا ترسله إلا مع clientRef (وإلا 426)، ولطلب المفتاح لا يُخزَّن على الإشعار"
     }
    ],
    "response": "201 {success:true, data:{...صف الإشعار (type=CREDIT, documentKind=DEBIT_NOTE, number=INV-YYMM-######, remainingAmt=total), einvoice, original{...}}}. الأصل القياسي يمر بالاعتماد الحي: 201 أو 202 أو 422",
    "rules": [
     "لا خصم على الإشعار المدين، ولا يمس مخزون السيارة ولا مبيعات الأصناف",
     "الأثر: قيد فاتورة آجلة يرفع رصيد العميل بالإجمالي، ويصبح الإشعار مديونية قابلة للتحصيل",
     "يُنسب لمندوب الأصل",
     "شروط الأصل مثل الإشعار الدائن",
     "المرجع ،"
    ],
    "example": "{\"reason\":\"فرق سعر لم يحتسب في الفاتورة\",\"lines\":[{\"description\":\"فرق سعر كرتون مياه 330 مل\",\"qty\":10,\"unitPrice\":1.5,\"taxPct\":15}],\"clientRef\":\"9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a\"}"
   },
   {
    "method": "PATCH",
    "path": "/invoices/:id/restock",
    "purpose": "تحديد هل يعود مرتجع معيّن لمخزون سيارة المندوب",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [
     {
      "name": "returnToStock",
      "type": "boolean",
      "required": true,
      "desc": "true يعيد الكميات للمخزون، وfalse لا يعيدها"
     }
    ],
    "response": "{success:true, data:<صف الفاتورة المحدّث>}",
    "rules": [
     "للمستندات من نوع RETURN فقط، ويشمل الإشعار الدائن. غير ذلك يرجع 400",
     "يغيّر حساب مخزون السيارة فوراً ولا يمس القيود المالية",
     "«تتبّع اللوط»: true زيادةٌ تعود بها البضاعة إلى تشغيلاتها. أما false لمرتجعٍ فيه صنف متتبَّع فيُخرجها من السيارة، فيُرفض 409 {code:'LOT_STOCK_INSUFFICIENT', detail} إن كانت قد بيعت، و503 LOT_BUSY عند الانشغال أو تبدّل تتبّع الصنف أثناء الطلب"
    ],
    "example": "{\"returnToStock\":true}"
   },
   {
    "method": "POST",
    "path": "/invoices/:id/einvoice/withdraw",
    "purpose": "سحب فاتورة قياسية عالقة بانتظار الاعتماد، بشرط ثبوت أن الهيئة لم تستلمها",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم",
     "المرحلة الثانية، والنوع القياسي 01"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{id, number, status:'CANCELLED', einvoiceStatus:'withdrawn', proof}}",
    "rules": [
     "لا يحتاج جسماً",
     "أي رفض يرجع 409 ZATCA_WITHDRAW_NOT_ALLOWED مع reason، ومن الأسباب SIMPLIFIED_KEPT وNOT_CONFIRMED وMIRROR_NOT_VOIDABLE وSTATE_CHANGED",
     "الأثر: المستند WITHDRAWN، والفاتورة CANCELLED، والقيود تُعكس في معاملة واحدة"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/invoices/:id/einvoice/retry",
    "purpose": "إعادة إرسال مستند ضريبي محجوب للهيئة بعد إصلاح سببه",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "200 أو 202 {success:true, data:{id, documentId, documentStatus, einvoiceStatus, pending}}. الحالة 202 تعني أن الإرسال مستمر في الخلفية",
    "rules": [
     "لا يحتاج جسماً",
     "الرفض يرجع 409 ZATCA_RETRY_NOT_ALLOWED مع reason: NO_DOCUMENT أو DOCUMENT_FINAL أو IN_FLIGHT أو PAUSED أو NOT_RETRYABLE",
     "يُرسل البايتات نفسها، ولا يُنشئ مستنداً جديداً"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/invoices/:id/einvoice/reissue",
    "purpose": "إعادة إصدار مستند مبسّط رفضته الهيئة بنفس الرقم والتاريخ",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "X-FS-Caps: zatca2 إجباري، وإلا 426",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{id, attemptNo, documentStatus, einvoiceStatus, einvoiceQr, icv, uuid, reportDeadline, warnings}}",
    "rules": [
     "لا يحتاج جسماً",
     "المبسّط المرفوض فقط. القياسية المرفوضة أُبطلت تلقائياً وتحتاج فاتورة جديدة",
     "الرفض يرجع 409 ZATCA_REISSUE_NOT_ALLOWED، وأخطاء الإصدار قد ترجع 422 أو 503",
     "بعد النجاح اطبع einvoiceQr الجديد"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/einvoice/summary",
    "purpose": "عدادات مستندات زاتكا للشركة حسب الحالة، مع حالة إيقاف الإرسال",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices (موروث من موجّه الفواتير)",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{live, submitPausedAt, counts:{overdue, blocked, pending, rejected, done}, total, earliestDeadlineAt, at}}. الشركة غير المربوطة ترجع live:false وأصفاراً",
    "rules": [
     "overdue يعني مستنداً غير نهائي تجاوز مهلة الإبلاغ",
     "المرجع"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/einvoice/documents",
    "purpose": "قائمة مستندات زاتكا مصفّاة حسب الحالة مع آخر محاولة لكل فاتورة",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [
     {
      "name": "state",
      "type": "enum all | overdue | blocked | pending | rejected | done",
      "required": false,
      "desc": "الحالة، الافتراضي all"
     },
     {
      "name": "limit",
      "type": "integer 1-200",
      "required": false,
      "desc": "حجم الصفحة، الافتراضي 50 والحد الأقصى 200"
     },
     {
      "name": "offset",
      "type": "integer 0-5000",
      "required": false,
      "desc": "الإزاحة، الافتراضي 0 والحد الأقصى 5000"
     }
    ],
    "body": [],
    "response": "{success:true, data:{live, state, submitPausedAt, rows:[{invoiceId, number, invoiceDate, issuedAt, total, currency, invoiceStatus, documentKind, subtype, customerName, mirror, bucket, overdue, document:{id, attemptNo, icv, uuid, status, flow, httpStatus, attempts, sentAttempts, nextAttemptAt, firstSubmitAt, finalizedAt, reportDeadline, updatedAt, xml:{signed, cleared}}|null, lastMessage}], hasMore, limit, offset}}",
    "rules": [
     "الترقيم بـoffset وhasMore، ولا يوجد total",
     "overdue مرتب بأقرب مهلة، وغيره مرتب حسب issuedAt تنازلياً",
     "القيم خارج الحدود تُقص إلى الحد ولا ترجع خطأ"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/:id/einvoice/messages",
    "purpose": "رسائل الهيئة وسجل الطلبات لمستند فاتورة معيّنة",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{invoiceId, number, mirror, document:{id, attemptNo, icv, uuid, status, flow, subtype, httpStatus, attempts, sentAttempts, nextAttemptAt, firstSubmitAt, finalizedAt, reportDeadline, issueDate, issueTime, updatedAt, overdue, xml}, diagnostics, mirrorMessages, logs:[{at, endpoint, httpStatus, outcome, durationMs, error}] (حتى 10)}}",
    "rules": [
     "الفاتورة بلا مستند ضريبي ترجع 404 لا يوجد مستند ضريبي لهذه الفاتورة"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/invoices/:id/einvoice/xml",
    "purpose": "تنزيل ملف XML الموقّع أو المعتمد من الهيئة",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [
     {
      "name": "variant",
      "type": "enum signed | cleared",
      "required": false,
      "desc": "نسخة الملف. الافتراضي cleared إذا كانت معتمدة، وإلا signed"
     }
    ],
    "body": [],
    "response": "نص XML وليس JSON: Content-Type application/xml; charset=utf-8 وContent-Disposition attachment مع اسم ملف",
    "rules": [
     "النسخة غير المخزّنة ترجع 404، وغياب المستند يرجع 404"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/invoices/einvoice/submit-pause",
    "purpose": "إيقاف أو استئناف إرسال كل مستندات الشركة إلى الهيئة",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "الدور ADMIN فقط: مفتاح صادر من MANAGER أو ACCOUNTANT يرجع 403",
     "الشركة مربوطة بالمرحلة الثانية، وإلا 404"
    ],
    "query": [],
    "body": [
     {
      "name": "paused",
      "type": "boolean",
      "required": true,
      "desc": "true يوقف الإرسال، وfalse يستأنفه"
     }
    ],
    "response": "{success:true, data:{pausedAt}}",
    "rules": [
     "مهلة الإبلاغ (24 ساعة للمبسّطة) تستمر في السريان أثناء الإيقاف",
     "يُسجَّل أثر في zatca_api_logs بالقيمة endpoint=ui:submit-pause"
    ],
    "example": "{\"paused\":true}"
   },
   {
    "method": "GET",
    "path": "/invoices/:id/einvoice/share",
    "purpose": "رابط عام للمستند الضريبي لإرساله إلى المشتري",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "requireAdmin",
     "نطاق المستخدم"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{invoiceId, number, status, mirror, available, reason, token, url}}. المستند غير النهائي يرجع available:false وreason=NOT_FINAL",
    "rules": [
     "الرابط مشتق وثابت لنفس المستند، وصيغته https://fieldsa.net/e/<token>",
     "المستند غير الموجود يرجع 404"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "receipts",
  "title": "سندات القبض",
  "overview": "سند القبض يعني تحصيل مبلغ من عميل. يوزَّع المبلغ إلزامياً على فواتيره الآجلة المفتوحة، ويُقيَّد دائناً في كشف حسابه. كل مسارات /receipts تمر بحارسين على مستوى الموجّه. الأول requireAccounting، فإن كان النظام المحاسبي مطفأ صراحةً للشركة كان الرد 403 مع ACCOUNTING_NOT_ALLOWED. والثاني صلاحية canManageReceipts للمستخدم صاحب المفتاح، ويُرفض الطلب فقط إن كانت قيمتها false. ويُطبَّق نطاق المستخدم المقيَّد (scopeEnabled) على العملاء والمناديب. المفتاح المضبوط «قراءة فقط» يُرفض في POST وPATCH بـ403 مع API_KEY_FORBIDDEN. التسلسل المقترح للمبرمج: GET /invoices/open?customerId لمعرفة الفواتير القابلة للتحصيل، ثم POST /receipts، ثم GET /customers/:id/statement لقراءة كشف الحساب. السند يمس دفتر العميل وحده (جدول account_entries ورصيد العميل)، ولا يرحّل قيوداً إلى دفتر الأستاذ العام",
  "endpoints": [
   {
    "method": "GET",
    "path": "/receipts",
    "purpose": "قائمة سندات القبض النشطة مع فلترة بالمندوب والعميل والتاريخ وترقيم صفحات",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting (accountingEnabled != false)",
     "admin scope: scoped users see only receipts of in-scope customers and reps"
    ],
    "query": [
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "رقم الصفحة، يبدأ من 1 وهو الافتراضي. الصفر أو القيمة غير الرقمية يُعامَل كـ1، ولا يوجد فحص للقيمة السالبة"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة (الافتراضي 20، وأقصاه 200 لطلبات المفتاح). للسحب الكامل استعمل /api/v1/sync/receipts"
     },
     {
      "name": "salesRepId",
      "type": "string",
      "required": false,
      "desc": "قصر النتائج على سندات مندوب واحد"
     },
     {
      "name": "customerId",
      "type": "string",
      "required": false,
      "desc": "قصر النتائج على سندات عميل واحد"
     },
     {
      "name": "from",
      "type": "date string",
      "required": false,
      "desc": "من تاريخ السند receiptDate (أكبر من أو يساوي)، يُحلَّل بـ new Date"
     },
     {
      "name": "to",
      "type": "date string",
      "required": false,
      "desc": "إلى تاريخ السند، ويشمل اليوم كاملاً حتى 23:59:59.999 بتوقيت الخادم. يصح إرسال from أو to منفردين"
     }
    ],
    "body": [],
    "response": "{ success: true, data: [سند], pagination: { total, page, limit, pages } }. كل سند يحمل حقوله: id وnumber وcustomerId وsalesRepId وreceiptDate وamount وpaymentMethod (الأساس المحاسبي) وpaymentMethodKey (مفتاح طريقة الشركة المخصّصة أو null) وchequeNumber وbankName وnotes وstatus وclientRef وclientCreatedAt وcreatedAt وupdatedAt. ويُضاف إليها customer {id, name} وsalesRep {id, name}، وinvoiceItems وكل عنصر فيها {id, receiptId, invoiceId, amount, invoice: {number}}. المرفقات photos لا تأتي في القائمة",
    "rules": [
     "تُعرض السندات ACTIVE وحدها، والملغاة لا تظهر في القائمة أبداً ولا يوجد باراميتر status",
     "الترتيب حسب createdAt تنازلياً أي الأحدث أولاً، وليس حسب receiptDate",
     "التاريخ غير الصالح في from أو to لا يُتحقق منه، فيسقط الاستعلام غالباً بخطأ 500"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/receipts/collection-balance",
    "purpose": "رصيد التحصيل المتراكم لدى مندوب: مجموع سنداته النشطة ناقص ما سلّمه للإدارة",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting",
     "admin scope: rep must be in scope, else 404"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "معرّف المندوب، وغيابه يعطي 400 مع رسالة يجب تحديد المندوب"
     }
    ],
    "body": [],
    "response": "{ success: true, data: { enabled: true, collected, settled, outstanding } }. collected هو مجموع مبالغ سندات المندوب النشطة، وsettled مجموع ما سُجّل استلامه منه (repSettlement)، وoutstanding يساوي collected - settled. القيم مقرّبة",
    "rules": [
     "الرصيد لا يُصفَّر يومياً، وينقص فقط بتسجيل استلام من المندوب، وذلك خارج هذه المجموعة في /sales-reps",
     "علم showCollectionBalance يخص تطبيق المندوب فقط، ولا أثر له على طلب الإدارة أو المفتاح، فيعود enabled دائماً true",
     "للمستخدم المقيَّد النطاق: collected يحسب سندات عملائه في النطاق فقط، أما settled فيحسب كل التسويات",
     "للمستخدم غير المقيَّد: معرّف مندوب غير موجود لا يعطي 404، بل أصفاراً"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/receipts/:id",
    "purpose": "تفاصيل سند واحد مع العميل والفواتير المخصّصة والمرفقات",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting",
     "admin scope: out-of-scope receipt returns 404"
    ],
    "query": [],
    "body": [],
    "response": "{ success: true, data: سند }. يحمل السند كل حقوله، ومعها customer وهو صف العميل كاملاً، وsalesRep {id, name, phone}، وinvoiceItems وكل عنصر فيها {id, receiptId, invoiceId, amount, invoice} والفاتورة صف كامل، وphotos [{id, data}] مرتبة تصاعدياً و data فيها نص data URL بترميز base64",
    "rules": [
     "يعيد السند الملغى أيضاً، فتحقق من status أي ACTIVE أو CANCELLED",
     "السند غير الموجود أو الخارج عن النطاق يعطي 404 مع رسالة السند غير موجود",
     "المرفقات قد تكون كبيرة، حتى 8 صور لكل واحدة 2.5 مليون حرف"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/receipts",
    "purpose": "إصدار سند قبض من عميل، يوزَّع على فواتيره الآجلة ويُقيَّد في كشف حسابه",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting",
     "API key must not be readOnly",
     "admin scope: rep and customer must be in scope",
     "ZATCA phase 2: invoices not yet final at the authority cannot be collected (409 ZATCA_ALLOCATION_BLOCKED)"
    ],
    "query": [],
    "body": [
     {
      "name": "customerId",
      "type": "string",
      "required": false,
      "desc": "معرّف العميل. يلزم إرسال customerId أو customerClientRef، وإلا كان الرد 400"
     },
     {
      "name": "customerClientRef",
      "type": "string (uuid)",
      "required": false,
      "desc": "بديل للعميل: قيمة clientRef لعميل سبق إنشاؤه. إن أُرسل مع customerId تقدّم عليه، وإن لم يوجد عميل بهذه القيمة كان الرد 400"
     },
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "المندوب الذي يُنسب إليه التحصيل. الزود يعتبره اختيارياً، لكنه مطلوب فعلياً للمفتاح، فغيابه يعطي 400 مع رسالة يجب تحديد المندوب، والمندوب الخارج عن الشركة أو النطاق يعطي 404"
     },
     {
      "name": "teamId",
      "type": "string | null",
      "required": false,
      "desc": "ميزة «الفرق»: الفريق الذي يعمل له المندوب الآن، بترتيب POST /invoices نفسه ويُهمل إن كانت الفرق مطفأة: ١) إشراف صاحب المفتاح أولاً — إن أشرف على فريق فعّال يضمّ المندوب فيُقبل teamId من فرقه المُشرَف عليها وإلا أولها (والمشتركة المؤرشفة كلها ⇒ بلا فريق) ٢) وإلا فريق من فرق المندوب الفعّالة ٣) وإلا فريقه الوحيد ٤) وإلا بلا فريق — بلا رفض أبداً"
     },
     {
      "name": "receiptDate",
      "type": "string (ISO date-time)",
      "required": false,
      "desc": "تاريخ السند، والافتراضي الآن. يحدد بادئة الرقم RCP-YYMM وتاريخ القيد في كشف الحساب، والتاريخ الماضي مقبول"
     },
     {
      "name": "amount",
      "type": "number",
      "required": true,
      "desc": "مبلغ السند، رقم موجب أكبر من صفر (لا يُقبل نصاً). لا حد أقصى له، ويُنصح بخانتين عشريتين"
     },
     {
      "name": "paymentMethod",
      "type": "enum: CASH | BANK_TRANSFER | POS | CHEQUE | ONLINE",
      "required": false,
      "desc": "طريقة الدفع، والافتراضي CASH. وهي الأساس المحاسبي للسند: مع paymentMethodKey يُستبدل بالأساس المحفوظ لتلك الطريقة في إعداد الشركة. والطريقة التي عطّلتها الشركة تُرفض بـ422 PAYMENT_METHOD_DISABLED"
     },
     {
      "name": "paymentMethodKey",
      "type": "string (c_…) | null",
      "required": false,
      "desc": "مفتاح طريقة دفع أضافتها الشركة (مثل STC Pay)، يُقرأ من choices في GET /company/payment-methods. الخادم يكتب في paymentMethod الأساس المحفوظ للطريقة (CASH أو POS أو BANK_TRANSFER أو CHEQUE) أياً كانت القيمة المرسلة. مفتاح غير معروف ⇒ 422 PAYMENT_METHOD_UNKNOWN، وطريقة معطّلة ⇒ 422 PAYMENT_METHOD_DISABLED، ومع paymentMethod = ONLINE ⇒ 422 PAYMENT_METHOD_KEY_ONLINE. غيابه أو null = طريقة مدمجة كما كان"
     },
     {
      "name": "chequeNumber",
      "type": "string",
      "required": false,
      "desc": "رقم الشيك، ولا يُفرض حتى مع CHEQUE"
     },
     {
      "name": "bankName",
      "type": "string",
      "required": false,
      "desc": "اسم البنك"
     },
     {
      "name": "notes",
      "type": "string",
      "required": false,
      "desc": "ملاحظات"
     },
     {
      "name": "photos",
      "type": "string[]",
      "required": false,
      "desc": "مرفقات بصيغة data URL مثل data:image/jpeg;base64,... وحدها الأقصى 8 عناصر، وكل عنصر حتى 2,500,000 حرف، وجسم الطلب كله حتى 10MB"
     },
     {
      "name": "invoiceAllocations",
      "type": "array of object",
      "required": false,
      "desc": "توزيع يدوي على فواتير العميل. ما يبقى بلا توزيع يكمّله الخادم آلياً على أقدم الفواتير"
     },
     {
      "name": "invoiceAllocations[].invoiceId",
      "type": "string",
      "required": true,
      "desc": "معرّف فاتورة آجلة CREDIT مؤكدة CONFIRMED لنفس العميل. تكرار الفاتورة الواحدة يُجمع"
     },
     {
      "name": "invoiceAllocations[].amount",
      "type": "number",
      "required": true,
      "desc": "المبلغ المخصّص لهذه الفاتورة، موجب. مجموع التخصيصات يجب ألا يتجاوز amount"
     },
     {
      "name": "clientRef",
      "type": "string (uuid)",
      "required": false,
      "desc": "مفتاح منع التكرار: إعادة الإرسال بنفس القيمة تعيد السند القائم ولا تنشئ آخر"
     },
     {
      "name": "clientCreatedAt",
      "type": "string (ISO date-time)",
      "required": false,
      "desc": "لحظة الإنشاء على جهازك، ويُخزَّن للمرجعية فقط"
     }
    ],
    "response": "عند الإنشاء يكون الرد 201: { success: true, data: سند }. يحمل السند حقوله (id، وnumber مثل RCP-2610-000123، وamount، وstatus ACTIVE...) ومعها invoiceItems، وكل عنصر فيها {amount, invoice: {id, number}} أي التوزيع الفعلي المخزَّن. وعند الإعادة بنفس clientRef يكون الرد 200: { success: true, data: سند, idempotent: true }. المرفقات لا تعود في الرد",
    "rules": [
     "الترتيب في الكود: يُفحص clientRef أولاً قبل أي منطق آخر، فإن وُجد سند بنفس القيمة أُعيد كما هو بـ200 مع idempotent true، حتى لو اختلف الجسم أو كان السند ملغى، والسند الخارج عن النطاق يعطي 404",
     "وإن تزامن طلبان بنفس clientRef فخطأ P2002 يعيد السند القائم بـ200",
     "الترقيم: RCP-YYMM-NNNNNN منفصل لكل شركة، والشهر من receiptDate لا من وقت الرفع، والتسلسل يساوي أعلى رقم موجود زائد 1، مع إعادة محاولة حتى 3 مرات عند التصادم",
     "التوزيع إلزامي: إن تجاوز مجموع invoiceAllocations المبلغ amount بأكثر من 0.0005 كان الرد 400. وما يبقى بلا توزيع يكمّله الخادم على أقدم الفواتير حسب invoiceDate، بشرط أن تكون CONFIRMED وCREDIT ومتبقيها أكبر من 0.004، ومسموحاً تحصيلها لدى الهيئة. والفائض عن دين العميل يبقى رصيداً دائناً له",
     "الفواتير النقدية CASH لا تقبل التخصيص",
     "تخصيص فاتورة ليست لهذا العميل، أو غير CONFIRMED أو غير CREDIT، يرمي خطأً عاماً يعود 500 مع رسالة توجد فاتورة غير صالحة في التخصيص، وليس 400",
     "تخصيص مبلغ أكبر من متبقي الفاتورة: في فاتورة المرحلة الأولى أو غير ZATCA يعود 500 مع رسالة مبلغ التخصيص أكبر من المتبقي. وفي فاتورة المرحلة الثانية (zatcaPhase 2) يُقلَّم التخصيص إلى المتبقي، والفائض رصيد دائن للعميل ولا يُعاد توزيعه",
     "ZATCA المرحلة الثانية: الفاتورة التي حالتها einvoiceStatus واحدة من clearance_pending أو clearance_blocked أو rejected أو withdrawn تعطي 409 مع {success:false, code:'ZATCA_ALLOCATION_BLOCKED', message, data:{invoiceId}}",
     "الأثر داخل معاملة واحدة: إنشاء السند ومرفقاته، وروابط receipt_invoices، وتحديث paidAmt وremainingAmt لكل فاتورة مع قفل الصفوف، وقيد RECEIPT_CREDIT في كشف الحساب بالمبلغ كاملاً بتاريخ receiptDate، وخفض customer.balance وزيادة totalCollected",
     "بعد الالتزام تُلغى روابط الدفع الإلكتروني الحية (ميسر) على الفواتير المخصّصة، بأسلوب best-effort",
     "لا يُفحص status العميل (نشط أو موقوف)، وتكفي أن يكون في الشركة والنطاق. العميل غير الموجود يعطي 404، والخارج عن النطاق 403 مع رسالة هذا العميل غير مسند لك",
     "فشل التحقق بالزود يعطي 400 مع { success:false, message:'بيانات غير صحيحة ...', errors }. وإرسال amount نصاً يُرفض",
     "مفتاح API يرسل salesRepId دائماً: بدونه 400 «يجب تحديد المندوب»، ولمندوب خارج النطاق أو من شركة أخرى 404",
     "ترويسة X-FS-Replay خاصة بصندوق تطبيق المندوب وتُمحى من طلبات المفتاح، فرفض 422 لطريقة مجهولة أو معطّلة يسري على المفتاح دائماً",
     "paymentMethodKey في صف السند (وفي /v1/sync/receipts) هو المفتاح المخصّص أو null للطرق المدمجة، وpaymentMethod الأساس المحاسبي دائماً"
    ],
    "example": "{\"customerId\":\"5b0c7e2a-1f3d-4a9e-8c21-7d4f6a9b2e10\",\"salesRepId\":\"a8e4d1c9-3b7f-4f02-9a6e-0c5d2b8f7e31\",\"amount\":1150.00,\"paymentMethod\":\"BANK_TRANSFER\",\"bankName\":\"مصرف الراجحي\",\"receiptDate\":\"2026-10-11T09:30:00+03:00\",\"notes\":\"دفعة حساب أكتوبر\",\"invoiceAllocations\":[{\"invoiceId\":\"e3f9a2b4-6c1d-4e8f-b5a7-9d0c2e4f6a81\",\"amount\":1150.00}],\"clientRef\":\"3f1c2b9e-6a4d-4c1e-9b7a-2d5e8f0a1b2c\"}"
   },
   {
    "method": "PATCH",
    "path": "/receipts/:id/cancel",
    "purpose": "إلغاء سند قبض: إعادة المبالغ إلى الفواتير وعكس القيد في كشف الحساب",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting",
     "API key must not be readOnly",
     "admin scope: out-of-scope receipt returns 404"
    ],
    "query": [],
    "body": [],
    "response": "{ success: true, data: سند } بعد الإلغاء، وحالته status CANCELLED",
    "rules": [
     "لا يحتاج جسماً ولا سبباً",
     "السند غير الموجود يعطي 404، والملغى مسبقاً يعطي 400 مع رسالة السند ملغى مسبقا، وكذلك الطلبان المتزامنان يفوز أحدهما ويأخذ الآخر 400",
     "الأثر داخل معاملة: تتحول الحالة إلى CANCELLED، ويُعاد كل تخصيص إلى فاتورته (paidAmt ينقص وremainingAmt يزيد)، ويُضاف قيد RECEIPT_DEBIT مدين بالمبلغ كاملاً بتاريخ اليوم لا بتاريخ السند الأصلي، ويرتفع customer.balance وينقص totalCollected، ويُنشأ إشعار RECEIPT_CANCELLED",
     "روابط receipt_invoices لا تُحذف عند الإلغاء، والفاتورة المرتبطة بسند ولو ملغى لا يمكن إلغاؤها لاحقاً",
     "كشف الحساب يُبقي سطري الإصدار والإلغاء معاً، ولا يُحذف القيد الأصلي"
    ],
    "example": "{}"
   },
   {
    "method": "GET",
    "path": "/invoices/open",
    "purpose": "فواتير العميل الآجلة المفتوحة القابلة للتحصيل، لاستخدامها في invoiceAllocations قبل إصدار السند",
    "permission": "canManageReceipts",
    "gates": [
     "requireAccounting",
     "admin scope",
     "ZATCA phase 2: invoices not final at the authority are excluded"
    ],
    "query": [
     {
      "name": "customerId",
      "type": "string",
      "required": true,
      "desc": "معرّف العميل، وغيابه يعطي 400 مع رسالة معرف العميل مطلوب"
     }
    ],
    "body": [],
    "response": "{ success: true, data: [ { id, number, remainingAmt, invoiceDate } ] } مرتبة من الأقدم، وبحد أقصى 200 فاتورة، وبلا ترقيم صفحات",
    "rules": [
     "الشرط هو نفسه الذي يستعمله POST /receipts في التكملة الآلية: CONFIRMED وCREDIT ومتبقيها أكبر من 0.004، ومسموح تحصيلها لدى الهيئة",
     "العميل الخارج عن النطاق يعطي 403 مع رسالة لا تملك صلاحية الوصول لهذا العميل",
     "المسار في موجّه /invoices، لكن بوابته canManageReceipts لا canManageInvoices"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/customers/:id/statement",
    "purpose": "كشف حساب العميل: حركات الفواتير والسندات مع رصيد جارٍ ورصيد مرحّل للفترة",
    "permission": "canManageCustomers",
    "gates": [
     "admin scope: out-of-scope customer returns 404",
     "no requireAccounting gate on this router"
    ],
    "query": [
     {
      "name": "from",
      "type": "date string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية الفترة. بصيغة YYYY-MM-DD تُحسب الحدود بتوقيت الشركة إن كان مضبوطاً، وإلا بمنتصف ليل UTC. إرساله يحسب openingBalance من الحركات السابقة"
     },
     {
      "name": "to",
      "type": "date string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية الفترة شاملة يومها كاملاً. يصح إرسال طرف واحد فقط، وبدون طرفين يعود كل التاريخ"
     }
    ],
    "body": [],
    "response": "{ success: true, data: { customer, entries, openingBalance, closingBalance, timezone } }. customer صف العميل كاملاً. وentries قيود account_entries، وكل قيد {id, type, debit, credit, balance, description, entryDate, invoiceId, receiptId, createdAt, invoice, receipt}، والفاتورة فيها بنودها مع product {name, unit}. وتكون type واحدة من INVOICE_DEBIT أو INVOICE_CREDIT أو RECEIPT_CREDIT أو RECEIPT_DEBIT أو ADJUSTMENT_DEBIT أو ADJUSTMENT_CREDIT. وtimezone نص أو null",
    "rules": [
     "الرصيد balance في كل سطر مشتق بالترتيب المعروض: المرحّل زائد المدين ناقص الدائن، وليس القيمة المخزّنة",
     "الترتيب حسب entryDate ثم createdAt ثم debit تنازلياً ثم id، فالفاتورة النقدية تظهر قبل سدادها",
     "الصيغة غير YYYY-MM-DD تُعامل بالسلوك القديم: new Date للبداية، ونهاية اليوم بتوقيت الخادم للنهاية",
     "لا ترقيم صفحات، فكل حركات الفترة تعود دفعة واحدة",
     "الصلاحية المطلوبة canManageCustomers لا canManageReceipts",
     "بنود الفواتير في الكشف بلقطة وحدة كل بند: qty بوحدته وunitName (null = وحدة الأساس، فاعرض product.unit) وunitFactor وbaseQty. والأرصدة من القيود بالمبالغ فلا تمسّها الوحدة"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "sales-reps",
  "title": "المناديب والتحصيل",
  "overview": "إدارة مناديب الشركة من إنشاء وتعديل صلاحيات وحذف، وإحصاءاتهم، وإسناد العملاء لكل مندوب مع مفتاح عزل العملاء، ورصيد التحصيل المتراكم لدى المندوب وتسجيل استلامه منه (التسويات). كل مسارات هذه المجموعة تحت /api/sales-reps ومحروسة على مستوى الموجّه بـ authenticate ثم requireAdmin (ADMIN أو MANAGER أو ACCOUNTANT) ثم requireAdminPermission('canManageSalesReps'). المفتاح يعمل بهوية مستخدم الشركة الذي أصدره، فإن كان حسابه مقيّد النطاق (scopeEnabled) لا يرى إلا مناديبه المُسنَدين ويرد 404 لغيرهم. المفتاح «قراءة فقط» يمرّ بطلبات GET وحدها. لا توجد في هذا الملف بوابة النظام المحاسبي (requireAccounting) ولا أعلام اشتراك أخرى. أخطاء التحقق من zod ترجع 400 بالشكل {success:false, message, errors:{field:[...]}}، وأي خطأ غير معالج يرجع 500 برسالته. حدّ المفتاح 120 طلباً في الدقيقة مع رؤوس X-RateLimit-*",
  "endpoints": [
   {
    "method": "GET",
    "path": "/sales-reps",
    "purpose": "قائمة المناديب مع بحث وترقيم صفحات",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin: ADMIN|MANAGER|ACCOUNTANT",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter: صاحب المفتاح المقيّد يرى مناديبه المسندين فقط"
    ],
    "query": [
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "رقم الصفحة يبدأ من 1 والافتراضي 1"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة (الافتراضي 20). لطلب المفتاح تُقصّ القيمة فوق 200 أو غير الرقمية إلى 200، والقيمة 0 تعود إلى 20"
     },
     {
      "name": "search",
      "type": "string",
      "required": false,
      "desc": "بحث جزئي في الاسم أو الجوال أو اسم المستخدم، حساس لحالة الأحرف اللاتينية"
     }
    ],
    "body": [],
    "response": "{success:true, data:[مندوب], pagination:{total, page, limit, pages}} مرتبة بالاسم تصاعدياً. حقول المندوب: id, name, phone, email, username, isActive, canCreateInvoice, canSellOnCredit, canSellOnInstallment, canSellInCash, canEditInvoice, canDeleteInvoice, canCancelInvoice, canChangePrice, maxDiscountPct, canSellBelowPrice, canCreateReceipt, canEditReceipt, canCancelReceipt, canManageVanStock, canAddCustomer, canEditCustomer, canViewStatement, showCollectionBalance, requireCustomerProximity, requireLocationOn, requirePunchAtCustomer, proximityRadiusM, punchRadiusM, punchOutsideAction, requireBoundDevice, boundDeviceName, boundDeviceAt, requirePresenceCheck, showRouteOnMap, shiftStart, shiftEnd, shiftDays, locationId, createdAt",
    "rules": [
     "لا تُعاد كلمة المرور ولا حقول التتبع والموقع ولا canSellWithoutStock ولا canBeTracked",
     "pages = ceil(total/limit) من utils/helpers.ts",
     "لطلب المفتاح سقف الصفحة 200 صف. للسحب الكامل استعمل /v1/sync/sales-reps",
     "locationId موقع المندوب الحالي في ميزة «لوكيشن» (أو null) للقراءة وحدها — الإسناد من PUT /locations/reps/:salesRepId، واسم الموقع من GET /locations"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/sales-reps/:id",
    "purpose": "بيانات مندوب واحد بصلاحياته",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{نفس حقول عنصر القائمة}} أو 404 {success:false, message:'المندوب غير موجود'} إذا لم يكن في الشركة أو خارج نطاق صاحب المفتاح",
    "rules": [
     "المعرّف UUID",
     "حقول المندوب نفسها كما في القائمة، ومنها locationId وحقول البصمة والدوام"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/sales-reps",
    "purpose": "إنشاء مندوب جديد بحساب دخول لتطبيق المندوب وصلاحياته",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "مفتاح غير قراءة فقط",
     "حد المناديب للشركة maxSalesReps"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": true,
      "desc": "اسم المندوب، حرف واحد على الأقل"
     },
     {
      "name": "phone",
      "type": "string",
      "required": true,
      "desc": "الجوال 9 أحرف على الأقل بلا فحص صيغة، فريد داخل الشركة"
     },
     {
      "name": "email",
      "type": "string(email)",
      "required": false,
      "desc": "بريد صحيح أو نص فارغ أو null وكلاهما يُخزَّن null، فريد داخل الشركة"
     },
     {
      "name": "username",
      "type": "string",
      "required": true,
      "desc": "اسم الدخول 4 أحرف على الأقل، فريد على مستوى المنصة كلها لا الشركة فقط"
     },
     {
      "name": "password",
      "type": "string",
      "required": true,
      "desc": "كلمة مرور الدخول 8 أحرف على الأقل، غيابها 400 'كلمة المرور مطلوبة'"
     },
     {
      "name": "isActive",
      "type": "boolean",
      "required": false,
      "desc": "تفعيل الحساب والافتراضي true"
     },
     {
      "name": "canCreateInvoice",
      "type": "boolean",
      "required": false,
      "desc": "إصدار فواتير، الافتراضي true"
     },
     {
      "name": "canSellOnCredit",
      "type": "boolean",
      "required": false,
      "desc": "البيع الآجل، الافتراضي true"
     },
     {
      "name": "canSellOnInstallment",
      "type": "boolean",
      "required": false,
      "desc": "البيع بالتقسيط، الافتراضي false"
     },
     {
      "name": "canSellInCash",
      "type": "boolean",
      "required": false,
      "desc": "البيع النقدي، الافتراضي true"
     },
     {
      "name": "canEditInvoice",
      "type": "boolean",
      "required": false,
      "desc": "تعديل الفاتورة، الافتراضي false"
     },
     {
      "name": "canDeleteInvoice",
      "type": "boolean",
      "required": false,
      "desc": "حذف الفاتورة، الافتراضي false"
     },
     {
      "name": "canCancelInvoice",
      "type": "boolean",
      "required": false,
      "desc": "إلغاء الفاتورة، الافتراضي false"
     },
     {
      "name": "canChangePrice",
      "type": "boolean",
      "required": false,
      "desc": "تغيير سعر الصنف، الافتراضي false"
     },
     {
      "name": "maxDiscountPct",
      "type": "number",
      "required": false,
      "desc": "أقصى نسبة خصم من 0 إلى 100، الافتراضي 0"
     },
     {
      "name": "canSellBelowPrice",
      "type": "boolean",
      "required": false,
      "desc": "البيع بأقل من السعر، الافتراضي false"
     },
     {
      "name": "canCreateReceipt",
      "type": "boolean",
      "required": false,
      "desc": "إصدار سندات قبض، الافتراضي true"
     },
     {
      "name": "canEditReceipt",
      "type": "boolean",
      "required": false,
      "desc": "تعديل السند، الافتراضي false"
     },
     {
      "name": "canCancelReceipt",
      "type": "boolean",
      "required": false,
      "desc": "إلغاء السند، الافتراضي false"
     },
     {
      "name": "canManageVanStock",
      "type": "boolean",
      "required": false,
      "desc": "إدارة مخزون السيارة، الافتراضي true"
     },
     {
      "name": "canAddCustomer",
      "type": "boolean",
      "required": false,
      "desc": "إضافة عميل، الافتراضي false"
     },
     {
      "name": "canEditCustomer",
      "type": "boolean",
      "required": false,
      "desc": "تعديل عميل، الافتراضي false"
     },
     {
      "name": "canViewStatement",
      "type": "boolean",
      "required": false,
      "desc": "عرض كشف حساب العميل، الافتراضي true"
     },
     {
      "name": "showCollectionBalance",
      "type": "boolean",
      "required": false,
      "desc": "إظهار رصيد التحصيل المتراكم على شاشة المندوب، الافتراضي true"
     },
     {
      "name": "requireCustomerProximity",
      "type": "boolean",
      "required": false,
      "desc": "قيد تقييدي: لا يفتح ملف العميل إلا داخل proximityRadiusM متراً من موقعه المسجل، الافتراضي false"
     },
     {
      "name": "requireLocationOn",
      "type": "boolean",
      "required": false,
      "desc": "قيد تقييدي: اشتراط تفعيل الموقع في جوال المندوب، الافتراضي false"
     },
     {
      "name": "requirePunchAtCustomer",
      "type": "boolean",
      "required": false,
      "desc": "قيد تقييدي: لا يبصم المندوب حضوراً ولا انصرافاً إلا داخل punchRadiusM متراً من موقع أحد عملائه، الافتراضي false"
     },
     {
      "name": "proximityRadiusM",
      "type": "integer",
      "required": false,
      "desc": "مسافة قيد «البيع داخل نطاق العميل» بالأمتار، عدد صحيح من 10 إلى 5000، الافتراضي 50"
     },
     {
      "name": "punchRadiusM",
      "type": "integer",
      "required": false,
      "desc": "مسافة قيد «بصمة الحضور بموقع عميل» بالأمتار، عدد صحيح من 10 إلى 5000، الافتراضي 50"
     },
     {
      "name": "shiftDays",
      "type": "integer 0-127",
      "required": false,
      "desc": "أيام العمل بتات: الأحد = 1، الاثنين = 2، … السبت = 64 (مثال: الأحد إلى الخميس = 31)"
     },
     {
      "name": "shiftEnd",
      "type": "string \"HH:MM\" | null",
      "required": false,
      "desc": "نهاية الدوام لتنبيه «نسيت الانصراف»"
     },
     {
      "name": "shiftStart",
      "type": "string \"HH:MM\" | null",
      "required": false,
      "desc": "بداية الدوام لتنبيهات الحضور (24 ساعة)"
     },
     {
      "name": "showRouteOnMap",
      "type": "boolean",
      "required": false,
      "desc": "عرض خط سير المندوب على الخريطة (GET /tracking/route). false يُخفيه ويبقى التسجيل"
     },
     {
      "name": "requirePresenceCheck",
      "type": "boolean",
      "required": false,
      "desc": "التحقق العشوائي من التواجد أثناء الدوام"
     },
     {
      "name": "requireBoundDevice",
      "type": "boolean",
      "required": false,
      "desc": "ربط البصمة بجهاز واحد: أول جهاز يبصم يُربط. وإرسال false يفكّ الجهاز المربوط أيضاً (ويُدوَّن في سجل الحضور)"
     },
     {
      "name": "punchOutsideAction",
      "type": "enum REJECT | FLAG",
      "required": false,
      "desc": "بصمة خارج نطاق العميل حين يكون requirePunchAtCustomer مفعّلاً: REJECT ترفضها، وFLAG تقبلها موسومة «خارج النطاق» في التقرير"
     }
    ],
    "response": "201 {success:true, data:{id, name, phone, username, isActive}}",
    "rules": [
     "بلوغ حد maxSalesReps للشركة يرجع 403 برسالة الحد",
     "التكرار يرجع 409: اسم المستخدم عالمياً ثم الجوال ثم البريد داخل الشركة",
     "كلمة مرور أقل من 8 أحرف ترجع 400",
     "الحقول غير المعرّفة في المخطط تُتجاهل بصمت، فلا يمكن ضبط canSellWithoutStock أو canBeTracked من هنا",
     "الافتراضات من prisma/schema.prisma model SalesRep",
     "locationId لا يُقبل هنا: إسناد الموقع من PUT /locations/reps/:salesRepId وحده"
    ],
    "example": "{\"name\":\"خالد العتيبي\",\"phone\":\"0551234567\",\"email\":\"khalid@example.com\",\"username\":\"khalid.rep\",\"password\":\"Rep2026secure\",\"canSellOnCredit\":true,\"maxDiscountPct\":5,\"canAddCustomer\":true}"
   },
   {
    "method": "PUT",
    "path": "/sales-reps/:id",
    "purpose": "تعديل بيانات المندوب أو صلاحياته أو كلمة مروره أو تعطيله",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter",
     "مفتاح غير قراءة فقط"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": false,
      "desc": "حرف واحد على الأقل إن أُرسل"
     },
     {
      "name": "phone",
      "type": "string",
      "required": false,
      "desc": "9 أحرف على الأقل إن أُرسل"
     },
     {
      "name": "email",
      "type": "string(email)",
      "required": false,
      "desc": "تنبيه: غيابه من الجسم يمسح البريد المخزَّن ويجعله null، فأرسل البريد الحالي دائماً"
     },
     {
      "name": "username",
      "type": "string",
      "required": false,
      "desc": "4 أحرف على الأقل وفريد عالمياً"
     },
     {
      "name": "password",
      "type": "string",
      "required": false,
      "desc": "كلمة مرور جديدة 8 أحرف على الأقل، والنص الفارغ يُتجاهل"
     },
     {
      "name": "isActive",
      "type": "boolean",
      "required": false,
      "desc": "false يعطّل المندوب ويحفظ تاريخه وعهدته، وهو البديل المقترح للحذف"
     },
     {
      "name": "canCreateInvoice ... shiftDays",
      "type": "boolean / number",
      "required": false,
      "desc": "نفس حقول POST وكلها اختيارية: الصلاحيات، وmaxDiscountPct من 0 إلى 100، وproximityRadiusM وpunchRadiusM أعداد صحيحة من 10 إلى 5000، وpunchOutsideAction وrequireBoundDevice وrequirePresenceCheck وshowRouteOnMap وshiftStart وshiftEnd وshiftDays"
     }
    ],
    "response": "{success:true, data:{id, name, phone, username, isActive}} أو 404 'المندوب غير موجود'",
    "rules": [
     "تحديث جزئي (repSchema.partial) لكن email يُكتب دائماً: rest.email || null",
     "فحص التكرار يجري فقط إذا أُرسل username أو phone أو email ويرجع 409",
     "password أقل من 8 أحرف يرجع 400",
     "requireBoundDevice = false يفكّ الجهاز المربوط في الكتابة نفسها، وlocationId لا يُقبل هنا (PUT /locations/reps/:salesRepId)"
    ],
    "example": "{\"email\":\"khalid@example.com\",\"maxDiscountPct\":10,\"canCancelInvoice\":true,\"isActive\":true}"
   },
   {
    "method": "POST",
    "path": "/sales-reps/:id/unbind-device",
    "purpose": "فكّ ربط جهاز البصمة عن المندوب (غيّر جواله أو مسح بيانات التطبيق) — أول بصمة بعده تربط جهازه الجديد",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageSalesReps')",
     "نطاق المستخدم adminRepFilter",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{unbound:true}} إذا كان مربوطاً ففُكّ، أو {unbound:false} إذا لم يكن مربوطاً أصلاً. مندوب غير موجود أو خارج النطاق 404",
    "rules": [
     "بلا جسم",
     "يُدوَّن في سجل تدقيق الحضور (UNBIND_DEVICE) باسم صاحب المفتاح والجهاز الذي كان مربوطاً",
     "معرّف الجهاز نفسه لا يُعاد في أي رد ولا في المزامنة"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/sales-reps/:id/stats",
    "purpose": "إحصاءات مبيعات وتحصيل المندوب في فترة",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps"
    ],
    "query": [
     {
      "name": "from",
      "type": "date YYYY-MM-DD",
      "required": false,
      "desc": "بداية الفترة شاملة"
     },
     {
      "name": "to",
      "type": "date YYYY-MM-DD",
      "required": false,
      "desc": "نهاية الفترة وتشمل اليوم كاملاً حتى 23:59:59.999 بتوقيت الخادم، ويكفي طرف واحد"
     }
    ],
    "body": [],
    "response": "{success:true, data:{invoicesCount, salesTotal, receiptsCount, collectionsTotal}}",
    "rules": [
     "الفواتير بحالة CONFIRMED حسب invoiceDate ومجموع total، والسندات بحالة ACTIVE حسب receiptDate ومجموع amount",
     "لا فلتر على نوع الفاتورة فتدخل فواتير المرتجع RETURN في العدد والمجموع",
     "لا يتحقق من وجود المندوب ولا من نطاق المستخدم: معرّف مجهول يرجع أصفاراً",
     "تاريخ غير صالح يُفشل الطلب بخطأ خادم"
    ],
    "example": ""
   },
   {
    "method": "DELETE",
    "path": "/sales-reps/:id",
    "purpose": "حذف مندوب نهائياً مع إبقاء سجلاته المالية بلا مرجع له",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps (لا يشترط المدير الرئيسي)",
     "نطاق المستخدم adminRepFilter",
     "مفتاح غير قراءة فقط",
     "حارس الدفاتر إذا فُعّل النظام المحاسبي المتكامل"
    ],
    "query": [],
    "body": [],
    "response": "{success:true} أو 404 'المندوب غير موجود' أو 409 {success:false, code:'LEDGER_HISTORY_LOCKED', message, salesRepId, footprint:{settlements, invoices, receipts, vanLoads, moveLines}}",
    "rules": [
     "معاملة واحدة لا رجعة فيها: الفواتير والسندات والإقرارات اليومية تبقى ويُفرَّغ salesRepId منها، وتحميلات السيارة تبقى مع deletedSalesRepId",
     "تُحذف: المواقع والزيارات وصورها والإشعارات وتوجيه الإقرار اليومي وإسنادات العملاء واستلامات التحصيل (RepSettlement) ويُزال من قائمة المندوب الذكي",
     "حذف استلامات التحصيل يُنقص ما احتُسب في عهدة مستخدمي الشركة الذين استلموها (userCustody يجمع repSettlement)",
     "إذا كانت الدفاتر مفعّلة (glSettings.activatedAt) وللمندوب أثر مالي يُرفض بـ 409، وفي وضع الدفاتر اليدوية CLEAN لا يمنع إلا سطور القيود",
     "البديل الآمن PUT بـ isActive:false"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/sales-reps/settings/isolation",
    "purpose": "حالة مفتاح عزل عملاء المناديب للشركة",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{enabled:boolean}} و false إذا لم توجد إعدادات",
    "rules": [
     "إعداد على مستوى الشركة كلها لا المستخدم"
    ],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/sales-reps/settings/isolation",
    "purpose": "تشغيل أو إيقاف عزل عملاء المناديب",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "مفتاح غير قراءة فقط"
    ],
    "query": [],
    "body": [
     {
      "name": "enabled",
      "type": "boolean",
      "required": true,
      "desc": "true يقصر كل مندوب على عملائه المسندين، و false يعيد رؤية كل العملاء لكل المناديب"
     }
    ],
    "response": "{success:true, data:{enabled}}",
    "rules": [
     "الإيقاف لا يحذف الإسنادات بل تبقى محفوظة",
     "يكتب companySettings.customerIsolationEnabled للشركة كلها"
    ],
    "example": "{\"enabled\":true}"
   },
   {
    "method": "GET",
    "path": "/sales-reps/:id/customers",
    "purpose": "العملاء المسندون لمندوب",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{customerIds:[id], autoIds:[id], customers:[{id, name, businessName, phone, code}]}}",
    "rules": [
     "autoIds هي الإسنادات التي نشأت بإضافة المندوب للعميل بنفسه (source AUTO) والباقي MANUAL من الإدارة",
     "مرتبة بالأحدث إسناداً ولا ترقيم صفحات"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/sales-reps/:id/customers",
    "purpose": "إضافة وإزالة عملاء من إسناد المندوب بالفروقات",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter على المندوب و adminCustomerFilter على العملاء المضافين",
     "مفتاح غير قراءة فقط"
    ],
    "query": [],
    "body": [
     {
      "name": "add",
      "type": "string[]",
      "required": false,
      "desc": "معرّفات عملاء للإسناد، حتى 50000"
     },
     {
      "name": "remove",
      "type": "string[]",
      "required": false,
      "desc": "معرّفات عملاء لإلغاء إسنادهم، حتى 50000"
     }
    ],
    "response": "{success:true, data:{added, removed, total}} و total عدد إسنادات المندوب بعد التعديل",
    "rules": [
     "ليست استبدالاً كاملاً: ما لم يُذكر يبقى كما هو",
     "المعرّف الموجود في القائمتين يُزال ولا يُضاف",
     "المعرّفات خارج الشركة أو خارج نطاق صاحب المفتاح تُتجاهل بصمت",
     "الإسناد الجديد بمصدر MANUAL والمكرر يُتخطى",
     "added عدد المعرّفات الصالحة المطلوبة ولو كانت مسندة سلفاً، و removed عدد المعرّفات المطلوب إزالتها لا المحذوف فعلاً",
     "الإسناد لا يؤثر على رؤية المندوب إلا إذا كان مفتاح العزل مفعّلاً"
    ],
    "example": "{\"add\":[\"3f1c2a9e-1b2c-4d5e-8f90-1234567890ab\"],\"remove\":[\"9a8b7c6d-5e4f-4a3b-9c2d-0987654321fe\"]}"
   },
   {
    "method": "GET",
    "path": "/sales-reps/:id/collection",
    "purpose": "رصيد التحصيل المتراكم لدى المندوب",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{collected, settled, outstanding}}",
    "rules": [
     "collected مجموع كل سندات القبض النشطة ACTIVE للمندوب منذ البداية وبكل طرق الدفع",
     "settled مجموع الاستلامات المسجلة منه، و outstanding = collected - settled",
     "القيم مقرّبة إلى 6 منازل عشرية (clean)"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/sales-reps/:id/settlements",
    "purpose": "تسجيل استلام مبلغ تحصيل من المندوب فينقص رصيده",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter",
     "مفتاح غير قراءة فقط"
    ],
    "query": [],
    "body": [
     {
      "name": "amount",
      "type": "number",
      "required": true,
      "desc": "المبلغ المستلم أكبر من صفر، ويقبل نصاً رقمياً"
     },
     {
      "name": "method",
      "type": "enum CASH|BANK_TRANSFER|POS|CHEQUE",
      "required": false,
      "desc": "طريقة الاستلام والافتراضي CASH، وأي قيمة أخرى تتحول إلى CASH بصمت"
     },
     {
      "name": "note",
      "type": "string",
      "required": false,
      "desc": "ملاحظة تُقص إلى 300 حرف"
     },
     {
      "name": "photos",
      "type": "string[]",
      "required": false,
      "desc": "صور الإيصال بصيغة data URL مثل data:image/jpeg;base64,...، حتى 4 وكل صورة حتى 2500000 حرف، والزائد يُسقط بصمت"
     }
    ],
    "response": "201 {success:true, data:{collected, settled, outstanding}} بعد التسجيل",
    "rules": [
     "لا تحقق من zod هنا بل فحص يدوي: مبلغ غير صالح يرجع 400 'أدخل مبلغا صحيحا أكبر من صفر'",
     "لا سقف مقابل الرصيد المتبقي فقد يصير outstanding سالباً",
     "settledAt وقت الطلب ولا يمكن تأريخه بتاريخ سابق",
     "المبلغ يدخل عهدة صاحب المفتاح (receivedByUserId) ويُسجل createdBy باسمه، وتوريد العهدة يتم من مسارات /company-users الممنوعة على المفتاح فيلزم إجراؤه من اللوحة",
     "حجم جسم الطلب حتى 10mb"
    ],
    "example": "{\"amount\":1500,\"method\":\"CASH\",\"note\":\"تسليم تحصيل يوم الأحد\"}"
   },
   {
    "method": "GET",
    "path": "/sales-reps/:id/settlements",
    "purpose": "سجل استلامات التحصيل من المندوب",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "نطاق المستخدم adminRepFilter"
    ],
    "query": [
     {
      "name": "from",
      "type": "date YYYY-MM-DD",
      "required": false,
      "desc": "بداية فترة settledAt شاملة، والقيمة غير الصالحة تُتجاهل"
     },
     {
      "name": "to",
      "type": "date YYYY-MM-DD",
      "required": false,
      "desc": "نهاية الفترة شاملة اليوم كاملاً بتوقيت الخادم، والقيمة غير الصالحة تُتجاهل"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, salesRepId, amount, method, note, createdBy, receivedByUserId, settledAt, createdAt, photos:[{id, data}]}]}",
    "rules": [
     "أحدث 100 استلام فقط مرتبة بـ settledAt تنازلياً بلا ترقيم صفحات، فاستخدم from و to للوصول لما قبلها",
     "الصور تعود كاملة بصيغة base64 فقد تكون الاستجابة كبيرة"
    ],
    "example": ""
   },
   {
    "method": "DELETE",
    "path": "/sales-reps/:id/settlements/:settlementId",
    "purpose": "حذف استلام تحصيل مسجل خطأ فيعود المبلغ مطلوباً من المندوب",
    "permission": "canManageSalesReps + المدير الرئيسي",
    "gates": [
     "requireAdmin",
     "canManageSalesReps",
     "صاحب المفتاح دوره الحالي في القاعدة ADMIN وفعّال وفي الشركة نفسها، وإلا 403",
     "نطاق المستخدم adminRepFilter",
     "مفتاح غير قراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{collected, settled, outstanding}} بعد الحذف",
    "rules": [
     "MANAGER و ACCOUNTANT يرجعان 403 'حذف استلام التحصيل متاح للأدمن الرئيسي فقط'",
     "404 إذا لم يوجد المندوب أو لم يكن الاستلام لهذا المندوب في هذه الشركة",
     "حارس العهدة: إذا ورّد المستلم من عهدته ما يجعلها سالبة بعد الحذف يرجع 400 ويلزم حذف التوريد أولاً من صفحة مستخدمي الشركة",
     "يُنشأ إشعار REP_SETTLEMENT_DELETED بالمبلغ والتاريخ ومن حذف مع نسخة كاملة من الصف في data",
     "إذا فُعّلت الدفاتر يُسجل حدثا SETTLEMENT POST و REVERSE في glSourceEvent ضمن المعاملة نفسها"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "stock",
  "title": "مخزون السيارات ومخزون الشركة",
  "overview": "وحدتان مترابطتان. الأولى مخزون سيارات المناديب (/van-stock)، ورصيده لا يُخزَّن بل يُحسب في كل طلب: التحميل − التنزيل + التسوية − المبيع + المرتجع العائد للمخزون. والثانية مستودع الشركة المركزي (/warehouse)، ورصيده محسوب أيضاً: الوارد + تسويات المستودع + العائد من السيارات − المحمَّل للسيارات، مع تقييم بتكلفة الشراء الصافية قبل الضريبة. لذلك فتحميل سيارة عبر POST /van-stock/loads ينقص المستودع تلقائياً، وتنزيلها يعيد الكمية إليه.\nالحراس على كل مسارات /van-stock: يجب ألا يكون النظام المحاسبي مطفأً (accountingEnabled، والرفض 403 برمز ACCOUNTING_NOT_ALLOWED)، ويجب أن يملك صاحب المفتاح صلاحية canManageVanStock (والرفض 403). ويُطبَّق كذلك نطاق المناديب المحدد لصاحب المفتاح إن كان مقيَّداً.\nمسارات /warehouse تشترط الشيئين نفسيهما وتفعيل ميزة مخزون الشركة (warehouseEnabled، وهي مطفأة افتراضياً)، بهذا الترتيب: صلاحية canManageVanStock أولاً (403 بلا code، فيأتي ولو كان النظام المحاسبي مطفأً)، ثم النظام المحاسبي (403 ACCOUNTING_NOT_ALLOWED)، ثم عَلَم المستودع (403 بلا code برسالة «ميزة مخزون الشركة غير مفعلة لهذه الشركة»).\nالمفتاح المضبوط على «قراءة فقط» لا يمرّ إلا بطلبات GET.\nلكل قائمة في هذه المجموعة سقف ثابت: سجل المستودع آخر 100 حركة، وسجل التحميلات آخر 100 حركة ما لم تُرسل page فيُرقَّم بحدّ 200. للتاريخ الكامل استعمل مسارات المزامنة /v1/sync/van-loads و/v1/sync/warehouse-entries.\nلا يوجد مسار لتعديل الحركات أو حذفها، والتصحيح يكون بحركة معاكسة أو بتسوية. ولا يوجد clientRef، فإعادة إرسال طلب الكتابة تُنشئ حركة مكررة.\nطلبات البضاعة (/rep-stock-requests): المندوب الذي لا يملك صلاحية التحميل يرفع من تطبيقه ما يحتاجه، فيظهر للإدارة في «طلب مخزون» بصفحة مخزون الشركة. بمفتاح الشركة تقرأ المعلّقة وتعدّل الكميات المعتمدة وترسل الطلب العام أو ترفض. الطلب لا يمسّ أي رصيد، وكل كتابة ترسل نسخة الطلب updatedAt كما قرأتها (409 إن تغيّر). وحراسها بالترتيب: النظام المحاسبي (403 ACCOUNTING_NOT_ALLOWED) ثم canManageVanStock ثم العَلَم (403 WAREHOUSE_NOT_ENABLED).\nالحد 120 طلباً في الدقيقة لكل مفتاح، ويظهر في رؤوس X-RateLimit-*\nالوحدات المتعددة: كل رصيد وكمية مجمّعة في هذه المجموعة بوحدة الأساس للصنف (unit، أصغر ما يُباع): remaining وloaded وsold في السيارة، وonHand وreceived في المستودع، وأرقام الاقتراح والدقة، ومجاميع الملخّصات عبر الأصناف (حبّات لا كراتين). وتُرفق units (وحدات الصنف {id, name, factor, isActive}) بصفوف الأرصدة ليعرضها نظامكم «2 كرتون و3 حبة». ومسارات الكتابة (POST /van-stock/loads وPOST /warehouse/entries وتعديل طلب البضاعة) تقبل items[].unitId من units[].id للصنف، فتكون qty بوحدته (وunitCost لوحدته في الوارد)، ويكتب الخادم لقطتها unitName وunitFactor وbaseQty = qty × unitFactor. غياب unitId = وحدة الأساس كما قبل الميزة. ومزامنة /v1/sync/van-loads و/v1/sync/warehouse-entries تحمل اللقطة نفسها في كل بند: اجمع baseQty لا qty\n«تتبّع اللوط» (حين lotTrackingEnabled للشركة وlotTracked للصنف، وإلا لا شيء مما يلي): رصيد الصنف المتتبَّع مقسوم على تشغيلات في المستودع وفي كل سيارة، والباقي «غير مسمّى». لا تجعل أي حركة رصيد تشغيلة سالباً ولا تُنقص الرصيد غير المسمّى تحت الصفر، لأي مُصدِر (409 LOT_STOCK_INSUFFICIENT)، فالقاعدتان «لا فحص للتوفر» و«المستودع قد يصير سالباً» لا تنطبقان عليه. الوارد يلزمه تشغيلة (items[].lotId أو items[].lotNumber وتاريخاها)، والتحميل من المستودع يوزّعه الخادم بالأقرب انتهاءً أو بتشغيلاتك في items[].lots، والإنقاص من السيارة من مصدر صريح أو وحيد. كل كميات التشغيلات بوحدة الأساس. والمخزون الافتتاحي بالاستيراد (POST /import/opening-stock، صفوف rows حتى 5000) يقبل لكل صف lotNumber وproductionDate وexpiryDate للصنف المتتبَّع، وأخطاء صفوفه في errors[]: LOT_REQUIRED (رقم غائب أو أطول من 64) وLOT_DATES_INVALID وLOT_EXPIRY_REQUIRED وLOT_QTY_INVALID (كمية بالأساس بأكثر من أربع خانات) وLOT_DATES_MISMATCH (رقم مسجَّل أو مكرّر في الملف بتواريخ أخرى)، وانشغال الأصناف 409 OPENING_STOCK_LEDGER_BUSY. والتراجع عن دفعة افتتاحية استُعملت تشغيلاتها بعدها يبقى في blocked بالسبب «استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد». التفاصيل في مجموعة «تتبّع اللوط»",
  "endpoints": [
   {
    "method": "POST",
    "path": "/van-stock/loads",
    "purpose": "تسجيل حركة على سيارة مندوب: تحميل من المستودع، أو تنزيل إليه، أو تسوية جرد للسيارة",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "صلاحية canManageVanStock لصاحب المفتاح وإلا 403",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN",
     "المندوب يجب أن يكون ضمن نطاق صاحب المفتاح إن كان مقيداً"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب صاحب السيارة. اختياري في المخطط لكنه إلزامي فعلياً للمفتاح، وغيابه يعطي خطأ"
     },
     {
      "name": "type",
      "type": "enum: LOAD | UNLOAD | ADJUST | EXPIRED_OUT | DAMAGED_OUT",
      "required": false,
      "desc": "نوع الحركة، والافتراضي LOAD. التحميل يخرج من المستودع إلى السيارة، والتنزيل يعيد إلى المستودع، والتسوية تمسّ السيارة وحدها. EXPIRED_OUT وDAMAGED_OUT إزالة (إتلاف) من رصيد «منتهي الصلاحية» أو «المرتجع التالف» في السيارة"
     },
     {
      "name": "note",
      "type": "string",
      "required": false,
      "desc": "ملاحظة حرة بلا حد طول في المخطط، وتظهر كمرجع في /movements"
     },
     {
      "name": "items",
      "type": "array (min 1)",
      "required": true,
      "desc": "بنود الحركة"
     },
     {
      "name": "items[].productId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف صنف تابع للشركة. الصنف غير النشط مقبول، وتكرار الصنف في أكثر من بند مقبول"
     },
     {
      "name": "items[].qty",
      "type": "number",
      "required": true,
      "desc": "الكمية بوحدة البند (unitId)، وبلا unitId بوحدة الأساس. في LOAD وUNLOAD أرسلها موجبة. في ADJUST الموجب يزيد رصيد السيارة والسالب ينقصه. البند الذي كميته صفر يُحذف"
     },
     {
      "name": "items[].unitId",
      "type": "string | null",
      "required": false,
      "desc": "وحدة البند من units[].id للصنف (GET /products). غيابه أو null = وحدة الأساس بمعامل 1. الخادم يحلّ المعامل من وحدات الصنف، والرصيد يتحرّك بـqty × factor. تنبيه: في هذا المسار معرّفٌ لا يخصّ الصنف أو لوحدة موقوفة يُقرأ وحدةَ أساس بمعامل 1 بلا رفض، فتحقّق منه قبل الإرسال"
     },
     {
      "name": "items[].suggestedQty",
      "type": "number",
      "required": false,
      "desc": "كمية التعبئة المقترحة (حقل suggested من /van-stock/suggest)، تُحفظ لقياس تبنّي الاقتراح. بوحدة الأساس دائماً مهما كانت وحدة البند"
     },
     {
      "name": "items[].expectedQty",
      "type": "number",
      "required": false,
      "desc": "التنبؤ اليومي (حقل expected من /van-stock/suggest)، وهو مرجع قياس الدقة في /accuracy. بدونه يُعدّ البند غير مقاس. بوحدة الأساس دائماً"
     },
     {
      "name": "items[].lots",
      "type": "array ≤ 20 of {lotId: string | null, qty: number > 0}",
      "required": false,
      "desc": "«تتبّع اللوط» للصنف المتتبَّع وحده (ويُهمل لغيره): تشغيلات البند صراحةً بالكمية الأساسية مهما كانت وحدة البند، بأربع خانات عشرية على الأكثر، ومجموعها = |qty| × factor بالضبط وإلا 422 LOT_QTY_INVALID. lotId: null = الرصيد «غير المسمّى». في الإنقاص (التنزيل، وتسوية النقص، وEXPIRED_OUT وDAMAGED_OUT): من رصيد كل تشغيلة في السيارة ودلوها (409 LOT_STOCK_INSUFFICIENT)، والموقوفة والمنتهية تُنزَّلان. في التحميل من المستودع: من تشغيلات المستودع الصالحة (الموقوفة 422 LOT_BLOCKED والمنتهية 422 LOT_EXPIRED). غيابه في التحميل من المستودع = توزيع تلقائي بالأقرب انتهاءً (FEFO)، وفي الإنقاص = المصدر الوحيد في الدلو، فإن كان أكثر من مصدر رجع 422 LOT_REQUIRED وفي detail.sources قائمتها {lotId, lotNumber, usable, status, expiryDate} لتختار منها"
     },
     {
      "name": "items[].lotNumber",
      "type": "string ≤ 64 (بعد التطبيع)",
      "required": false,
      "desc": "«تتبّع اللوط»: البند كله إلى تشغيلة واحدة برقمها، بديلاً عن items[].lots (معاً 422 LOT_QTY_INVALID). في الزيادة بلا مستودع (التحميل حين مخزون الشركة مطفأ، والتسوية بالزيادة) تُحلّ التشغيلة القائمة بالرقم أو تُنشأ بمصدر LOAD مع تاريخيها. وفي الإنقاص تُحلّ القائمة وحدها وإلا 422 LOT_NOT_FOUND (في التحميل من المستودع detail.hint = 'RECEIVE_FIRST': سجّل الوارد أولاً)"
     },
     {
      "name": "items[].productionDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "تاريخ إنتاج التشغيلة الجديدة مع lotNumber. لا يتأخر عن الانتهاء وإلا 422 LOT_DATES_INVALID، ورقمٌ مسجَّل بتواريخ مختلفة 409 LOT_DATES_MISMATCH"
     },
     {
      "name": "items[].expiryDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "تاريخ انتهاء التشغيلة الجديدة مع lotNumber. إلزامي لصنف صلاحيته مفعّلة وإلا 422 LOT_EXPIRY_REQUIRED. يوم الانتهاء نفسه آخر يوم صالح"
     },
     {
      "name": "items[].lotReason",
      "type": "'EXPIRED_UNSOLD_DESTROY'",
      "required": false,
      "desc": "«تتبّع اللوط»: وسم إتلاف تشغيلة منتهية لم تُبع من رصيد السيارة الصالح للبيع، مع type=ADJUST وكمية سالبة وحدهما (وإلا 400)، ولتشغيلات منتهية يوم العملية وحدها (وإلا 400)، فيظهر في التقارير إتلافاً لا عجز جرد"
     },
     {
      "name": "deletedSalesRepId",
      "type": "string",
      "required": false,
      "desc": "«تتبّع اللوط»: تنزيل بضاعة سيارة مندوب محذوف إلى المستودع (بدل salesRepId ولا معه، وإلا 400). لمستخدم غير مقيّد بنطاق (403 LOT_SCOPED_USER) والميزة مفعّلة (403 LOTS_NOT_ALLOWED)، وبالنوع UNLOAD وحده (400)، ولأصناف متتبَّعة وحدها (400) بتشغيلات مسمّاة صريحة في items[].lots أو items[].lotNumber (422 LOT_REQUIRED). المعرّف من deletedSalesRepId في سجل التحميلات أو من GET /lots/:id/unload-plan، ومعرّفٌ بلا أثر محفوظ 404"
     }
    ],
    "response": "201 {success:true, data:{id, tenantId, salesRepId, deletedSalesRepId, type, note, createdBy:'ADMIN', createdAt, items:[{id, vanLoadId, productId, qty, unitName, unitFactor, baseQty, suggestedQty, expectedQty, product:{id,name,unit}, lots?}]}, warnings?}. «تتبّع اللوط»: حركةٌ فيها صنف متتبَّع ترجع كل بند بـlots:[{id, vanLoadItemId, tenantId, productId, vanKey, moveType, viaWarehouse, lotId, qty, certainty, reason, createdAt, lot:{lotNumber, expiryDate}|null}] (qty بالأساس وبإشارة البند، فتسوية النقص سالبة)، ومعها warnings:[{code, productId, detail?}] (قد تكون فارغة): LOT_FROM_UNKNOWN تحميلٌ من الرصيد غير المسمّى، LOT_SPLIT_UNIT وحدة بند انقسمت بين مصدرين، LOT_INTO_BLOCKED زيادةٌ إلى تشغيلة موقوفة، LOT_MULTI_IN_VAN صار في السيارة أكثر من تشغيلة للصنف",
    "rules": [
     "البنود التي كميتها صفر تُحذف، فإن لم يبقَ بند يُرَدّ 400 «لا توجد كميات صالحة»",
     "أي صنف لا يتبع الشركة يعطي 400 «منتج غير صالح»",
     "مندوب غير موجود في الشركة يعطي 404",
     "لا فحص لتوفر الكمية في المستودع عند LOAD ولا في السيارة عند UNLOAD، فقد يصير أي من الرصيدين سالباً — إلا الصنف المتتبَّع بالتشغيلة («تتبّع اللوط» مفعّل للشركة والصنف): لا يصير رصيد أي تشغيلة له سالباً في المستودع أو السيارة، ولا ينقص رصيده غير المسمّى تحت الصفر (409 LOT_STOCK_INSUFFICIENT مع detail)، فتحميله من المستودع قبل تسجيل وارده يُرفض بالرسالة «سجّل وارد التشغيلة أولاً» (detail.hint = 'RECEIVE_FIRST')",
     "الأثر على المستودع: LOAD ينقص onHand في المستودع، وUNLOAD يعيد الكمية إليه بكلفة خروجها من نفس السيارة (آخر ما حُمّل أول ما يعود)، وADJUST لا يمسّ المستودع",
     "الإدارة لا قيد عليها في إشارة qty، فـLOAD أو UNLOAD بكمية سالبة يُقبل ويعكس المعنى. أرسل الكميات موجبة دائماً. والصنف المتتبَّع: الكمية السالبة لتسوية ADJUST وحدها، وغيرها 422 LOT_QTY_INVALID",
     "«تتبّع اللوط» — شركة بلا مخزون شركة: تحميل الصنف المتتبَّع يحمل تشغيلته (items[].lotNumber وتاريخاه، أو items[].lots بتشغيلة قائمة أو null للرصيد غير المسمّى صراحةً)، وبدونها 422 LOT_REQUIRED",
     "«تتبّع اللوط» — التنزيل بعد إيقاف تشغيلة أو سحبها: اقرأ السيارات التي فيها من GET /lots/:id/unload-plan ثم أرسل UNLOAD بـitems[].lots = [{lotId, qty}] لكل سيارة",
     "«تتبّع اللوط» — الانشغال: 503 {code:'LOT_BUSY'} حين يكون الصنف مشغولاً بعملية تشغيلات أخرى. لا يُكتب شيء، فأعد الطلب (الحركة بلا clientRef، فلا تُعِده بعد 201)",
     "createdBy يُسجَّل ADMIN لكل طلب من غير المندوب",
     "EXPIRED_OUT وDAMAGED_OUT: كمياتٌ موجبة لا يتجاوز مجموعها بالأساس رصيد expired أو damaged للصنف في السيارة (وإلا 400)، ولا تمسّ remaining ولا المستودع",
     "لا يوجد clientRef ولا حماية من التكرار، ولا مسار تعديل أو حذف. التصحيح يكون بحركة معاكسة أو تسوية",
     "إن غاب salesRepId يُرَدّ 400 برسالة «يجب تحديد المندوب»",
     "مندوب خارج نطاق صاحب المفتاح يُرَدّ عليه 404 برسالة «المندوب غير موجود»",
     "ختم الموقع (ميزة «لوكيشن»): التحميل من النوع LOAD يُختم في الخادم بموقع المندوب لحظة التسجيل إن كانت الميزة مفعّلة، والأنواع الأخرى بلا ختم. لا حقل له في الجسم",
     "التحميل بالكرتون: {\"productId\":\"…\",\"unitId\":\"<كرتون 24>\",\"qty\":2} يزيد السيارة 48 حبة (baseQty) وينقص المستودع 48، ويبقى البند مطبوعاً «2 كرتون»"
    ],
    "example": "{\"salesRepId\":\"3f6c2a1e-8b4d-4c1a-9e2f-1a2b3c4d5e6f\",\"type\":\"LOAD\",\"note\":\"تحميل صباح الأحد\",\"items\":[{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"qty\":24,\"suggestedQty\":24,\"expectedQty\":20.5},{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000002\",\"unitId\":\"5e6f7a8b-0000-4000-8000-0000000000c1\",\"qty\":2}]}"
   },
   {
    "method": "GET",
    "path": "/van-stock/current",
    "purpose": "المخزون الحالي في سيارة مندوب لكل صنف، مع تفصيل المحمَّل والمباع والمتبقي",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب، وغيابه يعطي 400 «يجب تحديد المندوب»"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{productId, name, code, unit, loaded, unloaded, adjusted, sold, returned, remaining, expired, damaged, units:[{id, name, factor, isActive}]}]}، مرتبة تنازلياً حسب remaining",
    "rules": [
     "remaining = loaded − unloaded + adjusted − sold + returned، مقرّبة لأربع خانات، وتُحسب على كامل التاريخ",
     "sold هو بنود كل فاتورة مؤكدة (CONFIRMED) غير مرتجعة منسوبة لهذا المندوب، أياً كان من أنشأها",
     "returned هو المرتجعات غير المنتهية وغير التالفة التي returnToStock فيها true",
     "expired رصيد «منتهي الصلاحية»: مرتجعٌ عاد بعد انتهاء صلاحيته، لا يدخل remaining حتى يُزال بـEXPIRED_OUT",
     "damaged رصيد «المرتجع التالف»: مرتجعٌ سببه DAMAGED سُجّل منذ ١٥ أكتوبر ٢٠٢٦، لا يدخل remaining مهما كانت returnToStock حتى يُزال بـDAMAGED_OUT. والتالف المنتهي صلاحيته يدخل expired",
     "تظهر فقط الأصناف التي لها حركة لهذا المندوب، والأصناف غير النشطة تظهر إن كانت لها حركة",
     "remaining قد يكون سالباً إن باع المندوب فوق ما حمّل وهو يملك إذن canSellWithoutStock، أو بيع له بالإدارة أو المفتاح — إلا الصنف المتتبَّع بالتشغيلة («تتبّع اللوط»): بيعه مقيّد برصيد تشغيلاته وغير المسمّى لكل مُصدِر (409 LOT_STOCK_INSUFFICIENT)، فلا يصير remaining له سالباً إلا من تاريخ ما قبل التفعيل",
     "بنود الفاتورة التي لا صنف لها تُتجاهل",
     "معرّف مندوب غير موجود يعيد مصفوفة فارغة، ومندوب خارج النطاق يعيد 404 «المندوب غير موجود»",
     "salesRepId يُقبل نصاً واحداً فقط، وغير ذلك يُعامَل غائباً",
     "لا ترقيم صفحات",
     "كل الكميات بوحدة الأساس unit (تحميل كرتونين من 24 = loaded 48)، وunits وحدات الصنف للعرض: 51 حبة = «2 كرتون و3 حبة». صنفٌ بلا وحدات: units فارغة والأرقام كما كانت"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/van-stock/suggest",
    "purpose": "اقتراح كمية التحميل لكل صنف لسيارة مندوب في يوم معيّن، محسوب من تاريخ مبيعاته (لا يكتب شيئاً)",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب. غيابه يعطي 400، وغياب المندوب من الشركة يعطي 404"
     },
     {
      "name": "date",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "اليوم المستهدف بالتحميل، والافتراضي اليوم. مبيعات هذا اليوم نفسه مستبعدة من الحساب"
     },
     {
      "name": "windowDays",
      "type": "number",
      "required": false,
      "desc": "طول نافذة التاريخ بالأيام. الافتراضي 28، والأدنى 7، والأقصى 180"
     },
     {
      "name": "bufferPct",
      "type": "number",
      "required": false,
      "desc": "هامش الأمان بالنسبة المئوية فوق المتوقع. الافتراضي 15، والمدى من 0 إلى 100، والقيمة غير الرقمية تعود إلى 15"
     }
    ],
    "body": [],
    "response": "{success:true, data:{rows:[{id, name, code, unit, expected, withBuffer, onVan, suggested, basis:'weekday'|'overall'|'none', sampleDays, activeDays, confidence:'high'|'medium'|'low', why, units:[{id, name, factor, isActive}]}], meta:{targetDate, weekday, windowDays, bufferPct, dataDays, oldestSale, warning}, salesRep:{id,name}}}",
    "rules": [
     "معرّف الصنف في الصف يأتي باسم id لا productId",
     "الأصناف النشطة وحدها، وصنف بلا مبيعات في النافذة يأتي بقيمة صفر وbasis='none'",
     "صافي الطلب هو مبيعات الفواتير المؤكدة ناقص مرتجعاتها، والأيام التي لا بيع فيها تدخل في المتوسط",
     "basis='weekday' إذا وُجد في النافذة يومان على الأقل من نفس يوم الأسبوع فيهما بيع، وإلا يُستخدم المتوسط اليومي العام",
     "withBuffer = ceil(expected × (1 + bufferPct/100))، وsuggested = max(0, withBuffer − onVan)، وonVan هو متبقي السيارة الحالي",
     "الترتيب تنازلي حسب suggested ثم expected",
     "لتحويل الاقتراح إلى تحميل أرسل في POST /van-stock/loads: productId=row.id، وqty=row.suggested بلا unitId (الاقتراح بوحدة الأساس)، وsuggestedQty=row.suggested، وexpectedQty=row.expected. وللتحميل بالكرتون أرسل unitId وqty = suggested ÷ factor (مقرّباً لأعلى لكراتين كاملة) مع بقاء suggestedQty وexpectedQty بالأساس",
     "meta.warning يكون نصاً عربياً حين تقل البيانات عن 14 يوماً",
     "expected وwithBuffer وonVan وsuggested كلها بوحدة الأساس، وunits وحدات الصنف لعرضها بالكراتين"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/van-stock/lot-balances",
    "purpose": "«تتبّع اللوط»: أرصدة تشغيلات سيارة مندوب للأصناف المتتبَّعة — المتاح للبيع بالتشغيلة والموقوف والمحجوز والمنتهي والتالف (لا يكتب شيئاً)",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "lotTrackingEnabled للشركة، وإلا 403 LOTS_NOT_ALLOWED",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب. غيابه يعطي 400، وغياب المندوب من الشركة يعطي 404"
     }
    ],
    "body": [],
    "response": "{success:true, data:{serverTime, day, tracked:[productId], allowUnknown, products:[{productId, available, availableNamed, unknownUsable, quarantined, held, expiredUnsold, expiredReturned, damaged, lots:[{lotId, lotNumber, expiryDate, status:'ACTIVE'|'BLOCKED', blockKind:'HOLD'|'RECALL'|null, usable}]}]}}",
    "rules": [
     "الكميات كلها بوحدة الأساس للصنف",
     "tracked كل الأصناف المتتبَّعة في الشركة (lotTracked)، وproducts ما له رصيد منها في السيارة فقط: المتتبَّع الغائب عن products متاحه صفر",
     "available ما يُباع فعلاً = availableNamed (تشغيلات نشطة غير منتهية يوم day) + unknownUsable (الرصيد «غير المسمّى» الصالح: ما قبل التفعيل والمرتجع الحرّ وما بلا تشغيلة) حين allowUnknown. وunknownUsable لا يظهر سالباً هنا: العجز في GET /lots/health",
     "lots كل تشغيلة لها رصيد صالح في الدلو المتاح للبيع أيّاً كانت حالتها: الموقوفة (status = BLOCKED بنوع HOLD أو RECALL) تُحسب في quarantined، والمنتهية (expiryDate قبل day) في expiredUnsold، وكلتاهما لا تدخل available ولا تُباع — تُنزَّل بـUNLOAD أو تُتلف",
     "held المحجوز: مرتجع إشعار دائن قياسي (01) بانتظار اعتماد الهيئة، داخل رصيد السيارة ولا يُباع حتى يُعتمد. وexpiredReturned وdamaged رصيدا «منتهي الصلاحية» و«المرتجع التالف» للصنف في السيارة",
     "day يوم الشركة بمنطقتها الزمنية، وعليه يُقاس الانتهاء: يوم الانتهاء نفسه آخر يوم صالح، والتشغيلة المنتهية لا تُباع",
     "البيع نفسه يوزّع على التشغيلات تلقائياً في الخادم بالأقرب انتهاءً (FEFO)، فلا حاجة لإرسال تشغيلة مع الفاتورة. وأرصدة السيارة كلها بتفصيل الخام والمحجوز في GET /lots/balances"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/van-stock/accuracy",
    "purpose": "قياس دقة اقتراح التحميل: مقارنة التنبؤ المحفوظ مع كل تحميل بالمبيع الفعلي في اليوم نفسه",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب، وغيابه يعطي 400"
     },
     {
      "name": "days",
      "type": "number",
      "required": false,
      "desc": "عدد الأيام الماضية. الافتراضي 14، والأدنى 7، والأقصى 60"
     },
     {
      "name": "tz",
      "type": "integer",
      "required": false,
      "desc": "إزاحة التوقيت المحلي بالدقائق شرق UTC، والرياض 180. الافتراضي 0، والمدى ±840. تحدد حدود اليوم"
     }
    ],
    "body": [],
    "response": "{success:true, data:{days:[{day:'YYYY-MM-DD', productId, name, unit, expected, suggested, loaded, actual, error, adopted, outcome:'دقيق'|'نقص'|'زيادة', open}], summary:{measured, pending, unmeasured, adoptionRate, mae, bias, maePct, under, over, exact, verdict}, meta:{days, tzOffsetMin}}}",
    "rules": [
     "تُقاس حركات LOAD فقط، وبنود بلا expectedQty تُعدّ في unmeasured خارج القياس",
     "إن تكرر التحميل في اليوم نفسه يُعتمد الأول كمرجع للتنبؤ، والتالي يزيد loaded فقط",
     "actual هو المبيع ناقص المرتجع في اليوم، ولا ينزل تحت الصفر. وerror = actual − expected",
     "adopted تعني أن المحمَّل بالأساس (مجموع baseQty) يساوي suggestedQty (فرق أقل من 0.001)، فتحميل «2 كرتون» لاقتراح 48 حبة تبنٍّ. وexpected وsuggested وloaded وactual كلها بوحدة الأساس",
     "اليوم الجاري open=true ولا يدخل في summary"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/van-stock/summary",
    "purpose": "ملخص مخزون سيارات كل المناديب في سطر لكل مندوب، مع نافذة زمنية اختيارية",
    "permission": "canManageVanStock + دور لوحة الشركة (requireAdmin)",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "المناديب مقيدة بنطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدة، وتشمل اليوم نفسه. القيمة الفاسدة تُهمل"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدة حتى آخر اليوم. القيمة الفاسدة تُهمل، والمدى المقلوب يُصحَّح تلقائياً"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{salesRepId, repName, isActive, canSellWithoutStock, productCount, totalRemaining, totalLoaded, totalSold, totalDamaged, toolsCount, lastLoadAt}], filtered:boolean, from:string|null, to:string|null}",
    "rules": [
     "بلا from وto: الأرقام إجمالية على كامل التاريخ",
     "مع from أو to: totalLoaded وtotalSold هما ما جرى داخل المدة، أما totalRemaining فهو الرصيد التراكمي حتى نهاية to",
     "lastLoadAt هو تاريخ آخر LOAD قبل نهاية to",
     "productCount هو عدد الأصناف التي متبقيها غير صفري",
     "totalDamaged رصيد «المرتجع التالف» في السيارة حتى نهاية to، كالمتبقي",
     "toolsCount عدد الأدوات في عهدة السيارة الآن (المسلَّم − المستلَم) ولا يتبع المدة",
     "يشمل المناديب غير النشطين (راجع حقل isActive)",
     "لا ترقيم صفحات، والقائمة تشمل كل المناديب في النطاق",
     "totalRemaining وtotalLoaded وtotalSold وtotalDamaged مجاميع عبر أصناف مختلفة بوحدات أساسها (حبّات)، فلا تُقرأ كراتين"
    ],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/van-stock/sell-permission",
    "purpose": "تفعيل أو منع «البيع بدون مخزون» لمندوب",
    "permission": "canManageVanStock + دور لوحة الشركة (requireAdmin)",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "مفتاح قراءة فقط مرفوض",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب"
     },
     {
      "name": "canSellWithoutStock",
      "type": "boolean",
      "required": true,
      "desc": "true يسمح بالبيع فوق متبقي السيارة، وfalse يمنعه — إلا الصنف المتتبَّع بالتشغيلة («تتبّع اللوط» مفعّل للشركة والصنف): لا يُعفي منه الإذن، فبيعه فوق رصيد تشغيلات السيارة الصالحة وغير المسمّى يُرفض 409 LOT_STOCK_INSUFFICIENT أيّاً كانت قيمته"
     }
    ],
    "response": "{success:true, data:{salesRepId, canSellWithoutStock}}",
    "rules": [
     "الافتراضي true لكل مندوب schema.prisma:314",
     "عند false تُرفض بـ403 الفاتورة غير المرتجعة التي يصدرها المندوب من تطبيقه إن تجاوزت كمية صنف متبقي سيارته. والصنف المتتبَّع بالتشغيلة لا يمرّ بهذا الفحص: يُرفض فوق رصيد تشغيلاته بـ409 LOT_STOCK_INSUFFICIENT مع detail، عند true وfalse",
     "القيد لا يسري على الفواتير التي تنشئها الإدارة أو المفتاح لهذا المندوب، لكنها تُنقص متبقي سيارته — إلا الصنف المتتبَّع بالتشغيلة: قفل التشغيلات يسري على كل مُصدِر ومنه المفتاح، فلا يُباع فوق رصيد تشغيلات السيارة الصالحة وغير المسمّى (409 LOT_STOCK_INSUFFICIENT)",
     "مندوب غير موجود أو خارج النطاق يعطي 404 «المندوب غير موجود»"
    ],
    "example": "{\"salesRepId\":\"3f6c2a1e-8b4d-4c1a-9e2f-1a2b3c4d5e6f\",\"canSellWithoutStock\":false}"
   },
   {
    "method": "GET",
    "path": "/van-stock/loads",
    "purpose": "سجل حركات تحميل وتنزيل وتسوية السيارات (آخر 100 حركة، أو مرقَّماً بالتصفية)",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "الحركات مقيدة بنطاق مناديب صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": false,
      "desc": "لتصفية الحركات على مندوب واحد، وبدونه تأتي كل المناديب"
     },
     {
      "name": "type",
      "type": "enum: LOAD | UNLOAD | ADJUST | EXPIRED_OUT | DAMAGED_OUT",
      "required": false,
      "desc": "نوع الحركة. القيمة غير المعروفة تُهمل"
     },
     {
      "name": "from",
      "type": "date YYYY-MM-DD",
      "required": false,
      "desc": "بداية الفترة بأيام الشركة المحلية على لحظة تسجيل الحركة (createdAt). إذا غابت فهي يوم to"
     },
     {
      "name": "to",
      "type": "date YYYY-MM-DD",
      "required": false,
      "desc": "نهاية الفترة شاملة اليوم كاملاً بأيام الشركة. إذا غابت مع وجود from فهي اليوم. التاريخ غير الصالح أو from بعد to يعطي 400"
     },
     {
      "name": "locationId",
      "type": "string (uuid) | none",
      "required": false,
      "desc": "تصفية بختم الموقع (ميزة «لوكيشن»): معرّف موقع أو none. الختم على التحميل (LOAD) وحده، فالتنزيل والتسوية بلا موقع. يعمل ولو كانت الميزة مطفأة"
     },
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "يفعّل الترقيم ويضيف pagination للردّ. بدونه تبقى آخر 100 حركة كما هي"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة مع page، الافتراضي 50 وأقصاه 200"
     },
     {
      "name": "withLots",
      "type": "1 | true",
      "required": false,
      "desc": "«تتبّع اللوط»: يضيف لكل بند lots:[{id, vanLoadItemId, tenantId, productId, vanKey, moveType, viaWarehouse, lotId, qty, certainty, reason, createdAt, lot:{lotNumber, expiryDate}|null}] — توزيعه على التشغيلات بالكمية الأساسية وبإشارة البند. بند صنف غير متتبَّع lots فارغة. يُهمل حين تكون الميزة مطفأة للشركة"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, salesRepId, deletedSalesRepId, locationId, type, note, createdBy:'REP'|'ADMIN'|null, createdAt, items:[{id, vanLoadId, productId, qty, unitName, unitFactor, baseQty, suggestedQty, expectedQty, product:{id,name,unit}, lots?}], salesRep:{id,name}, location:{id,name}|null}], pagination?:{total, page, limit, pages}}",
    "rules": [
     "بلا page: آخر 100 حركة فقط، الأحدث أولاً، بلا pagination. ومع page: صفحات مرقّمة بحدّ 200. للتاريخ الكامل استعمل /v1/sync/van-loads",
     "location هو ختم موقع المندوب لحظة التحميل (حركات LOAD وحدها تُختم حين تفعّل الشركة ميزة «لوكيشن»)، ولا يتغيّر إن نُقل المندوب لاحقاً. وnull لما بلا ختم",
     "حركات مندوب محذوف تبقى وتظهر بـsalesRep={id:null, name:'مندوب محذوف'}، ولا يراها صاحب مفتاح مقيّد النطاق",
     "salesRepId خارج النطاق يعطي 404 «المندوب غير موجود»",
     "qty بوحدة البند ولقطتها unitName (null = الأساس) وunitFactor، وbaseQty بالأساس لمن يجمع. وsuggestedQty وexpectedQty بالأساس دائماً"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/van-stock/movements",
    "purpose": "خط زمني موحد لحركة سيارة مندوب: تحميلات وتنزيلات وتسويات ومبيعات ومرتجعات",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب، وغيابه يعطي 400"
     },
     {
      "name": "withLots",
      "type": "1 | true",
      "required": false,
      "desc": "«تتبّع اللوط»: يضيف لكل بند (حركة سيارة أو فاتورة) lots بصفوف توزيعه على التشغيلات ومعها lot:{lotNumber, expiryDate}|null، بالكمية الأساسية. يُهمل حين تكون الميزة مطفأة للشركة"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{kind:'LOAD'|'UNLOAD'|'ADJUST'|'EXPIRED_OUT'|'DAMAGED_OUT'|'SALE'|'RETURN'|'RETURN_DAMAGED', date, ref, by, items:[{name, unit, qty, baseQty, lots?}]}]}",
    "rules": [
     "يدمج آخر 50 حركة سيارة مع آخر 50 فاتورة مؤكدة، ثم يرتبها تنازلياً حسب التاريخ ويقتطع أول 60",
     "ref في حركة السيارة هو الملاحظة، وفي الفاتورة «رقم الفاتورة · اسم العميل»",
     "by في الفواتير دائماً 'REP' حتى لو أنشأتها الإدارة، وفي حركات السيارة REP أو ADMIN",
     "المرتجع يظهر هنا حتى لو لم يُعَد للمخزون (returnToStock=false)، والمرتجع التالف الداخل رصيد «المرتجع التالف» يظهر RETURN_DAMAGED، وبند بلا صنف يظهر باسم «صنف محذوف»",
     "لا تُعاد معرّفات للبنود أو الأصناف، فقط الاسم والوحدة والكمية: unit وحدة البند كما كُتب (لقطته، وإلا وحدة الصنف) وqty بها، وbaseQty الكمية بوحدة الأساس لمن يجمع"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/van-stock/tools",
    "purpose": "عهدة أدوات سيارة مندوب (عربة تحميل، سلة…): الرصيد لكل أداة وآخر حركات التسليم والاستلام",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب، وغيابه يعطي 400"
     }
    ],
    "body": [],
    "response": "{success:true, data:{balances:[{toolName, qty}], total, moves:[{id, type:'ISSUE'|'RETURN', toolName, qty, note, createdByName, createdAt}], names:[string]}}",
    "rules": [
     "الرصيد لكل أداة = المسلَّم (ISSUE) − المستلَم (RETURN)، والأداة التي رصيدها صفر لا تظهر في balances",
     "اسم الأداة يُطابق بلا فروق المسافات ولا حالة الحروف اللاتينية",
     "moves آخر 100 حركة، الأحدث أولاً",
     "names أسماء أدوات الشركة المستعملة سابقاً (للاقتراح عند التسليم)",
     "العهدة ليست بضاعة: لا تمسّ مخزون السيارة ولا المستودع"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/van-stock/tools",
    "purpose": "تسليم أدوات لسيارة مندوب عهدةً، أو استلامها منها",
    "permission": "canManageVanStock + دور لوحة الشركة (requireAdmin)",
    "gates": [
     "accountingEnabled ليس false",
     "صلاحية canManageVanStock",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN",
     "المندوب ضمن نطاق صاحب المفتاح"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب صاحب السيارة"
     },
     {
      "name": "type",
      "type": "enum: ISSUE | RETURN",
      "required": true,
      "desc": "ISSUE تسليم للسيارة، وRETURN استلام منها"
     },
     {
      "name": "note",
      "type": "string (≤300)",
      "required": false,
      "desc": "ملاحظة حرة"
     },
     {
      "name": "items",
      "type": "array (1..50)",
      "required": true,
      "desc": "الأدوات"
     },
     {
      "name": "items[].toolName",
      "type": "string (1..80)",
      "required": true,
      "desc": "اسم الأداة نصاً حراً، مثل «عربة تحميل» أو «سلة»"
     },
     {
      "name": "items[].qty",
      "type": "integer > 0",
      "required": true,
      "desc": "العدد"
     }
    ],
    "response": "201 {success:true, data:{count}}",
    "rules": [
     "RETURN لا يتجاوز عهدة الأداة في السيارة، وإلا 400",
     "سطران للأداة نفسها في الطلب يُجمعان في حركة واحدة",
     "لا مسار تعديل أو حذف: التصحيح بحركة معاكسة"
    ],
    "example": "{\"salesRepId\":\"3f6c2a1e-8b4d-4c1a-9e2f-1a2b3c4d5e6f\",\"type\":\"ISSUE\",\"items\":[{\"toolName\":\"عربة تحميل\",\"qty\":1},{\"toolName\":\"سلة\",\"qty\":4}]}"
   },
   {
    "method": "GET",
    "path": "/warehouse",
    "purpose": "رصيد مستودع الشركة لكل صنف، مع تفصيل الوارد والتسويات والمحمَّل للسيارات والعائد منها، وقيمته بتكلفة الشراء",
    "permission": "canManageVanStock",
    "gates": [
     "صلاحية canManageVanStock أولاً (403 بلا code)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "warehouseEnabled يجب أن يكون true وإلا 403 بلا code «ميزة مخزون الشركة غير مفعلة لهذه الشركة»"
    ],
    "query": [
     {
      "name": "asOf",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "المخزون في تاريخ مضى: حركات ما قبل نهاية ذلك اليوم بتوقيت الشركة وحدها. غيابه = الآن"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{productId, name, code, unit, received, adjusted, loadedToVans, returnedFromVans, onHand, avgCost, stockValue, costedQty, uncostedQty, units:[{id, name, factor, isActive}]}]}، مرتبة تنازلياً حسب onHand",
    "rules": [
     "تظهر كل الأصناف النشطة حتى التي لا حركة لها",
     "onHand = received + adjusted + returnedFromVans − loadedToVans، مقرّبة لأربع خانات",
     "تُحسب تحميلات كل المناديب ومنهم المحذوفون، ولا يُطبَّق نطاق المناديب هنا لأن المستودع على مستوى الشركة",
     "avgCost متوسط متحرك من الوارد المسعّر، صافٍ قبل الضريبة، بأربع خانات. stockValue = costedQty × avgCost، مقرّبة بخانات عملة الشركة",
     "uncostedQty كمية بلا سعر معروف، وهي خارج stockValue صراحة",
     "onHand وstockValue قد يصيران سالبين حين يُحمَّل للسيارات أكثر من الوارد — إلا الصنف المتتبَّع بالتشغيلة («تتبّع اللوط»): التحميل والتسوية بالنقص لا يتجاوزان رصيد تشغيلاته والرصيد غير المسمّى (409 LOT_STOCK_INSUFFICIENT)، فلا ينزل تحت الصفر إلا ما كان سالباً قبل التفعيل. وأرصدته بالتشغيلة في GET /lots/balances",
     "الكميات (received وadjusted وloadedToVans وreturnedFromVans وonHand وcostedQty وuncostedQty) بوحدة الأساس unit، وavgCost لوحدة الأساس (تكلفة الكرتون ÷ معامله بلا تقريب قبل المتوسط)، وunits وحدات الصنف للعرض"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/warehouse/vans",
    "purpose": "ما في مخزون السيارات الآن (أو في تاريخ) وقيمته بتكلفة خروجه من المستودع — بطاقة «في مخزون السيارات» بجانب قيمة المستودع",
    "permission": "canManageVanStock",
    "gates": [
     "صلاحية canManageVanStock أولاً (403 بلا code)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "warehouseEnabled يجب أن يكون true وإلا 403 بلا code «ميزة مخزون الشركة غير مفعلة لهذه الشركة»",
     "نطاق المستخدم: سيارات مناديبه وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "asOf",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "ما في السيارات في نهاية ذلك اليوم بتوقيت الشركة. غيابه = الآن"
     }
    ],
    "body": [],
    "response": "{success:true, data:{qty, value, uncostedQty, unsellableQty, reps, products, deletedVans, lotQuarantined?, lotHeld?, lotProducts?:[{productId, lotQuarantined, lotHeld}]}}",
    "rules": [
     "«تتبّع اللوط» (حين تكون الميزة مفعّلة للشركة وحدها): lotQuarantined رصيد تشغيلات موقوفة أو منتهية لم تُبع في سيارات النطاق، وlotHeld المحجوز (مرتجع إشعار دائن قياسي بانتظار الاعتماد) — كلاهما داخل qty ولا يُباع، فأضفه إلى ما لا يُباع. وlotProducts تفصيلهما لكل صنف متتبَّع. بوحدة الأساس، ومع asOf بيوم ذلك التاريخ",
     "value قيمة ما في السيارات بطبقات تكلفة خروجه من المستودع (الأحدث أولاً)، وuncostedQty كمية بلا تكلفة معروفة لا تدخل القيمة",
     "unsellableQty التالف والمنتهي في السيارات (لا يُباع)، وreps عدد السيارات التي فيها شيء، وproducts عدد الأصناف",
     "deletedVans سيارات مناديب محذوفين بقي فيها رصيد — تُعدّ لصاحب المفتاح غير المقيّد وحده",
     "qty وuncostedQty وunsellableQty مجاميع عبر الأصناف بوحدات أساسها"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/warehouse/entries",
    "purpose": "تسجيل وارد (شراء أو استلام) إلى مستودع الشركة، أو تسوية جرد له",
    "permission": "canManageVanStock",
    "gates": [
     "صلاحية canManageVanStock أولاً (403 بلا code)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "warehouseEnabled يجب أن يكون true وإلا 403 بلا code «ميزة مخزون الشركة غير مفعلة لهذه الشركة»",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "type",
      "type": "enum: RECEIVE | ADJUST",
      "required": false,
      "desc": "الافتراضي RECEIVE. RECEIVE وارد أو شراء، وADJUST تسوية جرد أو تالف"
     },
     {
      "name": "note",
      "type": "string (max 300)",
      "required": false,
      "desc": "ملاحظة"
     },
     {
      "name": "supplier",
      "type": "string (max 200)",
      "required": false,
      "desc": "اسم المورّد كنص حر، ولا يرتبط بسجل مورد"
     },
     {
      "name": "costsIncludeTax",
      "type": "boolean",
      "required": false,
      "desc": "الافتراضي false. اجعله true إن كانت قيم unitCost شاملة للضريبة، فيحوّلها الخادم إلى الصافي قبل الحفظ"
     },
     {
      "name": "items",
      "type": "array (min 1)",
      "required": true,
      "desc": "بنود الحركة"
     },
     {
      "name": "items[].productId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف صنف تابع للشركة"
     },
     {
      "name": "items[].qty",
      "type": "number",
      "required": true,
      "desc": "الكمية بوحدة البند (unitId)، وبلا unitId بوحدة الأساس. في RECEIVE يجب أن تكون موجبة. في ADJUST الموجب يزيد والسالب ينقص. البند الذي كميته صفر يُحذف"
     },
     {
      "name": "items[].unitId",
      "type": "string | null",
      "required": false,
      "desc": "وحدة البند من units[].id للصنف، كما في فاتورة المورّد (كرتون). غيابه أو null = وحدة الأساس بمعامل 1. تنبيه: في هذا المسار معرّفٌ لا يخصّ الصنف أو لوحدة موقوفة يُقرأ وحدةَ أساس بمعامل 1 بلا رفض، فتحقّق منه قبل الإرسال"
     },
     {
      "name": "items[].unitCost",
      "type": "number (>0, finite, max 1e9)",
      "required": false,
      "desc": "تكلفة شراء وحدة البند (تكلفة الكرتون لبند بالكرتون كما في فاتورة المورّد)، وتُقبل مع RECEIVE فقط. الصفر مرفوض، فإن لم يوجد سعر أغفل الحقل"
     },
     {
      "name": "items[].lotId",
      "type": "string ≤ 128 | null",
      "required": false,
      "desc": "«تتبّع اللوط» للصنف المتتبَّع وحده (ويُهمل لغيره أو والميزة مطفأة): السطر كله تشغيلة واحدة قائمة بمعرّفها (GET /lots). null صريحاً = الرصيد «غير المسمّى»، ويُقبل في التسوية ADJUST وحدها. تشغيلة من صنف آخر 422 LOT_PRODUCT_MISMATCH، وغير موجودة 422 LOT_NOT_FOUND"
     },
     {
      "name": "items[].lotNumber",
      "type": "string ≤ 64",
      "required": false,
      "desc": "«تتبّع اللوط»: رقم التشغيلة بديلاً عن lotId. في الوارد والتسوية بالزيادة تُحلّ القائمة بالرقم المطبَّع أو تُنشأ (المصدر RECEIVE للوارد)، وفي التسوية بالنقص تُحلّ القائمة وحدها وإلا 422 LOT_NOT_FOUND. الوارد RECEIVE لصنف متتبَّع بلا lotId ولا lotNumber يرجع 422 LOT_REQUIRED"
     },
     {
      "name": "items[].productionDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "تاريخ إنتاج التشغيلة. صيغة خاطئة أو بعد الانتهاء 422 LOT_DATES_INVALID، ومخالفٌ لتشغيلة مسجَّلة بالرقم أو المعرّف 409 LOT_DATES_MISMATCH، والتاريخ الغائب يطابق المسجَّل (لا يُصحَّح تاريخ تشغيلة من وارد: PATCH /lots/:id)"
     },
     {
      "name": "items[].expiryDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "تاريخ انتهاء التشغيلة، إلزامي للتشغيلة الجديدة لصنف صلاحيته مفعّلة وإلا 422 LOT_EXPIRY_REQUIRED. يوم الانتهاء نفسه آخر يوم صالح"
     }
    ],
    "response": "201 {success:true, data:{id, tenantId, type, note, supplier, createdBy, createdAt, items:[{id, entryId, productId, qty, unitName, unitFactor, baseQty, unitCost, expiresAt, product:{id,name,unit}, lotId?, lot?}]}, warnings?}. «تتبّع اللوط» (الميزة مفعّلة): كل بند يحمل lotId وlot:{lotNumber, productionDate, expiryDate}|null (null لصنف غير متتبَّع أو للرصيد غير المسمّى)، وwarnings:[{code:'LOT_INTO_BLOCKED', productId, detail:{idx, lotId, lotNumber, blockKind}}] حين يدخل الوارد تشغيلة موقوفة",
    "rules": [
     "«تتبّع اللوط»: سطر الصنف المتتبَّع تشغيلة واحدة بالكمية الأساسية (qty × factor) بأربع خانات عشرية على الأكثر (وإلا 422 LOT_QTY_INVALID). التسوية بالنقص لا تتجاوز رصيد التشغيلة أو الرصيد غير المسمّى في المستودع (409 LOT_STOCK_INSUFFICIENT)، وسطرٌ بالنقص بلا تشغيلة يأخذ المصدر الوحيد في المستودع وإلا 422 LOT_REQUIRED بقائمة detail.sources. والموقوفة والمنتهية تخرج بالتسوية بالنقص (الإتلاف). وأي رفض يلغي الحركة كلها، والانشغال 503 LOT_BUSY",
     "البنود التي كميتها صفر تُحذف، فإن لم يبقَ بند يُرَدّ 400",
     "RECEIVE بكمية سالبة يعطي 400، والتنقيص يكون بتسوية ADJUST",
     "ADJUST مع unitCost يعطي 400",
     "أي صنف لا يتبع الشركة يعطي 400 «منتج غير صالح»",
     "unitCost المحفوظ صافٍ دائماً ولوحدة البند، والتقييم يقسمه على unitFactor فتكلفة الحبة = تكلفة الكرتون ÷ 24. مع costsIncludeTax=true يكون unitCost ÷ (1 + taxPct الصنف/100) مقرّباً لأربع خانات",
     "التقييم: الوارد المسعّر يحرّك متوسط التكلفة، والوارد بلا سعر يدخل uncostedQty، والتسوية الموجبة تُقيَّم بمتوسط اللحظة، والسالبة تنقص الكمية المقيَّمة وغير المقيَّمة بنسبتهما",
     "المسار لا يُنشئ قيداً محاسبياً ولا ذمة مورد، فهو حركة مخزون فقط",
     "createdBy هو اسم مستخدم الشركة صاحب المفتاح",
     "لا يوجد clientRef، ولا مسار تعديل أو حذف"
    ],
    "example": "{\"type\":\"RECEIVE\",\"supplier\":\"مؤسسة التوريد المتحدة\",\"note\":\"فاتورة مورد 5512\",\"costsIncludeTax\":true,\"items\":[{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"unitId\":\"5e6f7a8b-0000-4000-8000-0000000000c1\",\"qty\":5,\"unitCost\":276},{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000002\",\"qty\":48}]}"
   },
   {
    "method": "GET",
    "path": "/warehouse/entries",
    "purpose": "سجل حركات المستودع (الوارد والتسويات) مع قيمة كل سطر وإجمالي الحركة (آخر 100 حركة)",
    "permission": "canManageVanStock",
    "gates": [
     "صلاحية canManageVanStock أولاً (403 بلا code)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "warehouseEnabled يجب أن يكون true وإلا 403 بلا code «ميزة مخزون الشركة غير مفعلة لهذه الشركة»"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, type, note, supplier, createdBy, createdAt, items:[{id, entryId, productId, qty, unitName, unitFactor, baseQty, unitCost, expiresAt, product:{name,unit}, lineCost, lotId?, lot?}], totalCost}]}",
    "rules": [
     "«تتبّع اللوط» (حين تكون الميزة مفعّلة للشركة): كل بند يحمل lotId وlot:{lotNumber, productionDate, expiryDate}|null — تشغيلة السطر، وnull لصنف غير متتبَّع أو للرصيد غير المسمّى. والميزة مطفأة: الرد كما كان",
     "آخر 100 حركة فقط، الأحدث أولاً، بلا ترقيم صفحات. للتاريخ الكامل استعمل /v1/sync/warehouse-entries",
     "unitCost صافٍ قبل الضريبة، ويكون null إن لم يُسعَّر",
     "lineCost = qty × unitCost بوحدة السطر (كراتين × تكلفة الكرتون) مقرّبة بخانات عملة الشركة، وتكون 0 حين لا يوجد سعر. وtotalCost هو مجموع قيم lineCost بعد تقريب كل منها. وbaseQty كمية السطر بالأساس",
     "expiresAt حقل مهجور لا يُكتب، فتجاهله",
     "product في هذا المسار يحمل name وunit فقط، بلا id، والمعرّف موجود في productId"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/rep-stock-requests",
    "purpose": "طلبات البضاعة المعلّقة التي رفعها المناديب من «مخزون سيارتي» — نافذة «طلب مخزون» في صفحة مخزون الشركة",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب (403 «غير مسموح» للمندوب)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "صلاحية canManageVanStock (403 بلا code)",
     "warehouseEnabled يجب أن يكون true وإلا 403 WAREHOUSE_NOT_ENABLED «ميزة مخزون الشركة غير مفعلة لهذه الشركة»",
     "نطاق المستخدم: طلبات مناديبه وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, status, note, createdAt, updatedAt, decidedAt, sentRef, items:[{productId, name, code, unit, requestedQty, qty, unitName, unitFactor, baseQty, requestedBaseQty, baseUnit, units:[{id, name, factor, isActive}]}], salesRepId, repName}]}، الأقدم أولاً",
    "rules": [
     "المعلّقة (PENDING) وحدها، ولكل مندوب طلبٌ معلّق واحد على الأكثر",
     "requestedQty ما طلبه المندوب، وqty ما اعتمدته الإدارة بعد تعديلها (يساويه حتى تعدّله). الأصناف مرتبة بالاسم",
     "updatedAt «نسخة» الطلب: أرسلها كما قرأتها في التعديل والرفض والإرسال، فإن عدّل المندوب طلبه بعد قراءتك رُدّ 409",
     "الطلب لا يمسّ أي رصيد: لا في السيارة ولا في المستودع. التحميل الفعلي بـPOST /van-stock/loads",
     "رفع الطلب نفسه من تطبيق المندوب وحده (/rep-stock-requests/mine للمندوب)، فلا مسار له بمفتاح الشركة",
     "unit وحدة السطر (لقطته، وإلا وحدة الصنف) وrequestedQty وqty بها، وbaseQty وrequestedBaseQty بوحدة الأساس baseUnit لمن يجمع طلبات المناديب في الطلب العام. والطلب سطر واحد لكل صنف: أسطر المندوب بوحدة واحدة تُجمع بها، وبوحدات مختلفة تصير سطراً بالأساس"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/rep-stock-requests/:id",
    "purpose": "تعديل الكميات المعتمدة في طلب مندوب معلّق قبل إرساله",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب (403 «غير مسموح» للمندوب)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "صلاحية canManageVanStock (403 بلا code)",
     "warehouseEnabled يجب أن يكون true وإلا 403 WAREHOUSE_NOT_ENABLED «ميزة مخزون الشركة غير مفعلة لهذه الشركة»",
     "نطاق المستخدم: طلبات مناديبه وحدها",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "updatedAt",
      "type": "string (ISO)",
      "required": true,
      "desc": "نسخة الطلب كما جاءت في GET /rep-stock-requests"
     },
     {
      "name": "items",
      "type": "array (1..500)",
      "required": true,
      "desc": "الأصناف التي تعدّل كميتها، وما لم يُذكر يبقى كما هو"
     },
     {
      "name": "items[].productId",
      "type": "string",
      "required": true,
      "desc": "صنفٌ موجود في طلب المندوب نفسه، وإلا 400 «الصنف ليس في طلب المندوب»"
     },
     {
      "name": "items[].qty",
      "type": "number (0..1000000)",
      "required": true,
      "desc": "الكمية المعتمدة بوحدة السطر (أو بوحدة unitId إن أُرسل)، تُقرَّب لأربع خانات. الصفر يُبقي الصنف بكمية صفر. والسقف 1000000 بوحدة الأساس أيضاً (وإلا 400 «الكمية أكبر من الحد المسموح»)"
     },
     {
      "name": "items[].unitId",
      "type": "string | null",
      "required": false,
      "desc": "غيابه = وحدة سطر المندوب كما هي، وnull = وحدة الأساس صراحةً، ومعرّفٌ من units[].id = تلك الوحدة. التعديل بوحدة غير وحدة السطر يعيد السطر كله إلى وحدة الأساس: «طلب 5 كرتون، اعتُمد 100 حبة» يصير requestedQty 120 وqty 100 بالحبة"
     }
    ],
    "response": "{success:true, data:{id, status, note, createdAt, updatedAt, decidedAt, sentRef, items:[{productId, name, code, unit, requestedQty, qty, unitName, unitFactor, baseQty, requestedBaseQty, baseUnit, units}]}} بنسخة updatedAt جديدة",
    "rules": [
     "requestedQty لا يتغيّر أبداً، فيبقى ما طلبه المندوب ظاهراً بجانب المعتمد",
     "404 «الطلب غير موجود» لطلب غير معلّق أو خارج النطاق، و409 «عدل المندوب طلبه للتو» إن اختلفت updatedAt",
     "لا يضيف صنفاً جديداً إلى الطلب"
    ],
    "example": "{\"updatedAt\":\"2026-10-27T08:15:02.114Z\",\"items\":[{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"qty\":30}]}"
   },
   {
    "method": "POST",
    "path": "/rep-stock-requests/send",
    "purpose": "إرسال الطلب العام: تعليم طلبات المناديب المشمولة «أُرسلت» برقم مرجع واحد (ورقة طلب المخزون للمشتريات أو الإنتاج)",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب (403 «غير مسموح» للمندوب)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "صلاحية canManageVanStock (403 بلا code)",
     "warehouseEnabled يجب أن يكون true وإلا 403 WAREHOUSE_NOT_ENABLED «ميزة مخزون الشركة غير مفعلة لهذه الشركة»",
     "نطاق المستخدم: طلبات مناديبه وحدها",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "ref",
      "type": "string (1..40)",
      "required": true,
      "desc": "رقم مرجع الطلب العام في نظامكم، يُحفظ في sentRef لكل طلب مشمول"
     },
     {
      "name": "requests",
      "type": "array (1..500)",
      "required": true,
      "desc": "الطلبات المشمولة"
     },
     {
      "name": "requests[].id",
      "type": "string",
      "required": true,
      "desc": "معرّف طلب معلّق"
     },
     {
      "name": "requests[].updatedAt",
      "type": "string (ISO)",
      "required": true,
      "desc": "نسخة الطلب كما قرأتها"
     }
    ],
    "response": "{success:true, data:{sent}} — عدد الطلبات التي صارت SENT",
    "rules": [
     "كل شيء أو لا شيء: إن غاب طلب (أُرسل أو سُحب أو خارج النطاق) أو تغيّرت نسخته رُدّ 409 «تغيرت طلبات المناديب منذ فتح النافذة» ولم يُرسَل شيء",
     "الإرسال لا يُنشئ حركة مخزون ولا ملفاً: ورقة الطلب (PDF) تُبنى في المتصفح من الكميات المعتمدة، والتحميل الفعلي بـPOST /van-stock/loads",
     "decidedBy اسم صاحب المفتاح، أو «الدعم الفني» لمفتاح أصدره مزوّد الخدمة"
    ],
    "example": "{\"ref\":\"PR-2026-114\",\"requests\":[{\"id\":\"9c1e7a52-3d4b-4f60-8a21-5b6c7d8e9f00\",\"updatedAt\":\"2026-10-27T08:15:02.114Z\"}]}"
   },
   {
    "method": "POST",
    "path": "/rep-stock-requests/:id/reject",
    "purpose": "رفض طلب مندوب معلّق، فيراه المندوب «مرفوضاً» في تطبيقه",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب (403 «غير مسموح» للمندوب)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "صلاحية canManageVanStock (403 بلا code)",
     "warehouseEnabled يجب أن يكون true وإلا 403 WAREHOUSE_NOT_ENABLED «ميزة مخزون الشركة غير مفعلة لهذه الشركة»",
     "نطاق المستخدم: طلبات مناديبه وحدها",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "updatedAt",
      "type": "string (ISO)",
      "required": true,
      "desc": "نسخة الطلب كما قرأتها"
     }
    ],
    "response": "{success:true}",
    "rules": [
     "404 لطلب غير معلّق أو خارج النطاق، و409 إن عدّله المندوب بعد قراءتك",
     "الطلب المرفوض لا يعود معلّقاً، والمندوب يرفع طلباً جديداً"
    ],
    "example": "{\"updatedAt\":\"2026-10-27T08:15:02.114Z\"}"
   }
  ]
 },
 {
  "key": "lots",
  "title": "تتبّع اللوط (التشغيلات)",
  "overview": "مسارات /api/lots: بطاقات التشغيلات (اللوطات) وأرصدتها في المستودع وكل سيارة، والتسمية، والإيقاف والسحب، والتتبّع إلى العملاء. التشغيلة رقمٌ مطبَّع فريد لكل صنف (قصّ الأطراف ودمج المسافات والأرقام العربية والفارسية إلى لاتينية والأحرف اللاتينية كبيرة، حتى 64 حرفاً) بتاريخَي إنتاج وانتهاء YYYY-MM-DD، وحالة ACTIVE أو BLOCKED (بنوع HOLD إيقاف أو RECALL سحب)\nالميزة يفعّلها مزود الخدمة لكل شركة (lotTrackingEnabled في GET /company)، ثم تُفعَّل لكل صنف (lotTracked). الصنف المتتبَّع فعلياً = العلمان معاً. والمطفأة لا تغيّر سلوك أي مسار: لا فحوص تشغيلات ولا صفوف توزيع (withLots يُتجاهل، وموارد المزامنة الخمسة 403 LOTS_DISABLED ولا تُذكر في resources من /v1/me)، والإطفاء يُخفي التشغيلات وسجلّها ولا يحذفها. أما الأعمدة الجديدة في الصفوف القائمة فتظهر بلا أثر، بقيمها الافتراضية لشركةٍ لم تُفعَّل لها الميزة: lotTracked وlotTrackedSince في الصنف (وبعد إطفاء الميزة قد يبقى lotTracked=true من فترة تفعيلها، ولا أثر له حتى تُفعَّل الميزة)، وlotId (null) في بنود وارد المستودع، وlotTrackingEnabled وlotOnInvoice (false) في GET /company\nالحراس بالترتيب على كل مسارات المجموعة: المندوب مرفوض 403 «غير مسموح»، ثم النظام المحاسبي (403 ACCOUNTING_NOT_ALLOWED)، ثم عَلَم الشركة (403 LOTS_NOT_ALLOWED)، ثم صلاحية canManageVanStock (403 بلا code). ومسارا التبديل الجماعي والإعدادات يضيفان canManageProducts وcanManageCompanySettings. المفتاح «قراءة فقط» لا يتجاوز GET (403 API_KEY_FORBIDDEN)، وصاحب المفتاح المقيّد بنطاق يرى المستودع وسيارات مناديبه وحدها، ولا يوقف ولا يمدّ انتهاء تشغيلة لها حركات ولا يصحّح إلى غير المسمّى (403 LOT_SCOPED_USER)\nالأماكن: المستودع WAREHOUSE بدلو واحد SELLABLE، وكل سيارة VAN (مفتاحها salesRepId، ويبقى بعد حذف المندوب) بثلاثة دلاء: SELLABLE المتاح للبيع، وEXPIRED منتهي الصلاحية، وDAMAGED المرتجع التالف. لكل تشغيلة في كل مكان ودلو: raw الخام، وheld المحجوز (مرتجع إشعار دائن قياسي 01 بانتظار اعتماد الهيئة)، وusable الصالح = raw − held. وunknown «غير المسمّى» = رصيد الصنف − مجموع خام التشغيلات: رصيد ما قبل التفعيل والمرتجع الحرّ وما بلا تشغيلة، وقد يكون سالباً من تاريخ قبل التفعيل فيظهر عجزاً في GET /lots/health\nكل كمية في هذه المجموعة وفي حقول التشغيلات بالمسارات الأخرى بوحدة الأساس للصنف مهما كانت وحدة البند (كرتون من 24 = 24)، وبأربع خانات عشرية على الأكثر\nالقاعدة الحاكمة لكل مُصدِر ومنه المفتاح: لا يصير صالح أي تشغيلة سالباً، ولا ينقص غير المسمّى تحت min(0، ما كان) (409 LOT_STOCK_INSUFFICIENT)، ولا يُعفي منها canSellWithoutStock. البيع والتحميل من المستودع يوزّعهما الخادم بالأقرب انتهاءً (FEFO) من التشغيلات النشطة غير المنتهية يوم الشركة، ثم من غير المسمّى بيقين UNKNOWN. والإنقاص من السيارة (التنزيل والتسوية والإتلاف) من مصدر صريح، أو الوحيد في دلوه\nاليقين لكل صف توزيع: CONFIRMED مؤكد (صريح أو المصدر الوحيد)، وASSUMED مفترض (اختيار بقاعدة بين مصدرين أو وراثة)، وUNKNOWN غير معروف (lotId = null)\nالحقبة: تفعيل الشركة أو الصنف (أو إعادة تفعيله) يبدأ حقبة جديدة، وحركات التشغيلات قبلها لا تدخل الأرصدة وتبقى في التتبّع وسجل التدقيق. فبعد إعادة التفعيل يصير الرصيد المسمّى سابقاً «غير مسمّى» حتى يُسمّى بـPOST /lots/relabel\nالمفتاح عميلٌ حيّ: X-FS-Replay تُمحى من طلباته، فلا ينال تسامح صندوق تطبيق المندوب (التلميح والحجز للمراجعة LOT_REPLAY_HELD) ويُقاس الانتهاء بيوم الشركة بساعة الخادم. يوم الانتهاء نفسه آخر يوم صالح\nشكل أخطاء اللوط: {success:false, code, message, detail?}، وdetail فيه productId وفهرس السطر (line أو idx) والمطلوب والمتاح بحسب الرمز. 422 لرفض البيانات، و409 للرصيد والتعارض، و503 LOT_BUSY حين يكون الصنف مشغولاً بعملية تشغيلات أخرى (أعد المحاولة؛ في الفواتير بنفس clientRef). وأخطاء التحقق 400 كسائر المسارات\nالتحذيرات لا تمنع وتأتي في warnings:[{code, productId, detail?}] بجوار data: LOT_FROM_UNKNOWN، وLOT_SPLIT_UNIT، وLOT_INTO_BLOCKED، وLOT_MULTI_IN_VAN (وLOT_HINT_REJECTED وLOT_REPLAY_FLAGGED لإعادة رفع تطبيق المندوب وحدها)\nللسحب الكامل والانعكاس استعمل موارد المزامنة الخمسة: product-lots وvan-load-item-lots وinvoice-item-lots وlot-relabels وlot-events. ولا ربط خارجي للتشغيلات سوى هذه الواجهة: لا webhook ولا حقول في حمولة ERP",
  "endpoints": [
   {
    "method": "GET",
    "path": "/lots",
    "purpose": "بطاقات التشغيلات بحثاً وقائمة، مع ملخّص رصيد كل تشغيلة",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب (403 «غير مسموح» للمندوب)",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock (403 بلا code)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "q",
      "type": "string",
      "required": false,
      "desc": "بحث جزئي في رقم التشغيلة بعد تطبيعه أو في اسم الصنف (بلا حساسية لحالة الأحرف)"
     },
     {
      "name": "productId",
      "type": "string (uuid)",
      "required": false,
      "desc": "تشغيلات صنف واحد"
     },
     {
      "name": "status",
      "type": "enum: ACTIVE | BLOCKED",
      "required": false,
      "desc": "تصفية بالحالة، وغير ذلك يُهمل"
     },
     {
      "name": "expiringWithinDays",
      "type": "integer ≥ 0",
      "required": false,
      "desc": "ما ينتهي خلال N يوماً من يوم الشركة، والمنتهي فعلاً ضمنه. القيمة غير الصحيحة أو السالبة 400 «عدد الأيام غير صالح»"
     },
     {
      "name": "page",
      "type": "integer",
      "required": false,
      "desc": "رقم الصفحة، الافتراضي 1"
     },
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "حجم الصفحة، الافتراضي 50 وأقصاه 200"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, productId, lotNumber, productionDate, expiryDate, status, blockKind, blockedAt, createdAt, blockReason, blockedBy, note, source, createdBy, updatedAt, productName, productCode, productUnit, summary:{warehouse, vans:{SELLABLE, EXPIRED, DAMAGED}, held, vanCount, total}}], pagination:{total, page, limit, pages}, scoped}",
    "rules": [
     "الترتيب بالأقرب انتهاءً (بلا انتهاء آخراً) ثم برقم التشغيلة",
     "summary خام التشغيلة بالأساس: warehouse في المستودع (صفر حين يكون مخزون الشركة مطفأً)، وvans مجموع دلاء السيارات المرئية، وheld المحجوز في السيارات، وvanCount عدد السيارات التي فيها، وtotal المجموع. للتفصيل لكل سيارة GET /lots/:id",
     "source مصدر إنشاء البطاقة: RECEIVE وارد، وLOAD تحميل بلا مستودع أو تسوية، وOPENING_IMPORT استيراد افتتاحي، وRELABEL تسمية، وRETURN مرتجع، وMANUAL يدوي",
     "scoped = true لصاحب مفتاح مقيّد بنطاق: الملخّص بسيارات مناديبه وحدها"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/lots/balances",
    "purpose": "أرصدة تشغيلات صنف أو أصناف في المستودع وكل سيارة بالتفصيل، والمخزون في تاريخ مضى",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "نطاق المستخدم: سيارات مناديبه وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "productId",
      "type": "string (uuid)",
      "required": false,
      "desc": "صنف واحد. يلزم هو أو productIds وإلا 400 «حدد الصنف»"
     },
     {
      "name": "productIds",
      "type": "string (مفصولة بفاصلة) | مكرّر",
      "required": false,
      "desc": "حتى 50 صنفاً في الطلب وإلا 400. الصنف الذي ليس من الشركة يُسقط بصمت"
     },
     {
      "name": "asOf",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "الأرصدة في نهاية ذلك اليوم بتوقيت الشركة: حركات المستودع والسيارات والتسميات قبلها، والفواتير بتاريخها. غيابه = الآن"
     }
    ],
    "body": [],
    "response": "{success:true, data:{asOf, day, warehouse:[PlaceView], vans:[{salesRepId, repName, deleted, view:PlaceView}], scoped}} — PlaceView = {productId, place:'WAREHOUSE'|'VAN', vanKey, total:{SELLABLE, EXPIRED, DAMAGED}|null, lots:[{lotId, meta:{id, productId, lotNumber, productionDate, expiryDate, status, blockKind, blockedAt, createdAt}, raw, held, usable}], unknown, unknownUsable, deficits:[{lotId, bucket, qty}], approximate, availability:{available, availableNamed, availableUnknown, quarantined, expiredUnsold, held, expiredReturned, damaged, unknownDeficit}}",
    "rules": [
     "raw وheld وusable وtotal وunknown كائنات بالدلاء الثلاثة {SELLABLE, EXPIRED, DAMAGED} بالأساس. lots بالأقرب انتهاءً",
     "availability ليوم day: available ما يُباع ويُحمَّل الآن = availableNamed (تشغيلات نشطة غير منتهية) + availableUnknown (غير المسمّى الصالح)، وquarantined صالح التشغيلات الموقوفة، وexpiredUnsold صالح المنتهية غير المباعة، وheld المحجوز، وunknownDeficit العجز غير المسمّى",
     "warehouse فارغة حين يكون مخزون الشركة مطفأً. وvans للسيارات التي فيها شيء من الأصناف، وصاحب المفتاح غير المقيّد يرى معها سيارات المناديب المحذوفين (deleted = true، repName «مندوب محذوف») برصيد صنف مجهول: total وunknown null وapproximate = true",
     "deficits كل خام أو صالح سالب — خلل يُصحَّح، ويُجمع لكل الأصناف في GET /lots/health"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/lots/fefo",
    "purpose": "اقتراح تحميل صنف من المستودع بالأقرب انتهاءً (FEFO) قبل الحفظ — قراءة بلا قفل ولا كتابة",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "productId",
      "type": "string (uuid)",
      "required": true,
      "desc": "الصنف. غيابه 400 «حدد الصنف»، وصنف ليس من الشركة 404"
     },
     {
      "name": "qty",
      "type": "number > 0",
      "required": false,
      "desc": "الكمية بالأساس بأربع خانات على الأكثر (وإلا 422 LOT_QTY_INVALID) — لسطر واحد"
     },
     {
      "name": "unitFactor",
      "type": "number > 0",
      "required": false,
      "desc": "معامل وحدة السطر (24 لكرتون)، الافتراضي 1: يُؤخذ الكرتون من تشغيلة واحدة ما أمكن. غير الصالح 400 «معامل الوحدة غير صالح»"
     },
     {
      "name": "lines",
      "type": "string «كمية[:معامل]» مفصولة بفاصلة",
      "required": false,
      "desc": "بديل qty لعدة أسطر للصنف نفسه بوحدات مختلفة («48:24,5» = كرتونان وخمس حبات بالأساس)، حتى 50 سطراً. يُقترح لكل سطر من رصيد مشترك كما يوزّعه الحفظ"
     },
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": false,
      "desc": "سيارة الوجهة: يضيف تحذير LOT_MULTI_IN_VAN إن صار فيها أكثر من تشغيلة للصنف. مندوب ليس من الشركة أو خارج النطاق 404"
     }
    ],
    "body": [],
    "response": "{success:true, data:{rows:[{lotId, qty, certainty, flags, expiryDate}], lines:[{idx, qty, unitFactor, rows:[...]}], shortage?, warnings:[{code, productId, detail?}]}}. والصنف غير المتتبَّع أو مخزون الشركة المطفأ: {rows:[], lines (بلا صفوف), warnings:[], warehouse, tracked}",
    "rules": [
     "rows الاقتراح للمستند كله، وlines لكل سطر بفهرسه. lotId = null من الرصيد غير المسمّى بيقين UNKNOWN بعد نفاد التشغيلات الصالحة",
     "shortage حين لا يكفي الرصيد: تفاصيل النقص {productId, wanted, available, byLot, unknownUsable}، والاقتراح عندها لما يتوفر منه مقتطعاً على الأسطر (الكراتين أولاً)",
     "الاقتراح لا يحجز شيئاً: الحفظ في POST /van-stock/loads يعيد التوزيع والفحص تحت القفل، فأرسل الاقتراح في items[].lots أو اترك الخادم يوزّع بالقاعدة نفسها"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/lots/health",
    "purpose": "سلامة الأرصدة: كل رصيد تشغيلة أو رصيد غير مسمّى سالب في المستودع والسيارات لكل الأصناف المتتبَّعة",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{deficits:[{productId, productName, place:'WAREHOUSE'|'VAN', salesRepId, repName, lotId, lotNumber, bucket, qty}], scoped}}",
    "rules": [
     "qty سالبة بالأساس. lotId = null عجز في الرصيد غير المسمّى: غالباً من رصيد سالب قبل التفعيل، ويُصحَّح بتسوية موجبة بلا تشغيلة (items[].lots = [{lotId: null, qty}])",
     "صاحب المفتاح المقيّد يرى المستودع وسيارات مناديبه وحدها"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/lots",
    "purpose": "إنشاء بطاقة تشغيلة لصنف (بلا رصيد) — التشغيلات تُنشأ كذلك تلقائياً مع الوارد والتسمية برقمها",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "productId",
      "type": "string (uuid)",
      "required": true,
      "desc": "الصنف. ليس من الشركة 404 «الصنف غير موجود»"
     },
     {
      "name": "lotNumber",
      "type": "string ≤ 256 | number",
      "required": true,
      "desc": "رقم التشغيلة، يُطبَّع ويجب ألا يتجاوز 64 حرفاً بعد التطبيع (وإلا 400، ولا يُقصّ). الفارغ 422 LOT_REQUIRED"
     },
     {
      "name": "productionDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "تاريخ الإنتاج"
     },
     {
      "name": "expiryDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "تاريخ الانتهاء، إلزامي لصنف صلاحيته مفعّلة (422 LOT_EXPIRY_REQUIRED). الإنتاج بعد الانتهاء أو صيغة خاطئة 422 LOT_DATES_INVALID"
     },
     {
      "name": "note",
      "type": "string ≤ 500 | null",
      "required": false,
      "desc": "ملاحظة"
     }
    ],
    "response": "201 {success:true, data:{id, productId, lotNumber, productionDate, expiryDate, status:'ACTIVE', blockKind:null, blockedAt:null, createdAt, blockReason, blockedBy, note, source:'MANUAL', createdBy, updatedAt}} — 409 {success:false, code:'LOT_NUMBER_TAKEN', message, detail:{id, lotNumber}} للرقم المسجَّل لهذا الصنف (id البطاقة القائمة)",
    "rules": [
     "الرقم فريد لكل صنف بعد التطبيع: «b-12» و«B-12» تشغيلة واحدة",
     "يُسجَّل الإنشاء في سجل التدقيق (CREATE)",
     "لا رصيد للبطاقة حتى يدخلها وارد أو تسمية أو تحميل"
    ],
    "example": "{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"lotNumber\":\"B-2026-1031\",\"productionDate\":\"2026-10-20\",\"expiryDate\":\"2027-04-20\"}"
   },
   {
    "method": "POST",
    "path": "/lots/relabel",
    "purpose": "تسمية الرصيد القائم بتشغيلة، أو إعادة تصنيفه من تشغيلة إلى أخرى، أو تصحيحه إلى غير المسمّى — بُعد التشغيلة وحده بلا تغيير في رصيد الصنف ولا قيمته",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "السيارة ضمن نطاق صاحب المفتاح (وإلا 404 «المندوب غير موجود»)",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "productId",
      "type": "string (uuid)",
      "required": true,
      "desc": "صنف متتبَّع (وإلا 422 LOT_RELABEL_INVALID «فعّل تتبعه أولا»)"
     },
     {
      "name": "place",
      "type": "enum: WAREHOUSE | VAN",
      "required": true,
      "desc": "المستودع (يتطلب مخزون الشركة مفعّلاً، وإلا 422 LOT_RELABEL_INVALID) أو سيارة"
     },
     {
      "name": "salesRepId",
      "type": "string",
      "required": false,
      "desc": "سيارة المندوب، إلزامي مع VAN (وإلا 400 «حدد سيارة المندوب»). سيارة مندوب محذوف لها أثر محفوظ تُقبل لغير المقيّد"
     },
     {
      "name": "vanKey",
      "type": "string | null",
      "required": false,
      "desc": "مرادف salesRepId (مفتاح السيارة كما في موارد المزامنة)، ويغلبه إن أُرسلا معاً"
     },
     {
      "name": "bucket",
      "type": "enum: SELLABLE | EXPIRED | DAMAGED",
      "required": false,
      "desc": "الدلو، الافتراضي SELLABLE. المستودع SELLABLE وحده"
     },
     {
      "name": "fromLotId",
      "type": "string | null",
      "required": false,
      "desc": "المصدر: تشغيلة نشطة غير منتهية يوم الشركة (الموقوفة 422 LOT_BLOCKED والمنتهية 422 LOT_EXPIRED)، أو null/غياب = الرصيد غير المسمّى"
     },
     {
      "name": "reason",
      "type": "enum: LABEL_EXISTING | RECLASSIFY | CORRECTION",
      "required": true,
      "desc": "LABEL_EXISTING تسمية رصيد قائم، وRECLASSIFY نقل بين تشغيلتين، وCORRECTION تصحيح (إلزامي للإرجاع إلى غير المسمّى)"
     },
     {
      "name": "note",
      "type": "string ≤ 500 | null",
      "required": false,
      "desc": "ملاحظة، إلزامية مع الإرجاع إلى غير المسمّى (422 LOT_REASON_REQUIRED)"
     },
     {
      "name": "lines",
      "type": "array (1..20)",
      "required": true,
      "desc": "الوجهات وكمياتها"
     },
     {
      "name": "lines[].toLotId",
      "type": "string | null",
      "required": false,
      "desc": "تشغيلة قائمة للصنف نفسه (وإلا 422 LOT_NOT_FOUND أو LOT_PRODUCT_MISMATCH). الموقوفة تُقبل بتحذير LOT_INTO_BLOCKED"
     },
     {
      "name": "lines[].lotNumber",
      "type": "string | number",
      "required": false,
      "desc": "بديل toLotId: تشغيلة تُحلّ برقمها أو تُنشأ (المصدر RELABEL) مع تاريخيها. وبلا toLotId ولا lotNumber = إلى غير المسمّى: تصحيحٌ بـreason CORRECTION وnote، لمستخدم غير مقيّد (403 LOT_SCOPED_USER)"
     },
     {
      "name": "lines[].productionDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "للتشغيلة الجديدة برقمها. رقم مسجَّل بتواريخ أخرى 409 LOT_DATES_MISMATCH"
     },
     {
      "name": "lines[].expiryDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "للتشغيلة الجديدة، إلزامي لصنف صلاحيته مفعّلة (422 LOT_EXPIRY_REQUIRED)"
     },
     {
      "name": "lines[].qty",
      "type": "number > 0",
      "required": true,
      "desc": "الكمية بالأساس بأربع خانات على الأكثر (وإلا 422 LOT_QTY_INVALID)"
     }
    ],
    "response": "201 {success:true, data:{rows, warnings:[{code:'LOT_INTO_BLOCKED', productId, detail:{lotId, lotNumber, blockKind}}]}} — rows عدد الأسطر المكتوبة",
    "rules": [
     "مجموع الأسطر لا يتجاوز صالح المصدر في المكان والدلو، والمحجوز لا يُسمّى (409 LOT_STOCK_INSUFFICIENT)، وغير المسمّى لا يُنقص تحت min(0، ما كان)، وسيارة المندوب المحذوف لا يُسمّى من غير المسمّى فيها (رصيد صنفها مجهول)",
     "من التشغيلة إليها نفسها، أو من غير المسمّى إلى غير المسمّى: 422 LOT_RELABEL_INVALID",
     "يُكتب صف تسمية لكل سطر (مورد المزامنة lot-relabels) وحدث RELABEL في سجل كل تشغيلة في الطرفين، والكل في معاملة واحدة: رفضٌ واحد يلغي الطلب كله",
     "يوم التفعيل: سمِّ الرصيد القائم بعد الجرد بالسطر {lotNumber, productionDate, expiryDate, qty} من fromLotId = null"
    ],
    "example": "{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"place\":\"VAN\",\"salesRepId\":\"3f6c2a1e-8b4d-4c1a-9e2f-1a2b3c4d5e6f\",\"fromLotId\":null,\"reason\":\"LABEL_EXISTING\",\"lines\":[{\"lotNumber\":\"B-2026-0915\",\"productionDate\":\"2026-09-15\",\"expiryDate\":\"2027-03-15\",\"qty\":36}]}"
   },
   {
    "method": "POST",
    "path": "/lots/products/tracking",
    "purpose": "تشغيل تتبّع الأصناف بالتشغيلة أو إطفاؤه جماعياً: أصناف بعينها أو فئة أو الكل",
    "permission": "canManageVanStock + canManageProducts",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحيتا canManageVanStock وcanManageProducts (403 بلا code)",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "enabled",
      "type": "boolean",
      "required": true,
      "desc": "true تشغيل، وfalse إطفاء"
     },
     {
      "name": "productIds",
      "type": "string[] ≤ 1000",
      "required": false,
      "desc": "أصناف بعينها. يلزم واحد بالضبط من productIds وcategoryId وall وإلا 400 «حدد الأصناف أو الفئة أو الكل»"
     },
     {
      "name": "categoryId",
      "type": "string",
      "required": false,
      "desc": "كل أصناف الفئة غير المؤرشفة"
     },
     {
      "name": "all",
      "type": "true",
      "required": false,
      "desc": "كل أصناف الشركة غير المؤرشفة"
     },
     {
      "name": "confirmLotBalances",
      "type": "boolean",
      "required": false,
      "desc": "تأكيد إطفاء أصناف لها أرصدة في تشغيلات مسمّاة. بدونه 409 LOT_TRACKING_HAS_BALANCE"
     }
    ],
    "response": "{success:true, data:{updated, needsAttention:[{productId, name, warehouse:{total, unknown}|null, vans:[{salesRepId, total, unknown}]}]}} — 409 {success:false, code:'LOT_TRACKING_HAS_BALANCE', message, detail:{updated, products:[{productId, name, warehouse, vans:[{salesRepId, qty}], qty}]}}",
    "rules": [
     "updated عدد الأصناف التي تبدّلت فعلاً، والمساوية حالتها للمطلوب تُتخطّى",
     "needsAttention بعد التشغيل وحده: أصناف لها رصيد غير مسمّى أو سالب في المستودع أو السيارات المرئية (بالأساس) — إجراء يوم التفعيل: صحّح السالب بتسوية موجبة بلا تشغيلة، ثم سمِّ الرصيد بـPOST /lots/relabel",
     "التشغيل يبدأ حقبة جديدة لكل صنف، والإطفاء يُخفي ولا يحذف. ويُسجَّل لكل صنف TRACKING_ON أو TRACKING_OFF في سجل التدقيق",
     "الإطفاء يُفحص قبل أي تغيير، ثم يُنفَّذ على دفعات من 100 صنف كل منها في معاملة: إن رجع 409 أو 503 في منتصفه فـdetail.updated ما تبدّل قبله، وأعد الطلب نفسه فتُتخطّى المتبدّلة",
     "الصنف الواحد يُبدَّل كذلك بـPUT /products/:id بالحقلين lotTracked وconfirmLotBalances"
    ],
    "example": "{\"enabled\":true,\"categoryId\":\"3f2c1a9e-7b1d-4c2e-9a51-0d6e8f4b2c11\"}"
   },
   {
    "method": "PUT",
    "path": "/lots/settings",
    "purpose": "طباعة رقم التشغيلة على فاتورة العميل أو إيقافها",
    "permission": "canManageVanStock + canManageCompanySettings",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحيتا canManageVanStock وcanManageCompanySettings",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "lotOnInvoice",
      "type": "boolean",
      "required": true,
      "desc": "true يطبع رقم التشغيلة وانتهاءها تحت كل بند في ورقة الفاتورة"
     }
    ],
    "response": "{success:true, data:{lotOnInvoice}} — 404 «أكمل إعدادات الشركة أولا» لشركة بلا صف إعدادات",
    "rules": [
     "يُقرأ في GET /company بالحقل lotOnInvoice، ولا يمسّه PUT /company"
    ],
    "example": "{\"lotOnInvoice\":true}"
   },
   {
    "method": "GET",
    "path": "/lots/:id",
    "purpose": "بطاقة تشغيلة بأرصدتها في المستودع وكل سيارة",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{id, productId, lotNumber, productionDate, expiryDate, status, blockKind, blockedAt, createdAt, blockReason, blockedBy, note, source, createdBy, updatedAt, product:{id, name, code, unit, lotTracked, shelfLifeOn}, expired, day, inUse, summary:{warehouse, vans, held, vanCount, total, places:[{place, salesRepId, repName, deleted, raw, held, usable}]}, scoped}} — 404 {success:false, code:'LOT_NOT_FOUND', message, detail:{lotId}}",
    "rules": [
     "updatedAt نسخة البطاقة: أرسلها كما هي في PATCH /lots/:id وPATCH /lots/:id/status",
     "expired منتهية يوم الشركة day، وinUse لها حركات (فلا تُحذف، ومدّ انتهائها لغير المقيّد بسبب)",
     "places لكل مكان فيه التشغيلة بدلائه بالأساس، والمحذوفة سياراتهم لغير المقيّد وحده"
    ],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/lots/:id",
    "purpose": "تعديل تاريخي التشغيلة وملاحظتها (الرقم لا يتغيّر)",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "updatedAt",
      "type": "string (ISO)",
      "required": true,
      "desc": "نسخة البطاقة كما قرأتها. تغيّرت بعد قراءتك ⇒ 409 LOT_CHANGED فأعد القراءة"
     },
     {
      "name": "productionDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "الغياب يُبقي القيمة، وnull أو '' يمحوها"
     },
     {
      "name": "expiryDate",
      "type": "string (YYYY-MM-DD) | null",
      "required": false,
      "desc": "الغياب يُبقي القيمة. التقصير حرّ، أما مدّ الانتهاء أو محوه لتشغيلة لها حركات فلمستخدم غير مقيّد (403 LOT_SCOPED_USER) وبسبب (422 LOT_REASON_REQUIRED)"
     },
     {
      "name": "note",
      "type": "string ≤ 500 | null",
      "required": false,
      "desc": "الملاحظة"
     },
     {
      "name": "reason",
      "type": "string ≤ 500 | null",
      "required": false,
      "desc": "سبب التعديل، يُكتب في سجل التدقيق، وإلزامي لمدّ الانتهاء"
     }
    ],
    "response": "{success:true, data:<البطاقة بعد التعديل كما في POST /lots>}",
    "rules": [
     "422 LOT_DATES_INVALID للإنتاج بعد الانتهاء أو صيغة خاطئة، و422 LOT_EXPIRY_REQUIRED لمحو انتهاء صنف صلاحيته مفعّلة، و404 LOT_NOT_FOUND",
     "صلاحية بنود الفواتير الصادرة (لقطة الانتهاء وقت البيع) لا تتغيّر",
     "يُسجَّل في سجل التدقيق UPDATE_DATES أو UPDATE_NOTE بالقيم قبل وبعد"
    ],
    "example": "{\"expiryDate\":\"2027-05-20\",\"reason\":\"تصحيح تاريخ الطباعة من شهادة المصنع\",\"updatedAt\":\"2026-10-30T09:12:44.501Z\"}"
   },
   {
    "method": "PATCH",
    "path": "/lots/:id/status",
    "purpose": "إيقاف تشغيلة (HOLD) أو سحبها (RECALL) أو إعادة تنشيطها",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مستخدم غير مقيّد بنطاق، وإلا 403 LOT_SCOPED_USER",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [
     {
      "name": "status",
      "type": "enum: ACTIVE | BLOCKED",
      "required": true,
      "desc": "BLOCKED إيقاف أو سحب، وACTIVE إعادة تنشيط"
     },
     {
      "name": "blockKind",
      "type": "enum: HOLD | RECALL",
      "required": false,
      "desc": "نوع الإيقاف مع BLOCKED. غيابه يُبقي نوع الموقوفة أصلاً، وللنشطة HOLD. تنزيل السحب إلى إيقاف بـHOLD صريحاً"
     },
     {
      "name": "reason",
      "type": "string ≤ 500",
      "required": true,
      "desc": "السبب، إلزامي في الاتجاهين (422 LOT_REASON_REQUIRED)"
     },
     {
      "name": "updatedAt",
      "type": "string (ISO)",
      "required": true,
      "desc": "نسخة البطاقة كما قرأتها (409 LOT_CHANGED)"
     }
    ],
    "response": "{success:true, data:<البطاقة بحالتها الجديدة: status وblockKind وblockReason وblockedAt وblockedBy>}",
    "rules": [
     "الموقوفة لا تُباع ولا تُحمَّل ولا يُسمّى منها، ورصيدها في السيارات «معزول» داخل الرصيد ولا يُباع. تخرج بالتنزيل أو تسوية النقص أو الإتلاف",
     "بعد الإيقاف: GET /lots/:id/unload-plan ثم POST /van-stock/loads بالنوع UNLOAD وitems[].lots لكل سيارة، وGET /lots/:id/trace لقائمة العملاء",
     "تصعيد الإيقاف إلى سحب يُبقي blockedAt الأول. وإعادة التنشيط تمحو أعمدة الإيقاف",
     "يُسجَّل في سجل التدقيق BLOCK أو UNBLOCK بالحالة قبل وبعد. والطلب المساوي للحالة القائمة لا يغيّر شيئاً"
    ],
    "example": "{\"status\":\"BLOCKED\",\"blockKind\":\"RECALL\",\"reason\":\"سحب احترازي بطلب المصنع\",\"updatedAt\":\"2026-10-30T09:12:44.501Z\"}"
   },
   {
    "method": "DELETE",
    "path": "/lots/:id",
    "purpose": "حذف بطاقة تشغيلة لا حركات لها",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مفتاح قراءة فقط مرفوض 403 API_KEY_FORBIDDEN"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{id}} — 409 {success:false, code:'LOT_IN_USE', message} لتشغيلة لها وارد أو حركة سيارة أو بند فاتورة أو تسمية — 404 LOT_NOT_FOUND",
    "rules": [
     "سجل تدقيقها يبقى بعد الحذف ومعه حدث DELETE (GET /lots/:id/events ومورد lot-events)، وحذفها يصل المزامنة بغيابها من /v1/sync/product-lots/ids"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/lots/:id/trace",
    "purpose": "تتبّع تشغيلة: مصدرها وأماكنها والعملاء الذين استلموها وسجلّها — أساس السحب من السوق",
    "permission": "canManageVanStock (+ canManageCustomers لقائمة العملاء)",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "نطاق المستخدم: فواتير نطاقه وسيارات مناديبه",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "scope",
      "type": "enum: STRICT | BROAD",
      "required": false,
      "desc": "STRICT (الافتراضي) ما سُجّل بالتشغيلة نفسها. BROAD يضيف كل بيع للصنف من سيارةٍ أثناء وجود التشغيلة فيها، موسوماً broad بيقين ASSUMED وبكمية البند كلها"
     }
    ],
    "body": [],
    "response": "{success:true, data:{lot:{id, productId, lotNumber, productionDate, expiryDate, status, blockKind, blockedAt, createdAt, productName, source, note}, origin:[{kind, at, ref, qty}], places:[{place, salesRepId, repName, raw, usable, held, approximate, loaded, unloaded, sold, returned}], customers:[{customerId, name, phone, address, city, invoices:[{invoiceId, number, date, sold, returned, net, weakest, flags, broad}]}]|null, customersHidden, scoped, scope, events:[{kind, at, actorName, reason}]}}",
    "rules": [
     "origin مصادر دخول التشغيلة: kind = RECEIVE أو ADJUST (المستودع) أو OPENING_IMPORT أو LOAD أو ADJUST (سيارة بلا مستودع) أو RELABEL (موجبة إليها وسالبة منها) أو RETURN (مرتجع حرّ إليها)، وref معرّف الحركة",
     "customers كل من بيع له من التشغيلة ولو صار صافيه صفراً بمرتجع، والمرتجع المرتبط يُنسب لفاتورة بيعه. weakest أضعف يقين في صفوف الفاتورة: CONFIRMED أو ASSUMED أو UNKNOWN",
     "customers = null وcustomersHidden = true لصاحب مفتاح بلا canManageCustomers",
     "الكميات بالأساس. وسيارة المندوب المحذوف «مندوب محذوف» بـapproximate = true لغير المقيّد وحده"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/lots/:id/unload-plan",
    "purpose": "خطة تنزيل تشغيلة بعد إيقافها أو سحبها: كل سيارة فيها التشغيلة برصيدها",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "نطاق المستخدم: سيارات مناديبه وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{salesRepId, repName, deleted, usable:{SELLABLE, EXPIRED, DAMAGED}, held:{SELLABLE, EXPIRED, DAMAGED}}]}",
    "rules": [
     "لكل سيارة أرسل POST /van-stock/loads بالنوع UNLOAD وitems:[{productId, qty: usable.SELLABLE, lots:[{lotId, qty: usable.SELLABLE}]}] (الكمية بالأساس بلا unitId). وسيارة المندوب المحذوف (deleted = true) بـdeletedSalesRepId = salesRepId بدل salesRepId",
     "held محجوز بانتظار اعتماد إشعار دائن، لا يُنزَّل حتى يُعتمد. وEXPIRED وDAMAGED تُزالان بـEXPIRED_OUT وDAMAGED_OUT",
     "السيارات القائمة بالاسم أولاً ثم المحذوفة، والمحذوفة لغير المقيّد وحده"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/lots/:id/events",
    "purpose": "سجل تدقيق التشغيلة: كل تغيير عليها وعلى حالتها وتواريخها وتسميتها",
    "permission": "canManageVanStock",
    "gates": [
     "مستخدم شركة لا مندوب",
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة وإلا 403 LOTS_NOT_ALLOWED",
     "صلاحية canManageVanStock",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "limit",
      "type": "integer",
      "required": false,
      "desc": "عدد الأحداث، الافتراضي 200 وأقصاه 200 لطلبات المفتاح"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, lotId, productId, kind, before, after, reason, actorType, actorName, createdAt}], scoped}",
    "rules": [
     "الأحدث أولاً. kind = CREATE أو UPDATE_DATES أو UPDATE_NOTE أو BLOCK أو UNBLOCK أو RELABEL أو DELETE، وbefore وafter كائنا JSON بالقيم قبل التغيير وبعده",
     "actorType = ADMIN أو API_KEY أو OWNER أو STAFF (الدعم الفني لمزود الخدمة) أو SYSTEM، وactorName اسم الفاعل",
     "سجل التشغيلة المحذوفة يبقى ويُقرأ بمعرّفها. وصاحب المفتاح المقيّد لا يرى تسميات سيارات خارج نطاقه. ولكل أحداث الشركة ومعها تبديل تتبّع الأصناف (TRACKING_ON وTRACKING_OFF بلا lotId) استعمل مورد المزامنة lot-events",
     "أحداث التبديل في lot-events بلا lotId (فلا تظهر هنا) ونوعان: تبديل تتبّع صنفٍ productId فيه معرّف الصنف، وbefore وafter من الحقلين {lotTracked, lotTrackedSince} (وbefore = null لصنفٍ أُنشئ متتبَّعاً، وقد يُضاف created أو confirmLotBalances وnamedBalances). وتبديل مزود الخدمة للميزة على الشركة كلها حدثٌ على مستوى الشركة: productId = \"*\" (ليس معرّف صنف، فلا تربطه بجدول الأصناف) وbefore {lotTrackingEnabled} وafter {lotTrackingEnabled, lotTrackingSince}، وactorType = OWNER أو STAFF"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "field",
  "title": "الزيارات والتتبع وخطوط السير",
  "overview": "ثلاثة موجّهات: /visits لزيارات المناديب الميدانية مع صورها، و/tracking للخريطة الحية وخط سير المندوب الفعلي وإعداد التتبع، و/rep-routes لخطوط السير المخططة (قائمة عملاء مرتبة ليوم معيّن أو دائمة). المفتاح يعمل بهوية المستخدم الذي أصدره وأدواره وصلاحياته ونطاقه. المفتاح «قراءة فقط» يُرفض في POST وPATCH وDELETE برمز 403 API_KEY_FORBIDDEN. حد الطلبات 120 طلباً في الدقيقة لكل مفتاح، ويُرجع رأسي X-RateLimit-Limit وX-RateLimit-Remaining، وعند تجاوزه 429 API_RATE_LIMIT. شكل الرد دائماً {success, data} ولا يوجد ترقيم صفحات (pagination) في هذه المجموعة، والقوائم مسقوفة داخلياً. أخطاء التحقق من الحقول ترجع 400 بالشكل {success:false, message, errors}. انتبه للأيام: في /visits و/tracking اليوم يُحسب بتوقيت UTC، أي من الساعة 3 فجراً إلى 3 فجراً بتوقيت الرياض. أما /rep-routes فتقبل tzOffsetMin بالدقائق شرق UTC (الرياض 180). نقاط المندوب الخاصة بتطبيق الجوال (إرسال الموقع والنبضة وبصمة الحضور) لا يستعملها المفتاح\nوموجّه رابع /attendance-admin لتعديل بصمات الحضور إدارياً ورفعها دفعة واحدة: يشترط صلاحية canManageTracking وتفعيل ميزة بصمة الحضور للشركة (attendanceEnabled في GET /company، وإلا 403 ATTENDANCE_DISABLED). كل كتابة فيه تشترط سبباً مكتوباً من 3 إلى 300 حرف ويُدوَّن في سجل التدقيق باسم صاحب المفتاح، وتداخل الفترات يرجع 409 ATTENDANCE_OVERLAP مع conflict. والأيام فيه بمعامل tz بالدقائق شرق UTC (الرياض 180)، وافتراضه 0 أي أيام UTC",
  "endpoints": [
   {
    "method": "POST",
    "path": "/visits",
    "purpose": "تسجيل زيارة ميدانية لعميل باسم مندوب محدد، مع ملاحظة وصور وموقع ومدة اختيارية",
    "permission": "أي مستخدم شركة (ADMIN أو MANAGER أو ACCOUNTANT)، ولا يلزم إذن خاص لأن الموجّه لا يفحص canManageTracking",
    "gates": [
     "مفتاح القراءة فقط يُرفض (403 API_KEY_FORBIDDEN)",
     "نطاق المستخدم: canAccessRep على المندوب وcanAccessCustomer على العميل",
     "المندوب المفعّل له اشتراط تفعيل الموقع (requireLocationOn) لا تُسجّل زيارته نيابةً عنه ويرجع 403 VISIT_REP_ONLY"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "معرّف المندوب الذي تُنسب له الزيارة. إلزامي لمستخدم الشركة وإلا يرجع 400 «يجب تحديد المندوب». ليس ضمن مخطط zod ولا يُتحقق من صيغته، فاجلبه من قائمة المناديب"
     },
     {
      "name": "customerId",
      "type": "string",
      "required": false,
      "desc": "معرّف العميل. يجب إرسال customerId أو customerClientRef"
     },
     {
      "name": "customerClientRef",
      "type": "string (uuid)",
      "required": false,
      "desc": "بديل customerId لعميل أُنشئ بمرجع clientRef، ويحوّله الخادم إلى المعرّف الحقيقي. إن لم يوجد بعد يرجع 400 CUSTOMER_REF_PENDING"
     },
     {
      "name": "note",
      "type": "string (max 2000)",
      "required": false,
      "desc": "ملاحظة نصية عن الزيارة"
     },
     {
      "name": "lat",
      "type": "number (-90..90) | null",
      "required": false,
      "desc": "خط عرض موقع الزيارة"
     },
     {
      "name": "lng",
      "type": "number (-180..180) | null",
      "required": false,
      "desc": "خط طول موقع الزيارة"
     },
     {
      "name": "photos",
      "type": "string[] (max 8 items, each max 2,500,000 chars)",
      "required": false,
      "desc": "صور بصيغة data URL مثل data:image/jpeg;base64,... ويُفضّل ضغطها"
     },
     {
      "name": "clientRef",
      "type": "string (uuid)",
      "required": false,
      "desc": "مفتاح منع التكرار. إن سبق رفع زيارة بنفس القيمة تُعاد كما هي ولا تُنشأ ثانية"
     },
     {
      "name": "createdAt",
      "type": "string (ISO 8601)",
      "required": false,
      "desc": "لحظة الزيارة الفعلية، وإن غابت فلحظة الخادم. لا يُتحقق من صيغتها، والقيمة الفاسدة تسبب خطأ 500"
     },
     {
      "name": "startedAt",
      "type": "string (ISO 8601)",
      "required": false,
      "desc": "بداية مؤقّت الزيارة. يُرسل مع endedAt حتى تُحسب المدة"
     },
     {
      "name": "endedAt",
      "type": "string (ISO 8601)",
      "required": false,
      "desc": "نهاية مؤقّت الزيارة"
     },
     {
      "name": "clientDurationSec",
      "type": "number",
      "required": false,
      "desc": "المدة كما قاسها جهازك، وهي للمقارنة فقط ولا تُخزّن. المعتمد هو حساب الخادم من الطابعين"
     }
    ],
    "response": "201 بالشكل {success:true, data:{id, tenantId, salesRepId, customerId, note, lat, lng, clientRef, createdAt, receivedAt, startedAt, endedAt, durationSec, _count:{photos}}}. عند تكرار clientRef يرجع 200 بالشكل {success:true, data:<الزيارة القائمة>, idempotent:true}. محتوى الصور لا يُعاد في هذا الرد",
    "rules": [
     "فحص clientRef يجري قبل أي شيء آخر: الزيارة القائمة بنفس المرجع تُعاد بحالة 200 ولو اختلف المندوب أو العميل. إن كان عميلها خارج نطاقك يرجع 404",
     "سباق رفعين متزامنين بنفس clientRef يصطدم بالقيد الفريد (tenantId, clientRef) فيرجع 409 «السجل موجود مسبقا»",
     "يُشترط إرسال customerId أو customerClientRef، وإلا يرجع 400 «بيانات غير صحيحة»",
     "المندوب خارج نطاق المستخدم يرجع 404 «المندوب غير موجود»",
     "المندوب المفعّل له اشتراط تفعيل الموقع: الإدارة والمفتاح لا يسجّلان زيارته، ويرجع 403 VISIT_REP_ONLY",
     "العميل غير موجود في الشركة يرجع 404. العميل خارج نطاق المستخدم المقيّد يرجع 403 «هذا العميل غير مسند لك». لا يُفحص إسناد العميل للمندوب نفسه عند التسجيل نيابةً عنه",
     "المدة تُحسب على الخادم من startedAt وendedAt. إن كانت أقل من ثانيتين أو سالبة أو الطابع فاسداً تُحفظ الزيارة بلا توقيت دون رفض. ما زاد عن 4 ساعات يُقصّ إلى 14400 ثانية",
     "الحقل receivedAt يأخذ دائماً ساعة الخادم، وعليه تعتمد مزامنة /api/v1/sync للزيارات. أما createdAt فهو لحظة الزيارة",
     "لا تأثير مالياً ولا مخزنياً للزيارة. تظهر في الخريطة والتقارير وتُحسب منجزةً في خط السير المخطط لنفس العميل في اليوم نفسه",
     "سجلّان للعميل نفسه خلال 5 دقائق، أحدهما بمؤقّت والآخر ملاحظة أو صورة، يُعرضان ويُعدّان زيارة واحدة في القوائم والعدادات"
    ],
    "example": "{\"salesRepId\":\"3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c\",\"customerId\":\"8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f\",\"note\":\"عرض المنتجات الجديدة وطلب العميل زيارة الأسبوع القادم\",\"lat\":24.7136,\"lng\":46.6753,\"startedAt\":\"2026-10-11T07:30:00.000Z\",\"endedAt\":\"2026-10-11T07:52:00.000Z\",\"clientRef\":\"0b7c6a8e-3d1f-4c5e-9a2b-1f2e3d4c5b6a\"}"
   },
   {
    "method": "GET",
    "path": "/visits",
    "purpose": "قائمة زيارات مندوب واحد في يوم محدد، بلا محتوى الصور (عددها فقط)، والأحدث أولاً",
    "permission": "requireAdmin، أي أحد الأدوار ADMIN أو MANAGER أو ACCOUNTANT، ولا يلزم إذن خاص",
    "gates": [
     "نطاق المستخدم المقيّد: تظهر فقط الزيارات التي عميلها ومندوبها كلاهما ضمن نطاقه"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "معرّف المندوب. إن غاب يرجع 400"
     },
     {
      "name": "date",
      "type": "string YYYY-MM-DD",
      "required": false,
      "desc": "اليوم المطلوب بتوقيت UTC، وافتراضه اليوم الحالي. الصيغة غير الصحيحة تسبب خطأ 500"
     }
    ],
    "body": [],
    "response": "{success:true, data:[...]}. كل عنصر يمثّل وقفة عند عميل وفيه: id وtenantId وsalesRepId وcustomerId وnote (ملاحظات السجلات المدموجة مفصولة بسطر جديد) وlat وlng وclientRef وcreatedAt وreceivedAt وstartedAt وendedAt وdurationSec وcustomer:{id,name,phone} و_count:{photos} (مجموع صور السجلات المدموجة) وcustomerName وat",
    "rules": [
     "نافذة اليوم من date 00:00Z إلى +24 ساعة بتوقيت UTC",
     "لا ترقيم صفحات. السقف 500 سجل خام في اليوم",
     "سجل المؤقّت وسجل الملاحظة أو الصورة للعميل نفسه خلال 5 دقائق يُدمجان في عنصر واحد يحمل معرّف سجل المؤقّت",
     "لمحتوى الصور استدعِ GET /visits/:id"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/visits/count-by-rep",
    "purpose": "عدد زيارات كل مندوب في يوم واحد",
    "permission": "requireAdmin، أي أحد الأدوار ADMIN أو MANAGER أو ACCOUNTANT",
    "gates": [
     "نطاق المستخدم المقيّد يرشّح الزيارات"
    ],
    "query": [
     {
      "name": "date",
      "type": "string YYYY-MM-DD",
      "required": false,
      "desc": "اليوم بتوقيت UTC، وافتراضه اليوم الحالي"
     }
    ],
    "body": [],
    "response": "{success:true, data:{\"<salesRepId>\": <عدد الوقفات>, ...}}، والمندوب الذي ليس له زيارات لا يظهر",
    "rules": [
     "العدد للوقفات بعد دمج سجلَّي المؤقّت والملاحظة، لا للسجلات الخام، فيطابق القائمة",
     "السقف 20000 سجل في اليوم"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/visits/:id",
    "purpose": "تفاصيل زيارة واحدة مع صورها كاملة",
    "permission": "أي مستخدم شركة، ولا يوجد requireAdmin ولا إذن خاص",
    "gates": [
     "نطاق المستخدم المقيّد: الزيارة خارج النطاق ترجع 404"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{id, salesRepId, customerId, note, lat, lng, clientRef, createdAt, receivedAt, startedAt, endedAt, durationSec, customer:{id,name,phone}, salesRep:{id,name}, photos:[{id, data}]}}. الحقل data في الصور نص data URL كامل، وقد يصل حجم الرد إلى عدة ميغابايت",
    "rules": [
     "إن كانت الزيارة جزءاً من وقفة مدموجة (سجل مؤقّت مع سجل ملاحظة لنفس المندوب والعميل) يُعاد المدموج: id سجل المؤقّت وطوابعه ومدته، والملاحظات مجمّعة، وصور جميع السجلات. قد يختلف id في الرد عن id المطلوب",
     "غير الموجودة ترجع 404 «الزيارة غير موجودة»"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/tracking/settings",
    "purpose": "معرفة هل تتبع مواقع المناديب مفعّل على مستوى الشركة",
    "permission": "canManageTracking، وهو حارس على مستوى الموجّه كله",
    "gates": [
     "requireAdminPermission('canManageTracking') يمنع إن كانت قيمته false للمستخدم صاحب المفتاح"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{enabled:boolean}}، وافتراضه false",
    "rules": [
     "عند الإيقاف لا تُخزّن نقاط مواقع المناديب، باستثناء المندوب المفعّل له اشتراط تفعيل الموقع فموقعه يُخزّن دائماً"
    ],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/tracking/settings",
    "purpose": "تفعيل تتبع مواقع المناديب للشركة أو إيقافه",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "مفتاح القراءة فقط يُرفض"
    ],
    "query": [],
    "body": [
     {
      "name": "enabled",
      "type": "boolean",
      "required": true,
      "desc": "true للتفعيل وfalse للإيقاف"
     }
    ],
    "response": "{success:true, data:{enabled}}",
    "rules": [
     "يحدّث CompanySettings.trackingEnabled للشركة، فيتوقف تخزين مواقع المناديب أو يبدأ",
     "المندوب المستثنى (canBeTracked=false) لا يُتتبع ولو كان التتبع مفعّلاً، باستثناء المقيّد باشتراط الموقع"
    ],
    "example": "{\"enabled\":true}"
   },
   {
    "method": "GET",
    "path": "/tracking/live",
    "purpose": "آخر موقع معروف لكل مندوب نشط، مع عدد زياراته اليوم (الخريطة الحية)",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "نطاق المستخدم المقيّد يرشّح المناديب والزيارات"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, name, phone, isActive, lastLat, lastLng, lastSeenAt, lastLocAt, visitsToday}], serverNow}. الترتيب: الأحدث ظهوراً أولاً، ومن ليس له موقع في الآخر. lite=1 يعيد المواقع بلا visitsToday",
    "rules": [
     "يشمل كل المناديب النشطين ولو لم يرسلوا موقعاً بعد، وفي هذه الحالة lastLat وlastLng بقيمة null",
     "visitsToday يُحسب منذ منتصف ليل UTC اليوم، أي الثالثة فجراً بتوقيت الرياض، ويعدّ الوقفات لا السجلات",
     "يتحدّث lastSeenAt بنبضات تطبيق المندوب، فهو مؤشر الاتصال لا عمر الموقع",
     "lastLocAt لحظة التقاط lastLat وlastLng بساعة الخادم: موقعٌ عمره دقائق والمندوب متصل يعني أن موقعه متوقف"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/tracking/route",
    "purpose": "خط السير الفعلي لمندوب في يوم: نقاط GPS ومسار مطابق للشوارع وموقع بصمتَي الحضور والانصراف",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "المندوب خارج نطاق المستخدم يرجع 404",
     "إن أُطفئ «عرض خط السير على الخريطة» في إعدادات المندوب (showRouteOnMap=false) ترجع data فارغة وshape وsnapped فارغين وrouteHidden=true، وتبقى بصمتا الحضور والانصراف"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "معرّف المندوب، وإن غاب يرجع 400"
     },
     {
      "name": "date",
      "type": "string YYYY-MM-DD",
      "required": false,
      "desc": "اليوم بتوقيت UTC، وافتراضه اليوم الحالي"
     },
     {
      "name": "snap",
      "type": "string",
      "required": false,
      "desc": "أرسل 0 لإيقاف مطابقة الشوارع والحصول على النقاط الخام فقط، وهو أسرع. الافتراض تشغيل المطابقة"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{lat,lng,accuracy,speed,capturedAt}], snapped:[{lat,lng}]|null, shape:{segments:[{kind:'observed'|'inferred'|'raw', points:[{lat,lng}], meters}], observedMeters, inferredMeters, rawMeters, truncated, degraded}|null, checkIn:{lat,lng,at}|null, checkOut:{lat,lng,at}|null}. تنبيه: snapped وshape وcheckIn وcheckOut تأتي بجانب data في أعلى الرد وليست داخلها",
    "rules": [
     "النقاط مرتبة تصاعدياً بوقت الالتقاط، والسقف أول 5000 نقطة في اليوم",
     "المطابقة تستدعي خدمة خرائط خارجية. degraded=true يعني أن المرسوم خطوط مستقيمة وليس شوارع، وعندها snapped=null. وعند snap=0 تكون shape وsnapped بقيمة null",
     "checkIn هو أول بصمة حضور لها موقع في اليوم، وcheckOut آخر بصمة انصراف لها موقع",
     "accuracy بالأمتار وspeed بالمتر في الثانية"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/rep-routes/mine",
    "purpose": "خط السير المخطط لمندوب في يوم محدد، مع حالة إنجاز كل عميل من سجل الزيارات",
    "permission": "أي مستخدم شركة نشط بشرط ألا تكون قيمة canManageTracking لديه false، ويُفحص هذا داخل المعالج",
    "gates": [
     "المندوب خارج نطاق المستخدم يرجع 404",
     "محطات العملاء خارج نطاق المستخدم تُحجب وتُعدّ في hiddenByScope"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "معرّف المندوب، وهو إلزامي لمستخدم الشركة وإلا يرجع 400"
     },
     {
      "name": "date",
      "type": "string YYYY-MM-DD",
      "required": false,
      "desc": "اليوم المطلوب. إن غاب أو خالف الصيغة يُحسب من tzOffsetMin"
     },
     {
      "name": "tzOffsetMin",
      "type": "number",
      "required": false,
      "desc": "إزاحة المنطقة الزمنية بالدقائق شرق UTC، والرياض 180. تحدد اليوم ونافذة احتساب الزيارات، وافتراضها 0"
     }
    ],
    "body": [],
    "response": "{success:true, data:null} إن لم يوجد خط. وإلا {success:true, data:{id, name, isPermanent, routeDate, day, stops:[{id, seq, note, customerId, customerName, phone, address, lat, lng, done, doneAt}], doneCount, total, hiddenByScope}}",
    "rules": [
     "الخط المؤقت لهذا اليوم يتقدم على الخط الدائم",
     "الخط الدائم لا يسري على يوم سابق لتاريخ إنشائه",
     "done يعني وجود زيارة للعميل من هذا المندوب داخل يوم المندوب بحسب tzOffsetMin، فالإنجاز مشتق من الزيارات ولا يُخزّن"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/rep-routes",
    "purpose": "كل خطوط السير النشطة في الشركة مع تقدّم اليوم لكل خط",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "نطاق المستخدم المقيّد: خطوط مناديبه فقط"
    ],
    "query": [
     {
      "name": "date",
      "type": "string YYYY-MM-DD",
      "required": false,
      "desc": "اليوم المرجعي لحساب doneToday"
     },
     {
      "name": "tzOffsetMin",
      "type": "number",
      "required": false,
      "desc": "إزاحة المنطقة الزمنية بالدقائق شرق UTC، والرياض 180"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, name, isPermanent, routeDate, salesRepId, salesRepName, total, doneToday}]}. doneToday بقيمة null للخط المؤقت الخاص بيوم غير اليوم المرجعي",
    "rules": [
     "لا ترقيم صفحات. يعيد كل الخطوط النشطة، ومنها خطوط مؤقتة لأيام ماضية ما لم تُوقف",
     "الترتيب: الخطوط المؤقتة أولاً، ثم routeDate تنازلياً، ثم createdAt تنازلياً"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/rep-routes/:id",
    "purpose": "تفاصيل خط سير للتحرير: محطاته بترتيبها",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "خط مندوب خارج النطاق يرجع 404"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{id, name, isPermanent, routeDate, salesRepId, stops:[{customerId, seq, note, customerName}]}}",
    "rules": [
     "لا يرشّح على isActive، فيمكن قراءة خط أُوقف أو استُبدل بمعرّفه",
     "الرد لا يتضمن الحقل isActive"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/rep-routes",
    "purpose": "إنشاء خط سير لمندوب أو استبدال خط قائم (لا يوجد تعديل جزئي)",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "مفتاح القراءة فقط يُرفض",
     "المندوب خارج النطاق يرجع 404",
     "العملاء خارج نطاق المستخدم أو خارج الشركة يُسقطون مع تحذير"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف المندوب"
     },
     {
      "name": "name",
      "type": "string (1..80)",
      "required": true,
      "desc": "اسم الخط، مثل خط الأحد شمال الرياض"
     },
     {
      "name": "isPermanent",
      "type": "boolean",
      "required": false,
      "desc": "true لخط يتكرر كل يوم، وfalse (الافتراضي) لخط يوم واحد"
     },
     {
      "name": "routeDate",
      "type": "string YYYY-MM-DD | null",
      "required": false,
      "desc": "إلزامي إذا كان isPermanent=false، ويُهمل للخط الدائم"
     },
     {
      "name": "replacesId",
      "type": "string (uuid) | null",
      "required": false,
      "desc": "معرّف الخط الذي يحل هذا محلّه، ويُوقف داخل المعاملة نفسها"
     },
     {
      "name": "stops",
      "type": "array (min 1)",
      "required": true,
      "desc": "محطات الخط، وترتيب المصفوفة هو ترتيب الزيارة"
     },
     {
      "name": "stops[].customerId",
      "type": "string (uuid)",
      "required": true,
      "desc": "معرّف العميل، ولا يتكرر في الخط الواحد"
     },
     {
      "name": "stops[].note",
      "type": "string (max 200) | null",
      "required": false,
      "desc": "ملاحظة للمندوب على هذه المحطة"
     }
    ],
    "response": "201 بالشكل {success:true, data:{id}, warning?}. يظهر warning مثل «2 عميل خارج نطاقك لم يُضَف» حين تُسقط محطات",
    "rules": [
     "خط واحد لكل حالة: إنشاء خط دائم يوقف تلقائياً الخط الدائم النشط السابق للمندوب، وخط مؤقت يوقف المؤقت النشط لنفس المندوب ونفس اليوم",
     "replacesId يوقف ذلك الخط أيضاً ولو تغيّر نوعه أو تاريخه أو مندوبه، وهو طريقة التعديل",
     "seq يُرقّم من 1 بحسب موضع المحطة في المصفوفة",
     "العملاء غير الموجودين في الشركة أو خارج نطاق المستخدم يُسقطون بصمت مع warning. إن لم يبقَ أحد يرجع 400 «لا عملاء صالحين في خط السير»",
     "تكرار customerId في stops يصطدم بالقيد الفريد (routeId, customerId) فتُلغى المعاملة كلها ويرجع 409 «السجل موجود مسبقا»",
     "لا يُفحص إسناد العميل للمندوب. محطة لعميل غير مُسنَد للمندوب، عند تفعيل عزل العملاء، تُحجب عنه في تطبيقه وتُعدّ في hiddenByScope",
     "خط مؤقت بلا routeDate يرجع 400 مع خطأ على الحقل routeDate"
    ],
    "example": "{\"salesRepId\":\"3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c\",\"name\":\"خط الأحد شمال الرياض\",\"isPermanent\":false,\"routeDate\":\"2026-10-12\",\"stops\":[{\"customerId\":\"8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f\",\"note\":\"تحصيل الفاتورة المتأخرة\"},{\"customerId\":\"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d\"}]}"
   },
   {
    "method": "DELETE",
    "path": "/rep-routes/:id",
    "purpose": "إيقاف خط سير. هذا تعطيل وليس حذفاً، فالسجل يبقى",
    "permission": "requireAdmin مع canManageTracking",
    "gates": [
     "مفتاح القراءة فقط يُرفض",
     "خط مندوب خارج النطاق يرجع 404"
    ],
    "query": [],
    "body": [],
    "response": "{success:true}",
    "rules": [
     "يضبط isActive=false فقط. استدعاؤه على خط موقوف مسبقاً ينجح أيضاً",
     "الخط غير الموجود يرجع 404 «خط السير غير موجود»"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/attendance-admin/rows",
    "purpose": "بصمات مندوب في مدى أيام مع سجل تدقيق تعديلاتها — لنافذة التعديل",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: مناديبه وحدهم (404 لغيرهم)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "المندوب"
     },
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": true,
      "desc": "أول يوم"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": true,
      "desc": "آخر يوم ويشمل يومه. المدى من يوم إلى 31 يوماً وإلا 400"
     },
     {
      "name": "tz",
      "type": "integer -840..840",
      "required": false,
      "desc": "إزاحة التوقيت بالدقائق شرق UTC لحدود الأيام (الرياض 180). الافتراضي 0 = أيام UTC"
     }
    ],
    "body": [],
    "response": "{success:true, data:{rows:[{id, salesRepId, checkInAt, checkOutAt, checkInLat, checkInLng, checkOutLat, checkOutLng, checkInDevice, checkOutDevice, checkInOutside, checkInDistanceM, checkOutOutside, checkOutDistanceM, source, editedAt, editedBy}], audit:[{id, attendanceId, action, before, after, reason, actorName, createdAt}]}}",
    "rules": [
     "الصفوف بالحضور تصاعدياً وحتى 500، والسجل الأحدث أولاً وحتى 100",
     "source: APP (بصمة التطبيق) أو ADMIN (أُضيفت يدوياً) أو IMPORT (من الرفع)، وeditedAt/editedBy لما عُدّل"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/attendance-admin/rows",
    "purpose": "إضافة فترة حضور يدوياً (حضور وانصراف، أو حضور مفتوح)",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: مناديبه وحدهم (404 لغيرهم)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepId",
      "type": "string",
      "required": true,
      "desc": "المندوب"
     },
     {
      "name": "checkInAt",
      "type": "ISO date-time",
      "required": true,
      "desc": "وقت الحضور"
     },
     {
      "name": "checkOutAt",
      "type": "ISO date-time | null",
      "required": false,
      "desc": "وقت الانصراف، وغيابه حضور مفتوح"
     },
     {
      "name": "reason",
      "type": "string 3-300",
      "required": true,
      "desc": "سبب الإضافة، ويُدوَّن في السجل"
     }
    ],
    "response": "201 {success:true, data:{id, salesRepId, checkInAt, checkOutAt, checkInLat, checkInLng, checkOutLat, checkOutLng, checkInDevice, checkOutDevice, checkInOutside, checkInDistanceM, checkOutOutside, checkOutDistanceM, source, editedAt, editedBy}} بمصدر ADMIN",
    "rules": [
     "لا مستقبل، والانصراف بعد الحضور، ولا فترة فوق 24 ساعة، ولا أقدم من 400 يوم — وإلا 400 برسالة القاعدة",
     "التداخل مع فترة قائمة للمندوب 409 ATTENDANCE_OVERLAP مع conflict:{checkInAt, checkOutAt}"
    ],
    "example": "{\"salesRepId\":\"<salesRepId>\",\"checkInAt\":\"2026-10-25T05:00:00Z\",\"checkOutAt\":\"2026-10-25T13:00:00Z\",\"reason\":\"نسي البصمة صباحاً\"}"
   },
   {
    "method": "PUT",
    "path": "/attendance-admin/rows/:id",
    "purpose": "تعديل وقتي فترة، أو إغلاق نوبة مفتوحة على وقتها الحقيقي",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: مناديبه وحدهم (404 لغيرهم)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "checkInAt",
      "type": "ISO date-time",
      "required": true,
      "desc": "وقت الحضور"
     },
     {
      "name": "checkOutAt",
      "type": "ISO date-time | null",
      "required": true,
      "desc": "وقت الانصراف، أو null لإبقائها مفتوحة"
     },
     {
      "name": "reason",
      "type": "string 3-300",
      "required": true,
      "desc": "سبب التعديل"
     }
    ],
    "response": "{success:true, data:{id, salesRepId, checkInAt, checkOutAt, checkInLat, checkInLng, checkOutLat, checkOutLng, checkInDevice, checkOutDevice, checkInOutside, checkInDistanceM, checkOutOutside, checkOutDistanceM, source, editedAt, editedBy}}",
    "rules": [
     "الحقلان يُرسلان معاً دائماً (كتابة كاملة للفترة)",
     "السجل يحفظ القيمتين قبل وبعد، وبصمة التطبيق المعدّلة تبقى موسومة editedAt"
    ],
    "example": ""
   },
   {
    "method": "DELETE",
    "path": "/attendance-admin/rows/:id",
    "purpose": "حذف فترة بسبب مكتوب — تبقى في سجل التدقيق بوقتيها ومصدرها",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: مناديبه وحدهم (404 لغيرهم)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "reason",
      "type": "string 3-300",
      "required": true,
      "desc": "سبب الحذف في الجسم وحده (Content-Type: application/json مع DELETE)، وغيابه 400"
     }
    ],
    "response": "{success:true}",
    "rules": [
     "السبب لا يُقرأ من الرابط (?reason=) عمداً: نص حرّ قد يحوي معلومة شخصية عن المندوب، والرابط يُكتب كاملاً في سجلات الوصول وسجلات الوسطاء"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/attendance-admin/presence",
    "purpose": "نتائج «التحقق العشوائي من التواجد» في مدى أيام — لتقرير ساعات العمل",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: بلا salesRepId تُصفّى النتائج بمناديبه، وsalesRepId لمندوب خارج نطاقه أو غير موجود 404",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": true,
      "desc": "أول يوم (يوم نوبة المندوب)"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": true,
      "desc": "آخر يوم. المدى حتى 93 يوماً وإلا 400"
     },
     {
      "name": "tz",
      "type": "integer -840..840",
      "required": false,
      "desc": "يُقبل ويُتحقق منه (عدد صحيح بين -840 و840 وإلا 400) ولا أثر له في النتيجة: التصفية على اليوم المحفوظ مع كل تحقق (day، يوم نوبة المندوب)"
     },
     {
      "name": "salesRepId",
      "type": "string",
      "required": false,
      "desc": "حصر بمندوب، وغيابه كل مناديب النطاق"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, salesRepId, day, status, dueAt, sentAt, respondedAt, delaySec, lat, lng, accuracy, distanceM, device, otherDevice, pushSent}]}",
    "rules": [
     "المواعيد القادمة (SCHEDULED) لا تُعاد",
     "حتى 5000 صف بموعدها تصاعدياً"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/attendance-admin/reps",
    "purpose": "مناديب النطاق بأسماء مستخدميهم — لمطابقة ملف الرفع",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: القائمة مصفّاة بمناديبه (لا 404 في هذا المسار)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, name, username}]}",
    "rules": [
     "تشمل المناديب الموقوفين (لا تصفية بـisActive) مرتبين بالاسم، حتى 5000 مندوب"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/attendance-admin/import",
    "purpose": "رفع بصمات دفعة واحدة (من Excel أو نظام حضور آخر) — كل صف يُحكم وحده",
    "permission": "canManageTracking",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageTracking')",
     "attendanceEnabled: 403 ATTENDANCE_DISABLED",
     "نطاق المستخدم: مناديبه وحدهم — لكن المندوب خارج النطاق (أو خارج الشركة) لا يُرجع الطلب كله 404: يعود صفّه في rejected[] برسالة «المندوب غير موجود» ويُكتب المقبول من غيره",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "reason",
      "type": "string 3-300",
      "required": true,
      "desc": "سبب الرفع، ويُدوَّن سطراً لكل مندوب"
     },
     {
      "name": "rows",
      "type": "array 1-2000",
      "required": true,
      "desc": "الصفوف"
     },
     {
      "name": "rows[].salesRepId",
      "type": "string",
      "required": true,
      "desc": "المندوب"
     },
     {
      "name": "rows[].checkInAt",
      "type": "ISO date-time",
      "required": true,
      "desc": "وقت الحضور"
     },
     {
      "name": "rows[].checkOutAt",
      "type": "ISO date-time | null",
      "required": false,
      "desc": "وقت الانصراف"
     }
    ],
    "response": "{success:true, data:{created, rejected:[{index, message}]}}",
    "rules": [
     "الملف ليس Excel: حوّله في نظامك إلى صفوف JSON بأوقات ISO (بتوقيتك) ومعرّفات المناديب",
     "المقبول يُكتب بمصدر IMPORT، والمرفوض يعود برقم صفه وسببه (مندوب خارج النطاق، أو مخالف للحدود، أو متداخل مع القائم أو مع صف آخر في الملف)",
     "الرفع كله معاملة واحدة: إما يُكتب كل المقبول أو لا شيء. فوق 2000 صف 400 IMPORT_TOO_MANY_ROWS"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "reports",
  "title": "التقارير ولوحة المؤشرات وبيانات الشركة والإشعارات",
  "overview": "كل المسارات تحت https://api.fieldsa.net/api وتقبل مفتاح الشركة في Authorization: Bearer fsk_... أو في الترويسة X-API-Key، ويعمل المفتاح بهوية المستخدم الذي أصدره (ADMIN أو MANAGER أو ACCOUNTANT) فتسري عليه صلاحياته ونطاقه. لا يقع أي من هذه المسارات ضمن البادئات الممنوعة على المفاتيح. حد الطلبات 120 في الدقيقة لكل مفتاح (X-RateLimit-Limit و429 API_RATE_LIMIT). المفتاح المضبوط «قراءة فقط» لا يمر إلا بطلبات GET وHEAD، فيُرفض عليه PUT /company وPATCH للإشعارات برمز 403 API_KEY_FORBIDDEN. لا يوجد ترقيم صفحات (page/limit) في أي مسار من هذه المجموعة، وبعضها يرجع كل الصفوف دفعة واحدة، فاستعمل مدى زمنياً ضيقاً. التواريخ في from وto بصيغة YYYY-MM-DD وتُفسَّر على أنها منتصف ليل UTC، وقيمة to تشمل يومها كاملاً، إلا في work-hours وrep-ranking حيث تُحسب بالتوقيت المحلي عبر tz، وفي payment-methods حيث تُحسب بأيام الشركة المحلية (المنطقة الزمنية لإعداد الشركة) والافتراض اليوم. التقارير (/reports) لا يحجبها إطفاء النظام المحاسبي إلا اثنان: GET /reports/payment-methods (403 ACCOUNTING_NOT_ALLOWED قبل فحص عَلَم صفحتها)، وGET /reports/rep-ranking بالمعيارين الماليين sales وproduct (403 ACCOUNTING_NOT_ALLOWED؛ والمعايير الأخرى تعمل). أما لوحة المؤشرات (/dashboard) فتُرجع أصفاراً حين يكون مطفأً. أخطاء التحقق من الجسم ترجع 400 بالشكل {success:false, message, errors:{field:[...]}}. ميزة «الفرق»: معظم التقارير تقبل teamId (معرّف فريق أو none)، وللفلتر معنيان بحسب ما يقوم عليه الرقم:\n- بوسم المستند: sales وorders وreturns وcollections وcustomer-visits وpayment-methods، ومبيعات وتحصيل وزيارات rep-performance، والمعايير sales وproduct وvisits في rep-ranking، وزيارات work-hours. المستند يحمل فريقاً واحداً، فمجموع الفرق مع none يساوي إجمالي الشركة بلا ازدواج.\n- بعضوية المندوب الحالية في الفريق: rep-receivables كلها، وساعات work-hours وجلساتها وبصماتها ونقاطها، وworkMinutes في rep-performance، والمعياران distance وappTime في rep-ranking. هذه لا تنقسم بالفريق، فالمندوب في فريقين يُحسب كاملاً تحت كليهما ولا يصح جمع الفرق.\nوصف كل تقرير يذكر معناه.",
  "endpoints": [
   {
    "method": "GET",
    "path": "/reports/sales",
    "purpose": "تقرير المبيعات المؤكدة بدون المرتجعات، إما تفصيلياً بالفواتير وبنودها أو مجمّعاً حسب الصنف أو المندوب أو العميل أو القناة أو المدينة",
    "permission": "canViewReports (الأدوار ADMIN وMANAGER وACCOUNTANT)",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم المقيّد: لا تظهر إلا فاتورة عميلها ومندوبها كلاهما ضمن نطاقه (قاعدة AND)",
     "لا يحجبه إطفاء النظام المحاسبي (لا يمر بـ requireAccounting)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى على invoiceDate، تُفسَّر منتصف ليل UTC"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى شاملة اليوم كاملاً (أقل من to مضافاً إليه 24 ساعة)"
     },
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": false,
      "desc": "حصر التقرير بمندوب واحد"
     },
     {
      "name": "customerId",
      "type": "string (uuid)",
      "required": false,
      "desc": "حصر التقرير بعميل واحد"
     },
     {
      "name": "groupBy",
      "type": "enum: product | rep | customer | channel | region",
      "required": false,
      "desc": "نوع التجميع، وبدونه أو بقيمة غير معروفة يرجع التقرير التفصيلي مع الملخص"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams لحصر التقرير بمستندات الفريق (بوسم المستند)، أو none لما بلا فريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "بدون groupBy: {success:true, data:{invoices:[صف الفاتورة كاملاً بكل أعمدتها ومنها number وtype وinvoiceDate وsubtotal وdiscountAmt وtaxAmt وtotal وpaidAmt وremainingAmt وpricesIncludeTax، مع customer{id,name,channel,city} وsalesRep{id,name} أو null وitems[صف البند كاملاً ومنه qty وunitPrice وunitCost وdiscountAmt وtaxPct وtaxAmt وlineTotal وunitName وunitFactor وbaseQty مع product{id,name,code,unit} أو null]], summary:{total, count, taxTotal, discountTotal, defaultRangeDays?}}}. مع groupBy=product تكون data مصفوفة [{productId, name, code, qty, baseQty, unit, units:[{name, factor}], total}] حيث total مجموع lineTotal. ومع rep أو customer أو channel أو region تكون data مصفوفة [{name, count, total}]. كل التجميعات مرتبة تنازلياً حسب total",
    "rules": [
     "الحالة CONFIRMED وحدها، والنوع RETURN مستثنى",
     "بلا from ولا to يُقصر التقرير على آخر 90 يوماً، ويُعلن ذلك بـ summary.defaultRangeDays=90 في الوضع التفصيلي وحده، أما مع groupBy فيُطبَّق السقف دون إعلان",
     "يكفي طرف واحد من المدى، والطرف الغائب يعني بلا حد من جهته",
     "لا ترقيم ولا حد أقصى للصفوف، والفواتير مرتبة تصاعدياً بـ invoiceDate",
     "groupBy=rep يجمع الفواتير التي بلا مندوب تحت «بلا مندوب»، وproduct يجمع البند الذي بلا منتج تحت «صنف محذوف»، وchannel يجمع العميل الذي بلا قناة تحت UNSET، وregion يجمّع حسب customer.city وغيابها «—»",
     "المبالغ في هذا التقرير كما خُزّنت في الفاتورة: total شامل الضريبة، وsubtotal وdiscountAmt صافيان قبل الضريبة",
     "الوحدات: في التفصيلي qty البند بوحدته وunitPrice وunitCost لوحدته (الكرتون لبند بالكرتون)، وbaseQty بالأساس. ومع groupBy=product تُجمع الكمية بوحدة الأساس unit (qty = baseQty)، وunits وحدات الصنف النشطة من الأكبر لعرضها «2 كرتون و3 حبة». صنفٌ بلا وحدات: الأرقام كما كانت"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/orders",
    "purpose": "تقرير الطلبات، وهي الفواتير التي حُدّد لها تاريخ تسليم، مرتبة حسب الأقرب تسليماً",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم المقيّد (قاعدة AND على العميل والمندوب)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى على deliveryDate وليس على invoiceDate"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى على deliveryDate شاملة اليوم كاملاً"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams لحصر التقرير بمستندات الفريق (بوسم المستند)، أو none لما بلا فريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:{orders:[{id, number, invoiceDate, deliveryDate, total, paidAmt, status, customer{id,name,phone,city}, salesRep{id,name} أو null}], summary:{count, total, paid}, rangeApplied:boolean, defaultDays:90 أو null}}",
    "rules": [
     "الشرط الأساسي أن يكون deliveryDate غير فارغ",
     "تُستثنى الحالة CANCELLED فقط، فتدخل المسودات DRAFT، ولا يوجد فلتر على نوع المستند",
     "بلا from ولا to يُطبَّق deliveryDate أكبر من أو يساوي الآن ناقص 90 يوماً بلا حد أعلى، فتدخل التسليمات المستقبلية",
     "الحد الأقصى 5000 صف مرتبة تصاعدياً بـ deliveryDate"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/returns",
    "purpose": "تقرير المرتجعات: كل مرتجع مؤكد بسببه وبنوده وفاتورة البيع التي أُرجع منها، مع نسبة المرتجع من المبيعات",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى على invoiceDate (منتصف ليل UTC)"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى شاملة اليوم. بلا from وto: آخر 90 يوماً"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams لحصر التقرير بمستندات الفريق (بوسم المستند)، أو none لما بلا فريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     },
     {
      "name": "withLots",
      "type": "1 | true",
      "required": false,
      "desc": "«تتبّع اللوط»: يضيف لكل بند مرتجع lots:[{id, invoiceItemId, invoiceId, productId, vanKey, lotId, quantity, certainty, expiryDate, sourceItemLotId, flags, createdAt, lot:{lotNumber, expiryDate}|null}] بتشغيلاته (الكمية بوحدة الأساس، وlotId = null «غير معروف»، وsourceItemLotId صفّ البيع الذي ورثه المرتجع المرتبط) حين تكون الميزة مفعّلة للشركة، وإلا يُهمل. بند صنف غير متتبَّع lots فارغة"
     }
    ],
    "body": [],
    "response": "{success:true, data:{returns:[{id, number, invoiceDate, total, taxAmt, reason, returnToStock, toDamagedStock, creditNote, notes, saleInvoices:[number], customer{id,name,phone,city}, salesRep{id,name}, items:[{name, unit, qty, unitFactor, baseQty, baseUnit, lineTotal, returnExpired, expiresAt}]}], summary:{count, total, salesTotal, returnRate, byReason:{NORMAL|DAMAGED|EXCHANGE:{count,total}}, expiredLines}, rangeApplied, defaultDays}}",
    "rules": [
     "returnRate نسبة المرتجع من مبيعات المدى نفسه بمنزلة عشرية واحدة، وnull بلا مبيعات",
     "saleInvoices أرقام فواتير البيع: الأصل للإشعار الدائن، أو فواتير البنود المرتبطة للمرتجع من فاتورة بيع في المرحلة الأولى",
     "toDamagedStock = true للتالف الذي دخل رصيد «المرتجع التالف» في السيارة (لا يُباع)",
     "حتى 5000 مرتجع، الأحدث أولاً",
     "unit وحدة البند المرتجع كما كُتب (لقطته، وإلا وحدة الصنف) وqty بها، وbaseQty بوحدة الأساس baseUnit: حبةٌ أُرجعت من بند كرتون تظهر «1 حبة» لا «1 كرتون»"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/lot-sales",
    "purpose": "«تتبّع اللوط»: المبيعات حسب التشغيلة — لكل صنف وتشغيلة المباع والمرتجع والصافي وعدد العملاء والفواتير، ومنه تعرف من استلم تشغيلة معيّنة",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "accountingEnabled ليس false، وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "lotTrackingEnabled للشركة، وإلا 403 LOTS_NOT_ALLOWED",
     "نطاق المستخدم",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى على invoiceDate بيوم الشركة ومنطقتها الزمنية"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى شاملة اليوم. بلا from وto: آخر 90 يوماً. وfrom بعد to يعطي 400"
     },
     {
      "name": "productId",
      "type": "string (uuid)",
      "required": false,
      "desc": "حصر التقرير بصنف واحد"
     },
     {
      "name": "lotId",
      "type": "string (uuid) | none",
      "required": false,
      "desc": "حصر التقرير بتشغيلة واحدة، أو none لما بيع من رصيد «غير معروف» التشغيلة"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق لحصر التقرير بمستندات الفريق، أو none لما بلا فريق"
     }
    ],
    "body": [],
    "response": "{success:true, data:{rows:[{productId, productName, productCode, unit, units:[{name, factor}], lotId, lotNumber, productionDate, expiryDate, status, blockKind, sold, returned, net, customers, invoices, returnInvoices, soldByCertainty:{CONFIRMED, ASSUMED, UNKNOWN}}], products:[{productId, productName, productCode, unit, units, lots, sold, returned, net, customers, invoices, returnInvoices, soldByCertainty}], summary:{lots, products, customers, invoices, returnInvoices}, range:{from, to, timezone}, rangeApplied, defaultDays, scoped, truncated, maxInvoices?}}. التاريخ غير الصالح أو المعامل المكرّر 400 «معامل غير صالح»",
    "rules": [
     "الكميات بوحدة الأساس للصنف، ولا تُجمع كميات صنفين معاً: الملخّص عدّاتٌ بلا كمية",
     "lotId = null صفّ «غير معروف»: بيعٌ من رصيد بلا تشغيلة، أو مرتجع حرّ بلا تشغيلة",
     "soldByCertainty يقين نسبة المباع إلى التشغيلة: CONFIRMED مؤكد، وASSUMED مفترض بالأقرب انتهاءً، وUNKNOWN غير معروف",
     "الفواتير المؤكدة وحدها، والمرتجع والإشعار الدائن يُطرحان في returned",
     "الترتيب: الصنف بالاسم، ثم التشغيلات بالأقرب انتهاءً، و«غير معروف» آخراً",
     "حتى 20000 فاتورة الأحدث أولاً، وtruncated = true حين يتجاوز المدى ذلك فضيّق المدى"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/collections",
    "purpose": "تقرير التحصيل من سندات القبض الفعّالة مع ملخص حسب طريقة الدفع",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم المقيّد (قاعدة AND على العميل والمندوب)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى على receiptDate"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى على receiptDate شاملة اليوم كاملاً"
     },
     {
      "name": "salesRepId",
      "type": "string (uuid)",
      "required": false,
      "desc": "حصر التقرير بمندوب"
     },
     {
      "name": "paymentMethod",
      "type": "enum: CASH | BANK_TRANSFER | POS | CHEQUE | ONLINE",
      "required": false,
      "desc": "حصر التقرير بطريقة دفع، والقيمة غير المعروفة تُرجع قائمة فارغة لأن الحقل نصي. التصفية بالأساس المحاسبي فتشمل طرق الشركة المخصّصة التي تُعامل مثله. وONLINE الدفع الإلكتروني: سندات روابط الدفع (ميسر) التي يكتبها الخادم حين يُدفع الرابط"
     },
     {
      "name": "paymentMethodKey",
      "type": "string (c_…)",
      "required": false,
      "desc": "حصر التقرير بطريقة أضافتها الشركة بمفتاحها. القيمة التي لا تطابق الصيغة c_[a-z0-9]{4,24} تُهمل بصمت فيعود كل السجل"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams لحصر التقرير بمستندات الفريق (بوسم المستند)، أو none لما بلا فريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:{receipts:[صف السند كاملاً بكل أعمدته ومنها number وamount وpaymentMethod وreceiptDate وstatus، مع customer{id,name} وsalesRep{id,name} أو null], summary:{total, count, byMethod:{CASH?:number, BANK_TRANSFER?:number, POS?:number, CHEQUE?:number, ONLINE?:number} بالأساس المحاسبي, byMethodKey:{معرّف الطريقة: number} حيث المعرّف رمز الطريقة المدمجة أو مفتاح طريقة الشركة المخصّصة, methods:[{id, base, key, custom, label, companyLabel, icon, active, manual, amount, count}]}}}",
    "rules": [
     "السندات ذات الحالة ACTIVE فقط، فالملغاة لا تدخل",
     "لا يوجد مدى افتراضي هنا خلافاً لتقرير المبيعات، فبلا from وto يرجع كل السجل",
     "لا ترقيم ولا حد للصفوف، والترتيب تصاعدي بـ receiptDate",
     "byMethod بالأساس المحاسبي كما كان، وbyMethodKey وmethods بطرق الشركة وأسمائها: المعرّف رمز الطريقة المدمجة أو مفتاح المخصّصة. ومنها ONLINE لما حُصّل من روابط الدفع الإلكتروني (ميسر)، وكل طريقة تظهر في الثلاثة حين يوجد في الفترة سند بها",
     "لا تطابق أرقامه صفحة طرق الدفع (GET /reports/payment-methods) لثلاثة فروق: from وto هنا أيام UTC (منتصف الليل UTC) وهناك أيام الشركة المحلية، والسند بلا مندوب يدخل total والمجاميع هنا وهناك يُعزل في noRep خارج الإجماليات، والنقدي هناك يضيف فواتير البيع النقدي",
     "كل صف سند يحمل team{id, name} (أو null) وteamId"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/payment-methods",
    "purpose": "صفحة «طرق الدفع»: ما حصّله كل مندوب بكل طريقة دفع في الفترة — جدول لكل طريقة",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "requirePaymentMethods: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 PAYMENT_METHODS_NOT_ALLOWED إن كانت صفحة طرق الدفع مطفأة",
     "نطاق المستخدم على السندات والفواتير",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "أول يوم بأيام الشركة المحلية (لا UTC). الافتراضي = to"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "آخر يوم ويشمل يومه. الافتراض اليوم بتوقيت الشركة، إلا إن أُرسل from وحده في المستقبل فيصير to = from. التاريخ غير الصالح أو from بعد to يرجع 400"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams لحصر التقرير بمستندات الفريق (بوسم المستند)، أو none لما بلا فريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:{range:{from, to, timezone}, methods:[{method, base, key, custom, label, companyLabel, icon, active, rows:[{salesRepId, repName, repActive, amount, count, receiptsAmount, receiptsCount, invoicesAmount, invoicesCount}], total:{…}, noRep:{amount, count}}], total:{amount, count}, noRep:{amount, count}, repsCount, roster:[{salesRepId, repName, repActive}]}}",
    "rules": [
     "method معرّف الجدول: رمز الطريقة المدمجة (CASH وPOS وBANK_TRANSFER وCHEQUE وONLINE) أو مفتاح طريقة الشركة المخصّصة (c_…)، وbase الأساس الذي تُعامل مثله",
     "النقدي = سندات القبض النقدية + فواتير البيع النقدي (receiptsAmount وinvoicesAmount)، فلا يطابق رصيد التحصيل ولا /reports/collections. ويختلف عن /reports/collections في كل الطرق أيضاً: الأيام هنا بتوقيت الشركة وهناك UTC، والتحصيل بلا مندوب هنا خارج total وهناك داخله",
     "كل طريقة مخصّصة جدول مستقل بمفتاحها ولو كان أساسها النقدي، والمعطّلة لا تظهر إلا إن حُصّل بها في الفترة (active = false)",
     "التحصيل بلا مندوب في noRep خارج جداول المناديب",
     "roster = مناديب النطاق النشطون، ويُضاف إليهم كل من حصّل في الفترة ولو كان موقوفاً (repActive = false). ومع teamId يصير النشطون أعضاء الفريق الحاليين أو من له مستند موسوم به في أي وقت، ومع none من ليس في أي فريق أو له مستند بلا فريق. لعرض «كل مندوب مع كل طريقة» ولو بلا تحصيل اجمع roster مع rows كل طريقة",
     "التاريخ تاريخ المستند (receiptDate وinvoiceDate) لا لحظة الرفع"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/balances",
    "purpose": "أرصدة العملاء النشطين: الكل أو المدينون أو المتجاوزون لسقف الائتمان",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق العملاء للمستخدم المقيّد (adminCustomerFilter)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "type",
      "type": "enum: overdue | exceeded",
      "required": false,
      "desc": "overdue تعني كل عميل رصيده أكبر من صفر، وexceeded تعني من له سقف أكبر من صفر ورصيده أكبر من السقف، وبدونها يرجع كل العملاء النشطين"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, name, phone, balance, creditLimit, paymentDays, totalSales, totalCollected}]} مرتبة تنازلياً حسب balance",
    "rules": [
     "العملاء ذوو الحالة ACTIVE فقط",
     "الرصيد هنا هو القيمة المخزنة customer.balance، وليس المحسوب من قيود الحساب كما في rep-receivables",
     "overdue لا تفحص paymentDays ولا تاريخ الاستحقاق، بل الرصيد الموجب فقط مع تجاهل كسور أصغر من 1e-6",
     "exceeded تُفلتر في الذاكرة بعد جلب كل من له سقف",
     "لا ترقيم ولا حد للصفوف"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/rep-performance",
    "purpose": "أداء المناديب النشطين: المبيعات والتحصيل والخصومات ونسبة التحصيل ودقائق العمل وعدد الزيارات مع روابط مواقعها",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المناديب للمستخدم المقيّد (adminRepFilter) والزيارات بقاعدة AND",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى شاملة اليوم كاملاً"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams أو none. المبيعات والتحصيل والزيارات بوسم المستند، والمناديب المعروضون أعضاء الفريق الحاليون أو من له فاتورة أو سند أو زيارة موسومة به (في أي وقت). أما workMinutes فمن كل جلسات المندوب ولا تنقسم بالفريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, name, invoicesCount, salesTotal, collectionsTotal, discountTotal, collectionRate (نسبة مئوية صحيحة), avgInvoice (مقرّب لعدد صحيح), workMinutes, workHours, workMins, visitsCount, visits:[{customerName, createdAt, lat, lng, mapsUrl}]}]} مرتبة تنازلياً حسب salesTotal",
    "rules": [
     "فلتر التاريخ على المبيعات والتحصيل لا يُطبَّق إلا إذا أُرسل from وto معاً، وإلا تُحسب على كل السجل",
     "جلسات العمل والزيارات تستعمل from وحده (أو بداية الزمن) وto وحده (أو الآن) كلّاً على حدة",
     "المبيعات فواتير CONFIRMED بلا RETURN، والتحصيل سندات ACTIVE، ومجاميع المندوب لا تُقيَّد بنطاق العملاء",
     "workMinutes مجموع (lastBeatAt ناقص startedAt) لجلسات التطبيق RepSession",
     "visitsCount عدد الوقفات بعد دمج سجل المؤقت مع سجل الملاحظة أو الصورة لنفس العميل خلال 5 دقائق، لا عدد السجلات",
     "قائمة visits تضم الوقفات ذات الإحداثيات فقط بحد 300 لكل مندوب، وcreatedAt فيها بداية الوقفة، والصفوف الخام محدودة بـ 20000 الأقدم أولاً",
     "المناديب النشطون isActive فقط"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/customer-visits",
    "purpose": "كل زيارات العملاء في قائمة واحدة: العميل والمندوب والوقت والمدة والملاحظات ورابط الموقع",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم المقيّد (العميل والمندوب كلاهما إلزامي في الزيارة)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "بداية المدى على createdAt، وغيابه يعني من البداية"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "نهاية المدى شاملة اليوم كاملاً، وغيابه يعني حتى الآن"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams لحصر التقرير بمستندات الفريق (بوسم المستند)، أو none لما بلا فريق. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:{count, visits:[{id, customerId, customerName, repName, createdAt, durationSec, note, mapsUrl}]}} مرتبة من الأحدث",
    "rules": [
     "تُجلب أحدث 5000 سجل خام ثم تُدمج في وقفات، فالمدى الطويل يُقصّ بصمت",
     "createdAt في الصف هو بداية الوقفة (startedAt أو createdAt)، وid معرّف أول سجل فيها",
     "note تجمع الملاحظات غير المكررة بفاصل « · »، وmapsUrl نص فارغ إذا لم يوجد موقع",
     "لا فلتر حسب المندوب أو العميل في هذا المسار"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/rep-receivables",
    "purpose": "مديونيات العملاء المسندين لكل مندوب مع الرصيد اللحظي وتاريخ آخر تحصيل",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم المقيّد: تقاطع مناديبه وعملائه",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams، أو none للمناديب الذين ليسوا في أي فريق. يحصر المناديب بعضويتهم الحالية في الفريق، لا بوسم المستند: الأرصدة والإسناد لا تُوسم، فيظهر كل عضو بكل عملائه المسندين وأرصدتهم كاملة، والمندوب في فريقين يظهر تحت كليهما. غيابه = كل المناديب، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, name, customersCount, debtorsCount, totalBalance, customers:[{id, name, businessName, phone, city, balance, lastPaymentAt}]}]} المناديب مرتبون تنازلياً حسب totalBalance والعملاء داخل كل مندوب تنازلياً حسب balance",
    "rules": [
     "الرصيد لحظي ويُحسب مجموع المدين ناقص مجموع الدائن من قيود حساب العميل AccountEntry مقرّباً لست خانات، ولا يتأثر بأي تاريخ",
     "lastPaymentAt أحدث entryDate لقيد من نوع RECEIPT_CREDIT أو null",
     "الإسناد من جدول CustomerAssignment، فقد يظهر العميل تحت أكثر من مندوب، ولا يوجد فلتر على حالة العميل",
     "يظهر كل مندوب نشط ولو بلا عملاء مسندين بصف صفري",
     "debtorsCount عدد من رصيده أكبر من صفر"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/work-hours",
    "purpose": "ساعات العمل اليومية لكل مندوب من جلسات التطبيق ونقاط الموقع والزيارات وبصمات الحضور مع أيام الغياب",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المناديب للمستخدم المقيّد",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD فقط)",
      "required": false,
      "desc": "أول يوم محلي، يجب أن يكون تاريخاً مجرداً لأنه يُلصق به T00:00:00.000Z"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD فقط)",
      "required": false,
      "desc": "آخر يوم محلي شاملاً، وغيابه يعني حتى الآن"
     },
     {
      "name": "tz",
      "type": "integer",
      "required": false,
      "desc": "إزاحة التوقيت المحلي بالدقائق شرق UTC، للسعودية 180، الافتراضي 0 ومحصور بين -840 و840"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams، أو none للمناديب الذين ليسوا في أي فريق. يحصر المناديب بعضويتهم الحالية في الفريق، وجلساتهم وبصماتهم ونقاط موقعهم تُحسب كاملة بلا تصفية بالفريق، والزيارات وحدها بوسم المستند. المندوب في فريقين يظهر تحت كليهما. غيابه = كل المناديب، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, name, totalMinutes, hours, minutes, sessions, firstSeen, lastSeen, fieldMinutesTotal, workedDays, absentDays, visitsTotal, avgDayMinutes, days:[{date, firstActivity, lastActivity, spanMinutes, periods:[{start, end, source:'PUNCH'|'ACTIVITY', inLat?, inLng?, outLat?, outLng?}], breakMinutes, appMinutes, visits:[{customerName, start, end, durationSec, hasNote, parts, lat, lng, sources}], visitsCount, visitsSec, absent}]}], meta:{tzOffsetMin, rangeClamped?:31}}",
    "rules": [
     "بلا from يكون المدى 7 أيام تنتهي عند to أو الآن",
     "الحد الأقصى 31 يوماً، والزائد يُقصّ من البداية ويُعلن بـ meta.rangeClamped=31",
     "مرّر tz=180 للسعودية وإلا حُسبت الأيام بتوقيت UTC",
     "totalMinutes وhours وminutes نشاط التطبيق من الجلسات، أما fieldMinutesTotal فمجموع spanMinutes الميداني والترتيب تنازلي حسبه",
     "اليوم الذي فيه بصمة حضور تُؤخذ فترته من البصمات (PUNCH) ومجموع النوبات المغلقة وحدها، واليوم بلا بصمة امتداد واحد من أول أثر لآخر أثر (ACTIVITY)",
     "الأيام الخالية داخل المدى تظهر بصف absent=true، وavgDayMinutes يُقسم على أيام العمل لا أيام المدى",
     "الزيارات الخام محدودة بـ 10000 سجل"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/reports/rep-ranking",
    "purpose": "تقييم المناديب وترتيبهم بمعيار واحد في مدى أيام",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم: مناديبه النشطون",
     "المعياران الماليان (sales وproduct) يرجعان 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "metric",
      "type": "enum sales | product | visits | distance | appTime",
      "required": true,
      "desc": "المعيار: قيمة المبيعات، أو كمية صنف، أو عدد الزيارات، أو المسافة بالكيلو، أو وقت استخدام التطبيق بالدقائق. غيره 400"
     },
     {
      "name": "productId",
      "type": "string",
      "required": false,
      "desc": "إلزامي مع metric=product، وصنف من شركة أخرى 404"
     },
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "أول يوم بالتوقيت المحلي عبر tz. غيابه = منذ البداية، إلا distance فأسبوع ينتهي في to"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "آخر يوم، والافتراض اليوم"
     },
     {
      "name": "tz",
      "type": "integer -840..840",
      "required": false,
      "desc": "إزاحة التوقيت بالدقائق شرق UTC (الرياض 180)"
     },
     {
      "name": "teamId",
      "type": "string | none",
      "required": false,
      "desc": "ميزة «الفرق»: معرّف فريق من GET /company/teams أو none. مع sales وproduct وvisits: القيمة من المستندات الموسومة بالفريق، والمناديب أعضاؤه الحاليون أو من له مستند موسوم به. مع distance وappTime: المناديب بعضويتهم الحالية والقيمة من كل نقاطهم وجلساتهم بلا تصفية بالفريق، فالمندوب في فريقين يُحسب تحت كليهما. غيابه = كل الفرق، والقيمة غير النصية تُهمل"
     }
    ],
    "body": [],
    "response": "{success:true, data:{metric, product:{id,name,unit,units:[{name, factor}]}|null, rows:[{repId, name, value, rank}], range:{from, to}, clampedDays}}",
    "rules": [
     "الصفوف بالقيمة تنازلياً، والمتساويان يأخذان المرتبة نفسها (1، 2، 2، 4)",
     "distance مدى أقصاه 31 يوماً، وما زاد يُقصّ ويُعلن في clampedDays",
     "المبالغ والكميات بثلاث منازل، والكيلو بمنزلة واحدة، والدقائق صحيحة",
     "مع metric=product: value الكمية المباعة بوحدة الأساس product.unit (كرتون من 24 = 24)، وunits وحدات الصنف النشطة للعرض"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/dashboard",
    "purpose": "مؤشرات لوحة التحكم: مبيعات وتحصيل اليوم والشهر ومشتريات الشهر وأعداد العملاء وأفضل المناديب والعملاء وآخر الفواتير",
    "permission": "canAccessDashboard",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canAccessDashboard')",
     "accountingEnabled: إذا أُطفئ النظام المحاسبي تُرجع أرقام المبيعات والتحصيل أصفاراً والقوائم فارغة",
     "warehouseEnabled: مشتريات الشهر تُحسب فقط حين يكون المستودع مفعّلاً والنظام المحاسبي مفعّلاً",
     "نطاق المستخدم المقيّد على الفواتير والسندات والعملاء والمناديب",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{accountingEnabled, today:{salesTotal, invoicesCount, collectionsTotal, receiptsCount}, warehouseEnabled, month:{salesTotal, invoicesCount, collectionsTotal, receiptsCount, purchasesTotal, purchaseEntriesCount}, customers:{total, withBalance, creditExceeded}, topReps:[{id, name, invoicesCount, salesTotal}], topCustomers:[{id, name, totalSales, balance}], recentInvoices:[صف الفاتورة كاملاً مع customer{name} وsalesRep{name}]}}",
    "rules": [
     "المبيعات فواتير CONFIRMED بلا RETURN، والتحصيل سندات ACTIVE",
     "حدود اليوم والشهر محسوبة بتوقيت الخادم المحلي عبر new Date(y,m,d) وليس بتوقيت الرياض صراحةً",
     "purchasesTotal مجموع الكمية ضرب سعر التكلفة لحركات المستودع RECEIVE هذا الشهر على مستوى الشركة دون نطاق",
     "أعداد العملاء customers تُرجع دائماً حتى مع إطفاء المحاسبة: total للنشطين، وwithBalance رصيدهم أكبر من صفر، وcreditExceeded سقفهم أكبر من صفر ورصيدهم أكبر من السقف",
     "topReps تأخذ أول 5 مناديب من القاعدة بلا ترتيب ثم ترتّبهم بمبيعات الشهر، فليست بالضرورة أعلى 5 في الشركة",
     "topCustomers أعلى 5 حسب totalSales المخزن مع استثناء الحالة DELETED، وrecentInvoices آخر 10 فواتير مؤكدة غير مرتجعة حسب createdAt"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/dashboard/sales-trend",
    "purpose": "منحنى المبيعات اليومية لعدد من الأيام الماضية",
    "permission": "canAccessDashboard",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canAccessDashboard')",
     "accountingEnabled: إذا أُطفئ النظام المحاسبي ترجع data مصفوفة فارغة",
     "نطاق المستخدم المقيّد (قاعدة AND)",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "days",
      "type": "integer",
      "required": false,
      "desc": "عدد الأيام الماضية، الافتراضي 30، والقيمة 0 أو غير الرقمية تعني 30، ولا يوجد حد أقصى في الكود"
     }
    ],
    "body": [],
    "response": "{success:true, data:[{date:'YYYY-MM-DD', total}]} مرتبة تصاعدياً",
    "rules": [
     "تظهر الأيام التي فيها مبيعات فقط دون ملء الأيام الخالية بأصفار",
     "date مأخوذ من invoiceDate بتوقيت UTC",
     "فواتير CONFIRMED بلا RETURN"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/company",
    "purpose": "بيانات الشركة وإعداداتها مع أعلام الميزات المفعّلة في الاشتراك",
    "permission": "لا تتطلب صلاحية خاصة (أي مستخدم مصادق)",
    "gates": [
     "authenticate فقط",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{كل أعمدة إعدادات الشركة ومنها name وaddress وtaxNumber وcommercialReg وphone وemail وlogo (base64) وprimaryColor وheaderStyle وnumerals وcountryCode وcurrency وcurrencyOverride وdefaultVatPct وeinvoiceProvider وeinvoiceEnabled وeinvoiceEnv وeinvoiceClientId وحقول بائع زاتكا وzatcaPhase2StartedAt، مع einvoiceHasSecret:boolean بدل السر، والأعلام erpEnabled وpetroappEnabled وhatifEnabled وcatalogEnabled وpaylinkEnabled وwarehouseEnabled وreceivablesSummaryEnabled وaccountingEnabled وdailyReportEnabled وattendanceEnabled وinvoiceSignatureEnabled وaccountingSuiteEnabled وzatcaPhase2Enabled وaiRepEnabled وapiEnabled وlocationsEnabled وpaymentMethodsEnabled وlotTrackingEnabled وlotOnInvoice}}. وفي أعمدة الإعدادات الخام: teamsEnabled وprintSettings وpaymentMethodsConfig (JSON أو null)",
    "rules": [
     "einvoiceClientSecret لا يُعاد أبداً ويُستبدل بـ einvoiceHasSecret",
     "accountingEnabled يكون true ما لم يُطفأ صراحة، وبقية الأعلام false ما لم تُفعَّل",
     "إذا لم يوجد صف إعدادات للشركة ترجع الأعلام وحدها",
     "استعمل الأعلام لمعرفة الميزات المتاحة قبل استدعاء مساراتها مثل المستودع وروابط الدفع",
     "تحقّق من locationsEnabled قبل /locations، ومن paymentMethodsEnabled قبل /reports/payment-methods وPUT /company/payment-methods، ومن attendanceEnabled قبل /attendance-admin",
     "«تتبّع اللوط»: lotTrackingEnabled يفعّله مزود الخدمة لكل شركة — تحقّق منه قبل /lots ومزامنة موارد التشغيلات وحقول التشغيلات في المسارات الأخرى. وlotOnInvoice (طباعة رقم التشغيلة على فاتورة العميل، يضبطه PUT /lots/settings) يصل true مع الميزة المفعّلة وحدها، ولا يمسّه PUT /company",
     "اقرأ طرق الدفع من GET /company/payment-methods وإعدادات الطباعة من GET /company/print-settings لا من العمودين الخام: المساران يعيدان الصورة المكتملة بالافتراضي"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/company",
    "purpose": "تعديل بيانات الشركة: الاسم والعنوان والرقم الضريبي والسجل والهوية البصرية والدولة والعملة وبيانات ربط الفوترة الإلكترونية للمزودات غير زاتكا",
    "permission": "canManageCompanySettings",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)",
     "zatcaPhase2Enabled: تغيير taxNumber أو commercialReg أو countryCode لشركة سعودية يحتاج دور ADMIN غير مقيّد النطاق",
     "zatcaPhase2StartedAt: بعد التفعيل الحي لا تتغير الدولة ولا العملة ولا تجاوزها ولا مزود الفوترة (409)"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": true,
      "desc": "اسم الشركة، حد أدنى حرف واحد"
     },
     {
      "name": "address",
      "type": "string | null",
      "required": false,
      "desc": "العنوان، غيابه يبقي القيمة المحفوظة"
     },
     {
      "name": "taxNumber",
      "type": "string | null",
      "required": false,
      "desc": "الرقم الضريبي، غيابه يبقيه، ومع تفعيل زاتكا المرحلة الثانية ودولة SA يُطبَّع (أرقام لاتينية وقص المسافات) ويجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3"
     },
     {
      "name": "commercialReg",
      "type": "string | null",
      "required": false,
      "desc": "السجل التجاري، غيابه يبقيه، ومع زاتكا المرحلة الثانية يُطبَّع وحده الأقصى 64"
     },
     {
      "name": "phone",
      "type": "string | null",
      "required": false,
      "desc": "هاتف الشركة، غيابه يبقيه"
     },
     {
      "name": "email",
      "type": "string (email) | null | ''",
      "required": false,
      "desc": "البريد، وغيابه أو القيمة الفارغة يمسحه"
     },
     {
      "name": "logo",
      "type": "string (base64 data URL) | null | ''",
      "required": false,
      "desc": "الشعار، وغيابه يمسحه، وحد جسم الطلب 10MB"
     },
     {
      "name": "primaryColor",
      "type": "string (hex) | null | ''",
      "required": false,
      "desc": "لون الترويسة، وغيابه يمسحه، ولا يُتحقق من صيغته"
     },
     {
      "name": "headerStyle",
      "type": "enum: classic | banner | minimal | null",
      "required": false,
      "desc": "شكل ترويسة المطبوعات"
     },
     {
      "name": "numerals",
      "type": "enum: arabic | latin",
      "required": false,
      "desc": "شكل الأرقام في الواجهة والمطبوعات"
     },
     {
      "name": "countryCode",
      "type": "string (طوله 2)",
      "required": false,
      "desc": "دولة الشركة، ويشتق الخادم منها currency وdefaultVatPct وeinvoiceProvider، والرمز غير المعروف يُعامل SA، وغيابه لا يغير الدولة"
     },
     {
      "name": "currencyOverride",
      "type": "enum: USD | EUR | '' | null",
      "required": false,
      "desc": "تجاوز العملة، وغيابه يبقي المحفوظ، و'' أو null يزيله ويعيد عملة الدولة"
     },
     {
      "name": "einvoiceEnabled",
      "type": "boolean",
      "required": false,
      "desc": "تفعيل الإرسال الحكومي لمزودات ETA وPeppol وTTN"
     },
     {
      "name": "einvoiceEnv",
      "type": "enum: preprod | production",
      "required": false,
      "desc": "بيئة مزود الفوترة"
     },
     {
      "name": "einvoiceClientId",
      "type": "string | null | ''",
      "required": false,
      "desc": "معرّف العميل لدى المزود، وغيابه يمسحه"
     },
     {
      "name": "einvoiceClientSecret",
      "type": "string",
      "required": false,
      "desc": "السر، يُكتب فقط إذا أُرسل غير فارغ ولا يُعاد في أي استجابة"
     },
     {
      "name": "einvoiceActivityCode",
      "type": "string | null | ''",
      "required": false,
      "desc": "كود النشاط لـ ETA، وغيابه يمسحه"
     },
     {
      "name": "einvoiceBranchCode",
      "type": "string | null | ''",
      "required": false,
      "desc": "كود الفرع، وغيابه يمسحه"
     },
     {
      "name": "einvoiceIntermediaryUrl",
      "type": "string | null | ''",
      "required": false,
      "desc": "رابط الوسيط المعتمد، وغيابه يمسحه"
     }
    ],
    "response": "{success:true, data:{صف إعدادات الشركة بعد الحفظ بدون einvoiceClientSecret ومعه einvoiceHasSecret}} ولا تُرجع أعلام الاشتراك هنا",
    "rules": [
     "الحقول email وlogo وprimaryColor وeinvoiceClientId وeinvoiceActivityCode وeinvoiceBranchCode وeinvoiceIntermediaryUrl تُضبط null إذا غابت عن الجسم، فاقرأ GET /company أولاً وأعد إرسالها كاملة",
     "العملة والضريبة الافتراضية ومزود الفوترة لا تُرسل، بل يشتقها الخادم من countryCode ومن currencyOverride",
     "العملية upsert فتنشئ صف الإعدادات إن لم يوجد",
     "مع zatcaPhase2Enabled وتغيير فعلي في taxNumber أو commercialReg أو countryCode لشركة سعودية: غير ADMIN يُرد 403 SELLER_FIELDS_ADMIN_ONLY، والمقيد النطاق 403 SELLER_FIELDS_SCOPED، والصيغة الخاطئة 400 SELLER_INVALID مع fieldErrors:[{field, messageAr}]",
     "مع زاتكا المرحلة الثانية: إرسال taxNumber أو commercialReg بنفس القيمة بعد التطبيع لا يُكتب",
     "بعد التفعيل الحي (zatcaPhase2StartedAt) أي تغيير فعلي في countryCode أو currency أو currencyOverride أو einvoiceProvider يُرد 409 ZATCA_SETTINGS_LOCKED مع fields، والحفظ بلا تغيير فعلي يمر",
     "حقول einvoice هنا لمزودات ETA وPeppol وTTN، أما ربط زاتكا المرحلة الثانية فله مسارات /zatca"
    ],
    "example": "{\"name\":\"شركة الريادة للتوزيع\",\"address\":\"الرياض، حي السلي\",\"taxNumber\":\"310123456700003\",\"commercialReg\":\"1010123456\",\"phone\":\"0112345678\",\"email\":\"info@alriyada.sa\",\"primaryColor\":\"#E15A30\",\"headerStyle\":\"classic\",\"numerals\":\"latin\",\"countryCode\":\"SA\"}"
   },
   {
    "method": "GET",
    "path": "/company/print-settings",
    "purpose": "إعدادات الطباعة للشركة: قوالب الطابعات ومقاساتها وأي قالب لكل نوع مستند",
    "permission": "لا تتطلب صلاحية خاصة (أي مستخدم مصادق)",
    "gates": [
     "authenticate فقط",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:PrintSettingsV1, stored, hasCompany}. PrintSettingsV1 = {version:1, profiles:[1..12 قالب طابعة: نوعها ومقاس الورق وتصميمه وهوامشه], routing:{لكل نوع مستند معرّف قالبه أو null}, pdfProfileId (قالب الطابعة العادية لمشاركة PDF), repMayChoose}",
    "rules": [
     "stored = false يعني الافتراضي (شريط 58 مم للفواتير والسندات وA4 للـPDF)، وdata يحمل حينها الافتراضي كاملاً",
     "hasCompany = false: لا صف لبيانات الشركة بعد، فالحفظ يرجع 409 COMPANY_SETTINGS_MISSING"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/company/print-settings",
    "purpose": "حفظ إعدادات الطباعة كاملة، أو استعادة الافتراضي",
    "permission": "canManageCompanySettings",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "بلا عَلَم اشتراك",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "(الجسم كله)",
      "type": "PrintSettingsV1 | {reset:true}",
      "required": true,
      "desc": "الإعداد كاملاً بصيغة GET نفسها (لا PATCH)، أو {\"reset\":true} وحده لاستعادة الافتراضي"
     }
    ],
    "response": "{success:true, data:PrintSettingsV1, stored, hasCompany:true}",
    "rules": [
     "البنية صارمة: حقل غير معروف في أي مستوى أو نسخة غير 1 يُرفض 400 PRINT_SETTINGS_INVALID مع issues:[{path, message}]",
     "فوق 16 كيلوبايت 413 PRINT_SETTINGS_TOO_LARGE، وبلا صف بيانات شركة 409 COMPANY_SETTINGS_MISSING",
     "الاستعادة بـ{\"reset\":true} لا بـnull: محلّل JSON في الخادم يرفض null خاماً في أعلى الجسم",
     "اقرأ GET أولاً وعدّل ثم أرسل الكل"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/notifications",
    "purpose": "أحدث 50 إشعاراً للشركة ضمن نطاق المستخدم",
    "permission": "لا تتطلب صلاحية خاصة (أي مستخدم شركة مصادق)",
    "gates": [
     "authenticate فقط",
     "نطاق المستخدم المقيّد: الإشعار الذي بلا عميل أو بلا مندوب يظهر له",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, type, title, body, salesRepId, customerId, isRead, data (نص JSON أو null), createdAt}]} من الأحدث",
    "rules": [
     "الحد ثابت 50 بلا ترقيم ولا فلتر لحالة القراءة",
     "type نص مفتوح، ومن قيمه في الكود CREDIT_LIMIT_EXCEEDED وINVOICE_CANCELLED وRECEIPT_CANCELLED وPAYLINK_PAID وPAYLINK_REFUNDED وZATCA_ISSUE_FAILED وأنواع LEDGER_*",
     "حقل data نص JSON يجب فكّه عند القراءة"
    ],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/notifications/:id/read",
    "purpose": "تعليم إشعار واحد كمقروء",
    "permission": "لا تتطلب صلاحية خاصة (أي مستخدم شركة مصادق)",
    "gates": [
     "authenticate فقط",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)",
     "نطاق المستخدم المقيّد"
    ],
    "query": [],
    "body": [],
    "response": "{success:true}",
    "rules": [
     "بلا جسم طلب، والمعرّف في المسار",
     "يستعمل updateMany فيرجع success:true حتى إذا لم يوجد الإشعار أو كان خارج النطاق، ولا يوجد 404"
    ],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/notifications/read-all",
    "purpose": "تعليم كل الإشعارات غير المقروءة ضمن نطاق المستخدم كمقروءة",
    "permission": "لا تتطلب صلاحية خاصة (أي مستخدم شركة مصادق)",
    "gates": [
     "authenticate فقط",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)",
     "نطاق المستخدم المقيّد"
    ],
    "query": [],
    "body": [],
    "response": "{success:true}",
    "rules": [
     "بلا جسم طلب",
     "يشمل كل إشعارات الشركة غير المقروءة ضمن النطاق وليس فقط آخر 50 المعروضة"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "locations",
  "title": "لوكيشن (مواقع الشركة وختم الفواتير والتحميلات)",
  "overview": "ميزة «لوكيشن»: تعرّف الشركة مواقعها (فرع أو مدينة أو مستودع)، وتُسند كل مندوب إلى موقع واحد، فيُختم كل مستند يصدره بموقعه لحظة الإصدار، وتعرض صفحة لوكيشن مبيعات كل موقع ومرتجعاته وتحميلاته في فترة. المسارات تحت https://api.fieldsa.net/api/locations وتعمل بمفتاح الشركة بهوية من أصدره.\nالبوّابة على كل المسارات بالترتيب: مستخدم شركة (requireAdmin)، ثم النظام المحاسبي (403 ACCOUNTING_NOT_ALLOWED إن كان مطفأً)، ثم عَلَم الميزة الذي يفعّله مزوّد الخدمة لكل شركة (403 LOCATIONS_NOT_ALLOWED). تحقّق منه بقراءة data.locationsEnabled من GET /company.\nالختم:\n- يكتبه الخادم وحده لحظة الإصدار: الفاتورة (POST /invoices) وتحميل السيارة من النوع LOAD (POST /van-stock/loads) يأخذان موقع المندوب الحالي. لا حقل locationId في جسم الإصدار.\n- الختم لقطة ثابتة: نقل المندوب لموقع آخر لا يغيّر مستنداته القديمة، وإطفاء الميزة يوقف الختم الجديد ويُبقي القديم.\n- المرتجع من فاتورة بيع والإشعاران الدائن والمدين ترث ختم الفاتورة الأصلية. السندات والزيارات والتنزيل والتسوية لا تُختم.\nالقراءة بلا العَلَم: فلتر locationId=<معرّف>|none في GET /invoices وGET /van-stock/loads يعمل دائماً، وlocationId يأتي في صفوف GET /sales-reps وفي مزامنة sales-reps وinvoices وvan-loads. أسماء المواقع من GET /locations أو من مورد المزامنة locations (كلاهما يشترط العَلَم).\nالموقع الذي عليه مستندات لا يُحذف بل يُؤرشف (isActive = false)، والموقع الذي فيه مناديب لا يُؤرشف ولا يُحذف حتى يُنقلوا. المفتاح «قراءة فقط» يمرّ بطلبات GET وحدها.",
  "endpoints": [
   {
    "method": "GET",
    "path": "/locations",
    "purpose": "مواقع الشركة مع عدد المناديب المسندين لكل موقع",
    "permission": "أي مستخدم شركة (لا صلاحية خاصة)",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, name, lat, lng, isActive, createdAt, updatedAt, repsCount}]}",
    "rules": [
     "الترتيب: الفعّال أولاً ثم بالاسم",
     "repsCount يُعدّ ضمن نطاق صاحب المفتاح إن كان مقيّداً",
     "id هو القيمة التي تأتي في locationId للفواتير والتحميلات والمناديب",
     "lat وlng اختياريان، null لموقع بلا نقطة على الخريطة"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/locations/summary",
    "purpose": "ملخّص الفترة لكل موقع بختم المستند: فواتير البيع والمرتجعات (عدداً ومبلغاً)، وتحميلات السيارات (عدداً وكميات لكل صنف)",
    "permission": "canViewReports",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "requireAdminPermission('canViewReports')",
     "نطاق المستخدم: مستنداته وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [
     {
      "name": "from",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "أول يوم بأيام الشركة المحلية (لا UTC). الافتراضي = to"
     },
     {
      "name": "to",
      "type": "string (YYYY-MM-DD)",
      "required": false,
      "desc": "آخر يوم ويشمل يومه، والافتراض اليوم. التاريخ غير الصالح أو from بعد to يرجع 400"
     }
    ],
    "body": [],
    "response": "{success:true, data:{range:{from, to, timezone}, rows:[LocationBucket], none:LocationBucket, totals:{sales:{count, amount}, returns:{count, amount}, net, loads:{count, qty}}}}. LocationBucket = {locationId, name, isActive, lat, lng, sales:{count, amount}, returns:{count, amount}, net, loads:{count, qty, products:[{productId, name, unit, qty}]}}",
    "rules": [
     "الفواتير المؤكدة وحدها بتاريخها invoiceDate: البيع (CASH وCREDIT ومعه الإشعار المدين) في sales، والمرتجع (ومعه الإشعار الدائن) في returns، وnet = البيع − المرتجع",
     "التحميلات من النوع LOAD بلحظة تسجيلها createdAt، بكميات بلا مبالغ بوحدة الأساس للصنف (unit)، والكرتون والحبة من الصنف نفسه يُجمعان حبّات، وqty على مستوى الموقع مجموع أصناف مختلفة بوحدات أساسها، وأصنافها بالكمية تنازلياً",
     "none سطر «بلا موقع»: ما خُتم قبل التفعيل أو لمندوب بلا موقع أو لموقع حُذف",
     "الصفوف: كل موقع فعّال ولو بلا حركة، والمؤرشف إن كانت له حركة في الفترة. المبالغ بثلاث منازل والكميات بأربع"
    ],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/locations/reps",
    "purpose": "مناديب النطاق بموقع كلٍّ منهم الحالي — لشاشة الإسناد",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "requireAdminPermission('canManageSalesReps')",
     "نطاق المستخدم",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, name, isActive, locationId}]}",
    "rules": [
     "الفعّال أولاً ثم بالاسم، وlocationId = null لمندوب بلا موقع"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/locations/reps/:salesRepId",
    "purpose": "إسناد مندوب لموقع واحد، أو إخراجه من كل المواقع",
    "permission": "canManageSalesReps",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "requireAdminPermission('canManageSalesReps')",
     "نطاق المستخدم: مندوب في نطاقه (canAccessRep)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "locationId",
      "type": "string | null",
      "required": true,
      "desc": "معرّف الموقع، أو null = «بلا موقع». الحقل إلزامي في الجسم، وغيابه 400"
     }
    ],
    "response": "{success:true, data:{salesRepId, locationId}}",
    "rules": [
     "يسري على ما يصدره المندوب بعد الإسناد وحده — مستنداته القديمة باقية على ختمها",
     "مندوب أو موقع غير موجود أو خارج النطاق 404، وموقع مؤرشف 409 LOCATION_ARCHIVED"
    ],
    "example": "{\"locationId\":\"<locationId>\"}"
   },
   {
    "method": "POST",
    "path": "/locations",
    "purpose": "تعريف موقع جديد",
    "permission": "canManageCompanySettings",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": true,
      "desc": "اسم الموقع: يُشذَّب طرفاه، فإن زاد بعدها على 120 حرفاً يُرفض 400؛ وإلا يُطوى فراغه المتكرر ويُقصّ إلى 60 حرفاً بصمت. فريد في الشركة بعد ذلك"
     },
     {
      "name": "lat",
      "type": "number | null",
      "required": false,
      "desc": "خط العرض -90..90، يُرسل مع lng أو لا يُرسلان"
     },
     {
      "name": "lng",
      "type": "number | null",
      "required": false,
      "desc": "خط الطول -180..180"
     }
    ],
    "response": "201 {success:true, data:{id, name, lat, lng, isActive, createdAt, updatedAt, repsCount}} بـrepsCount = 0",
    "rules": [
     "اسم مكرر 409 LOCATION_NAME_TAKEN، والمقارنة بالاسم بعد قصّه إلى 60 حرفاً",
     "أحد الإحداثيين دون الآخر أو خارج المدى 400"
    ],
    "example": "{\"name\":\"فرع جدة\",\"lat\":21.5433,\"lng\":39.1728}"
   },
   {
    "method": "PUT",
    "path": "/locations/:id",
    "purpose": "إعادة تسمية موقع، أو تغيير نقطته، أو أرشفته واستعادته",
    "permission": "canManageCompanySettings",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string",
      "required": false,
      "desc": "اسم جديد بقواعد الإنشاء نفسها"
     },
     {
      "name": "lat",
      "type": "number | null",
      "required": false,
      "desc": "null يمسح النقطة. ما لم يُرسل من الإحداثيين يبقى على قيمته، والزوج الناتج يُتحقق منه كاملاً"
     },
     {
      "name": "lng",
      "type": "number | null",
      "required": false,
      "desc": "كما lat"
     },
     {
      "name": "isActive",
      "type": "boolean",
      "required": false,
      "desc": "false يؤرشف الموقع (لا يُسند إليه ولا يُختم به جديد)، وtrue يستعيده"
     }
    ],
    "response": "{success:true, data:{id, name, lat, lng, isActive, createdAt, updatedAt}}",
    "rules": [
     "موقع غير موجود 404، واسم مكرر 409 LOCATION_NAME_TAKEN",
     "الأرشفة وفيه مناديب 409 LOCATION_HAS_REPS مع repsCount — انقلهم أولاً بـPUT /locations/reps/:salesRepId",
     "إعادة التسمية لا تمسّ المستندات المختومة (الختم معرّف لا اسم)، فتظهر بالاسم الجديد في الملخّص"
    ],
    "example": "{\"isActive\":false}"
   },
   {
    "method": "DELETE",
    "path": "/locations/:id",
    "purpose": "حذف موقع بلا مناديب ولا مستندات",
    "permission": "canManageCompanySettings",
    "gates": [
     "requireAdmin",
     "requireLocations: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 LOCATIONS_NOT_ALLOWED إن كانت الميزة مطفأة",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [],
    "response": "{success:true}",
    "rules": [
     "فيه مناديب 409 LOCATION_HAS_REPS مع repsCount، وعليه فواتير أو تحميلات 409 LOCATION_HAS_DOCUMENTS — أرشفه بدل الحذف ليبقى في التقارير",
     "الحذف الفعلي لا يصل المزامنة تعديلاً: طابِق معرّفات مورد locations بـ/v1/sync/locations/ids"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "payment-methods",
  "title": "طرق الدفع (إدارة الطرق وصفحة التحصيل لكل طريقة)",
  "overview": "لكل شركة خمس طرق مدمجة (CASH نقدي، POS شبكة، BANK_TRANSFER تحويل بنكي، CHEQUE شيك، ONLINE دفع إلكتروني من روابط الدفع)، وتستطيع إعادة تسميتها وإيقافها، وإضافة طرق خاصة بها (مثل STC Pay) لكلٍّ منها مفتاح c_… وأساس من الأربعة اليدوية تُعامل مثله محاسبياً.\nالسند يحمل الأساس في paymentMethod (القيود والعهدة عليه كما كانت) ومفتاح الطريقة المخصّصة في paymentMethodKey. المفاتيح لا تُحذف أبداً ولا يتغيّر أساسها، فهي ثابتة لربط نظامك.\nالبوّابة:\n- قراءة الطرق GET /company/payment-methods لأي مستخدم مسجّل وبلا عَلَم — منها تُبنى اختيارات السند وأسماء paymentMethodKey.\n- تعديل الطرق PUT وصفحة التحصيل GET /reports/payment-methods يشترطان النظام المحاسبي (403 ACCOUNTING_NOT_ALLOWED) ثم عَلَم الصفحة الذي يفعّله مزوّد الخدمة (403 PAYMENT_METHODS_NOT_ALLOWED). تحقّق منه بقراءة data.paymentMethodsEnabled من GET /company.\n- إصدار السند بطريقة مخصّصة (POST /receipts بـpaymentMethodKey) وتقرير التحصيل (/reports/collections) لا يشترطان العَلَم.\nصفحة التحصيل نفسها (GET /reports/payment-methods) موثّقة في مجموعة التقارير.",
  "endpoints": [
   {
    "method": "GET",
    "path": "/company/payment-methods",
    "purpose": "طرق دفع الشركة بأسمائها وحالتها، وما يصح اختياره في سند القبض الآن",
    "permission": "لا تتطلب صلاحية خاصة (أي مستخدم مصادق)",
    "gates": [
     "authenticate فقط",
     "بلا عَلَم",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:PaymentMethodsConfigV1|null, stored, hasCompany, methods:[{id, base, key, custom, label, companyLabel, icon, active, manual}], choices:[{id, base, key, custom, label, companyLabel, icon, active, manual}]}. PaymentMethodsConfigV1 = {version:1, builtins:{CASH|POS|BANK_TRANSFER|CHEQUE|ONLINE:{label|null, active}}, custom:[{key, label, base, icon, active}]}",
    "rules": [
     "data = null والـstored = false: الشركة على الافتراضي (الطرق الخمس بأسمائها الافتراضية ومفعّلة)",
     "methods كل الطرق ومنها المعطّلة: id رمز المدمجة أو مفتاح المخصّصة، وlabel الاسم المعروض، وcompanyLabel اسم الشركة الخاص أو null للافتراضي",
     "choices ما يصح إرساله في السند الآن: المفعّلة اليدوية بلا ONLINE. أرسل paymentMethod = base، ومعه paymentMethodKey = key للمخصّصة",
     "لترجمة paymentMethodKey في السندات القديمة استعمل methods (المفاتيح لا تُحذف، فالمعطّلة باقية فيها)"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/company/payment-methods",
    "purpose": "حفظ إعداد طرق الدفع كاملاً (إعادة تسمية، إيقاف، إضافة طريقة)، أو استعادة الافتراضي",
    "permission": "canManageCompanySettings",
    "gates": [
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "requirePaymentMethods: 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً، ثم 403 PAYMENT_METHODS_NOT_ALLOWED إن كانت صفحة طرق الدفع مطفأة",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "version",
      "type": "1",
      "required": true,
      "desc": "نسخة الإعداد"
     },
     {
      "name": "builtins",
      "type": "object",
      "required": false,
      "desc": "لكل طريقة مدمجة {label?: string|null, active?: boolean}. الغائب منها يعود للافتراضي، والاسم بقاعدة التفرّد نفسها في custom[].label"
     },
     {
      "name": "custom",
      "type": "array ≤ 20",
      "required": false,
      "desc": "الطرق المخصّصة بترتيب العرض: {key?, label, base, icon?, active?}"
     },
     {
      "name": "custom[].key",
      "type": "string c_[a-z0-9]{4,24}",
      "required": false,
      "desc": "مفتاح طريقة محفوظة. الطريقة الجديدة تُرسل بلا key فيولّده الخادم ويعيده في data.custom"
     },
     {
      "name": "custom[].label",
      "type": "string 1-40",
      "required": true,
      "desc": "الاسم، فريد بين كل الطرق بعد التطبيع العربي، ومنها المعطّلة. والمدمجة التي لم تُسمَّ تحجز اسمها الافتراضي (نقدي، شبكة، تحويل بنكي، شيك، دفع إلكتروني) وأسماءها البديلة (نقد للنقدي، وتحويل للتحويل البنكي، ودفع الكتروني للدفع الإلكتروني). الاسم المكرر أو المحجوز 400 PAYMENT_METHODS_INVALID"
     },
     {
      "name": "custom[].base",
      "type": "enum CASH | POS | BANK_TRANSFER | CHEQUE",
      "required": true,
      "desc": "الأساس الذي تُعامل مثله، ولا يتغيّر بعد أول حفظ"
     },
     {
      "name": "custom[].icon",
      "type": "enum",
      "required": false,
      "desc": "wallet أو smartphone أو credit-card أو banknote أو landmark أو qr-code أو coins أو gift أو receipt أو handshake أو store أو globe"
     },
     {
      "name": "custom[].active",
      "type": "boolean",
      "required": false,
      "desc": "false يوقفها: تختفي من نموذج السند وتبقى في التقارير والسندات القديمة"
     },
     {
      "name": "reset",
      "type": "true",
      "required": false,
      "desc": "بديل الجسم كله: {\"reset\":true} وحده يستعيد الافتراضي للمدمجة، والمخصّصة تبقى معطّلة بأسمائها"
     }
    ],
    "response": "{success:true, data, stored, hasCompany:true, methods:[…], choices:[…]} بصيغة GET نفسها",
    "rules": [
     "الإعداد يُرسل كاملاً (لا PATCH): اقرأ data من GET، عدّله، ثم أرسله كله. والجسم الذي يساوي الافتراضي يُحفظ null",
     "حذف طريقة محفوظة (غيابها من custom) أو تغيير base لها 409 PAYMENT_METHODS_CONFLICT مع issues — أوقفها بـactive:false بدل حذفها",
     "ONLINE لا يُعطّل، وطريقة مفعّلة واحدة على الأقل، وحقل غير معروف أو نسخة غير 1 تُرفض: 400 PAYMENT_METHODS_INVALID مع issues:[{path, message}]",
     "الجسم فوق 8 كيلوبايت 413 PAYMENT_METHODS_TOO_LARGE، وبلا صف بيانات شركة 409 COMPANY_SETTINGS_MISSING",
     "إن انقطع الرد بعد إضافة طريقة جديدة فلا تُعد الطلب كما هو: المفتاح المولَّد غائب عن جسمك فتصير الإعادة «حذفاً» يرجع 409. اقرأ GET أولاً ثم أعد التعديل",
     "الاستعادة بـ{\"reset\":true} لا بـnull: محلّل JSON في الخادم يرفض null خاماً في أعلى الجسم"
    ],
    "example": "{\"version\":1,\"builtins\":{\"POS\":{\"label\":\"مدى\"},\"CHEQUE\":{\"active\":false}},\"custom\":[{\"label\":\"STC Pay\",\"base\":\"BANK_TRANSFER\",\"icon\":\"smartphone\"}]}"
   }
  ]
 },
 {
  "key": "teams",
  "title": "الفرق داخل الشركة",
  "overview": "ميزة «الفرق»: مطفأة افتراضياً ويفعّلها مدير الشركة (PATCH /company/teams/settings). حين تُفعَّل تُوسم الفواتير والسندات والزيارات واستلامات التحصيل بفريق المندوب (teamId)، وتقيّد أصناف الفريق بيع مناديبه، وتقبل التقارير teamId.\nالمسارات تحت https://api.fieldsa.net/api/company/teams لأي مستخدم شركة للقراءة، والكتابة بصلاحية canManageCompanySettings ولصاحب مفتاح غير مقيّد النطاق.\nالفريق الذي عليه مستندات لا يُحذف بل يُؤرشف (409 TEAM_HAS_DOCUMENTS). وتعيين مشرفي الفريق (PUT /company/teams/:id/supervisors) يكتب نطاق مستخدمي الشركة فهو ممنوع على المفتاح دائماً بـ403 — من لوحة التحكم وحدها. الرمز API_KEY_FORBIDDEN، إلا إن نقص صاحب المفتاح canManageCompanySettings أو canManageCompanyUsers فيسبقه 403 نقص الصلاحية بلا code، لأن الصلاحيتين تُفحصان أولاً.\nحذف فريق له مشرفون بالمفتاح يحوّل من لم يبقَ له فريق منهم إلى قوائم يدوية مقيّدة (يرى أقل لا أكثر) — احذفه من اللوحة إن أردت مراجعة نطاقهم.\nللمزامنة: مورد teams في /v1/sync قائمة كاملة بالأعضاء والأصناف.",
  "endpoints": [
   {
    "method": "GET",
    "path": "/company/teams/settings",
    "purpose": "حالة ميزة الفرق للشركة",
    "permission": "أي مستخدم شركة",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{enabled}}",
    "rules": [],
    "example": ""
   },
   {
    "method": "PATCH",
    "path": "/company/teams/settings",
    "purpose": "تفعيل الفرق أو إطفاؤها — الإطفاء لا يحذف الفرق ولا الوسوم",
    "permission": "canManageCompanySettings",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "enabled",
      "type": "boolean",
      "required": true,
      "desc": "الحالة الجديدة"
     }
    ],
    "response": "{success:true, data:{enabled}}",
    "rules": [],
    "example": ""
   },
   {
    "method": "GET",
    "path": "/company/teams",
    "purpose": "الفرق بأعضائها وأصنافها ومشرفيها",
    "permission": "أي مستخدم شركة",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "المقيّد النطاق يرى الفرق التي يشرف عليها وحدها",
     "مسموح لمفتاح القراءة فقط"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, name, isActive, createdAt, members:[{salesRepId, name, isActive}], productIds:[...], supervisors:[{adminId, name, teamScoped}], docsCount}]}",
    "rules": [
     "الفعّال أولاً ثم بالاسم",
     "productIds فارغة = الفريق يبيع كل الأصناف"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/company/teams",
    "purpose": "إنشاء فريق",
    "permission": "canManageCompanySettings",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string 1-60",
      "required": true,
      "desc": "اسم فريد في الشركة"
     }
    ],
    "response": "201 {success:true, data:{id, name, isActive}}",
    "rules": [
     "اسم مكرر 409"
    ],
    "example": "{\"name\":\"فريق الشمال\"}"
   },
   {
    "method": "PUT",
    "path": "/company/teams/:id",
    "purpose": "إعادة تسمية فريق أو أرشفته واستعادته",
    "permission": "canManageCompanySettings",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "name",
      "type": "string 1-60",
      "required": false,
      "desc": "الاسم الجديد"
     },
     {
      "name": "isActive",
      "type": "boolean",
      "required": false,
      "desc": "false يؤرشف"
     }
    ],
    "response": "{success:true, data:{id, name, isActive}}",
    "rules": [
     "غير موجود 404، واسم مكرر 409"
    ],
    "example": ""
   },
   {
    "method": "DELETE",
    "path": "/company/teams/:id",
    "purpose": "حذف فريق بلا مستندات",
    "permission": "canManageCompanySettings",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [],
    "response": "{success:true}",
    "rules": [
     "عليه فواتير أو سندات أو زيارات أو استلامات 409 TEAM_HAS_DOCUMENTS — أرشفه بدل الحذف",
     "مشرفوه الذين لم يبقَ لهم فريق يتحوّلون إلى قوائم يدوية مقيّدة"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/company/teams/:id/members",
    "purpose": "أعضاء الفريق: القائمة الكاملة بعد التعديل",
    "permission": "canManageCompanySettings",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "salesRepIds",
      "type": "string[] ≤ 5000",
      "required": true,
      "desc": "كل مناديب الفريق بعد التعديل (يُضاف الجديد ويُزال الغائب)، والمندوب قد يكون في أكثر من فريق"
     }
    ],
    "response": "{success:true, data:{added, removed}}",
    "rules": [
     "فريق غير موجود 404، ومندوب ليس من الشركة 400"
    ],
    "example": ""
   },
   {
    "method": "PUT",
    "path": "/company/teams/:id/products",
    "purpose": "أصناف الفريق التي يقتصر عليها بيع مناديبه",
    "permission": "canManageCompanySettings",
    "gates": [
     "authenticate (موجّه الشركة)",
     "requireAdmin",
     "requireAdminPermission('canManageCompanySettings')",
     "صاحب المفتاح غير مقيّد النطاق (وإلا 403)",
     "يُرفض لمفتاح القراءة فقط (403 API_KEY_FORBIDDEN)"
    ],
    "query": [],
    "body": [
     {
      "name": "productIds",
      "type": "string[] ≤ 5000",
      "required": true,
      "desc": "كل أصناف الفريق بعد التعديل، وفارغة = الفريق يبيع كل الأصناف"
     }
    ],
    "response": "{success:true, data:{added, removed}}",
    "rules": [
     "فريق غير موجود 404، وصنف ليس من الشركة 400",
     "الأصناف المتغيّرة يتحرّك updatedAt لها فتصل مزامنة products"
    ],
    "example": ""
   }
  ]
 }
];

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * أدلّة الربط خطوةً بخطوة (طلب المالك ٢٦ أكتوبر ٢٠٢٦: «ملف دليل ربط API حدّثه لكي يكون فيه آلية لربط صفحة اللوكيشن وصفحة
 * طرق الدفع»، ثم ٢٧ أكتوبر: «تأكد انه يحتوي على ما يتعلق بمخزون الشركة (المستودع) و اللوكيشن»). الفهرس أعلاه يجيب «ماذا
 * يقبل كل مسار»، والأدلّة تجيب «بأي ترتيب أستدعيها لأعيد بناء الصفحة في نظامي».
 * تُرسم في components/ApiDocs.tsx أقساماً قبل الفهرس فتدخل ملف FieldSales-API.html المحمَّل.
 * اختبار apiDocsCatalog.test.ts يحرسهما: كل خطوةٍ بمسار موثّقةٌ في الفهرس بطريقتها، وكل curl بالعنوان الحيّ والمفتاح الوهمي
 * (لا مفتاح حقيقي ولا مفتاح في الرابط)، وكل رمز خطأ يذكرانه موجودٌ في الخادم — دليلٌ يَعِد برمزٍ لا يرسله الخادم يضلّل المبرمج.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export interface DocGuideStep {
  title: string;
  text: string;
  /** المسار الذي تدور عليه الخطوة — موثّق في API_DOC_GROUPS بالطريقة نفسها */
  method?: string;
  path?: string;
  curl?: string;
}
export interface DocGuide { key: string; title: string; intro: string; steps: DocGuideStep[] }

/** المفتاح في الأمثلة وهميّ دائماً — المستند يُسلَّم لمبرمج الشركة ولا يحوي مفتاحاً */
export const API_DOC_PLACEHOLDER_KEY = 'fsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const AUTH = `-H "Authorization: Bearer ${API_DOC_PLACEHOLDER_KEY}"`;
const JSON_CT = '-H "Content-Type: application/json"';
const get = (p: string) => `curl -s "${API_BASE_URL}${p}" \\\n  ${AUTH}`;
const send = (method: string, p: string, body?: string) =>
  `curl -s -X ${method} "${API_BASE_URL}${p}" \\\n  ${AUTH}${body === undefined ? '' : ` \\\n  ${JSON_CT} \\\n  -d '${body}'`}`;

export const API_DOC_GUIDES: DocGuide[] = [
  {
    key: 'locations-guide',
    title: 'ربط صفحة اللوكيشن',
    intro: [
      'صفحة «لوكيشن» تعرض لكل موقع من مواقع الشركة مبيعاته ومرتجعاته وتحميلات سياراته في فترة. كل فاتورة وكل تحميل سيارة (النوع LOAD وحده) يُختم بموقع مندوبه لحظة الإصدار، والختم لقطة ثابتة: نقل المندوب لاحقاً لا يغيّر مستنداته القديمة.',
      'المرتجع من فاتورة بيع والإشعاران الدائن والمدين ترث ختم الفاتورة الأصلية. السندات والزيارات والتنزيل والتسوية لا تُختم.',
      'الخطوات أدناه تعيد بناء الصفحة في نظامكم: المواقع، ثم إسناد المناديب، ثم الملخّص أو المستندات المختومة نفسها.',
    ].join('\n'),
    steps: [
      {
        title: 'تحقّق أن الميزة مفعّلة لشركتكم',
        method: 'GET', path: '/company',
        text: [
          'الميزة يفعّلها مزوّد الخدمة لكل شركة، وتشترط ألا يكون النظام المحاسبي مطفأً. اقرأ data.locationsEnabled وdata.accountingEnabled.',
          '- بدونها ترجع كل مسارات /api/locations الرمز 403 LOCATIONS_NOT_ALLOWED، وقبله 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً.',
          '- فلتر locationId في الفواتير والتحميلات يعمل دائماً، لكن الختم الجديد لا يُكتب إلا والميزة مفعّلة.',
        ].join('\n'),
        curl: get('/company'),
      },
      {
        title: 'جهّز المفتاح بالصلاحيات المناسبة',
        text: [
          'المفتاح يُصدَر من لوحة التحكم ← إعدادات الشركة ← تبويب «الربط البرمجي API»، ويعمل بصلاحيات من أصدره:',
          '- قراءة المواقع: أي مستخدم شركة. والملخّص: canViewReports. والإسناد: canManageSalesReps.',
          '- تعريف المواقع وأرشفتها وحذفها: canManageCompanySettings وحساب غير مقيّد النطاق، وبمفتاح «قراءة وكتابة».',
          '- الفواتير: canManageInvoices، والتحميلات: canManageVanStock.',
          'جرّب المفتاح بـGET /api/v1/me قبل أي شيء.',
        ].join('\n'),
        curl: get('/v1/me'),
      },
      {
        title: 'اقرأ المواقع واحفظ معرّفاتها',
        method: 'GET', path: '/locations',
        text: [
          'الرد [{id, name, lat, lng, isActive, createdAt, updatedAt, repsCount}]، الفعّال أولاً ثم بالاسم.',
          'احفظ id في نظامكم: هو القيمة التي تأتي في locationId للفواتير والتحميلات والمناديب. والمؤرشف isActive = false يبقى لترجمة المستندات القديمة.',
        ].join('\n'),
        curl: get('/locations'),
      },
      {
        title: 'عرّف موقعاً جديداً (اختياري)',
        method: 'POST', path: '/locations',
        text: [
          'الجسم {name, lat?, lng?}. الاسم حتى 120 حرفاً بعد تشذيب طرفيه وإلا 400، ويُحفظ أول 60 حرفاً منه بعد طيّ فراغه بصمت. الإحداثيان معاً أو لا شيء. أرسل الجسم بترميز UTF-8.',
          '- النجاح 201 بالموقع الجديد.',
          '- 409 LOCATION_NAME_TAKEN لاسم مكرر، و400 لإحداثي دون الآخر أو خارج المدى.',
          '- إعادة التسمية أو الأرشفة بـPUT /api/locations/:id بالجسم {"isActive":false}، وترجع 409 LOCATION_HAS_REPS (مع repsCount) إن بقي فيه مناديب.',
          '- الحذف بـDELETE لا يصح إلا لموقع بلا مناديب ولا مستندات، وإلا 409 LOCATION_HAS_DOCUMENTS — أرشفه بدلاً من حذفه.',
        ].join('\n'),
        curl: send('POST', '/locations', '{"name":"فرع جدة","lat":21.5433,"lng":39.1728}'),
      },
      {
        title: 'أسند المناديب إلى المواقع',
        method: 'PUT', path: '/locations/reps/:salesRepId',
        text: [
          'اقرأ المناديب بموقع كلٍّ منهم من GET /api/locations/reps ([{id, name, isActive, locationId}])، أو من locationId في GET /api/sales-reps.',
          'ثم أسند بالجسم {"locationId":"<locationId>"}، أو {"locationId":null} لإخراجه من كل المواقع. الحقل إلزامي في الجسم.',
          '- 409 LOCATION_ARCHIVED لموقع مؤرشف، و404 لمندوب أو موقع غير موجود أو خارج النطاق.',
          '- الإسناد يسري على ما يصدره المندوب بعده فقط.',
        ].join('\n'),
        curl: send('PUT', '/locations/reps/<salesRepId>', '{"locationId":"<locationId>"}'),
      },
      {
        title: 'اقرأ ملخّص الفترة كما تعرضه الصفحة',
        method: 'GET', path: '/locations/summary',
        text: [
          'الرد data{range{from, to, timezone}, rows[], none, totals}، وكل صف {locationId, name, isActive, lat, lng, sales{count, amount}, returns{count, amount}, net, loads{count, qty, products[{productId, name, unit, qty}]}}.',
          '- from وto أيام بتوقيت الشركة المحلي لا UTC، والافتراض اليوم. التاريخ غير الصالح أو from بعد to يرجع 400.',
          '- الفواتير المؤكدة وحدها بتاريخها invoiceDate، والتحميلات بلحظة تسجيلها بكميات بلا مبالغ.',
          '- none سطر «بلا موقع»: ما خُتم قبل التفعيل أو لمندوب بلا موقع.',
        ].join('\n'),
        curl: get('/locations/summary?from=2026-10-01&to=2026-10-25'),
      },
      {
        title: 'أو اسحب المستندات المختومة نفسها',
        method: 'GET', path: '/invoices',
        text: [
          'الفواتير: GET /api/invoices?locationId=<id>&from=…&to=…&page=1&limit=200، والقيمة none للفواتير بلا موقع. كل صف يحمل locationId وlocation{id, name}.',
          'التحميلات: GET /api/van-stock/loads?locationId=<id>&type=LOAD&from=…&to=…&page=1&limit=200، ومع page يضاف pagination للرد.',
          'تنبيه: from وto في الفواتير بمنتصف ليل UTC، وفي التحميلات والملخّص بأيام الشركة — فقد يختلف مجموع يوم واحد بينهما بما وقع بين منتصف الليل والثالثة فجراً بتوقيت الرياض.',
        ].join('\n'),
        curl: get('/invoices?locationId=<locationId>&from=2026-10-01&to=2026-10-25&page=1&limit=200'),
      },
      {
        title: 'أبقِ نظامكم متزامناً',
        text: [
          'للانعكاس أولاً بأول استعمل المزامنة (القسم ٣) بدل سحب القوائم:',
          '- /api/v1/sync/locations: أسماء المواقع ونقاطها وأرشفتها، تُلتقط إعادة التسمية والأرشفة بطابع التعديل. يشترط صلاحية canManageSalesReps، ثم ألا يكون النظام المحاسبي مطفأً (403 ACCOUNTING_DISABLED)، ثم تفعيل الميزة (403 LOCATIONS_DISABLED).',
          '- locationId موجود في /api/v1/sync/invoices و/api/v1/sync/van-loads و/api/v1/sync/sales-reps، فتبني الملخّص في نظامكم بتجميعها.',
          '- الموقع المحذوف حذفاً فعلياً يُكتشف بمطابقة /api/v1/sync/locations/ids مرة في اليوم.',
        ].join('\n'),
        curl: get('/v1/sync/locations?since=2026-10-25T00:00:00Z&limit=500'),
      },
    ],
  },
  {
    key: 'payment-methods-guide',
    title: 'ربط صفحة طرق الدفع',
    intro: [
      'صفحة «طرق الدفع» تعرض ما حصّله كل مندوب بكل طريقة دفع في فترة. النقدي فيها = سندات القبض النقدية + فواتير البيع النقدي، وكل طريقة أضافتها الشركة (مثل STC Pay) لها جدولها المستقل بمفتاحها c_….',
      'كل طريقة مخصّصة تُعامل محاسبياً مثل أساس من أربعة: CASH أو POS أو BANK_TRANSFER أو CHEQUE. السند يحمل الأساس في paymentMethod والمفتاح في paymentMethodKey، والمفاتيح لا تُحذف أبداً ولا يتغيّر أساسها.',
    ].join('\n'),
    steps: [
      {
        title: 'تحقّق أن الصفحة مفعّلة لشركتكم',
        method: 'GET', path: '/company',
        text: [
          'العَلَم يفعّله مزوّد الخدمة: اقرأ data.paymentMethodsEnabled وdata.accountingEnabled.',
          '- بدونه يرجع GET /api/reports/payment-methods وPUT /api/company/payment-methods الرمز 403 PAYMENT_METHODS_NOT_ALLOWED، وقبله 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً.',
          '- لا يشترط العَلَم: قراءة الطرق، وإصدار السند بـpaymentMethodKey، وتقرير التحصيل.',
        ].join('\n'),
        curl: get('/company'),
      },
      {
        title: 'جهّز المفتاح بالصلاحيات المناسبة',
        text: [
          '- التقرير: canViewReports، ويحترم نطاق مُصدِر المفتاح إن كان مقيّداً.',
          '- تعديل الطرق: canManageCompanySettings بمفتاح «قراءة وكتابة».',
          '- إصدار السندات: canManageReceipts بمفتاح «قراءة وكتابة».',
        ].join('\n'),
      },
      {
        title: 'اقرأ طرق الشركة وما يصح اختياره في السند',
        method: 'GET', path: '/company/payment-methods',
        text: [
          'الرد {data: الإعداد أو null, stored, hasCompany, methods:[{id, base, key, custom, label, companyLabel, icon, active, manual}], choices:[…]}.',
          '- choices ما يصح إرساله في السند الآن: المفعّلة اليدوية بلا ONLINE.',
          '- methods كل الطرق ومنها المعطّلة: بها تترجم paymentMethodKey في السندات القديمة إلى اسم.',
          '- data = null يعني الافتراضي: الطرق الخمس بأسمائها الافتراضية ومفعّلة.',
        ].join('\n'),
        curl: get('/company/payment-methods'),
      },
      {
        title: 'عدّل الطرق أو أضف طريقة (اختياري)',
        method: 'PUT', path: '/company/payment-methods',
        text: [
          'الإعداد يُرسل كاملاً ولا يوجد PATCH: اقرأ data أولاً، عدّله، ثم أرسله كله. الطريقة الجديدة بلا key يولّد الخادم مفتاحها c_… ويعيده في data.custom.',
          'القواعد:',
          '- لا تُحذف طريقة محفوظة ولا يتغيّر base لها، وإلا 409 PAYMENT_METHODS_CONFLICT — أوقفها بـ"active":false بدل حذفها.',
          '- ONLINE لا يُعطَّل، وطريقة مفعّلة واحدة على الأقل، و20 طريقة مخصّصة على الأكثر، والاسم من 1 إلى 40 حرفاً وفريد بعد التطبيع العربي.',
          '- المدمجة التي لم تُسمَّ تحجز اسمها الافتراضي وأسماءها البديلة («نقد» و«تحويل» و«دفع الكتروني»)، فطريقة مخصّصة بأحدها ترجع 400 PAYMENT_METHODS_INVALID.',
          '- الأيقونات من قائمة مغلقة: wallet وsmartphone وcredit-card وbanknote وlandmark وqr-code وcoins وgift وreceipt وhandshake وstore وglobe.',
          '- الأخطاء: 400 PAYMENT_METHODS_INVALID مع issues[{path, message}]، و413 PAYMENT_METHODS_TOO_LARGE فوق 8 كيلوبايت، و409 COMPANY_SETTINGS_MISSING.',
          '- استعادة الافتراضي بالجسم {"reset":true} لا null، والطرق المخصّصة تبقى معطّلة لا تُحذف.',
          '- إن انقطع الرد بعد إضافة طريقة جديدة فلا تُعد الطلب كما هو: الإعادة ترجع 409 لأن المفتاح المولَّد غائب عن جسمك. اقرأ GET أولاً ثم أعد التعديل.',
        ].join('\n'),
        curl: send('PUT', '/company/payment-methods', '{"version":1,"builtins":{"POS":{"label":"مدى"},"CHEQUE":{"active":false}},"custom":[{"label":"STC Pay","base":"BANK_TRANSFER","icon":"smartphone"}]}'),
      },
      {
        title: 'أصدر سند قبض بطريقة مخصّصة',
        method: 'POST', path: '/receipts',
        text: [
          'أرسل paymentMethodKey من choices، ومعه salesRepId دائماً (بدونه 400). الخادم يكتب في paymentMethod الأساس المحفوظ للطريقة أياً كان المرسل.',
          '- الأخطاء 422: PAYMENT_METHOD_UNKNOWN لمفتاح غير معروف، وPAYMENT_METHOD_DISABLED لطريقة معطّلة، وPAYMENT_METHOD_KEY_ONLINE مع paymentMethod = ONLINE.',
          '- للطرق المدمجة يكفي paymentMethod وحده، والمعطّلة منها ترجع 422 PAYMENT_METHOD_DISABLED.',
          '- أرسل clientRef (UUID) لمنع التكرار عند إعادة المحاولة. وترويسة X-FS-Replay تُمحى من طلبات المفتاح فلا ترسلها.',
        ].join('\n'),
        curl: send('POST', '/receipts', '{"customerId":"<customerId>","salesRepId":"<salesRepId>","amount":250,"paymentMethodKey":"c_k3x9q2m7p1","clientRef":"<uuid>"}'),
      },
      {
        title: 'اقرأ تقرير الصفحة',
        method: 'GET', path: '/reports/payment-methods',
        text: [
          'الرد data{range{from, to, timezone}, methods[{method, base, key, custom, label, companyLabel, icon, active, rows[{salesRepId, repName, repActive, amount, count, receiptsAmount, receiptsCount, invoicesAmount, invoicesCount}], total, noRep}], total{amount, count}, noRep, repsCount, roster[{salesRepId, repName, repActive}]}.',
          '- from وto أيام بتوقيت الشركة لا UTC، والافتراض اليوم (وfrom وحده في المستقبل يجعل to = from). ويقبل teamId=<id> أو none بوسم المستند.',
          '- التحصيل بلا مندوب في noRep خارج الجداول، والطريقة المعطّلة لا تظهر إلا إن حُصّل بها في الفترة.',
          '- لا يطابق تقرير التحصيل: النقدي هنا يضيف فواتير البيع النقدي، والأيام هنا بتوقيت الشركة وهناك UTC، والتحصيل بلا مندوب هنا خارج total وهناك داخله.',
          '- roster مناديب النطاق النشطون (أو أعضاء الفريق ومن له مستند موسوم به مع teamId) ومعهم كل من حصّل في الفترة ولو موقوفاً. لعرض «كل مندوب مع كل طريقة» ولو بلا تحصيل اجمع roster مع rows كل طريقة.',
        ].join('\n'),
        curl: get('/reports/payment-methods?from=2026-10-01&to=2026-10-25'),
      },
      {
        title: 'التحصيل التفصيلي والمزامنة',
        method: 'GET', path: '/reports/collections',
        text: [
          'GET /api/reports/collections?from=…&to=…&paymentMethodKey=c_… يرجع السندات وsummary.byMethod بالأساس وbyMethodKey وmethods بأسماء الشركة. from وto هنا بمنتصف ليل UTC، والمفتاح بغير صيغة c_… يُهمل فيعود كل السجل.',
          'وللانعكاس أولاً بأول: /api/v1/sync/receipts يحمل paymentMethodKey (null للطرق المدمجة) والأساس في paymentMethod، وأسماء الطرق من GET /api/company/payment-methods.',
        ].join('\n'),
        curl: get('/reports/collections?from=2026-10-01&to=2026-10-25&paymentMethodKey=c_k3x9q2m7p1'),
      },
    ],
  },
  {
    key: 'warehouse-guide',
    title: 'ربط صفحة مخزون الشركة',
    intro: [
      'صفحة «مخزون الشركة» تعرض رصيد المستودع المركزي لكل صنف وقيمته بتكلفة الشراء، وسجل الوارد والتسويات، وقيمة ما في سيارات المناديب، و«طلب مخزون» الذي يجمع طلبات البضاعة من المناديب.',
      'الرصيد لا يُخزَّن بل يُحسب في كل طلب: الوارد + تسويات المستودع + العائد من السيارات − المحمَّل للسيارات. فتحميل سيارة (POST /van-stock/loads بالنوع LOAD) ينقص المستودع، وتنزيلها (UNLOAD) يعيد الكمية إليه.',
      'التقييم بتكلفة الشراء الصافية قبل الضريبة: الوارد المسعّر يحرّك متوسط التكلفة، والوارد بلا سعر يُحسب كمية بلا قيمة (uncostedQty).',
    ].join('\n'),
    steps: [
      {
        title: 'تحقّق أن الميزة مفعّلة لشركتكم',
        method: 'GET', path: '/company',
        text: [
          'اقرأ data.warehouseEnabled وdata.accountingEnabled. الميزة مطفأة افتراضياً ويفعّلها مزوّد الخدمة، وتشترط ألا يكون النظام المحاسبي مطفأً.',
          '- بدون العَلَم ترجع مسارات /api/warehouse الرمز 403 برسالة «ميزة مخزون الشركة غير مفعلة لهذه الشركة»، ومسارات /api/rep-stock-requests الرمز 403 WAREHOUSE_NOT_ENABLED، ومورد المزامنة warehouse-entries الرمز 403 WAREHOUSE_DISABLED.',
          '- والنظام المحاسبي المطفأ يرجع 403 ACCOUNTING_NOT_ALLOWED (وفي المزامنة ACCOUNTING_DISABLED).',
        ].join('\n'),
        curl: get('/company'),
      },
      {
        title: 'جهّز المفتاح بالصلاحيات المناسبة',
        text: [
          'المفتاح يعمل بصلاحيات من أصدره، وكل مسارات المخزون تشترط له صلاحية canManageVanStock:',
          '- القراءة تكفيها مفتاح «قراءة فقط»، والوارد والتسوية والتحميل وتعديل الطلبات تشترط مفتاح «قراءة وكتابة» (وإلا 403 API_KEY_FORBIDDEN).',
          '- الأصناف ومعرّفاتها من GET /api/products (صلاحية canManageProducts) أو من مورد المزامنة products.',
          '- رصيد المستودع على مستوى الشركة كلها، أما قيمة ما في السيارات وطلبات المناديب فتتبع نطاق المناديب لصاحب المفتاح إن كان مقيّداً.',
        ].join('\n'),
        curl: get('/v1/me'),
      },
      {
        title: 'اقرأ رصيد المستودع وقيمته',
        method: 'GET', path: '/warehouse',
        text: [
          'الرد [{productId, name, code, unit, received, adjusted, loadedToVans, returnedFromVans, onHand, avgCost, stockValue, costedQty, uncostedQty}]، مرتباً تنازلياً بالرصيد، ويضم كل الأصناف النشطة ولو بلا حركة.',
          '- onHand = received + adjusted + returnedFromVans − loadedToVans، وقد يصير سالباً إن حُمّل للسيارات أكثر من الوارد — إلا الصنف المتتبَّع بالتشغيلة («تتبّع اللوط»): لا يُحمَّل ولا يُسوّى بالنقص فوق رصيد تشغيلاته (409 LOT_STOCK_INSUFFICIENT، دليل ربط تتبّع اللوط).',
          '- stockValue = costedQty × avgCost، وavgCost صافٍ قبل الضريبة. وuncostedQty خارج القيمة صراحةً.',
          '- للمخزون في تاريخ مضى أضف ?asOf=YYYY-MM-DD (نهاية ذلك اليوم بتوقيت الشركة).',
          '- الكميات بوحدة الأساس للصنف (unit، أصغر ما يُباع)، وavgCost لوحدة الأساس، وunits وحدات الصنف الأكبر لعرض الرصيد «2 كرتون و3 حبة».',
        ].join('\n'),
        curl: get('/warehouse?asOf=2026-10-25'),
      },
      {
        title: 'سجّل وارداً أو تسوية جرد',
        method: 'POST', path: '/warehouse/entries',
        text: [
          'الجسم {type: RECEIVE|ADJUST, supplier?, note?, costsIncludeTax?, items:[{productId, qty, unitId?, unitCost?}]}، والنجاح 201 بالحركة.',
          '- unitId وحدة البند كما في فاتورة المورّد (كرتون) من units[].id للصنف: qty بها وunitCost لها، والرصيد يزيد qty × factor. بلا unitId فالكمية والتكلفة بوحدة الأساس.',
          '- RECEIVE وارد أو شراء بكميات موجبة، وunitCost اختياري موجب (أغفله إن لم يوجد سعر). مع costsIncludeTax=true يحوّل الخادم التكلفة إلى الصافي بضريبة الصنف.',
          '- ADJUST تسوية جرد: الموجب يزيد والسالب ينقص، وبلا unitCost (وإلا 400).',
          '- الصنف المتتبَّع بالتشغيلة («تتبّع اللوط»): كل سطر تشغيلة واحدة — items[].lotId لتشغيلة قائمة، أو items[].lotNumber مع productionDate وexpiryDate (YYYY-MM-DD) تُحلّ أو تُنشأ. الوارد بلا تشغيلة 422 LOT_REQUIRED (دليل ربط تتبّع اللوط).',
          '- لا clientRef ولا تعديل ولا حذف: إعادة الطلب نفسه تُنشئ حركة مكررة، فلا تُعِد الإرسال إلا بعد التأكد من فشل الأول، والتصحيح بتسوية معاكسة.',
          '- الحركة مخزون فقط: لا تُنشئ قيداً محاسبياً ولا ذمة مورد.',
        ].join('\n'),
        curl: send('POST', '/warehouse/entries', '{"type":"RECEIVE","supplier":"مؤسسة التوريد المتحدة","note":"فاتورة مورد 5512","costsIncludeTax":true,"items":[{"productId":"<productId>","qty":120,"unitCost":11.5}]}'),
      },
      {
        title: 'اقرأ سجل الحركات',
        method: 'GET', path: '/warehouse/entries',
        text: [
          'آخر 100 حركة (الوارد والتسويات)، الأحدث أولاً، ولكل سطر lineCost ولكل حركة totalCost. التحميل والتنزيل لا يظهران هنا بل في GET /api/van-stock/loads.',
          'للتاريخ الكامل استعمل مورد المزامنة warehouse-entries (الخطوة الأخيرة).',
        ].join('\n'),
        curl: get('/warehouse/entries'),
      },
      {
        title: 'حمّل سيارة من المستودع أو أعِد إليه',
        method: 'POST', path: '/van-stock/loads',
        text: [
          'الجسم {salesRepId, type: LOAD|UNLOAD, note?, items:[{productId, qty, unitId?}]}. LOAD ينقص المستودع ويزيد السيارة، وUNLOAD يعيد الكمية إلى المستودع بكلفة خروجها من السيارة نفسها.',
          '- unitId وحدة البند من units[].id للصنف (كرتون): qty بها والرصيد يتحرّك qty × factor. بلا unitId فالكمية بوحدة الأساس.',
          '- لا فحص لتوفر الكمية في المستودع ولا في السيارة، فتحقّق من GET /api/warehouse قبل التحميل إن أردت منع الرصيد السالب. والاستثناء الصنف المتتبَّع بالتشغيلة («تتبّع اللوط»): الخادم يوزّع تحميله على تشغيلات المستودع بالأقرب انتهاءً ويرفض ما يتجاوز رصيدها 409 LOT_STOCK_INSUFFICIENT، والإنقاص من السيارة يلزمه مصدر صريح في items[].lots إن كان فيها أكثر من تشغيلة (422 LOT_REQUIRED).',
          '- التحميل LOAD يُختم بموقع المندوب إن كانت ميزة «لوكيشن» مفعّلة (انظر دليل اللوكيشن).',
          '- السجل في GET /api/van-stock/loads، وقيمة ما في كل السيارات في GET /api/warehouse/vans ({qty, value, uncostedQty, unsellableQty, reps, products, deletedVans}).',
        ].join('\n'),
        curl: send('POST', '/van-stock/loads', '{"salesRepId":"<salesRepId>","type":"LOAD","note":"تحميل صباح الأحد","items":[{"productId":"<productId>","qty":24}]}'),
      },
      {
        title: 'اقرأ طلبات البضاعة من المناديب',
        method: 'GET', path: '/rep-stock-requests',
        text: [
          'المندوب الذي لا يملك صلاحية التحميل يرفع من تطبيقه ما يحتاجه، فيظهر هنا. الرد [{id, status, note, createdAt, updatedAt, salesRepId, repName, items:[{productId, name, code, unit, requestedQty, qty, unitName, unitFactor, baseQty, requestedBaseQty, baseUnit, units}]}] للطلبات المعلّقة وحدها، الأقدم أولاً.',
          '- unit وحدة السطر كما طلب المندوب (كرتون) وrequestedQty وqty بها، وbaseQty بوحدة الأساس baseUnit لجمع الطلبات في طلبكم العام.',
          '- requestedQty ما طلبه المندوب، وqty ما تعتمده الإدارة. احفظ updatedAt لكل طلب: هو نسخته التي ترسلها في الخطوتين التاليتين.',
          '- الطلب لا يمسّ أي رصيد. يصير بضاعة في السيارة حين تسجّل له تحميلاً (الخطوة السابقة).',
        ].join('\n'),
        curl: get('/rep-stock-requests'),
      },
      {
        title: 'عدّل الكميات المعتمدة أو ارفض',
        method: 'PUT', path: '/rep-stock-requests/:id',
        text: [
          'التعديل بالجسم {updatedAt, items:[{productId, qty}]} لأصناف في الطلب نفسه، والرد الطلب بنسخة updatedAt جديدة. الصنف غير الموجود في الطلب يرجع 400.',
          'الرفض بـPOST /api/rep-stock-requests/:id/reject بالجسم {updatedAt}.',
          '- 404 لطلب غير معلّق أو خارج النطاق، و409 إن عدّل المندوب طلبه بعد قراءتك: أعد القراءة ثم أعد المحاولة.',
        ].join('\n'),
        curl: send('PUT', '/rep-stock-requests/<requestId>', '{"updatedAt":"2026-10-27T08:15:02.114Z","items":[{"productId":"<productId>","qty":30}]}'),
      },
      {
        title: 'أرسل الطلب العام',
        method: 'POST', path: '/rep-stock-requests/send',
        text: [
          'الجسم {ref, requests:[{id, updatedAt}]}، وref رقم مرجع طلب المشتريات أو الإنتاج في نظامكم (حتى 40 حرفاً)، فتصير الطلبات المشمولة SENT ويراها المندوب «أُرسلت».',
          '- كل شيء أو لا شيء: إن تغيّر طلب أو غاب رجع 409 ولم يُرسَل شيء.',
          '- ورقة الطلب (PDF) تُبنى في لوحة التحكم ولا يرجعها الخادم: ابنِ مستندكم من الكميات المعتمدة qty.',
        ].join('\n'),
        curl: send('POST', '/rep-stock-requests/send', '{"ref":"PR-2026-114","requests":[{"id":"<requestId>","updatedAt":"2026-10-27T08:15:02.114Z"}]}'),
      },
      {
        title: 'أبقِ نظامكم متزامناً',
        text: [
          'للانعكاس أولاً بأول استعمل المزامنة (القسم ٣) بدل سحب القوائم:',
          '- /api/v1/sync/warehouse-entries: الوارد والتسويات ببنودها. يشترط canManageVanStock ثم ألا يكون النظام المحاسبي مطفأً (403 ACCOUNTING_DISABLED) ثم تفعيل الميزة (403 WAREHOUSE_DISABLED). الحركة المحذوفة تُكتشف بمطابقة /ids.',
          '- /api/v1/sync/van-loads: التحميل والتنزيل والتسوية للسيارات، ومعها locationId.',
          '- بهما مع الفواتير تحسب رصيد المستودع والسيارات في نظامكم بالمعادلة أعلاه، بجمع baseQty لكل بند (الكمية بالأساس) لا qty: البند يحمل unitName وunitFactor وbaseQty = qty × unitFactor.',
          '- «تتبّع اللوط» مفعّل: بنود warehouse-entries تحمل id وlotId، وبنود van-loads تحمل id، وتوزيع التشغيلات في موارده الخمسة (دليل ربط تتبّع اللوط).',
        ].join('\n'),
        curl: get('/v1/sync/warehouse-entries?since=2026-10-25T00:00:00Z&limit=500'),
      },
    ],
  },
  {
    key: 'lots-guide',
    title: 'ربط تتبّع اللوط',
    intro: [
      '«تتبّع اللوط» يقسم رصيد الصنف المتتبَّع على تشغيلات (لوطات): رقم تشغيلة مطبَّع لكل صنف بتاريخَي إنتاج وانتهاء وحالة. يعرف به نظامكم أي تشغيلة في المستودع وفي كل سيارة، ومن العملاء الذين استلموا تشغيلة بعينها حين تُسحب.',
      'الميزة يفعّلها مزوّد الخدمة لكل شركة، ثم تُفعَّل لكل صنف. المطفأة لا تغيّر سلوك أي مسار ولا تُرجع صفوف تشغيلات (withLots يُتجاهل، وموارد المزامنة الخمسة 403 LOTS_DISABLED)، والأعمدة الجديدة في الصفوف القائمة (مثل lotTracked في الصنف) بلا أثر. وكل كمية تشغيلة بوحدة الأساس للصنف (كرتون من 24 = 24).',
      'القاعدة الحاكمة: لا يصير رصيد أي تشغيلة سالباً، ولا ينقص الرصيد «غير المسمّى» (ما لا تُعرف تشغيلته: رصيد ما قبل التفعيل والمرتجع الحرّ) تحت الصفر، لأي مُصدِر ومنه المفتاح، ولا يُعفي منها إذن البيع بدون مخزون. البيع والتحميل يوزّعهما الخادم بالأقرب انتهاءً (FEFO) ثم من غير المسمّى، والتشغيلة الموقوفة أو المنتهية لا تُباع ولا تُحمَّل.',
      'المفتاح عميلٌ حيّ: ترويسة X-FS-Replay تُمحى من طلباته، فلا ينال تسامح صندوق تطبيق المندوب ولا الحجز للمراجعة، ويُقاس يوم الانتهاء بيوم الشركة بساعة الخادم.',
    ].join('\n'),
    steps: [
      {
        title: 'تحقّق أن الميزة مفعّلة لشركتكم',
        method: 'GET', path: '/company',
        text: [
          'اقرأ data.lotTrackingEnabled وdata.accountingEnabled. الميزة مطفأة افتراضياً، وتشترط ألا يكون النظام المحاسبي مطفأً.',
          '- بدونها ترجع كل مسارات /api/lots وGET /api/van-stock/lot-balances وGET /api/reports/lot-sales الرمز 403 LOTS_NOT_ALLOWED (وقبله 403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأً)، وموارد المزامنة الخمسة 403 LOTS_DISABLED.',
          '- مسارات /api/lots تشترط لصاحب المفتاح صلاحية canManageVanStock، والكتابة مفتاح «قراءة وكتابة» (وإلا 403 API_KEY_FORBIDDEN). وdata.lotOnInvoice: هل يُطبع رقم التشغيلة على فاتورة العميل (PUT /api/lots/settings).',
        ].join('\n'),
        curl: get('/company'),
      },
      {
        title: 'فعّل التتبّع للأصناف',
        method: 'POST', path: '/lots/products/tracking',
        text: [
          'الجسم {enabled: true, productIds:[...]} أو {enabled: true, categoryId} أو {enabled: true, all: true} — واحدٌ منها بالضبط (وإلا 400). يشترط صلاحية canManageProducts أيضاً. والصنف الواحد يُفعَّل كذلك بـPUT /api/products/:id بالحقل lotTracked.',
          '- الرد {updated, needsAttention:[{productId, name, warehouse:{total, unknown}|null, vans:[{salesRepId, total, unknown}]}]}: أصنافٌ لها رصيد «غير مسمّى» أو سالب تحتاج تسمية (الخطوة الرابعة)، والسالب يُصحَّح أولاً بتسوية موجبة بلا تشغيلة.',
          '- التفعيل يبدأ «حقبة» للصنف: حركات التشغيلات قبلها لا تدخل الأرصدة. والإطفاء ({enabled: false}) لصنف له أرصدة مسمّاة يرجع 409 LOT_TRACKING_HAS_BALANCE ما لم ترسل confirmLotBalances: true، ويُخفي ولا يحذف.',
        ].join('\n'),
        curl: send('POST', '/lots/products/tracking', '{"enabled":true,"productIds":["<productId>"]}'),
      },
      {
        title: 'سجّل الوارد بتشغيلته',
        method: 'POST', path: '/warehouse/entries',
        text: [
          'لكل سطر صنفٍ متتبَّع تشغيلةٌ واحدة: items[].lotNumber مع productionDate وexpiryDate (YYYY-MM-DD)، فتُنشأ التشغيلة أو تُحلّ القائمة بالرقم المطبَّع (مسافات مدموجة وأحرف لاتينية كبيرة وأرقام عربية إلى لاتينية، حتى 64 حرفاً)، أو items[].lotId لتشغيلة قائمة.',
          '- الوارد بلا تشغيلة 422 LOT_REQUIRED. والانتهاء إلزامي لصنف صلاحيته مفعّلة (422 LOT_EXPIRY_REQUIRED)، والإنتاج بعد الانتهاء 422 LOT_DATES_INVALID، ورقمٌ مسجَّل بتواريخ أخرى 409 LOT_DATES_MISMATCH.',
          '- الرد 201 وكل بند فيه lotId وlot:{lotNumber, productionDate, expiryDate}. وفي شركة بلا مخزون شركة يحمل التحميل تشغيلته بنفسه (POST /api/van-stock/loads بـitems[].lotNumber).',
          '- المخزون الافتتاحي بالاستيراد (POST /api/import/opening-stock) يقبل الأعمدة نفسها لكل صف: lotNumber وproductionDate وexpiryDate.',
        ].join('\n'),
        curl: send('POST', '/warehouse/entries', '{"type":"RECEIVE","supplier":"مصنع الأغذية","items":[{"productId":"<productId>","qty":240,"unitCost":4.2,"lotNumber":"B-2026-1031","productionDate":"2026-10-20","expiryDate":"2027-04-20"}]}'),
      },
      {
        title: 'سمِّ الرصيد القائم يوم التفعيل',
        method: 'POST', path: '/lots/relabel',
        text: [
          'الرصيد الذي سبق التفعيل «غير مسمّى»: يُباع ويُحمَّل بعد نفاد التشغيلات الصالحة بيقين UNKNOWN. لتسميته بعد الجرد أرسل {productId, place: WAREHOUSE|VAN, salesRepId (للسيارة), fromLotId: null, reason: LABEL_EXISTING, lines:[{lotNumber, productionDate, expiryDate, qty}]}.',
          '- التسمية لا تغيّر رصيد الصنف ولا قيمته، بل تنقل الكمية بين تشغيلة وأخرى أو من غير المسمّى إليها. وإعادة التصنيف بين تشغيلتين reason: RECLASSIFY مع fromLotId.',
          '- لا تسمية فوق الرصيد (409 LOT_STOCK_INSUFFICIENT)، ولا من تشغيلة موقوفة (422 LOT_BLOCKED) أو منتهية (422 LOT_EXPIRED). والإرجاع إلى غير المسمّى (سطر بلا toLotId ولا lotNumber) تصحيحٌ: reason: CORRECTION مع note، لمستخدم غير مقيّد بنطاق (403 LOT_SCOPED_USER).',
        ].join('\n'),
        curl: send('POST', '/lots/relabel', '{"productId":"<productId>","place":"WAREHOUSE","fromLotId":null,"reason":"LABEL_EXISTING","lines":[{"lotNumber":"B-2026-0915","productionDate":"2026-09-15","expiryDate":"2027-03-15","qty":96}]}'),
      },
      {
        title: 'اقترح التحميل ثم حمّل السيارة',
        method: 'GET', path: '/lots/fefo',
        text: [
          'للمعاينة قبل الحفظ: GET /api/lots/fefo?productId=…&qty=…&salesRepId=… يعيد {rows:[{lotId, qty, certainty, flags, expiryDate}], lines, shortage?, warnings} بالأقرب انتهاءً من المستودع، بلا قفل ولا كتابة. qty بالأساس، ولبند بالكرتون أرسل unitFactor فيُؤخذ الكرتون من تشغيلة واحدة ما أمكن.',
          '- ثم POST /api/van-stock/loads بالنوع LOAD: بلا items[].lots يوزّع الخادم بنفسه بالقاعدة نفسها، أو أرسل items[].lots = [{lotId, qty}] بالأساس ومجموعها qty × factor. والرد يحمل لكل بند lots، وwarnings (LOT_MULTI_IN_VAN حين صار في السيارة أكثر من تشغيلة للصنف).',
          '- النقص 409 LOT_STOCK_INSUFFICIENT، وإن لم يكن في المستودع شيء من الصنف فبالرسالة «سجّل وارد التشغيلة أولاً». والتنزيل UNLOAD من سيارة فيها أكثر من تشغيلة يلزمه items[].lots، وإلا 422 LOT_REQUIRED وفي detail.sources تشغيلاتها لتختار.',
        ].join('\n'),
        curl: get('/lots/fefo?productId=<productId>&qty=48&unitFactor=24&salesRepId=<salesRepId>'),
      },
      {
        title: 'اقرأ الأرصدة بالتشغيلة',
        method: 'GET', path: '/lots/balances',
        text: [
          'GET /api/lots/balances?productIds=<id1>,<id2> (حتى 50 صنفاً، و?asOf=YYYY-MM-DD لتاريخ مضى) يعيد {day, warehouse:[…], vans:[{salesRepId, repName, deleted, view}]}، ولكل مكان: total رصيد الصنف بدلاءه {SELLABLE, EXPIRED, DAMAGED}، وlots لكل تشغيلة raw (الخام) وheld (المحجوز) وusable (الصالح = الخام − المحجوز)، وunknown غير المسمّى، وavailability {available, availableNamed, availableUnknown, quarantined, expiredUnsold, held, …}.',
          '- quarantined رصيد تشغيلات موقوفة، وexpiredUnsold تشغيلات منتهية لم تُبع: كلاهما في السيارة ولا يُباع. وheld مرتجع إشعار دائن قياسي بانتظار اعتماد الهيئة.',
          '- لسيارة واحدة بشكل مختصر: GET /api/van-stock/lot-balances?salesRepId=…، وللبطاقات بحثاً: GET /api/lots?q=…&expiringWithinDays=30، وللعجوزات: GET /api/lots/health.',
          '- البيع في POST /api/invoices يوزّعه الخادم من سيارة المندوب، فلا يلزم إرسال تشغيلة. وتوزيع كل فاتورة بـGET /api/invoices/:id?withLots=1.',
        ].join('\n'),
        curl: get('/lots/balances?productIds=<productId>'),
      },
      {
        title: 'تتبّع تشغيلة: من استلمها؟',
        method: 'GET', path: '/lots/:id/trace',
        text: [
          'GET /api/lots/<lotId>/trace يعيد مصدر التشغيلة (origin)، وأماكنها الآن (places) بالمحمَّل والمنزَّل والمباع والمرتجع، والعملاء (customers) بفواتيرهم وصافي كلٍّ منها ويقين النسبة (weakest)، وسجلّها (events).',
          '- scope=STRICT (الافتراضي) ما سُجّل بالتشغيلة نفسها. وscope=BROAD يضيف كل بيعٍ للصنف من سيارةٍ أثناء وجود التشغيلة فيها، موسوماً broad بيقين «مفترض» — للسحب الاحتياطي الأوسع.',
          '- customers تتطلب صلاحية canManageCustomers وإلا null مع customersHidden: true. والمستخدم المقيّد يرى فواتير نطاقه وسياراته وحدها.',
          '- للمبيعات حسب التشغيلة في فترة: GET /api/reports/lot-sales (صلاحية canViewReports).',
        ].join('\n'),
        curl: get('/lots/<lotId>/trace?scope=STRICT'),
      },
      {
        title: 'أوقف تشغيلة أو اسحبها',
        method: 'PATCH', path: '/lots/:id/status',
        text: [
          'الجسم {status: BLOCKED, blockKind: HOLD|RECALL, reason, updatedAt} — HOLD إيقاف مؤقت، وRECALL سحب من السوق. وإعادة التنشيط {status: ACTIVE, reason, updatedAt}. السبب إلزامي في الاتجاهين (422 LOT_REASON_REQUIRED)، والإجراء لمستخدم غير مقيّد بنطاق (403 LOT_SCOPED_USER).',
          '- updatedAt نسخة البطاقة كما قرأتها من GET /api/lots/:id: إن تغيّرت بعد قراءتك رجع 409 LOT_CHANGED فأعد القراءة.',
          '- الموقوفة لا تُباع ولا تُحمَّل ولا يُسمّى منها، ورصيدها في السيارات يصير «معزولاً». نزّله: GET /api/lots/<lotId>/unload-plan يعيد [{salesRepId, repName, deleted, usable, held}] لكل سيارة فيها، ثم POST /api/van-stock/loads بالنوع UNLOAD وitems[].lots = [{lotId, qty}] (وسيارة المندوب المحذوف بـdeletedSalesRepId). والإتلاف بتسوية نقص.',
        ].join('\n'),
        curl: send('PATCH', '/lots/<lotId>/status', '{"status":"BLOCKED","blockKind":"RECALL","reason":"سحب احترازي بطلب المصنع","updatedAt":"2026-10-30T09:12:44.501Z"}'),
      },
      {
        title: 'أبقِ نظامكم متزامناً',
        text: [
          'خمسة موارد مزامنة (القسم ٣) تحتاج تفعيل الميزة (403 LOTS_DISABLED) وألا يكون النظام المحاسبي مطفأً (403 ACCOUNTING_DISABLED أولاً)، وصاحب مفتاح غير مقيّد بنطاق:',
          '- product-lots: البطاقات بطابع التعديل (الإيقاف وتعديل التواريخ يعيدان إرسالها)، وتُحذف فعلياً فطابِقها بـ/ids.',
          '- van-load-item-lots وinvoice-item-lots: توزيع بنود الحركات والفواتير على التشغيلات (vanLoadItemId يطابق items[].id في van-loads، وinvoiceItemId يطابق items[].id في invoices). lot-relabels: التسميات. lot-events: سجل التدقيق.',
          '- في lot-events صفوفٌ بلا lotId لتبديل التتبّع (TRACKING_ON وTRACKING_OFF): للصنف productId معرّفه وbefore/after من {lotTracked, lotTrackedSince}، ولتبديل مزود الخدمة للميزة على الشركة productId = "*" (ليس معرّف صنف: لا تربطه بجدول الأصناف ولا تجعله مفتاحاً أجنبياً) وbefore {lotTrackingEnabled} وafter {lotTrackingEnabled, lotTrackingSince}.',
          '- تواريخ التشغيلة (productionDate وexpiryDate) أيامٌ بلا وقت: تصل في المزامنة بصيغة ISO عند منتصف ليل UTC، فخذ أول عشرة أحرف (YYYY-MM-DD) كما تعيدها مسارات /api/lots. وflags في invoice-item-lots أوسامٌ مفصولة بفاصلة أو null.',
          '- الأربعة الأخيرة بطابع الإنشاء: اطلب since = serverTime ناقص ٣ دقائق كما في القسم ٣ (معاملات التشغيلات تمتد حتى 20 ثانية). وتحويل وحدة أساس الصنف يضرب كمياتها دون إعادة إرسالها: اضرب بـconverted.factor أو أعد السحب بلا since.',
          '- والشركة المفعّلة وحدها: مورد products يحمل lotTracked، وبنود van-loads تحمل id، وبنود warehouse-entries تحمل id وlotId. التغيير لا يمسّ updatedAt الصفوف القديمة، فأعد سحب الموارد الثلاثة بلا since مرةً بعد التفعيل.',
        ].join('\n'),
        curl: get('/v1/sync/invoice-item-lots?since=2026-10-30T00:00:00Z&limit=500'),
      },
    ],
  },
];

/**
 * فهرس مسارات المنصة في مستند «الربط البرمجي API» — مستخرجٌ من مخططات zod ومعالجات كل موجّه
 * (العملاء، المنتجات، الفواتير، السندات، المناديب، المخزون، الميدان، التقارير). يُرسم في components/ApiDocs.tsx.
 * يُحدَّث حين يتغيّر عقد مسار؛ واختبار apiDocsCatalog.test.ts يتحقّق أن كل مسار مذكور هنا مركَّب فعلاً في الخادم.
 */
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
     "price في customerPrices صافٍ قبل الضريبة مثل basePrice للمنتج"
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
     "في الشركة التي تجمع البيانات: القيمة غير الصالحة تعود 400 CUSTOMER_ZATCA_INVALID مع fieldErrors. الاستثناء عند إرسال clientRef: لا يُرفض الطلب، بل تُسقط حقول المرحلة الثانية الخاطئة ويعود warnings",
     "aiPlaceId المسجل لعميل آخر في الشركة يعود 409 AI_PLACE_ALREADY_CUSTOMER. إذا أرسلت الرأس x-fs-replay: 1 لا يُرفض الإنشاء، وإنما يُسقط الربط وحده",
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
     "بلا ترقيم: يعيد كل حركات الفترة"
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
      "desc": "قائمة الأسعار. لا يوجد تحقق zod عليها، وغيابها يعطي 500"
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
      "desc": "السعر الخاص صافياً قبل الضريبة"
     }
    ],
    "response": "{success:true} بلا data. إذا لم يوجد العميل في الشركة يعود 404",
    "rules": [
     "لكل صنف upsert داخل معاملة واحدة، وفشل أي سطر يلغي الكل",
     "لا يحذف الأسعار التي لم تُرسل، ولا يوجد في هذه المجموعة مسار لحذف سعر خاص",
     "السعر صافٍ قبل الضريبة مثل basePrice، ويستخدم مرجعاً لسعر الفاتورة"
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
  "overview": "كل المسارات تحت /api/products وتعمل بمفتاح الشركة (Authorization: Bearer fsk_... أو X-API-Key) بهوية المستخدم الذي أصدره. على الموجّه كله ثلاثة حرّاس بالترتيب: authenticate ثم requireAccounting (403 ACCOUNTING_NOT_ALLOWED إن كان النظام المحاسبي مطفأ للشركة) ثم requireAdminPermission('canManageProducts') (403 «لا تملك صلاحية الوصول لهذا القسم» إن كانت صلاحية إدارة المنتجات false لصاحب المفتاح) وهذا يشمل القراءة أيضاً. الكتابة (POST/PUT/DELETE) تشترط requireAdmin (دور ADMIN أو MANAGER أو ACCOUNTANT) ولا تمر بمفتاح «قراءة فقط» (403 API_KEY_FORBIDDEN). كل الأسعار هنا (basePrice وشرائح الأسعار وأسعار العملاء) مخزنة صافية قبل الضريبة. الحذف أرشفة إن كان للصنف أثر (فواتير أو تحميل سيارة أو وارد مستودع) والمؤرشف يختفي من القوائم ويبقى قابلاً للقراءة بمعرّفه. الصنف غير النشط (INACTIVE) أو المؤرشف يُرفض في إنشاء الفواتير. أخطاء التحقق من zod تعود 400 بالشكل {success:false, message:'بيانات غير صحيحة <الحقول>', errors:{field:[...]}} والحقول غير المعروفة تُسقط بصمت. حد المفتاح 120 طلباً في الدقيقة (429 API_RATE_LIMIT مع Retry-After)",
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
    "response": "{success:true, data:[Product], pagination:{total, page, limit, pages}} — Product: id, tenantId, code, name, barcode, unit, basePrice, taxPct, image, itemCode, itemCodeType, unitCode, status, damagedReturnToStock, shelfLifeEnabled, shelfLifeValue, shelfLifeUnit, vatCategory, vatExemptionCode, vatExemptionReason, categoryId, deletedAt(دائماً null هنا), createdAt, updatedAt, category:{id, tenantId, name, createdAt}|null, priceTiers:[{id, productId, minQty, maxQty, price, createdAt}] مرتبة تصاعدياً بـminQty",
    "rules": [
     "الأصناف المؤرشفة (deletedAt غير فارغ) مستبعدة دائماً من القائمة",
     "pages = ceil(total / limit)",
     "basePrice وأسعار الشرائح صافية قبل الضريبة وtaxPct نسبة مئوية مثل 15",
     "الحقل image قد يكون data URL بصيغة base64 فيكبر حجم الرد"
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
    "response": "{success:true, data:Product} بنفس حقول القائمة مع category وpriceTiers — 404 {success:false, message:'الصنف غير موجود'} إن لم يوجد في الشركة",
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
      "desc": "وحدة البيع نص حر مثل كرتون أو حبة (حرف واحد على الأقل)"
     },
     {
      "name": "basePrice",
      "type": "number",
      "required": true,
      "desc": "سعر البيع الأساسي صافٍ قبل الضريبة و≥ 0"
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
      "desc": "كود الوحدة حسب جدول مزود الفوترة الإلكترونية والفارغ يُحفظ null"
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
     }
    ],
    "response": "201 {success:true, data:Product مع category (بدون priceTiers)} — 409 {success:false, message:'كود الصنف مستخدم من قبل'} أو رسالة «الكود مستخدم بصنف محذوف مؤرشف...» — 400 برسالة عربية لخطأ الصلاحية — 400 {success:false, code:'PRODUCT_ZATCA_INVALID', message, fieldErrors:[{field, messageAr}]} لخطأ الفئة الضريبية",
    "rules": [
     "الكود فريد لكل شركة (tenantId+code) ويُفحص مسبقاً بما فيه المؤرشف فيعود 409 برسالة واضحة",
     "taxPct غائب أو null ⇒ يرث نسبة دولة الشركة defaultVatPct",
     "basePrice صافٍ قبل الضريبة — الفواتير ذات pricesIncludeTax=true تحوّل السعر الشامل إلى صافٍ للمقارنة",
     "فحص الصلاحية: إن كان shelfLifeEnabled=true بلا وحدة صحيحة أو بمدة غير صحيحة أو تتجاوز الحد ⇒ 400",
     "حقول ZATCA الثلاثة ليست في مخطط zod بل تُقرأ من الجسم الخام وتُقص مسافاتها والنص الفارغ = null",
     "categoryId لا يُتحقق منه في الكود — معرّف غير موجود يفشل بقيد المفتاح الأجنبي فيعود 500",
     "لا يُنشأ مخزون ولا قيود عند إنشاء الصنف"
    ],
    "example": "{\"code\":\"P-1001\",\"name\":\"مياه 330 مل كرتون 40\",\"unit\":\"كرتون\",\"basePrice\":13.04,\"taxPct\":15,\"barcode\":\"6281234567890\",\"categoryId\":\"3f2c1a9e-7b1d-4c2e-9a51-0d6e8f4b2c11\",\"status\":\"ACTIVE\"}"
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
      "desc": "الوحدة (حرف واحد على الأقل)"
     },
     {
      "name": "basePrice",
      "type": "number",
      "required": false,
      "desc": "السعر الأساسي صافٍ قبل الضريبة و≥ 0"
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
      "desc": "'' أو null يمسحه"
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
     }
    ],
    "response": "{success:true, data:Product مع category (بدون priceTiers)} — 404 'الصنف غير موجود' — 400 لخطأ الصلاحية أو PRODUCT_ZATCA_INVALID — 409 'السجل موجود مسبقا' لتكرار الكود",
    "rules": [
     "id في المسار = معرّف الصنف",
     "فحص الصلاحية يجري على الدمج: القيمة المرسلة وإلا المحفوظة",
     "بوابة ZATCA لا تعمل إلا إن حمل الجسم أحد حقول vat* — تغيير taxPct وحده لا يعيد فحص الفئة المحفوظة فأرسل vatCategory معه عند تغيير النسبة",
     "الأصناف المؤرشفة قابلة للتعديل لكن التعديل لا يلغي الأرشفة (deletedAt يبقى) فتبقى مخفية من القوائم",
     "التعديل لا يمس شرائح الأسعار ولا أسعار العملاء ولا الفواتير السابقة"
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
     "إن وُجد للصنف أي بند فاتورة أو بند تحميل سيارة أو بند وارد مستودع ⇒ أرشفة: deletedAt=الآن وstatus=INACTIVE في معاملة واحدة",
     "في الحالتين تُحذف نهائياً شرائح أسعاره وأسعار العملاء الخاصة به ولا تعود",
     "المؤرشف يختفي من القوائم ولا يباع مجدداً ويبقى اسمه في الفواتير والتقارير القديمة ويُقرأ بـGET /products/:id",
     "كود الصنف المؤرشف يبقى محجوزاً فلا يمكن إنشاء صنف جديد بالكود نفسه"
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
      "desc": "أقل كمية للشريحة و≥ 0"
     },
     {
      "name": "tiers[].maxQty",
      "type": "number",
      "required": false,
      "desc": "أعلى كمية — اختياري للشريحة المفتوحة ولا يقبل null (احذفه بدلاً من null)"
     },
     {
      "name": "tiers[].price",
      "type": "number",
      "required": true,
      "desc": "سعر الوحدة في الشريحة صافٍ قبل الضريبة و≥ 0"
     }
    ],
    "response": "{success:true} بدون data — 404 'الصنف غير موجود' — 400 'بيانات غير صحيحة' إن غاب tiers أو لم يكن مصفوفة",
    "rules": [
     "العملية استبدال كامل: تحذف الشرائح القديمة وتنشئ المرسلة وتحدّث updatedAt للصنف في معاملة واحدة",
     "لا يتحقق الخادم من تداخل الشرائح ولا من أن minQty ≤ maxQty",
     "في الخادم تُستخدم الشرائح كحد أدنى لسعر المندوب في حارس الأسعار (أقل سعر شريحة) ولا تُطبّق تلقائياً على فواتير الإدارة",
     "تحديث updatedAt يجعل التغيير مرئياً لمزامنة ERP و/api/v1/sync"
    ],
    "example": "{\"tiers\":[{\"minQty\":1,\"maxQty\":49,\"price\":13.04},{\"minQty\":50,\"price\":12.5}]}"
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
     "price صافٍ قبل الضريبة وهو السعر المرجعي للعميل بدل basePrice",
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
  "overview": "كل المسارات تحت /api/invoices وتعمل بمفتاح الشركة (Authorization: Bearer fsk_… أو X-API-Key) بهوية المستخدم الذي أصدره. كل طلب يمر أولاً بحارس النظام المحاسبي: إذا كان accountingEnabled=false للشركة يرجع 403 بالرمز ACCOUNTING_NOT_ALLOWED. بعده كل المسارات تحتاج صلاحية canManageInvoices ما عدا GET /invoices/open الذي يحتاج canManageReceipts. الصلاحية ترفض فقط إذا كانت قيمتها false في حساب المستخدم، والرفض يرجع 403. ولأن مسارات الفوترة الإلكترونية (/einvoice/*) مركبة على نفس البادئة بعد موجّه الفواتير، فهي تمر بنفس الحارسين وتضيف requireAdmin، أي أن الدور يجب أن يكون ADMIN أو MANAGER أو ACCOUNTANT. نطاق المستخدم المقيّد (قوائم عملاء ومناديب) يُطبَّق على كل قراءة وكتابة، وما يقع خارج النطاق يرجع 404 أو 403. المفتاح المحدد «قراءة فقط» لا يقبل إلا GET وHEAD، وأي طريقة أخرى ترجع 403 بالرمز API_KEY_FORBIDDEN. حد الطلبات 120 طلباً في الدقيقة لكل مفتاح، ويرجع 429 بالرمز API_RATE_LIMIT مع ترويسة Retry-After. المفتاح معفى من الحد العام لـ/api. الترقيم يتم تلقائياً: الفاتورة INV-YYMM-000001 والمرتجع أو الإشعار الدائن RET-YYMM-000001، والتسلسل منفصل لكل شركة. الشركات المربوطة بالمرحلة الثانية من زاتكا (zatcaPhase2StartedAt مضبوط): يجب أن ترسل الترويسة X-FS-Caps: zatca2 في الإصدار وفي قراءة أي صف zatcaPhase=2 وفي الإشعارات وفي إعادة الإصدار، وبدونها يرجع 426 بالرمز ZATCA_CLIENT_UPDATE_REQUIRED. الترويسة تعني أن نظامك يطبع QR المرحلة الثانية من data.einvoice.qr ويحترم الحقل printable. لا ترسل X-FS-Replay، فهي خاصة بصندوق تطبيق المندوب حين يعمل دون اتصال. شكل الأخطاء: أخطاء التحقق ترجع 400 بالشكل {success:false, message, errors:{field:[...]}}. أخطاء زاتكا ترجع {success, code, message, issues?, errors?, data?, reason?, customerId?}، وsuccess=true فيها فقط عندما يكون الرمز 202. الأخطاء العامة ترجع {success:false, message}. ردود النجاح شكلها {success:true, data}، وتضاف pagination في القوائم المرقّمة",
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
      "desc": "تضمين بنود كل فاتورة مع product{name,unit}"
     },
     {
      "name": "locationId",
      "type": "string (uuid) | none",
      "required": false,
      "desc": "تصفية بختم الموقع (ميزة «لوكيشن»): معرّف موقع، أو none للفواتير بلا موقع"
     }
    ],
    "body": [],
    "response": "{success:true, data:[...], pagination:{total, page, limit, pages}}. كل صف فيه أعمدة الفاتورة: id وnumber وtype وstatus وinvoiceDate وdueDate وdeliveryDate وpaymentPlan وpricesIncludeTax وsubtotal وdiscountPct وdiscountAmt وtaxAmt وtotal وpaidAmt وremainingAmt وreturnReason وreturnToStock وeinvoiceProvider وeinvoiceStatus وeinvoiceQr وclientRef وzatcaPhase وdocumentKind وinvoiceSubtype وissuedAt وoriginalInvoiceId وcreatedAt وlocationId. ومعها customer{id,name,phone} وsalesRep{id,name} وlocation{id,name} (ختم موقع المندوب وقت الإصدار، أو null) و_count{items}، وitems عند طلب withItems. الحقل einvoiceSnapshot محذوف من صفوف القائمة",
    "rules": [
     "الترتيب حسب createdAt تنازلياً، والترقيم بالأسلوب skip=(page-1)*limit",
     "هذه القائمة لا تشترط X-FS-Caps حتى للصفوف المربوطة بالمرحلة الثانية، بخلاف GET /invoices/:id",
     "المبالغ subtotal وdiscountAmt صافية قبل الضريبة دائماً. أما unitPrice وlineTotal للبنود فتكون شاملة الضريبة إذا كان pricesIncludeTax=true",
     "لا ترسل قيماً سالبة لـpage أو limit، لأنها لا تُصحَّح وقد تسبب خطأ 500",
     "ملف المرجع"
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
    "query": [],
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
    "path": "/invoices/:id",
    "purpose": "تفاصيل فاتورة واحدة كاملة مع بنودها وعميلها وأقساطها وسندات القبض المرتبطة بها",
    "permission": "canManageInvoices",
    "gates": [
     "requireAccounting",
     "canManageInvoices",
     "نطاق المستخدم",
     "X-FS-Caps: zatca2 إذا كان zatcaPhase=2، وإلا 426 ZATCA_CLIENT_UPDATE_REQUIRED"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:{...أعمدة الفاتورة, customer{...كامل}, salesRep{id,name,phone}, installments[{seq,dueDate,amount,...}], items[{...,product{id,name,code,unit}}], receiptItems[{...,receipt{...}}], signature{image,repImage,createdAt}|null, einvoice? }}. الحقل einvoice يظهر لصفوف المرحلة الثانية فقط",
    "rules": [
     "الحقل signature يحمل صور التوقيع PNG بصيغة base64 وقد يكون حجمها كبيراً",
     "الحقل einvoice.qr هو رمز QR الذي يُطبع، والحقل printable يبين هل يجوز تسليم المستند فاتورةً ضريبية. القياسية لا تُطبع قبل اعتماد الهيئة",
     "المرجع"
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
      "desc": "الكمية"
     },
     {
      "name": "items[].unitPrice",
      "type": "number >= 0",
      "required": true,
      "desc": "سعر الوحدة. يكون صافياً قبل الضريبة إلا إذا كان pricesIncludeTax=true. في المرحلة الثانية السعر صفر يرجع 422"
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
      "desc": "للمرتجع في المرحلة الثانية فقط: معرّف بند الفاتورة الأصلية المُرجَع منه"
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
      "desc": "للمرتجع في المرحلة الثانية: الفاتورة الأصلية. إجباري هناك، وغيابه يرجع 422 ZATCA_RETURN_NEEDS_ORIGINAL"
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
      "desc": "لحظة الإنشاء على الجهاز، وهو حقل للعمل دون اتصال. لا ترسله من التكاملات"
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
    "response": "المرحلة الأولى: 201 {success:true, data:{...invoice, items[], customer{...}, installments[], signature}}. تكرار clientRef يرجع 200 {success:true, data:<الفاتورة القائمة>, idempotent:true}. المرحلة الثانية: الشكل نفسه مضافاً إليه data.einvoice. المبسّطة (02) ترجع 201. القياسية (01) تُرسل للاعتماد داخل الطلب بمهلة تقارب 20 ثانية، وترجع 201 إذا اعتُمدت، أو 202 ZATCA_CLEARANCE_PENDING إذا بقيت بانتظار الاعتماد (success:true وdata موجودة)، أو 422 ZATCA_REJECTED إذا رُفضت وأُبطلت (data.status=CANCELLED)، أو 202 ZATCA_CLEARED_NO_XML",
    "rules": [
     "الحساب: خصم الفاتورة يوزَّع على البنود قبل الضريبة، والإجمالي يساوي مجموع صافي البنود، والتقريب نصف لأعلى بعدد خانات عملة الشركة",
     "الأثر المحاسبي: CREDIT يرفع رصيد العميل بالإجمالي ويضع paidAmt=0 وremainingAmt=total. CASH يسجّل قيدين (مدين ثم تحصيل) فلا يتغير الرصيد، ويضع paidAmt=total وremainingAmt=0. RETURN ينقص رصيد العميل وtotalSales ويضع paid=0 وremaining=0",
     "الحد الائتماني لا يمنع الإنشاء. إذا كان creditLimit>0 وتجاوزه الرصيد مع الإجمالي يُنشأ تنبيه CREDIT_LIMIT_EXCEEDED فقط",
     "العميل المحظور BLOCKED يرجع 400، والعميل أو المندوب خارج النطاق يرجع 403 أو 404",
     "قيود المندوب (حد الخصم وتغيير السعر والبيع بلا مخزون والأذونات) لا تنطبق على المفتاح، لأنها مشروطة بالدور SALES_REP. لذلك المفتاح يستطيع البيع بأكثر من مخزون السيارة",
     "مخزون السيارة يُحسب من الفواتير المؤكدة لكل مندوب: البيع ينقصه، والمرتجع الذي returnToStock=true له يعيده",
     "منع التكرار: إذا وُجدت فاتورة بنفس clientRef تُعاد كما هي مع idempotent:true ولا يُعاد الحساب، ولو اختلف الجسم. والطلبان المتزامنان يحسمهما القيد الفريد",
     "التقسيط: الخادم يبني الجدول من الإجمالي المحسوب، والفارق يحمله القسط الأخير، والمجموع يجب أن يساوي الإجمالي وإلا 400",
     "المرحلة الثانية: المرتجع يصبح إشعاراً دائناً مرتبطاً بالأصل. أسعاره وضريبته تؤخذ من بنود الأصل، ويُتجاهل unitPrice المرسل. البند يُطابَق بـinvoiceItemId أو بالصنف إذا لم يتكرر في الأصل، وإلا 422. والكمية محدودة بما لم يُرجَع بعد",
     "المرحلة الثانية: العميل الذي لديه رقم ضريبي أو سجل تجاري أو نوع BUSINESS/GOVERNMENT تصدر له فاتورة قياسية (01) تحتاج بيانات مشترٍ كاملة، وإلا 422 ZATCA_BUYER_INCOMPLETE مع data.fields. وغيره تصدر له مبسّطة (02)",
     "المرحلة الثانية: إرسال clientCreatedAt دون clientRef يرجع 426. وخلال فترة تسليح التفعيل قد يرجع 409 ZATCA_GO_LIVE_ARMING لمستند يحمل clientCreatedAt",
     "أخطاء زاتكا الأخرى: 503 ZATCA_UNIT_UNAVAILABLE أو UNIT_BUSY أو STAMP_FAILED (أعد المحاولة بنفس clientRef)، و422 ZATCA_AMOUNTS أو PREFLIGHT أو CURRENCY",
     "مثال تقسيط: {\"customerId\":\"…\",\"salesRepId\":\"…\",\"type\":\"CREDIT\",\"paymentPlan\":\"INSTALLMENT\",\"installmentPlan\":{\"count\":3,\"firstDueDate\":\"2026-11-01\",\"period\":\"MONTHLY\"},\"items\":[{\"productId\":\"…\",\"qty\":10,\"unitPrice\":120}]}",
     "مثال مرتجع في المرحلة الأولى: {\"customerId\":\"…\",\"salesRepId\":\"…\",\"type\":\"RETURN\",\"returnReason\":\"DAMAGED\",\"returnToStock\":false,\"items\":[{\"productId\":\"…\",\"qty\":2,\"unitPrice\":5}]}",
     "مثال مرتجع في المرحلة الثانية: أضف originalInvoiceId وnoteReason وitems[].invoiceItemId. الحقل unitPrice إلزامي في المخطط لكنه يُهمل"
    ],
    "example": "{\"customerId\":\"8f1c2a4e-1b2c-4d5e-9f00-112233445566\",\"salesRepId\":\"2b7e9d10-3c4d-4e5f-8a90-aabbccddeeff\",\"type\":\"CASH\",\"pricesIncludeTax\":true,\"items\":[{\"productId\":\"a1d2c3b4-0000-4000-8000-000000000001\",\"qty\":12,\"unitPrice\":5.75},{\"productId\":\"a1d2c3b4-0000-4000-8000-000000000002\",\"qty\":2,\"unitPrice\":34.5,\"discountPct\":5}],\"notes\":\"طلب من نظام ERP\",\"clientRef\":\"3f2b8c1e-6a4d-4e2b-9c7a-1d2e3f4a5b6c\"}"
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
     "الفحوص تُعاد تحت قفل الصف لمنع الإلغاء المزدوج (services/docCancel.ts)"
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
    "response": "{success:true, data:{invoiceId, number, subtype, documentKind, einvoiceStatus, total, remainingAmt, creditedTotal, legacyReturnsApplied, eligible, refusal, messageAr, lines:[{invoiceItemId, seq, productId, itemName, unitCode, qty, credited, legacyCredited, returnable, unitPrice, discountPct, taxPct, vatCategory, vatExemptionCode, vatExemptionReason, damagedReturnToStock}], permissions:{full, partial, debit}}}",
    "rules": [
     "الشركة في المرحلة الأولى ترجع 409 مع رسالة أن الإشعارات للشركات المربوطة، وعندها سجّل مرتجعاً عادياً عبر POST /invoices",
     "returnable = qty − credited − legacyCredited. المرتجعات القديمة غير المرتبطة تُخصم فقط لأصل من المرحلة الأولى",
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
      "desc": "الكمية المرتجعة، ولا تتجاوز returnable"
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
      "desc": "لا ترسله، وإن أرسلته فـclientRef إجباري معه وإلا 426"
     }
    ],
    "response": "201 {success:true, data:{...صف الإشعار (type=RETURN, documentKind=CREDIT_NOTE, number=RET-YYMM-######, originalInvoiceId, items, customer), einvoice:{...}, original:{id, number, remainingAmt, customerCredit, creditedTotal}}}. إذا كان الأصل قياسياً (01) يُعتمد داخل الطلب: 201 أو 202 بانتظار الاعتماد أو 422 مرفوض ومُبطل. تكرار clientRef يرجع 200 مع idempotent:true",
    "rules": [
     "الأصل يجب أن يكون فاتورة CASH أو CREDIT مؤكدة، وليس إشعاراً (وإلا 409 ZATCA_NOTE_ON_NOTE). وإذا كان من المرحلة الثانية فيجب أن يكون معتمداً أو مبلغاً (وإلا 409 ZATCA_ORIGINAL_NOT_CLEARED). الإشعار مسموح على أصل من المرحلة الأولى",
     "الأسعار والضريبة والخصم الكلي من الأصل، ولا تُرسل أسعاراً",
     "الكمية الزائدة ترجع 422 ZATCA_CREDIT_QTY_EXCEEDED، وإذا كانت كل الكميات مرتجعة سابقاً يرجع 409 ZATCA_NOTHING_TO_CREDIT",
     "الأثر: ينقص remainingAmt للأصل بفرق نسبي بقيمة min(الإجمالي، المتبقي)، والزائد يصبح رصيداً دائناً للعميل. يُسجَّل قيد مرتجع فينقص رصيد العميل، وتُبطل روابط دفع الأصل",
     "الإشعار يُنسب لمندوب الأصل لأن المفتاح لا يملك هوية مندوب، والكميات تعود لمخزون ذلك المندوب حسب returnToStock",
     "المستخدم الإداري مسموح له بالكامل والجزئي"
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
      "desc": "لا ترسله إلا مع clientRef"
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
     "يغيّر حساب مخزون السيارة فوراً ولا يمس القيود المالية"
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
    "response": "{ success: true, data: [سند], pagination: { total, page, limit, pages } }. كل سند يحمل حقوله: id وnumber وcustomerId وsalesRepId وreceiptDate وamount وpaymentMethod وchequeNumber وbankName وnotes وstatus وclientRef وclientCreatedAt وcreatedAt وupdatedAt. ويُضاف إليها customer {id, name} وsalesRep {id, name}، وinvoiceItems وكل عنصر فيها {id, receiptId, invoiceId, amount, invoice: {number}}. المرفقات photos لا تأتي في القائمة",
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
      "desc": "طريقة الدفع، والافتراضي CASH"
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
     "فشل التحقق بالزود يعطي 400 مع { success:false, message:'بيانات غير صحيحة ...', errors }. وإرسال amount نصاً يُرفض"
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
     "الصلاحية المطلوبة canManageCustomers لا canManageReceipts"
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
      "desc": "حجم الصفحة (الافتراضي 20، وأقصاه 200 لطلبات المفتاح). القيمة 0 أو غير الرقمية تعود إلى 20"
     },
     {
      "name": "search",
      "type": "string",
      "required": false,
      "desc": "بحث جزئي في الاسم أو الجوال أو اسم المستخدم، حساس لحالة الأحرف اللاتينية"
     }
    ],
    "body": [],
    "response": "{success:true, data:[مندوب], pagination:{total, page, limit, pages}} مرتبة بالاسم تصاعدياً. حقول المندوب: id, name, phone, email, username, isActive, canCreateInvoice, canSellOnCredit, canSellOnInstallment, canSellInCash, canEditInvoice, canDeleteInvoice, canCancelInvoice, canChangePrice, maxDiscountPct, canSellBelowPrice, canCreateReceipt, canEditReceipt, canCancelReceipt, canManageVanStock, canAddCustomer, canEditCustomer, canViewStatement, showCollectionBalance, requireCustomerProximity, requireLocationOn, requirePunchAtCustomer, proximityRadiusM, punchRadiusM, createdAt",
    "rules": [
     "لا تُعاد كلمة المرور ولا حقول التتبع والموقع ولا canSellWithoutStock ولا canBeTracked",
     "pages = ceil(total/limit) من utils/helpers.ts",
     "يُنصح بـ limit لا يتجاوز 100 لأن الخادم لا يفرض سقفاً"
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
     "المعرّف UUID"
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
     }
    ],
    "response": "201 {success:true, data:{id, name, phone, username, isActive}}",
    "rules": [
     "بلوغ حد maxSalesReps للشركة يرجع 403 برسالة الحد",
     "التكرار يرجع 409: اسم المستخدم عالمياً ثم الجوال ثم البريد داخل الشركة",
     "كلمة مرور أقل من 8 أحرف ترجع 400",
     "الحقول غير المعرّفة في المخطط تُتجاهل بصمت، فلا يمكن ضبط canSellWithoutStock أو canBeTracked من هنا",
     "الافتراضات من prisma/schema.prisma model SalesRep"
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
      "name": "canCreateInvoice ... requireLocationOn",
      "type": "boolean / number",
      "required": false,
      "desc": "نفس حقول الصلاحيات في POST وكلها اختيارية، و maxDiscountPct رقم من 0 إلى 100"
     }
    ],
    "response": "{success:true, data:{id, name, phone, username, isActive}} أو 404 'المندوب غير موجود'",
    "rules": [
     "تحديث جزئي (repSchema.partial) لكن email يُكتب دائماً: rest.email || null",
     "فحص التكرار يجري فقط إذا أُرسل username أو phone أو email ويرجع 409",
     "password أقل من 8 أحرف يرجع 400"
    ],
    "example": "{\"email\":\"khalid@example.com\",\"maxDiscountPct\":10,\"canCancelInvoice\":true,\"isActive\":true}"
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
  "overview": "وحدتان مترابطتان. الأولى مخزون سيارات المناديب (/van-stock)، ورصيده لا يُخزَّن بل يُحسب في كل طلب: التحميل − التنزيل + التسوية − المبيع + المرتجع العائد للمخزون. والثانية مستودع الشركة المركزي (/warehouse)، ورصيده محسوب أيضاً: الوارد + تسويات المستودع + العائد من السيارات − المحمَّل للسيارات، مع تقييم بتكلفة الشراء الصافية قبل الضريبة. لذلك فتحميل سيارة عبر POST /van-stock/loads ينقص المستودع تلقائياً، وتنزيلها يعيد الكمية إليه.\nالحراس على كل مسارات /van-stock: يجب ألا يكون النظام المحاسبي مطفأً (accountingEnabled، والرفض 403 برمز ACCOUNTING_NOT_ALLOWED)، ويجب أن يملك صاحب المفتاح صلاحية canManageVanStock (والرفض 403). ويُطبَّق كذلك نطاق المناديب المحدد لصاحب المفتاح إن كان مقيَّداً.\nمسارات /warehouse تشترط الشيئين نفسيهما، وتشترط فوقهما تفعيل ميزة مخزون الشركة (warehouseEnabled، وهي مطفأة افتراضياً، والرفض 403).\nالمفتاح المضبوط على «قراءة فقط» لا يمرّ إلا بطلبات GET.\nلكل قائمة في هذه المجموعة سقف ثابت: سجل المستودع آخر 100 حركة، وسجل التحميلات آخر 100 حركة ما لم تُرسل page فيُرقَّم بحدّ 200. للتاريخ الكامل استعمل مسارات المزامنة /v1/sync/van-loads و/v1/sync/warehouse-entries.\nلا يوجد مسار لتعديل الحركات أو حذفها، والتصحيح يكون بحركة معاكسة أو بتسوية. ولا يوجد clientRef، فإعادة إرسال طلب الكتابة تُنشئ حركة مكررة.\nالحد 120 طلباً في الدقيقة لكل مفتاح، ويظهر في رؤوس X-RateLimit-*",
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
      "desc": "الكمية. في LOAD وUNLOAD أرسلها موجبة. في ADJUST الموجب يزيد رصيد السيارة والسالب ينقصه. البند الذي كميته صفر يُحذف"
     },
     {
      "name": "items[].suggestedQty",
      "type": "number",
      "required": false,
      "desc": "كمية التعبئة المقترحة (حقل suggested من /van-stock/suggest)، تُحفظ لقياس تبنّي الاقتراح"
     },
     {
      "name": "items[].expectedQty",
      "type": "number",
      "required": false,
      "desc": "التنبؤ اليومي (حقل expected من /van-stock/suggest)، وهو مرجع قياس الدقة في /accuracy. بدونه يُعدّ البند غير مقاس"
     }
    ],
    "response": "201 {success:true, data:{id, tenantId, salesRepId, deletedSalesRepId, type, note, createdBy:'ADMIN', createdAt, items:[{id, vanLoadId, productId, qty, suggestedQty, expectedQty, product:{id,name,unit}}]}}",
    "rules": [
     "البنود التي كميتها صفر تُحذف، فإن لم يبقَ بند يُرَدّ 400 «لا توجد كميات صالحة»",
     "أي صنف لا يتبع الشركة يعطي 400 «منتج غير صالح»",
     "مندوب غير موجود في الشركة يعطي 404",
     "لا فحص لتوفر الكمية في المستودع عند LOAD ولا في السيارة عند UNLOAD، فقد يصير أي من الرصيدين سالباً",
     "الأثر على المستودع: LOAD ينقص onHand في المستودع، وUNLOAD يعيد الكمية إليه بكلفة خروجها من نفس السيارة (آخر ما حُمّل أول ما يعود)، وADJUST لا يمسّ المستودع",
     "الإدارة لا قيد عليها في إشارة qty، فـLOAD أو UNLOAD بكمية سالبة يُقبل ويعكس المعنى. أرسل الكميات موجبة دائماً",
     "createdBy يُسجَّل ADMIN لكل طلب من غير المندوب",
     "EXPIRED_OUT وDAMAGED_OUT: كمياتٌ موجبة لا تتجاوز رصيد expired أو damaged للصنف في السيارة (وإلا 400)، ولا تمسّ remaining ولا المستودع",
     "لا يوجد clientRef ولا حماية من التكرار، ولا مسار تعديل أو حذف. التصحيح يكون بحركة معاكسة أو تسوية",
     "إن غاب salesRepId يُرَدّ 400 برسالة «يجب تحديد المندوب»",
     "مندوب خارج نطاق صاحب المفتاح يُرَدّ عليه 404 برسالة «المندوب غير موجود»"
    ],
    "example": "{\"salesRepId\":\"3f6c2a1e-8b4d-4c1a-9e2f-1a2b3c4d5e6f\",\"type\":\"LOAD\",\"note\":\"تحميل صباح الأحد\",\"items\":[{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"qty\":24,\"suggestedQty\":24,\"expectedQty\":20.5},{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000002\",\"qty\":10}]}"
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
    "response": "{success:true, data:[{productId, name, code, unit, loaded, unloaded, adjusted, sold, returned, remaining, expired, damaged}]}، مرتبة تنازلياً حسب remaining",
    "rules": [
     "remaining = loaded − unloaded + adjusted − sold + returned، مقرّبة لأربع خانات، وتُحسب على كامل التاريخ",
     "sold هو بنود كل فاتورة مؤكدة (CONFIRMED) غير مرتجعة منسوبة لهذا المندوب، أياً كان من أنشأها",
     "returned هو المرتجعات غير المنتهية وغير التالفة التي returnToStock فيها true",
     "expired رصيد «منتهي الصلاحية»: مرتجعٌ عاد بعد انتهاء صلاحيته، لا يدخل remaining حتى يُزال بـEXPIRED_OUT",
     "damaged رصيد «المرتجع التالف»: مرتجعٌ سببه DAMAGED سُجّل منذ ١٥ أكتوبر ٢٠٢٦، لا يدخل remaining مهما كانت returnToStock حتى يُزال بـDAMAGED_OUT. والتالف المنتهي صلاحيته يدخل expired",
     "تظهر فقط الأصناف التي لها حركة لهذا المندوب، والأصناف غير النشطة تظهر إن كانت لها حركة",
     "remaining قد يكون سالباً إن باع المندوب فوق ما حمّل وهو يملك إذن canSellWithoutStock",
     "بنود الفاتورة التي لا صنف لها تُتجاهل",
     "معرّف مندوب غير موجود يعيد مصفوفة فارغة، ومندوب خارج النطاق يعيد 404 «المندوب غير موجود»",
     "salesRepId يُقبل نصاً واحداً فقط، وغير ذلك يُعامَل غائباً",
     "لا ترقيم صفحات"
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
    "response": "{success:true, data:{rows:[{id, name, code, unit, expected, withBuffer, onVan, suggested, basis:'weekday'|'overall'|'none', sampleDays, activeDays, confidence:'high'|'medium'|'low', why}], meta:{targetDate, weekday, windowDays, bufferPct, dataDays, oldestSale, warning}, salesRep:{id,name}}}",
    "rules": [
     "معرّف الصنف في الصف يأتي باسم id لا productId",
     "الأصناف النشطة وحدها، وصنف بلا مبيعات في النافذة يأتي بقيمة صفر وbasis='none'",
     "صافي الطلب هو مبيعات الفواتير المؤكدة ناقص مرتجعاتها، والأيام التي لا بيع فيها تدخل في المتوسط",
     "basis='weekday' إذا وُجد في النافذة يومان على الأقل من نفس يوم الأسبوع فيهما بيع، وإلا يُستخدم المتوسط اليومي العام",
     "withBuffer = ceil(expected × (1 + bufferPct/100))، وsuggested = max(0, withBuffer − onVan)، وonVan هو متبقي السيارة الحالي",
     "الترتيب تنازلي حسب suggested ثم expected",
     "لتحويل الاقتراح إلى تحميل أرسل في POST /van-stock/loads: productId=row.id، وqty=row.suggested، وsuggestedQty=row.suggested، وexpectedQty=row.expected",
     "meta.warning يكون نصاً عربياً حين تقل البيانات عن 14 يوماً"
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
     "adopted تعني أن الكمية المحمّلة تساوي suggestedQty (فرق أقل من 0.001)",
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
     "لا ترقيم صفحات، والقائمة تشمل كل المناديب في النطاق"
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
      "desc": "true يسمح بالبيع فوق متبقي السيارة، وfalse يمنعه"
     }
    ],
    "response": "{success:true, data:{salesRepId, canSellWithoutStock}}",
    "rules": [
     "الافتراضي true لكل مندوب schema.prisma:314",
     "عند false تُرفض بـ403 الفاتورة غير المرتجعة التي يصدرها المندوب من تطبيقه إن تجاوزت كمية صنف متبقي سيارته",
     "القيد لا يسري على الفواتير التي تنشئها الإدارة أو المفتاح لهذا المندوب، لكنها تُنقص متبقي سيارته",
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
      "desc": "تصفية بختم الموقع (ميزة «لوكيشن»): معرّف موقع، أو none للحركات بلا موقع"
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
     }
    ],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, salesRepId, deletedSalesRepId, locationId, type, note, createdBy:'REP'|'ADMIN'|null, createdAt, items:[{id, vanLoadId, productId, qty, suggestedQty, expectedQty, product:{id,name,unit}}], salesRep:{id,name}, location:{id,name}|null}], pagination?:{total, page, limit, pages}}",
    "rules": [
     "بلا page: آخر 100 حركة فقط، الأحدث أولاً، بلا pagination. ومع page: صفحات مرقّمة بحدّ 200. للتاريخ الكامل استعمل /v1/sync/van-loads",
     "location هو ختم موقع المندوب لحظة التحميل (حركات LOAD وحدها تُختم حين تفعّل الشركة ميزة «لوكيشن»)، ولا يتغيّر إن نُقل المندوب لاحقاً. وnull لما بلا ختم",
     "حركات مندوب محذوف تبقى وتظهر بـsalesRep={id:null, name:'مندوب محذوف'}، ولا يراها صاحب مفتاح مقيّد النطاق",
     "salesRepId خارج النطاق يعطي 404 «المندوب غير موجود»"
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
     }
    ],
    "body": [],
    "response": "{success:true, data:[{kind:'LOAD'|'UNLOAD'|'ADJUST'|'EXPIRED_OUT'|'DAMAGED_OUT'|'SALE'|'RETURN'|'RETURN_DAMAGED', date, ref, by, items:[{name, unit, qty}]}]}",
    "rules": [
     "يدمج آخر 50 حركة سيارة مع آخر 50 فاتورة مؤكدة، ثم يرتبها تنازلياً حسب التاريخ ويقتطع أول 60",
     "ref في حركة السيارة هو الملاحظة، وفي الفاتورة «رقم الفاتورة · اسم العميل»",
     "by في الفواتير دائماً 'REP' حتى لو أنشأتها الإدارة، وفي حركات السيارة REP أو ADMIN",
     "المرتجع يظهر هنا حتى لو لم يُعَد للمخزون (returnToStock=false)، والمرتجع التالف الداخل رصيد «المرتجع التالف» يظهر RETURN_DAMAGED، وبند بلا صنف يظهر باسم «صنف محذوف»",
     "لا تُعاد معرّفات للبنود أو الأصناف، فقط الاسم والوحدة والكمية"
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
     "accountingEnabled ليس false وإلا 403 ACCOUNTING_NOT_ALLOWED",
     "warehouseEnabled يجب أن يكون true وإلا 403 «ميزة مخزون الشركة غير مفعلة»",
     "صلاحية canManageVanStock"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{productId, name, code, unit, received, adjusted, loadedToVans, returnedFromVans, onHand, avgCost, stockValue, costedQty, uncostedQty}]}، مرتبة تنازلياً حسب onHand",
    "rules": [
     "تظهر كل الأصناف النشطة حتى التي لا حركة لها",
     "onHand = received + adjusted + returnedFromVans − loadedToVans، مقرّبة لأربع خانات",
     "تُحسب تحميلات كل المناديب ومنهم المحذوفون، ولا يُطبَّق نطاق المناديب هنا لأن المستودع على مستوى الشركة",
     "avgCost متوسط متحرك من الوارد المسعّر، صافٍ قبل الضريبة، بأربع خانات. stockValue = costedQty × avgCost، مقرّبة بخانات عملة الشركة",
     "uncostedQty كمية بلا سعر معروف، وهي خارج stockValue صراحة",
     "onHand وstockValue قد يصيران سالبين حين يُحمَّل للسيارات أكثر من الوارد"
    ],
    "example": ""
   },
   {
    "method": "POST",
    "path": "/warehouse/entries",
    "purpose": "تسجيل وارد (شراء أو استلام) إلى مستودع الشركة، أو تسوية جرد له",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "warehouseEnabled يجب أن يكون true",
     "صلاحية canManageVanStock",
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
      "desc": "الكمية. في RECEIVE يجب أن تكون موجبة. في ADJUST الموجب يزيد والسالب ينقص. البند الذي كميته صفر يُحذف"
     },
     {
      "name": "items[].unitCost",
      "type": "number (>0, finite, max 1e9)",
      "required": false,
      "desc": "تكلفة شراء الوحدة، وتُقبل مع RECEIVE فقط. الصفر مرفوض، فإن لم يوجد سعر أغفل الحقل"
     }
    ],
    "response": "201 {success:true, data:{id, tenantId, type, note, supplier, createdBy, createdAt, items:[{id, entryId, productId, qty, unitCost, expiresAt, product:{id,name,unit}}]}}",
    "rules": [
     "البنود التي كميتها صفر تُحذف، فإن لم يبقَ بند يُرَدّ 400",
     "RECEIVE بكمية سالبة يعطي 400، والتنقيص يكون بتسوية ADJUST",
     "ADJUST مع unitCost يعطي 400",
     "أي صنف لا يتبع الشركة يعطي 400 «منتج غير صالح»",
     "unitCost المحفوظ صافٍ دائماً. مع costsIncludeTax=true يكون unitCost ÷ (1 + taxPct الصنف/100) مقرّباً لأربع خانات",
     "التقييم: الوارد المسعّر يحرّك متوسط التكلفة، والوارد بلا سعر يدخل uncostedQty، والتسوية الموجبة تُقيَّم بمتوسط اللحظة، والسالبة تنقص الكمية المقيَّمة وغير المقيَّمة بنسبتهما",
     "المسار لا يُنشئ قيداً محاسبياً ولا ذمة مورد، فهو حركة مخزون فقط",
     "createdBy هو اسم مستخدم الشركة صاحب المفتاح",
     "لا يوجد clientRef، ولا مسار تعديل أو حذف"
    ],
    "example": "{\"type\":\"RECEIVE\",\"supplier\":\"مؤسسة التوريد المتحدة\",\"note\":\"فاتورة مورد 5512\",\"costsIncludeTax\":true,\"items\":[{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"qty\":120,\"unitCost\":11.5},{\"productId\":\"a1b2c3d4-0000-4000-8000-000000000002\",\"qty\":48}]}"
   },
   {
    "method": "GET",
    "path": "/warehouse/entries",
    "purpose": "سجل حركات المستودع (الوارد والتسويات) مع قيمة كل سطر وإجمالي الحركة (آخر 100 حركة)",
    "permission": "canManageVanStock",
    "gates": [
     "accountingEnabled ليس false",
     "warehouseEnabled يجب أن يكون true",
     "صلاحية canManageVanStock"
    ],
    "query": [],
    "body": [],
    "response": "{success:true, data:[{id, tenantId, type, note, supplier, createdBy, createdAt, items:[{id, entryId, productId, qty, unitCost, expiresAt, product:{name,unit}, lineCost}], totalCost}]}",
    "rules": [
     "آخر 100 حركة فقط، الأحدث أولاً، بلا ترقيم صفحات. للتاريخ الكامل استعمل /v1/sync/warehouse-entries",
     "unitCost صافٍ قبل الضريبة، ويكون null إن لم يُسعَّر",
     "lineCost = qty × unitCost مقرّبة بخانات عملة الشركة، وتكون 0 حين لا يوجد سعر. وtotalCost هو مجموع قيم lineCost بعد تقريب كل منها",
     "expiresAt حقل مهجور لا يُكتب، فتجاهله",
     "product في هذا المسار يحمل name وunit فقط، بلا id، والمعرّف موجود في productId"
    ],
    "example": ""
   }
  ]
 },
 {
  "key": "field",
  "title": "الزيارات والتتبع وخطوط السير",
  "overview": "ثلاثة موجّهات: /visits لزيارات المناديب الميدانية مع صورها، و/tracking للخريطة الحية وخط سير المندوب الفعلي وإعداد التتبع، و/rep-routes لخطوط السير المخططة (قائمة عملاء مرتبة ليوم معيّن أو دائمة). المفتاح يعمل بهوية المستخدم الذي أصدره وأدواره وصلاحياته ونطاقه. المفتاح «قراءة فقط» يُرفض في POST وPATCH وDELETE برمز 403 API_KEY_FORBIDDEN. حد الطلبات 120 طلباً في الدقيقة لكل مفتاح، ويُرجع رأسي X-RateLimit-Limit وX-RateLimit-Remaining، وعند تجاوزه 429 API_RATE_LIMIT. شكل الرد دائماً {success, data} ولا يوجد ترقيم صفحات (pagination) في هذه المجموعة، والقوائم مسقوفة داخلياً. أخطاء التحقق من الحقول ترجع 400 بالشكل {success:false, message, errors}. انتبه للأيام: في /visits و/tracking اليوم يُحسب بتوقيت UTC، أي من الساعة 3 فجراً إلى 3 فجراً بتوقيت الرياض. أما /rep-routes فتقبل tzOffsetMin بالدقائق شرق UTC (الرياض 180). نقاط المندوب الخاصة بتطبيق الجوال (إرسال الموقع والنبضة وبصمة الحضور) لا يستعملها المفتاح",
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
   }
  ]
 },
 {
  "key": "reports",
  "title": "التقارير ولوحة المؤشرات وبيانات الشركة والإشعارات",
  "overview": "كل المسارات تحت https://api.fieldsa.net/api وتقبل مفتاح الشركة في Authorization: Bearer fsk_... أو في الترويسة X-API-Key، ويعمل المفتاح بهوية المستخدم الذي أصدره (ADMIN أو MANAGER أو ACCOUNTANT) فتسري عليه صلاحياته ونطاقه. لا يقع أي من هذه المسارات ضمن البادئات الممنوعة على المفاتيح. حد الطلبات 120 في الدقيقة لكل مفتاح (X-RateLimit-Limit و429 API_RATE_LIMIT). المفتاح المضبوط «قراءة فقط» لا يمر إلا بطلبات GET وHEAD، فيُرفض عليه PUT /company وPATCH للإشعارات برمز 403 API_KEY_FORBIDDEN. لا يوجد ترقيم صفحات (page/limit) في أي مسار من هذه المجموعة، وبعضها يرجع كل الصفوف دفعة واحدة، فاستعمل مدى زمنياً ضيقاً. التواريخ في from وto بصيغة YYYY-MM-DD وتُفسَّر على أنها منتصف ليل UTC، وقيمة to تشمل يومها كاملاً، إلا في work-hours حيث تُحسب بالتوقيت المحلي عبر tz. التقارير (/reports) لا يحجبها إطفاء النظام المحاسبي، أما لوحة المؤشرات (/dashboard) فتُرجع أصفاراً حين يكون مطفأً. أخطاء التحقق من الجسم ترجع 400 بالشكل {success:false, message, errors:{field:[...]}} من middleware/",
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
     }
    ],
    "body": [],
    "response": "بدون groupBy: {success:true, data:{invoices:[صف الفاتورة كاملاً بكل أعمدتها ومنها number وtype وinvoiceDate وsubtotal وdiscountAmt وtaxAmt وtotal وpaidAmt وremainingAmt وpricesIncludeTax، مع customer{id,name,channel,city} وsalesRep{id,name} أو null وitems[صف البند كاملاً ومنه qty وunitPrice وunitCost وdiscountAmt وtaxPct وtaxAmt وlineTotal مع product{id,name,code} أو null]], summary:{total, count, taxTotal, discountTotal, defaultRangeDays?}}}. مع groupBy=product تكون data مصفوفة [{name, code, qty, total}] حيث total مجموع lineTotal. ومع rep أو customer أو channel أو region تكون data مصفوفة [{name, count, total}]. كل التجميعات مرتبة تنازلياً حسب total",
    "rules": [
     "الحالة CONFIRMED وحدها، والنوع RETURN مستثنى",
     "بلا from ولا to يُقصر التقرير على آخر 90 يوماً، ويُعلن ذلك بـ summary.defaultRangeDays=90 في الوضع التفصيلي وحده، أما مع groupBy فيُطبَّق السقف دون إعلان",
     "يكفي طرف واحد من المدى، والطرف الغائب يعني بلا حد من جهته",
     "لا ترقيم ولا حد أقصى للصفوف، والفواتير مرتبة تصاعدياً بـ invoiceDate",
     "groupBy=rep يجمع الفواتير التي بلا مندوب تحت «بلا مندوب»، وproduct يجمع البند الذي بلا منتج تحت «صنف محذوف»، وchannel يجمع العميل الذي بلا قناة تحت UNSET، وregion يجمّع حسب customer.city وغيابها «—»",
     "المبالغ في هذا التقرير كما خُزّنت في الفاتورة: total شامل الضريبة، وsubtotal وdiscountAmt صافيان قبل الضريبة"
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
      "type": "enum: CASH | BANK_TRANSFER | POS | CHEQUE",
      "required": false,
      "desc": "حصر التقرير بطريقة دفع، والقيمة غير المعروفة تُرجع قائمة فارغة لأن الحقل نصي"
     }
    ],
    "body": [],
    "response": "{success:true, data:{receipts:[صف السند كاملاً بكل أعمدته ومنها number وamount وpaymentMethod وreceiptDate وstatus، مع customer{id,name} وsalesRep{id,name} أو null], summary:{total, count, byMethod:{CASH?:number, BANK_TRANSFER?:number, POS?:number, CHEQUE?:number}}}}",
    "rules": [
     "السندات ذات الحالة ACTIVE فقط، فالملغاة لا تدخل",
     "لا يوجد مدى افتراضي هنا خلافاً لتقرير المبيعات، فبلا from وto يرجع كل السجل",
     "لا ترقيم ولا حد للصفوف، والترتيب تصاعدي بـ receiptDate"
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
    "query": [],
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
    "response": "{success:true, data:{كل أعمدة إعدادات الشركة ومنها name وaddress وtaxNumber وcommercialReg وphone وemail وlogo (base64) وprimaryColor وheaderStyle وnumerals وcountryCode وcurrency وcurrencyOverride وdefaultVatPct وeinvoiceProvider وeinvoiceEnabled وeinvoiceEnv وeinvoiceClientId وحقول بائع زاتكا وzatcaPhase2StartedAt، مع einvoiceHasSecret:boolean بدل السر، والأعلام erpEnabled وpetroappEnabled وhatifEnabled وcatalogEnabled وpaylinkEnabled وwarehouseEnabled وreceivablesSummaryEnabled وaccountingEnabled وdailyReportEnabled وattendanceEnabled وinvoiceSignatureEnabled وaccountingSuiteEnabled وzatcaPhase2Enabled وaiRepEnabled وapiEnabled}}",
    "rules": [
     "einvoiceClientSecret لا يُعاد أبداً ويُستبدل بـ einvoiceHasSecret",
     "accountingEnabled يكون true ما لم يُطفأ صراحة، وبقية الأعلام false ما لم تُفعَّل",
     "إذا لم يوجد صف إعدادات للشركة ترجع الأعلام وحدها",
     "استعمل الأعلام لمعرفة الميزات المتاحة قبل استدعاء مساراتها مثل المستودع وروابط الدفع"
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
 }
];

# «سفير فيلد سيلز» v2 — مواصفة البناء (١٨ نوفمبر ٢٠٢٦)

> تعلو هذه المواصفة على `CONTRACT.md` حيث تتعارضان (ويُحدَّث العقد و`API.md` ليطابقاها — مهمّة الوكيل B).
> مرجع التصميم: دراسة «شركاء ركاز» (محلية). المالك أذن بالبناء صراحةً («ابدأ تعديل نظام سفير»).

## 0. قرارات المالك الحاكمة
| القرار | القيمة |
|---|---|
| الانضمام | **فوريّ**: التسجيل يفتح الحساب ويُدخله مباشرةً — **بلا تأكيد بريد ولا موافقة** (كالتسجيل التجريبي للشركات) |
| العمولة | **تبقى 30٪ من أول دفعة مؤكَّدة شاملةً الضريبة** (لا تغيير) |
| الحجز | **10 أيام** (كان 30) |
| الصرف | **دورة تسوية تلقائية كل 10 أيام** بحدٍّ أدنى **50 ر.س** وترحيل ما دونه. المنصّة **تُنشئ** دفعات التسوية وتنبّه المالك، والمالك **يحوّل يدوياً** ويسجّل «مدفوع» أو «فشل» — المنصّة لا تحرّك مالاً أبداً |
| الاعتماد | **تلقائيّ** للعمولة بعد انتهاء حجزها (ما لم تكن موقوفة/متنازعاً عليها) — ويبقى للمالك الاعتماد والإيقاف اليدويّان |
| الملف | **كامل مثل ركاز** لكنه لا يحجب الحساب: نوع السفير (فرد/شركة/مؤثر) عند التسجيل، ثم «أكمل ملفك»: روابط التواصل، الآيبان، صورة الهوية/الإقامة (+ السجل للشركة) — **شرطٌ لدخول دورة التسوية فقط** |
| الظهور | **صفحة علنية مفهرسة** `/ambassadors` (عربي/إنجليزي/فرنسي) ورابط في تذييل الموقع. البوابة `/ax` نفسها تبقى noindex وخارج الخريطة (تطبيق لا صفحة) |
| الجوال | البوابة **سهلة على الجوال مثل ركاز** (شريط سفلي + «المزيد»، زرّ مشاركة عريض بقائمة الجوال، بطاقات ٢×٢، خطوات البداية، زرّ دعم عائم) |
| يبقى كما هو | الترشيح المسبق، الحساب التجريبي الذي يفتحه السفير، نافذة الإسناد 90 يوماً، تبويب الأسعار (وخصم اليمن)، الخمس لغات، الإسناد والدفتر والاسترداد والخصم اللاحق |

## 1. قواعد ثابتة (لا تُكسر)
1. مصدر حقيقة الدفع كما هو: `payment_links.status='paid'` و`tenantId`. لا `plan` ولا `isActive` ولا MRR في `ledger.ts`.
2. عمولة واحدة لكل شركة على **أول** دفعة مؤكَّدة. المبالغ بالهللات Int، half-up.
3. لقطة الشروط في كل إسناد/عمولة لا تُمسّ: الإسنادات والعمولات القائمة تبقى بـholdDays المخزَّن (30) — v2 للإسنادات الجديدة بعد قبول شروط v4.
4. **المنصّة لا تحرّك مالاً**: لا ميسر ولا تحويل بنكي آلي. «التسوية التلقائية» = إنشاء دفعةٍ `draft` تلقائياً + إشعار.
5. رمز إحالة خاطئ لا يُفشل تسجيل شركة أبداً. لا حسابات تجريبية ولا اتصال بالقاعدة في التطوير — التحقق بالاختبارات.
6. عزل البوابة: سرّ `::affiliate`، `ax_token`، axios مستقل. كل استعلامٍ في `routes/affiliate.ts` مقيَّد بـ`affiliateId` من التوكن (حارس الاختبار قائم).
7. مستندات الهوية مشفّرة (AES-256-GCM، مفتاح `AFFILIATE_DOC_KEY` أو مشتقّ من سرّ السفير `::doc`) ولا تُعاد إلا للسفير نفسه أو للمالك/الموظف بصلاحية `affiliates.iban` مع حدث `document_viewed`.

## 2. المخطّط (مُطبَّق في الأساس — لا يعدّله أي وكيل)
`AffiliateUser`: `partnerType?`، `companyName?`، `socialLinks Json?`، `profileCompletedAt?`، علاقتا `documents`، `missedClaims`.
`AffiliatePayout`: `cycleKey?`، `periodStart?`، `periodEnd?`، `failedReason?`، `failedAt?`، والحالة `draft|recorded|void|failed`.
جداول جديدة: `AffiliateDocument` (+`AffiliateDocumentBlob.enc`)، `AffiliateMissedClaim`، `AffiliateMaterial` (+`AffiliateMaterialBlob.bytes`).
(انظر `backend/prisma/schema.prisma` — كتلة السفراء.)

## 3. الحالات والقيم
- **حالات السفير** (union كما هو في API.md): `pending_email|pending_review|approved|rejected|suspended`. التسجيل الجديد يُنشئ **`approved`** مباشرةً. `pending_email`/`pending_review` **إرثٌ** فقط: يُرقّى كلٌّ منهما إلى `approved` (أ) مرّةً عند الإقلاع بعلامة `OpsMarker 'ax-v2-instant'` (updateMany + حدث ملخّص `system`) و(ب) عند أي دخولٍ ناجح لصاحبه. الانتقالات: `approved→suspended`، `suspended→approved`، `rejected→approved` (إعادة تفعيل) — ولا موافقة/رفض للطلبات بعد اليوم (الرفض = إيقاف).
- **نوع السفير** `PartnerType = 'individual'|'company'|'influencer'`.
- **المنصّات** `SocialPlatform = 'x'|'instagram'|'snapchat'|'tiktok'|'youtube'|'linkedin'|'website'|'other'` — حتى ٨ روابط، كلٌّ `https?://` ≤300.
- **أنواع المستند** `DocKind = 'national_id'|'commercial_reg'` — jpeg/png/webp/pdf مفحوصة بالبايتات، ≤ ٥ ميغابايت للملف (data URL base64 في JSON).
- **اكتمال الملف** `profileComplete = partnerType && ibanEnc && national_id && (partnerType!=='company' || commercial_reg)`؛ يُختم `profileCompletedAt` حين يكتمل ويُمسح حين ينقص.
- **حالات الدفعة** `PayoutStatus = 'draft'|'recorded'|'void'|'failed'` — بالعربية للسفير: قيد المعالجة / مدفوعة / ملغاة / فشل التحويل.
- **حالات المطالبة الفائتة** `MissedClaimStatus = 'under_review'|'accepted'|'rejected'|'withdrawn'`.
- **فئات المواد** `MaterialCategory = 'image'|'video'|'document'|'text'|'link'`.

## 4. الشروط v4 (مدمجة)
- `BUILTIN_TERMS_VERSIONS = ['2026-09-v1','2026-09-v2','2026-09-v3','2026-11-v4']`، و`DEFAULT_TERMS_VERSION = '2026-11-v4'`.
- **إصلاح خطر `rulesFor`**: قواعد كل إصدارٍ مدمج من خريطة `BUILTIN_TERMS_RULES[version]` (v1–v3: 3000/30/10000/90/90/180 كما كانت؛ v4: 3000/**10**/**5000**/90/90/180) لا من `DEFAULT_SETTINGS` — فتغيير الافتراضيات لا يمسّ سفراء v1–v3 بأثرٍ رجعي. و`getSettings()` حين يرقّي `currentTermsVersion` المدمج يُعيد قيم القواعد من إصدار v4 أيضاً (فـ`/terms/public` و`/me` يقولان 10/50).
- نصّ v4 (عربي ملزِم، بلا `**`): الأرقام الحالية (30٪ من أول دفعة مؤكَّدة **شاملاً ضريبة القيمة المضافة**، نافذة 90 يوماً، قفل الترشيح 90، أول دفعة خلال 180)، **الحجز ١٠ أيام**، **التسوية كل ١٠ أيام بحدٍّ أدنى ٥٠ ريالاً ويُرحَّل ما دونه**، الانضمام فوريّ وحقّ الإيقاف لاحقاً، اكتمال الملف شرطٌ للصرف، المطالبة بإحالة فائتة خلال 30 يوماً من تسجيل الشركة، وبنود ركاز الناقصة: لا رسائل مزعجة ولا ادّعاءات مضلّلة، لا استعمال لاسم/شعار فيلد سيلز في حساباتٍ أو إعلاناتٍ توحي أنها رسمية إلا بإذن كتابي، الضرائب على السفير، الإيقاف للاحتيال أو المخالفة أو **عدم النشاط ١٢ شهراً**، ومصير العمولات غير المسوّاة عند الإنهاء (تُسوّى المستحقة المشروعة)، والتعديل بإشعار، والقانون الحاكم السعودي. وتبقى جملة «موثوق»/«إعلان» التذكيرية (اختبار قائم).
- السفير على v3 يرى بوابة قبول الشروط (TermsGate قائمة) قبل متابعة البوابة؛ إسناداته الجديدة قبل القبول `disputed` كما اليوم.

## 5. دورة العمولة والتسوية
- **الاعتماد التلقائي**: `autoApproveEligible(now)` في `ledger.ts` — لكل عمولة `pending` و`eligibleAt ≤ now`: نفس فحوص `approveCommission` (المزامنة، الدفعة الأسبق، الإسناد active، السفير approved، عمولة > 0) ثم `approved` بـ`approvedBy='system'` وحدث `actorType:'system'`. دالةٌ جديدة لا تعدّل توقيع الدوال الثلاث عشرة (`by: PlatformActor`).
- **حدود الدورة**: نهايات الدورات أيام **1 و11 و21** من كل شهر 00:00 بتوقيت الرياض. `cycleKey` = تاريخ النهاية `YYYY-MM-DD`؛ `periodStart` = النهاية السابقة.
- **المهمّة**: `services/affiliate/settlement.ts` → `runSettlementCycle(now)`: يحسب آخر نهايةٍ مرّت، ثم `claimMarker('ax-settle:'+cycleKey)` (OpsMarker — مرّة واحدة ولو تعدّدت النسخ أو أُعيد التشغيل)، ثم `reconcile()` ثم `autoApproveEligible` ثم لكل مرشّحٍ مؤهَّل (صافٍ ≥ الحدّ الأدنى من `rulesFor(termsVersion)`، `profileComplete`، status approved، بلا دفعة `draft` مفتوحة) دفعةٌ `draft` بـ`cycleKey/periodStart/periodEnd` و`createdBy='system'`، ثم بريدٌ للمالك بملخّص (عدد الدفعات ومجموعها). يُشغَّل من `startAffiliateSettlementScheduler()` في `index.ts` (setInterval ساعة + تأخير إقلاع، `unref`)، ومفتاح إطفاء `AX_SETTLEMENT_ENABLED=0`.
- **فشل التحويل**: `failPayout(id, by: PlatformActor, reason)` — draft → `failed`، تُفكّ عمولاتها وتعود `approved` (كالإلغاء)، ويُختم `failedReason/failedAt`، وبريدٌ للسفير «تعذّر التحويل — تحقّق من بيانات الآيبان»، وتدخل الدورة التالية تلقائياً بعد تصحيحه.
- **الحدّ الأدنى**: ما دون 50 ر.س يبقى `approved` بلا دفعة (يُرحَّل).

## 6. واجهات الخادم
### 6.1 البوابة `/api/affiliate` (الوكيل A)
| المسار | التغيير |
|---|---|
| `POST /register` | **201** `{token, user}` فوراً (`status:'approved'`, `emailVerifiedAt:null`). الجسم: `{fullName 2..80, email, phone, password 8..128, partnerType, companyName? (إلزامي للشركة 2..120), socialLinks?, acceptTerms:true, termsVersion, marketingConsent?}`. بريدٌ موجود ⇒ **409** `{code:'email_taken', message:'يوجد حساب بهذا البريد — سجّل الدخول'}` (كتسجيل الشركات). مغلق ⇒ 403. إصدار شروط قديم ⇒ 409 `terms_outdated`. يبقى `axRegisterLimiter` (6/ساعة/IP). بريد ترحيب للسفير (رابطه) وبريد «سفير جديد» للمالك. لا `mailVerify` بعد اليوم |
| `POST /verify-email`، `POST /resend-verification` | **تُحذفان** (روابط البريد القديمة: الواجهة تحوّلها للدخول) |
| `POST /login` | يدخل كل سفيرٍ بكلمة مروره الصحيحة (الموقوف يرى حالته كما اليوم). وفرع `pending_email` (كان يُرفض بـ401) يصير: يُرقّى الإرث `pending_*` إلى `approved` عند النجاح ويُعطى التوكن |
| `GET /me` | يضيف `user.partnerType, companyName, socialLinks, documents:[{kind, mime, sizeBytes, createdAt}], profileComplete, missing:['partnerType'|'iban'|'national_id'|'commercial_reg']`، و`settings.nextSettlementAt` (ISO لنهاية الدورة القادمة) و`settings.settlementEveryDays:10`، و`link` الجديد |
| `PUT /me` | يقبل أيضاً `partnerType, companyName, socialLinks` |
| `PUT /payout-profile` | **بلا شرط «بعد أول عمولة»** — متاح دائماً (IBAN سعودي SA+22 وmod-97 كما هو، 409 مع دفعة draft) |
| `POST /documents` | `{kind, dataUrl}` ⇒ 201 `{kind, mime, sizeBytes, createdAt}` (يستبدل السابق من النوع نفسه، تشفير، تحديث profileCompletedAt) |
| `GET /documents/:kind` | السفير نفسه ⇒ `{dataUrl}` لمعاينة ما رفعه |
| `DELETE /documents/:kind` | حذف حقيقي |
| `GET /dashboard` | يضيف `totalEarnedHalalas` (approved+paid صافياً)، `pendingSettlementHalalas` (approved بلا دفعة + في دفعة draft)، `activeReferrals` (إسنادات active)، `conversionRate` (paidCompanies/signups أو null)، `earningsByMonth:[{month:'YYYY-MM', halalas}]` لآخر ٦ أشهر (بتاريخ الدفعة)، `nextSettlementAt`، `steps:{account:true, shared:boolean(clicks30d>0||signups>0), firstPaid:boolean}` |
| `GET /payouts` | يعيد **كل** دفعاته (draft/recorded/failed؛ void يُخفى) بالحقول `{id, status, commissionsHalalas, adjustmentsHalalas, netHalalas, periodStart, periodEnd, transferredAt, bankReference, ibanLast4, failedReason}` |
| `POST /missed-claims` | `{companyName 2..120, contactPhone?, crNumber?, note? ≤200}` ⇒ 201 (الحد ٢٠ مفتوحة) — الملاحظة والاسم بلا جوال/بريد |
| `GET /missed-claims` · `POST /missed-claims/:id/withdraw` | قائمته وسحب ما تحت المراجعة |
| `GET /materials` · `GET /materials/:id/file` | القائمة `{id,title,category,fileName,mime,sizeBytes,url,textBody,createdAt}` والملف `{dataUrl}` |
| `referralLink(code)` | **`${frontendBase()}/signup?ref=${code}`** (رابط مباشر لصفحة التسجيل — `refFromSearch` يدعمه أصلاً) |

### 6.2 المالك `/api/affiliate-admin` (الوكيل B) — كلّها خلف `platformGate` ومصنّفة في `platformAccess.ts`
| المسار | المفتاح |
|---|---|
| `GET /overview` يضيف `newAffiliates7d`, `incompleteProfiles`, `missedClaimsUnderReview`, `nextSettlementAt`, `lastCycle:{cycleKey, payouts, totalHalalas}`؛ ويحذف `pending_review` من البطاقات | view |
| `GET /affiliates/:id` يضيف `partnerType, companyName, socialLinks, documents[], profileComplete, missing` | view |
| `GET /affiliates/:id/documents/:kind` ⇒ `{dataUrl}` + حدث `document_viewed` | **iban** |
| `POST /affiliates/:id/(suspend|reactivate)` كما هو؛ `approve/reject` تُبقيان للإرث | manage |
| `POST /commissions/:id/approve` يبقى (يدوي اختياري) | payouts |
| `POST /payouts/:id/fail {reason 3..300}` ⇒ `failPayout` | payouts |
| `POST /settlement/run` تشغيل الدورة الآن يدوياً (idempotent بنفس المفتاح) | payouts |
| `GET /missed-claims?status` (مع اقتراحات مطابقة بالاسم/السجل/الجوال) | view |
| `POST /missed-claims/:id/accept {tenantId, reason}` ⇒ `createOwnerAttribution` ثم `accepted` · `/reject {reason}` | manage |
| `GET /materials` · `POST /materials {title, category, dataUrl?|url?|textBody?, sortOrder?}` (ملف ≤ ٨ ميغابايت) · `DELETE /materials/:id` | view / manage |

## 7. البوابة `/ax` (الوكيل C) — الجوال أولاً
- **التنقّل**: على الجوال **شريط سفلي ثابت** بأربعة: الرئيسية · شركاتي · أرباحي · المزيد. «المزيد» ورقةٌ منزلقة من الأسفل بالباقي (رابطي، رشّح شركة، افتح حساباً تجريبياً، مطالبة بإحالة فائتة، الأسعار، المواد التسويقية، الأسئلة الشائعة، الدعم، الملف، الشروط، خروج) وتُغلق بعد الاختيار. على الحاسوب (≥lg) **شريطٌ جانبي** بالكل. التبويبات تبقى من `#hash` (الرجوع في أندرويد).
- **التسجيل**: بطاقةٌ واحدة: الاسم، البريد، الجوال بمنتقي الدولة، كلمة المرور، **نوع السفير** ببطاقات أيقونات كبيرة (فرد/شركة/مؤثر) واسم الشركة إن كانت، الموافقة على الشروط ⇒ يُخزَّن التوكن ويدخل الرئيسية فوراً (لا شاشة تأكيد بريد، ولا «بانتظار المراجعة»). `?verify=`/`?view=verify|resend` القديمة ⇒ الدخول.
- **الرئيسية**: ترحيب باسمه + حالته؛ **شريط أصفر «أكمل ملفك لاستلام أرباحك»** بما ينقص (إن نقص)؛ **زرّ «مشاركة رابطي» عريض** (`navigator.share` بنصٍّ جاهز، وإلا واتساب/نسخ) + «نسخ»؛ **خطوات البداية** (أُنشئ حسابك ✓ · شارك رابطك · أول شركة تدفع)؛ **بطاقات ٢×٢**: إجمالي الأرباح، تسوية معلّقة، إحالات نشطة، معدل التحويل؛ **رسم أعمدة بسيط** لأرباح ٦ أشهر (CSS بلا مكتبة)؛ «التسوية القادمة {date}»؛ وتنقّل سريع.
- **شركاتي**: بطاقات على الجوال بعمود «الطريقة» (رابط/رمز/ترشيح/حساب تجريبي/إداري) والحالة، وزرّ «مطالبة بإحالة فائتة».
- **أرباحي**: العمولات (الشركة، مبلغ الدفعة، النسبة، العمولة، «محجوزة حتى»، الحالة) + **التسويات** (الفترة، العمولات، التعديلات، الصافي، تاريخ الدفع، الحالة: قيد المعالجة/مدفوعة/فشل التحويل + السبب) + «التسوية القادمة».
- **ملفي**: النوع، اسم الشركة، روابط التواصل (منصّة + رابط، إضافة/حذف)، الحساب البنكي (متاح دائماً)، المستندات: الهوية/الإقامة (والسجل للشركة) **بتصوير أو من الاستديو** مع معاينة ونسبة اكتمال الملف.
- **المواد التسويقية**: تصفية بالفئة، تنزيل الملف/مشاركته، نسخ النصّ الجاهز، فتح الرابط.
- **الأسئلة الشائعة** (ثابتة بالخمس لغات: العمولة، الحجز والتسوية، الإحالة، الحساب التجريبي، المطالبة الفائتة، الملف والصرف) و**الدعم**: زرّ واتساب الرسمي `966506061608` وبريد `info@fieldsa.net` — و**زرّ واتساب عائم** داخل البوابة.
- كل نصٍّ جديد في `AX_DICT` بالخمس لغات. المصطلحات: «ترشيح/Nomination» للترشيح المسبق (اختبارٌ يمنع Referral فيه)، و«مطالبة بإحالة فائتة / Missed referral claim» للجديد.

## 8. لوحة المالك (الوكيل D) — `AffiliatesPanel.tsx` و`affiliatesPanelLogic.ts`
- نظرة عامة: «سفراء جدد هذا الأسبوع»، «ملفات ناقصة»، «مطالبات فائتة قيد المراجعة»، «التسوية القادمة {date}» و«آخر دورة: N دفعات بمجموع X»، وعمولات بانتظار الحجز. يُحذف «طلبات انضمام بانتظار المراجعة».
- المسوّقون: عمود «الملف» (مكتمل/ينقصه …) والنوع؛ الدرج: النوع، الشركة، روابط التواصل، المستندات بزرّ «عرض» (بصلاحية `affiliates.iban`، يُسجَّل).
- العمولات: ملاحظة «تُعتمد تلقائياً بعد ١٠ أيام» ويبقى الاعتماد اليدوي.
- الصرف: «دورة التسوية كل ١٠ أيام (١ و١١ و٢١)»، زرّ «تشغيل الدورة الآن»، الدفعات بالحالات الأربع والفترة، «تسجيل التحويل» و**«فشل التحويل»** (سبب).
- تبويب **«المطالبات الفائتة»**: قبول بربط شركة (`TenantSearchBox`) أو رفض بسبب.
- تبويب **«المواد التسويقية»**: رفع ملف/رابط/نصّ بعنوان وفئة، وحذف.
- الإعدادات: نصّ الرابط يصير «البوابة: fieldsa.net/ax — صفحة البرنامج العلنية: fieldsa.net/ambassadors — الانضمام فوريّ بلا موافقة» ومفتاح `intakeOpen` كما هو.

## 9. الصفحة العلنية (الوكيل E)
- `/ambassadors` و`/en/ambassadors` و`/fr/ambassadors` (مجموعة ثلاثية اللغة في `locale.ts`)، مصيَّرة مسبقاً بنصٍّ واحد المصدر (كائن نصوص في الصفحة يقرؤه prerender — فخّ المصدر المزدوج)، في الخريطة وllms، ورابط «سفراء فيلد سيلز / Ambassadors» في تذييل الصفحة الرئيسية (عمود «الشركة») بلغاته.
- المحتوى: «اكسب ٣٠٪ من أول دفعة لكل شركة تحيلها»، ٣ خطوات (سجّل وخذ رابطك فوراً · شارك رابطك · اربح — تُحجز ١٠ أيام وتُسوّى كل ١٠ أيام)، لماذا (فوري بلا انتظار، عمولة على كامل الدفعة الأولى ولو سنوية، أدوات: رابط، ترشيح، حساب تجريبي، مواد تسويقية، لوحة على الجوال، خمس لغات)، لمن (أفراد، شركات، مؤثرون، وكالات)، أسئلة شائعة، ودعوة «انضم الآن».
- **قيود الحرّاس**: لا مبالغ بعملة (verify-pricing يمنع «50 ر.س» — قل «حدّ أدنى بسيط»)، لا «اشترك الآن»، لا ادّعاء غير موثّق («أعلى نسبة في السوق» ممنوع)، لا أسماء منافسين (لا «ركاز»)، لا «الأسواق العربية» في رأس en/fr.
- **الربط بالبوابة دون كسر حرّاس الإخفاء**: أزرار الصفحة تشير إلى **`/ambassadors/join`** (و`/ambassadors/login`)، وهما مساران في `App.tsx` يحوّلان (`<Navigate replace>`) إلى `/ax?view=register` و`/ax`. فلا يظهر `/ax` في prerender ولا في src/pages (`hiding.test.ts` كما هو). يُضاف المساران إلى `APP_ROUTES` في `verify-sitemap.mjs` وإلى قائمة `PRIVATE` في `adsTracking.test.ts`، و`/ambassadors` إلى `MARKETING_ROOTS`/`PUBLIC`.

## 10. ملكية الملفات (لا يلمس وكيلٌ ملف غيره — والمخطّط مقفل)
- **A (خادم البوابة)**: `routes/affiliate.ts`، `services/affiliate/core.ts`، `rules.ts`، `mail.ts`، ملفات جديدة `services/affiliate/documents.ts` و`portalStats.ts`، اختبارات `tests/affiliate.test.ts` (أقسام التسجيل/الشروط/الرابط/البوابة فقط) و`tests/affiliate-v2-portal.test.ts` (جديد).
- **B (الدفتر والتسوية والمالك)**: `services/affiliate/ledger.ts`، جديد `settlement.ts` و`materials.ts` و`missedClaims.ts`، `routes/affiliateAdmin.ts`، `services/platformAccess.ts`، `index.ts` (سطر المجدول وحده)، `docs/affiliate/CONTRACT.md` و`API.md`، اختبارات `tests/affiliate.test.ts` (أقسام الدفتر/الصرف/المخطّط فقط)، `platform-staff*.test.ts`، جديد `tests/affiliate-v2-settlement.test.ts`. (مسارات البوابة للمطالبات والمواد يكتبها A مستدعياً دوالّ B من `missedClaims.ts`/`materials.ts` — يتّفقان على التواقيع في §11.)
- **C (البوابة)**: كل `web-admin/src/affiliate/**` واختباراتها.
- **D (لوحة المالك)**: `web-admin/src/components/AffiliatesPanel.tsx`، `affiliatesPanelLogic.ts(+test)`، و`web-admin/src/i18n/strings.ts` إن لزم.
- **E (الصفحة العلنية)**: صفحة جديدة `web-admin/src/pages/AmbassadorsPage.tsx` (+نصوصها)، `App.tsx`، `i18n/locale.ts`، `i18n/i18nRoutes.mjs`، `scripts/prerender.mjs`، `gen-sitemap.mjs`، `gen-llms.mjs`، `verify-sitemap.mjs`، `landing/landingTemplate.ts`، `pages/LandingPage.tsx`، `lib/adsRoutes.ts`، الملفات المولَّدة في `public/` (sitemap/llms)، واختبارات `adsTracking.test.ts` و`whatsappFab.test.ts` إن لزم.

## 11. تواقيع مشتركة بين A وB
```ts
// services/affiliate/missedClaims.ts (B)
export async function createMissedClaim(affiliateId: string, input: {companyName: string; contactPhone?: string|null; crNumber?: string|null; note?: string|null}): Promise<{id: string}>
export async function listMissedClaims(affiliateId: string): Promise<Array<{id, companyName, contactPhone, crNumber, note, status, reasonNote, submittedAt, reviewedAt}>>
export async function withdrawMissedClaim(affiliateId: string, id: string): Promise<void>   // LedgerError 404/409
// services/affiliate/materials.ts (B)
export async function listMaterials(): Promise<MaterialRow[]>
export async function materialFile(id: string): Promise<{dataUrl: string} | null>
// services/affiliate/settlement.ts (B)
export function nextSettlementAt(now?: Date): Date   // نهاية الدورة القادمة (1/11/21 00:00 الرياض)
export function cycleBounds(now?: Date): {cycleKey: string; periodStart: Date; periodEnd: Date} // آخر دورة انتهت
// services/affiliate/documents.ts (A)
export async function profileStatus(affiliateId: string): Promise<{complete: boolean; missing: string[]}>
export async function refreshProfileCompletion(affiliateId: string): Promise<boolean>
export async function documentDataUrl(affiliateId: string, kind: DocKind): Promise<string|null>   // B يستدعيها للمالك
```
B يستدعي `profileStatus` من A في المرشّحين للتسوية؛ A يستدعي `nextSettlementAt` من B. **كلٌّ منهما يُنشئ ملفّه بالتوقيع أعلاه أولاً** (ولو بتنفيذٍ مبدئي) ليبني الآخر عليه — وفي الدمج يبقى تنفيذ المالك الأصلي.

## 12. الاختبارات والتحقق
- الاختبارات القائمة التي تثبّت السلوك القديم عمداً (202 الموحّد للتسجيل، `canSetPayout`، `holdDays @default(30)` في المخطّط — **لا يُغيَّر في المخطّط**، `BUILTIN_TERMS_VERSIONS` بثلاثة، `/?ref=`، عدّ الثلاث عشرة، نصوص i18n المثبّتة، `USER_ACTIONS`…) **تُحدَّث لتطابق v2 بتعليقٍ يذكر قرار المالك** — لا تُحذف حراسةٌ بلا بديل.
- **الخادم**: من مجلد الخادم في نسختك: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` بعد `prisma generate` في بيئة معزولة — راجع §13. اختبارات: `node node_modules/tsx/dist/cli.mjs --test src/tests/<file>.test.ts`.
- **الويب**: `npx tsc --noEmit -p .` و`npx tsx --test <files>` (وإن أمكن `npm test` كاملاً — ٩ إخفاقات قديمة معروفة: build.gradle، twa-manifest، الوحدة الرئيسية، جوال العميل، دقّة المستند ×٢، دليل حركات المخزون، كل رمز خطأ في الدليلين، وحدة التحصيل بالبطاقة).

## 13. بيئة العمل
- لكل وكيلٍ نسخة git مستقلة (`C:/Users/ali_h/wt-amb-<حرف>`) على فرعه `amb/<حرف>` من الأساس. اعمل **فيها وحدها**، والتزم (commit) بمسارات صريحة في فرعك، **ولا تدفع (push) أبداً**.
- `web-admin/node_modules` و`backend/node_modules`: أنشئ وصلةً (junction) إلى `C:\Users\ali_h\wt-track\web-admin\node_modules` و`C:\Users\ali_h\wt-track\backend\node_modules` — **لكن لا تشغّل `prisma generate` داخل وصلة الخادم** (تكتب في نسخةٍ مشتركة). لفحص الخادم: انسخ `backend/src` و`prisma` و`tsconfig.json` و`package.json` إلى مجلدٍ مؤقت فريدٍ لك، وأنشئ فيه `node_modules` حقيقياً بوصلاتٍ لكل حزمة عدا `@prisma/client` (انسخه نسخاً) و`.prisma`، ثم `prisma generate` هناك. السكربت الجاهز: `powershell -File C:\Users\ali_h\AppData\Local\Temp\claude\6080d5ef4ca6efd1\d525e93c-b9b9-4790-bf11-0628ea85ca47\scratchpad\btc\prep.ps1 -Backend <نسختك>\backend -Src C:\Users\ali_h\wt-track\backend -Tmp <مجلدك المؤقت>` ثم من `<مجلدك المؤقت>`: `node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma`، ثم tsc والاختبارات. (اختباراتٌ تقرأ ملفاتٍ خارج الخادم — web-admin/docs — تحتاج وصلة `<مجلدك المؤقت>\..\web-admin` و`..\docs` إلى نسختك.)
- لا اتصال بقاعدة البيانات، لا حسابات تجريبية، لا نشر.

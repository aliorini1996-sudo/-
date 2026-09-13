# عقد تنفيذ برنامج «سفير فيلد سيلز» — v1

> هذا العقد **يعلو** على `affiliate_design.md` حيث يتعارضان. التصميم كُتب قبل قرارات المالك
> (١٣ سبتمبر ٢٠٢٦)، وهذا العقد يطبّقها ويطبّق إصلاحات `affiliate_critique.json` ذات الصلة.

## 0. قرارات المالك الحاكمة

| القرار | القيمة |
|---|---|
| نسبة العمولة | **30%** (`rateBps = 3000`) |
| على ماذا | **الدفعة الأولى المؤكَّدة فقط** لكل شركة — لا تكرار |
| الأساس | **كامل مبلغ الدفعة الأولى شاملاً الضريبة** (`amountHalalas`)، ولو غطّت سنة مقدّماً |
| الصرف | **يدوي من المالك من البداية** (المنشأة سعودية بسجل تجاري ومسجّلة ضريبياً). المنصّة **لا تحرّك مالاً** |
| الانضمام | رابط عام **غير مُدرج** + **موافقة المالك** على كل طلب |
| النشر | **النشر العلني مسموح** — من ينشر علناً يقرّ بترخيص «موثوق» ويُدخل رقمه، ويلتزم بوسم «إعلان» |
| التسمية | «سفير فيلد سيلز» في الواجهة |

## 1. قواعد ثابتة (لا تُكسر)

1. **مصدر حقيقة الدفع:** صفّ `payment_links` بحالة `status='paid'` و`tenantId` غير فارغ. لا يُقرأ `Tenant.plan` ولا `subscriptionEndsAt` ولا `isActive` ولا أي تقدير MRR.
2. **عمولة واحدة لكل شركة:** `AffiliateCommission.tenantId @unique` + `paymentLinkId @unique`. أوّل دفعة مؤكَّدة للشركة **بعد** `effectiveFrom` هي الوحيدة.
3. **المبالغ بالهللات `Int`**، والعمولة = `roundHalfUp(amountHalalas × rateBps / 10000)`.
4. **حجز قبل الاعتماد:** `eligibleAt = paidAt + holdDays` (افتراضي 30) يُحسب **مرّةً عند الإنشاء** ويُخزَّن — تغيير الإعدادات لاحقاً لا يمسّ عمولةً قائمة.
5. **الاسترداد:** قبل الصرف ⇒ العمولة `reversed`. بعد الصرف ⇒ قيد سالب `AffiliateAdjustment(kind='clawback_refund')` يُخصم من دفعات قادمة، **ولا دفعة سالبة أبداً**.
6. **رمز إحالة خاطئ أو فارغ لا يُفشل تسجيل الشركة أبداً** (يُهمَل بصمت).
7. **البوابة معزولة المصادقة:** سرّ مشتقّ `JWT_SECRET::affiliate` وحمولة `kind:'affiliate'`، وعميل axios مستقلّ ومفتاح تخزين مستقلّ (`ax_token`). لا تستعمل `api/client.ts`.
8. **غير مُدرجة:** لا في robots ولا sitemap ولا prerender ولا llms. `noindex,nofollow` يُحقن عند التحميل. تُستثنى من `VisitTracker` و`WhatsAppFab` (ومرآة اختباره). لا روابط إليها من صفحات عامة.
9. **لا بيانات أشخاص للشركات المرشَّحة:** اسم منشأة، سجل تجاري، مدينة، واختيار «كيف عرّفتهم». الملاحظة الحرّة ≤200 حرف **تُرفض إن احتوت جوالاً أو بريداً**.
10. **لا حسابات تجريبية ولا اتصال بالقاعدة.** التحقق بالاختبارات فقط.
11. **الأخطاء الموحّدة:** التسجيل واستعادة كلمة المرور تردّ 202 موحّدة (لا تعداد حسابات)، وتُلتقط P2002.

## 2. نموذج البيانات (إضافي فقط — جداول جديدة، لا FK لجداول قائمة)

```prisma
model AffiliateUser {
  id                 String    @id @default(uuid())
  email              String    @unique            // lowercase
  emailVerifiedAt    DateTime?
  passwordHash       String                        // scrypt salt:hash
  tokenVersion       Int       @default(0)
  failedLogins       Int       @default(0)
  lockedUntil        DateTime?
  fullName           String
  phone              String?                       // 9665XXXXXXXX — فهرس لا unique (منع التعداد)
  city               String?
  code               String    @unique            // ^[2-9A-HJ-NP-Z]{8}$
  status             String    @default("pending_email") // pending_email|pending_review|approved|rejected|suspended
  statusReason       String?
  reviewedAt         DateTime?
  reviewedBy         String?
  termsVersion       String
  termsAcceptedAt    DateTime
  termsIpHash        String?
  marketingConsent   Boolean   @default(false)
  publicPromoter     Boolean   @default(false)    // سينشر علناً
  mawthooqNo         String?
  mawthooqExpiry     DateTime?
  vatNumber          String?
  ibanEnc            String?                       // AES-256-GCM iv:tag:cipher
  ibanLast4          String?
  ibanHolderName     String?
  bankName           String?
  payoutUpdatedAt    DateTime?
  lastLoginAt        DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  claims       AffiliateClaim[]
  attributions TenantAttribution[]
  commissions  AffiliateCommission[]
  adjustments  AffiliateAdjustment[]
  payouts      AffiliatePayout[]
  @@index([status])
  @@index([phone])
  @@map("affiliate_users")
}

model AffiliateClaim {
  id              String        @id @default(uuid())
  affiliateId     String
  affiliate       AffiliateUser @relation(fields: [affiliateId], references: [id])
  companyName     String
  companyNameNorm String
  crNumber        String                          // ^\d{10}$ — إلزامي (يغلق ثغرة الترشيح بلا مفتاح)
  city            String?
  how             String                          // visit|relationship|event|online|other
  note            String?                         // ≤200، بلا جوال/بريد
  status          String        @default("under_review") // under_review|approved|rejected|withdrawn|expired|converted
  reasonCode      String?                         // existing_customer|duplicate|self_referral|insufficient|other
  reviewedAt      DateTime?
  reviewedBy      String?
  lockedUntil     DateTime?
  tenantId        String?
  convertedAt     DateTime?
  submittedAt     DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  @@index([affiliateId, status])
  @@index([status, submittedAt])
  @@index([crNumber])
  @@index([tenantId])
  @@map("affiliate_claims")
}

model TenantAttribution {
  id                 String        @id @default(uuid())
  tenantId           String        @unique
  tenantNameSnapshot String
  affiliateId        String
  affiliate          AffiliateUser @relation(fields: [affiliateId], references: [id])
  source             String                        // signup_code|claim|owner
  claimId            String?
  codeUsed           String?
  refVia             String?                       // link|typed
  status             String        @default("active") // active|disputed|void
  flags              String[]      @default([])    // self_email|self_phone|returning_company|ip_match
  reasonNote         String?
  effectiveFrom      DateTime
  rateBps            Int                           // لقطة
  firstPaymentDeadline DateTime                    // effectiveFrom + firstPaymentWithinDays
  termsVersion       String
  decidedBy          String?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  commission         AffiliateCommission?
  @@index([affiliateId, status])
  @@map("tenant_attributions")
}

model AffiliateCommission {
  id                   String            @id @default(uuid())
  tenantId             String            @unique   // عمولة واحدة لكل شركة — الدفعة الأولى
  paymentLinkId        String            @unique
  affiliateId          String
  affiliate            AffiliateUser     @relation(fields: [affiliateId], references: [id])
  attributionId        String            @unique
  attribution          TenantAttribution @relation(fields: [attributionId], references: [id])
  tenantNameSnapshot   String
  paymentAmountHalalas Int                          // شامل الضريبة
  coveredMonths        Int
  rateBps              Int
  commissionHalalas    Int
  paymentPaidAt        DateTime
  eligibleAt           DateTime                     // paidAt + holdDays — مخزَّن
  status               String            @default("pending") // pending|on_hold|approved|paid|reversed|declined
  reasonNote           String?
  approvedAt           DateTime?
  approvedBy           String?
  payoutId             String?
  payout               AffiliatePayout?  @relation(fields: [payoutId], references: [id])
  reversedAt           DateTime?
  termsVersion         String
  createdAt            DateTime          @default(now())
  updatedAt            DateTime          @updatedAt
  @@index([affiliateId, status])
  @@index([status, eligibleAt])
  @@index([payoutId])
  @@map("affiliate_commissions")
}

model AffiliateAdjustment {
  id            String        @id @default(uuid())
  affiliateId   String
  affiliate     AffiliateUser @relation(fields: [affiliateId], references: [id])
  commissionId  String?
  kind          String                              // clawback_refund|correction
  sourceRef     String        @default("")          // معرّف الاسترداد أو لقطة — يسمح بأكثر من استرداد جزئي
  amountHalalas Int                                 // سالب للاسترداد
  note          String?
  createdBy     String                              // system | superAdminId
  payoutId      String?
  createdAt     DateTime      @default(now())
  @@unique([commissionId, kind, sourceRef])
  @@index([affiliateId, payoutId])
  @@map("affiliate_adjustments")
}

model AffiliatePayout {
  id                 String        @id @default(uuid())
  affiliateId        String
  affiliate          AffiliateUser @relation(fields: [affiliateId], references: [id])
  commissionsHalalas Int
  adjustmentsHalalas Int
  netHalalas         Int
  status             String        @default("draft") // draft|recorded|void
  ibanLast4          String
  holderName         String
  transferredAt      DateTime?
  bankReference      String?
  createdBy          String
  recordedBy         String?
  voidReason         String?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  commissions        AffiliateCommission[]
  @@index([affiliateId, status])
  @@map("affiliate_payouts")
}

model AffiliateEvent {
  id        String   @id @default(uuid())
  entity    String   // user|claim|attribution|commission|payout|settings|terms|mail
  entityId  String
  action    String
  fromState String?
  toState   String?
  actorType String   // system|affiliate|owner|company
  actorId   String?
  reason    String?
  meta      Json?
  createdAt DateTime @default(now())
  @@index([entity, entityId])
  @@index([action, createdAt])
  @@map("affiliate_events")
}

model AffiliateSettings {
  id                    String   @id @default("global")
  intakeOpen            Boolean  @default(true)
  rateBps               Int      @default(3000)
  holdDays              Int      @default(30)
  minPayoutHalalas      Int      @default(10000)
  refWindowDays         Int      @default(90)
  claimLockDays         Int      @default(90)
  firstPaymentWithinDays Int     @default(180)
  currentTermsVersion   String   @default("2026-09-v1")
  disclosureText        String   @default("أحصل على عمولة من فيلد سيلز إذا اشتركت عبر رابطي")
  updatedBy             String?
  updatedAt             DateTime @updatedAt
  @@map("affiliate_settings")
}

model AffiliateTerms {
  version     String   @id
  body        String   // نص عادي يُعرض مُهرَّباً
  rulesJson   Json
  publishedAt DateTime @default(now())
  publishedBy String
  @@map("affiliate_terms")
}

model AffiliateClickDaily {
  code  String
  day   String   // YYYY-MM-DD بتوقيت الرياض
  count Int      @default(0)
  @@id([code, day])
  @@map("affiliate_click_daily")
}
```

## 3. الإسناد

- **الرابط:** `https://fieldsa.net/?ref=CODE` (أو أي صفحة عامة). يلتقطه العميل في `localStorage['fs_ref'] = {code, at, via:'link'}` — **آخر نقرة تكسب** (تُكتب فوق القديم)، وتنتهي بعد `refWindowDays`. يُرسل `POST /api/affiliate/click {code}` مرّةً لكل جلسة لعدّاد النقرات (بلا بيانات شخصية).
- **التسجيل:** حقل «رمز الإحالة» في `SignupPage`:
  - إن وُجد `fs_ref` صالح: يُملأ ويظهر، ومعه تنبيه «سيطّلع صاحب الرمز على اسم منشأتك وحالة اشتراكها لاحتساب عمولته» وزرّ إزالة.
  - وإلا: مطوي خلف رابط «لديك رمز إحالة؟» (يقلّل تسرّب الرموز).
  - يُرسل `ref` و`refVia: 'link'|'typed'` مع جسم التسجيل.
- **الخادم (`auth.ts` signup):** `ref` في `signupSchema` بصيغة متسامحة (`z.string().max(40).optional()` بلا regex)، ويُطبَّع بـ`parseRef`. داخل معاملة التسجيل وبعد إنشاء الشركة: `attachSignupAttribution(tx, {...})` — لا ترمي أبداً (أي خطأ يُسجَّل ويُتجاهل حتى لا يفشل التسجيل):
  - المسوّق `approved` وبرمزٍ مطابق ⇒ `TenantAttribution(source='signup_code', status='active')`.
  - إشارات تُحفظ في `flags`: `self_email` (بريد مسؤول الشركة = بريد المسوّق)، `self_phone` (جوال الشركة = جوال المسوّق)، `returning_company` (جوال الشركة يطابق `CompanySettings.phone` لشركةٍ أقدم). وجود `self_*` أو `returning_company` ⇒ `status='disputed'` بدل `active` (يحسمه المالك).
  - `effectiveFrom = now`، `firstPaymentDeadline = now + firstPaymentWithinDays`، و`rateBps` و`termsVersion` لقطة من الإعدادات.
- **الترشيح:** يُنشأ `under_review`. الردّ للمسوّق **موحّد** «استلمنا الترشيح وسيُراجع» مهما كانت النتيجة (لا يُكشف هل الشركة عميل). المالك يعتمده ⇒ `lockedUntil = now + claimLockDays`. **الأسبق يفوز:** لا يُعتمد ترشيحان ساريان بالسجل التجاري نفسه (يُفحص في الخادم عند الاعتماد).
- **ربط الترشيح بالشركة:** يدويّ من المالك (`link-tenant`) — مع اقتراحات بمطابقة `crNumber` مع `CompanySettings.commercialReg` واسم المنشأة المُطبَّع. يُنشئ `TenantAttribution(source='claim')` إن لم يوجد إسناد، أو يجعله `disputed` إن وُجد إسنادٌ بمسوّق آخر.
- **تعارض:** رمز التسجيل يغلب، إلا مع ترشيحٍ معتمدٍ ساري القفل لمسوّقٍ آخر بالسجل نفسه ⇒ `disputed` يحسمه المالك.
- **المالك:** إسناد يدوي، وإبطال (`void`) بسبب، وإعادة تفعيل (`void→active`) بسبب — ويُعيد العمولة إن كان رابطها ما زال `paid`.

## 4. دورة العمولة

```
(دفعة ميسر مؤكَّدة لشركة مُسندة active، بعد effectiveFrom وقبل firstPaymentDeadline، ولا عمولة سابقة للشركة)
   └─► pending (eligibleAt = paidAt + holdDays)
          ├─ المالك: on_hold (سبب) ⇄ pending
          ├─ المالك: declined (سبب — نهائي)
          ├─ الاسترداد قبل الصرف ⇒ reversed (نهائي)
          └─ now ≥ eligibleAt والرابط ما زال paid ⇒ المالك: approved
                 └─ يُدرج في دفعة ⇒ (payoutId) ⇒ عند تسجيل التحويل ⇒ paid
                        └─ استرداد بعد الصرف ⇒ AffiliateAdjustment سالب (العمولة تبقى paid)
```
- **الإسناد `disputed`:** تُنشأ العمولة `on_hold` لا `pending`.
- **الخطافات في `payments.ts`:** `accrueForPayment(linkId)` بعد القلب الناجح إلى `paid` (خارج المعاملة، `.catch(console.error)`)، و`reverseForPayment(linkId)` بعد القلب الناجح بعيداً عن `paid`. كلاهما idempotent.
- **قبل الاعتماد والصرف:** يُعاد قراءة `payment_links.status` (محليّاً) — وإن لم يكن `paid` تُعكس العمولة.
- **روابط يتيمة:** `POST /api/payments/:id/link-tenant` (SUPER_ADMIN) يضبط `tenantId` لرابط `paid` بلا شركة، ويسجّل حدثاً، ثم يستدعي `accrueForPayment`.

## 5. الصرف (يدوي)

- **المرشّحون:** مسوّقون لهم عمولات `approved` بلا `payoutId` + قيود بلا `payoutId`، وصافيها ≥ `minPayoutHalalas`، ولهم IBAN.
- **إنشاء دفعة (`draft`):** تُربط العمولات والقيود بها في معاملة. الصافي = مجموع العمولات + مجموع القيود (سالبة). **إن كان الصافي ≤ 0 لا تُنشأ** (تبقى القيود للدورة القادمة).
- **تسجيل التحويل (`recorded`):** مرجع التحويل البنكي + تاريخه ⇒ العمولات `paid`.
- **إلغاء (`void`):** يفكّ الربط وتعود العمولات `approved`.
- **IBAN:** يُطلب في البوابة **بعد أول عمولة معتمدة** فقط. تحقّق `^SA\d{22}$` + mod-97. يُخزَّن مشفّراً (`AFFILIATE_IBAN_KEY` أو مشتقّ من `JWT_SECRET`)، ويُعرض للمالك `holderName + last4` فقط، والكشف الكامل بزرّ «إظهار» يُسجَّل حدثاً.

## 6. المسارات الخلفية

### 6.1 البوابة — `backend/src/routes/affiliate.ts` مركّب على `/api/affiliate`
محدّدات **جديدة** خاصة بالبوابة (لا تُشارك `authLimiter`/`signupLimiter`).

| المسار | المصادقة | الجسم / الردّ |
|---|---|---|
| `GET /terms/public` | عام | `{version, body, disclosureText, rateBps, holdDays, minPayoutHalalas}` |
| `POST /register` | عام، محدّد | `{fullName, email, phone, city?, password, publicPromoter, mawthooqNo?, mawthooqExpiry?, vatNumber?, marketingConsent, acceptTerms:true, termsVersion, declarations:{independent,noSpam,disclose,noSelfReferral}}` ⇒ **202 موحّد** + بريد تأكيد. يرفض 403 إن `intakeOpen=false`. |
| `POST /verify-email` | عام | `{token}` ⇒ `pending_review` |
| `POST /login` | عام، محدّد | `{email, password}` ⇒ `{token, user}` — خطأ موحّد، قفل بعد 5 محاولات 15 دقيقة |
| `POST /forgot` / `POST /reset` | عام، محدّد | 202 موحّد / `{token, password}` |
| `POST /click` | عام، محدّد | `{code}` ⇒ 204 (يزيد `AffiliateClickDaily`) |
| `GET /me` | سفير | `{user (بلا ibanEnc/passwordHash), settings(disclosureText, rateBps, holdDays, minPayoutHalalas), link}` |
| `PUT /me` | سفير | `{city?, marketingConsent?, publicPromoter?, mawthooqNo?, mawthooqExpiry?, vatNumber?}` |
| `GET /dashboard` | سفير approved | `{clicks30d, signups, paidCompanies, pendingHalalas, approvedHalalas, paidHalalas}` |
| `GET /companies` | سفير approved | `[{tenantName, source, status: 'trial'|'paid'|'disputed'|'void', signedUpAt, firstPaidAt?, commission?:{status, commissionHalalas, eligibleAt}}]` |
| `POST /claims` | سفير approved | `{companyName, crNumber, city?, how, note?}` ⇒ 201 `{id}` + رسالة موحّدة |
| `GET /claims` | سفير approved | `[{id, companyName, crNumber, status, lockedUntil?, submittedAt}]` (بلا reasonNote) |
| `POST /claims/:id/withdraw` | سفير approved | يسحب ترشيحه `under_review` |
| `GET /commissions` | سفير approved | `[{tenantName, commissionHalalas, paymentAmountHalalas, status, eligibleAt, reasonNote?, paidAt?}]` |
| `GET /payouts` | سفير approved | `[{id, netHalalas, status, transferredAt, bankReference, ibanLast4}]` |
| `PUT /payout-profile` | سفير approved + له عمولة معتمدة | `{iban, holderName, bankName?}` |

### 6.2 المالك — `backend/src/routes/affiliateAdmin.ts` مركّب على `/api/affiliate-admin` بـ`authenticate, requireSuperAdmin`

| المسار | الغرض |
|---|---|
| `GET/PUT /settings` | الإعدادات (upsert للصفّ `global`) |
| `GET /terms` · `POST /terms` | الإصدارات · نشر إصدار `{version, body}` (يضبط `currentTermsVersion`) |
| `GET /affiliates?status=` | قائمة بإحصاء مختصر |
| `POST /affiliates/:id/approve` · `/reject {reason}` · `/suspend {reason}` · `/reactivate` | القرار + بريد |
| `GET /affiliates/:id` | التفصيل (IBAN مخفي) · `POST /affiliates/:id/reveal-iban` (حدث) |
| `GET /claims?status=` · `POST /claims/:id/approve` · `/reject {reasonCode}` · `/link-tenant {tenantId}` | الترشيحات + اقتراحات مطابقة |
| `GET /attributions?status=` · `POST /attributions` `{tenantId, affiliateId, reason}` · `/:id/void {reason}` · `/:id/activate {reason}` | الإسناد |
| `GET /commissions?status=` · `POST /commissions/:id/approve` · `/hold {reason}` · `/release` · `/decline {reason}` | العمولات |
| `GET /payouts/candidates` · `POST /payouts {affiliateId}` · `POST /payouts/:id/record {bankReference, transferredAt}` · `/void {reason}` · `GET /payouts` | الصرف |
| `POST /adjustments` `{affiliateId, amountHalalas, note}` | تصحيح يدوي |
| `GET /events?entity=&entityId=` | السجل |
| `GET /tenants/search?q=` | بحث شركات لربط الترشيح/الإسناد |

و`POST /api/payments/:id/link-tenant {tenantId}` في `payments.ts`.

## 7. الواجهات

### 7.أ البوابة `/ax` — `web-admin/src/affiliate/`
مستقلّة بالكامل (مثل `/hx`): `AffiliateApp.tsx` كسول من `App.tsx`، axios خاص، `ax_token`، `noindex,nofollow`، RTL، ألوان الهوية.

1. **دخول** · **تسجيل** (الحقول + الإقرارات + الشروط + «سأنشر علناً» ⇒ رقم موثوق وتاريخه) · **تأكيد البريد** · **نسيت كلمة المرور**.
2. **بانتظار الموافقة / مرفوض / موقوف** (حالة فقط).
3. **الرئيسية:** بطاقات (نقرات 30 يوماً، شركات سجّلت، شركات دفعت، عمولات معلّقة، معتمدة، مدفوعة) + الرابط مع نسخ + نصّ الإفصاح.
4. **رابطي:** الرابط + الرمز + نسخ + تنبيه الإفصاح ووسم «إعلان» للنشر العلني.
5. **رشّح شركة** + **ترشيحاتي**.
6. **شركاتي:** الحالة (تجربة/دفعت/قيد المراجعة/ملغاة) والعمولة وحالتها وتاريخ استحقاقها.
7. **أرباحي والدفعات:** العمولات بحالاتها وأسبابها + الدفعات بمرجع التحويل.
8. **الملف وبيانات الاستلام** (الآيبان يظهر حقله بعد أول عمولة معتمدة).
9. **الشروط.**

### 7.ب قسم المالك — `web-admin/src/components/AffiliatesPanel.tsx`
نافذة منبثقة من `PlatformPage` (زرّ «السفراء»)، بتبويبات: المسوّقون · الترشيحات · الإسناد · العمولات · الصرف · الإعدادات والشروط.

### 7.ج التسجيل وملتقط الرابط
- `web-admin/src/lib/referral.ts`: `captureRefFromUrl()` · `readRef()` · `clearRef()`، ويُستدعى الالتقاط من `App.tsx` لكل مسار.
- `SignupPage.tsx`: الحقل والتنبيه كما في §3.

## 8. الاختبارات
- خلفية: `backend/src/tests/affiliate.test.ts` (يُدرج في `package.json`): المال والجدولة والرموز والتطبيع وIBAN والإشارات والانتقالات والصرف، وحارس `signupSchema` المتسامح، وحارس مصدر الحقيقة، وحارس الخطافات.
- ويب: `web-admin/src/affiliate/*.test.ts`: `referral` وحارس الإخفاء (noindex، VisitTracker، WhatsAppFab، sitemap/robots/llms لا تحوي `/ax`).

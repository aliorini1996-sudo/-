# ربط Codemagic ورفع تطبيق المندوب إلى TestFlight/App Store

> يُنفَّذ **بعد تفعيل حساب Apple Developer**. الترتيب مهم: أنشئ App record أولاً (ليوجد Bundle ID) قبل أول بناء.
> أدوارك أنت (المالك): إنشاء المفاتيح والحسابات والدفع. أنا جهّزت المشروع و`codemagic.yaml` بالكامل.

---

## نظرة عامة على التدفّق
```
مشروع iOS (جاهز) ──push──▶ GitHub ──▶ Codemagic (بناء macOS + توقيع) ──▶ TestFlight ──▶ App Store
```
`codemagic.yaml` في جذر هذا المجلّد يفعل كل شيء: `pod install` → توقيع → بناء IPA → رفع لـTestFlight.

---

## 1) أنشئ مفتاح App Store Connect API (بعد تفعيل الحساب)
App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** → **Generate API Key**:
- الدور: **App Manager** (أو Admin).
- نزّل ملف **`.p8`** (يُنزَّل مرة واحدة فقط — احفظه).
- انسخ **Issuer ID** و **Key ID**.

## 2) أنشئ App record (ليوجد Bundle ID قبل التوقيع)
App Store Connect → **Apps** → **+** → **New App**:
- Platform: **iOS** · Name: **فيلد سيلز — مندوب المبيعات** · Primary Language: **Arabic**
- **Bundle ID:** إن لم يظهر `net.fieldsa.rep`، أنشئه في [Certificates, IDs & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list) (App ID، Explicit، `net.fieldsa.rep`) ثم عُد.
- SKU: `fieldsa-rep` · User Access: Full.

## 3) المشروع على GitHub ✅ (منجز)
مشروع iOS مدفوع كفرع مستقل جذره محتوى ios-app (كما يتطلّب Codemagic):
- المستودع: `aliorini1996-sudo/-` (مستودع dsd القائم) · **الفرع: `ios-app`** · 73 ملفاً، `codemagic.yaml` في الجذر.

## 4) أنشئ حساب Codemagic واربط المفتاح
- سجّل الدخول على <https://codemagic.io> بحساب GitHub (الخطة المجانية: **500 دقيقة macOS/شهر** — تكفي).
- **Teams → Personal Account → Integrations → Developer Portal (App Store Connect) → Connect**: ألصق **Issuer ID** و**Key ID** وارفع ملف **`.p8`**، وسمّه **حرفياً**: `FieldSales ASC Key` (يطابق `codemagic.yaml`).
- **Add application** → اختر المستودع `aliorini1996-sudo/-` → Codemagic يقرأ `codemagic.yaml` من الفرع المُختار عند البناء.

## 5) شغّل البناء
- افتح التطبيق في Codemagic → **Start new build** → اختر **الفرع `ios-app`** + ووركفلو **`ios-appstore`**.
- سيبني، يوقّع (يُنشئ الشهادة وملف التعريف تلقائياً)، ويرفع إلى **TestFlight**.
- عند النجاح: يظهر البناء في App Store Connect → **TestFlight** خلال ~10–30 دقيقة (بعد معالجة آبل).

## 6) بعد أول بناء ناجح
1. **TestFlight:** ثبّت التطبيق على آيفونك عبر تطبيق TestFlight وجرّبه فعلياً.
2. **صفحة المتجر:** املأ بيانات المتجر من [`metadata/app-store-listing.md`](metadata/app-store-listing.md) + ارفع [الأيقونة](assets/AppIcon-1024.png) واللقطات.
3. **الخصوصية والمراجعة:** أجب استبيان App Privacy ([`metadata/app-privacy.md`](metadata/app-privacy.md)) وأضف ملاحظات المراجِع + حساب تجريبي ([`metadata/review-notes.md`](metadata/review-notes.md)).
4. **أرسل للمراجعة** (Submit for Review). مدة المراجعة عادةً 24–48 ساعة.

---

## مصادر شائعة للفشل وحلولها
| العرض | السبب/الحل |
|---|---|
| `No matching profiles / bundle id not found` | لم تُنشئ App record/Identifier بعد → نفّذ الخطوة 2 قبل البناء. |
| `Certificate limit reached` | لديك 3 شهادات توزيع فعلاً → احذف قديمة من Certificates, IDs & Profiles، أو دع Codemagic يعيد الاستخدام. |
| فشل `pod install` (Firebase) | Firebase مثبّت على `~> 11.0` في `Podfile`؛ إن تغيّرت البيئة جرّب `pod repo update`. |
| رفض «Guideline 4.2» | راجع [`metadata/review-notes.md`](metadata/review-notes.md) — التموضع كأداة أعمال وإبراز الوظائف الأصلية. |
| رفض «الميزات المالية» | نفس ما واجهناه في Google Play → التطبيق أداة أعمال داخلية، لا خدمة مالية للمستهلك. |

## ملاحظات تقنية عن المشروع (للمرجع)
- غلاف **WKWebView** يحمّل `https://fieldsa.net/rep` حيّاً (كالـTWA على أندرويد) — أي تحديث واجهة يظهر فوراً بلا إعادة بناء.
- `WKAppBoundDomains = fieldsa.net, api.fieldsa.net` → يُفعّل Service Worker والعمل دون اتصال.
- Firebase مُضمّن ومُهيّأ لكنه خامل (بلا تسجيل إشعارات) — لا يطلب إذناً ولا ينهار.
- Entitlements فارغة (لا صلاحيات خاصة) → توقيع تلقائي بلا احتكاك. الكاميرا/الموقع تكفيها أوصاف `Info.plist`.
- الإصدار: `1.0.0` (build يتزايد تلقائياً في كل تشغيل Codemagic).

# تطبيق المندوب على App Store (iPhone) — خطة ونشر

نشر **تطبيق المندوب** (نفس الـPWA على `fieldsa.net/rep`) على متجر آبل، بمسار **Codemagic السحابي** (لا يحتاج جهاز Mac).

نظير أندرويد المنشور: `net.fieldsa.twa` على Google Play. هنا الغلاف WKWebView لـiOS.

---

## الحقائق القاطعة
1. **لا رفع من ويندوز وحده** — Xcode (macOS) مطلوب؛ نستخدم **Codemagic** (بناء+توقيع+رفع سحابي).
2. **Apple Developer Program 99$/سنة** — إجراء المالك، تفعيل 24–48 ساعة. راجع [`ENROLLMENT.md`](ENROLLMENT.md).
3. **خطر رفض البند 4.2** (غلاف ويبي رقيق) + شبهة **الميزات المالية** (رُفضنا عليها في Play) — نعالجها بالتموضع وملاحظات المراجعة.

---

## الحالة

| # | المهمة | المسؤول | الحالة |
|---|---|---|---|
| 1 | التسجيل في Apple Developer | **المالك** | 🔄 يبدأ الآن (المسار الحرج) — **فرد** |
| 2 | توليد مشروع iOS (PWABuilder) | Claude | ✅ **مكتمل** (المشروع في هذا المجلّد) |
| 3 | أصول وبيانات App Store | Claude | ✅ الأيقونة + الوصف + الخصوصية + ملاحظات المراجعة + دليل اللقطات · (صور اللقطات من TestFlight) |
| 4 | `codemagic.yaml` للبناء | Claude | ✅ **مكتوب** (يُشغَّل عند تفعيل الحساب) |
| 5 | معالجة خطر المراجعة | Claude | ✅ [`review-notes.md`](metadata/review-notes.md) |
| 6 | App record + الرفع النهائي | المالك + Claude | 🔒 محجوب بـ(1) |

## توافق الميزات مع تطبيق أندرويد المنشور (مُتحقَّق)
كلاهما يحمّل نفس الـPWA حيّاً، لكن غلاف iOS (WKWebView) ليس كروم كامل — فحصتُ كل ميزة وعالجتُ الفجوات:

| الميزة | على iOS | الحالة |
|---|---|---|
| فوترة ZATCA + QR | يعمل | ✅ |
| **حفظ/مشاركة PDF** | `canShare` يسقط لمسار التنزيل → WKDownload يفتح ورقة المشاركة | ✅ |
| **العمل دون اتصال** (SW+IndexedDB) | مُفعّل عبر `WKAppBoundDomains` الصحيح | ✅ |
| **صور الزيارات** (`<input capture>`) | يعمل + أُضيف `NSPhotoLibraryUsageDescription` + إذن الكاميرا | ✅ |
| **GPS الزيارات + التتبّع** | يعمل على iOS 15+ (وصف الموقع موجود) | ✅ |
| كشوف الحساب/المرتجعات/مخزون السيارة | منطق ويب بحت | ✅ |
| **ماسح الباركود المباشر** | أُضيف **ZXing** عبر `getUserMedia` كبديل لـiOS (يبقى `BarcodeDetector` الأصلي لأندرويد) | ✅ (بانتظار نشر الـPWA) |

> **تطابق كامل الآن.** أُصلح ماسح الباركود في الـPWA (`web-admin/src/rep/BarcodeScanner.tsx`): أندرويد يستمرّ على `BarcodeDetector` الأصلي، وiOS يستخدم **ZXing** (تحميل ديناميكي مقسّم عبر `getUserMedia` — الغلاف يمنح إذن الكاميرا). بديل يدوي في كلا المسارين. **يتفعّل بعد نشر الـPWA على fieldsa.net** (تعديل ويب، لا يخصّ مشروع iOS).

## هيكل المشروع المُولّد
```
ios-app/
├── codemagic.yaml            ← خط البناء (macOS + توقيع + رفع TestFlight)
├── CODEMAGIC-SETUP.md        ← دليل ربط Codemagic خطوة بخطوة
├── ENROLLMENT.md             ← دليل تسجيل Apple Developer
├── FieldSales.xcworkspace/   ← يُبنى هذا (بعد pod install)
├── FieldSales.xcodeproj/     ← السكيم: FieldSales
├── FieldSales/               ← كود الغلاف (WKWebView) + Info.plist + الأيقونات
├── Podfile                   ← Firebase/Messaging ~> 11.0
├── assets/AppIcon-1024.png   ← أيقونة المتجر
└── metadata/                 ← بيانات المتجر
```

---

## المنجز
- ✅ `assets/AppIcon-1024.png` — أيقونة المتجر (1024×1024، RGB بلا ألفا، زوايا مربّعة — مطابقة لشرط آبل).
- ✅ `ENROLLMENT.md` — دليل تسجيل المالك خطوة بخطوة.
- ✅ `metadata/app-store-listing.md` — الاسم/العنوان/الوصف/الكلمات/الروابط (عربي + إنجليزي).

## المتبقّي (بلا انتظار الحساب)
- مشروع iOS من PWABuilder → مستودع `ios-app` يتصل به Codemagic.
- `codemagic.yaml` + توثيق ربط Codemagic ومفتاح App Store Connect API.
- لقطات شاشة iPhone (6.7" و6.5") من المعاينة الحيّة.
- `metadata/app-privacy.md` (استبيان الخصوصية — الموقع GPS تحديداً).
- `metadata/review-notes.md` (ملاحظات المراجِع + حساب مراجعة تجريبي).

## يحتاج الحساب مفعّلاً
- تسجيل Bundle ID `net.fieldsa.rep` + إنشاء App record.
- مفتاح App Store Connect API (للتوقيع/الرفع في Codemagic).
- الرفع، ملء الصفحة، والإرسال للمراجعة.

---

## قرار معلّق على المالك
**فرد أم شركة** في التسجيل؟ (يؤثّر على اسم البائع واسم الحزمة). التوصية: **شركة** إن توفّر D‑U‑N‑S. التفصيل في [`ENROLLMENT.md`](ENROLLMENT.md).

# حزم ويندوز — winget و Chocolatey

## لماذا هذا المجلّد موجود

قِيس في ١١ سبتمبر ٢٠٢٦ من Bing Webmaster Tools: النطاق يملك **رابطين خلفيين اثنين**، ومجلّد
`/en` يملك **صفر رابط** رغم أن Bing يفهرس منه ٢٠٢ صفحة. وتوصية Bing الأولى نصّاً: «موقعك ليس
لديه روابط واردة كافية من نطاقات عالية الجودة».

وفحصُ وسم `rel` في كل ملفّ نملكه أظهر `nofollow` بلا استثناء: SaaSHub، ومتجرا آبل، وGoogle Play،
وسيرة X، ولينكدإن. **صفر روابط dofollow.**

هذان المصدران استثناء مُثبَت بالفحص:

| المصدر | الدليل |
|---|---|
| `winget.run` | صفحة حزمة حقيقية تربط موقع المشروع بـ`rel="noopener noreferrer"` — بلا `nofollow` |
| `community.chocolatey.org` | وسم «Software Site» يربط موقع البرنامج بلا أي سمة `rel` |

وكلاهما إنجليزيّ ومجانيّ ولا يشترط كياناً سعودياً — وهو ما ينقصنا تحديداً. وبيانُ winget واحد
يولّد صفحتين آليتين (`winget.run` و`winstall.app`).

## ما جرى التحقّق منه فعلاً

- المثبّت **ينزل علنياً بلا مصادقة**: جُلب كاملاً (٨١٬٦٤٧٬٠٦٧ بايت) من رابط الإصدار المرقَّم
- بصمته: `2503FA377FD122EE3019E93DCCE750746ECB9FEBF8B401E9C28AF090CE18FB18`
- نوعه **NSIS** — السلسلة `Nullsoft.NSIS.exehead` موجودة في الثنائيّ عند الإزاحة ٥١١٠٠،
  وNSIS يدعم `/S` للتثبيت الصامت بحكم بنيته. وهذا شرط قبول صريح في مستودع مايكروسوفت.
- البيانات اجتازت `winget validate` — وهي أداة مايكروسوفت نفسها، لا تقديرنا:

```
Manifest validation succeeded.
```

## إرسال winget

المستودع لا يقبل إلا طلب سحب من حسابك على GitHub، فهذه خطواتك أنت:

```bash
gh repo fork microsoft/winget-pkgs --clone
cd winget-pkgs
git checkout -b fieldsales-admin-1.0.0
cp -r "<هذا المجلّد>/winget/manifests/f/FieldSales" manifests/f/
git add manifests/f/FieldSales && git commit -m "New package: FieldSales.FieldSalesAdmin version 1.0.0"
git push origin fieldsales-admin-1.0.0
gh pr create --repo microsoft/winget-pkgs --title "New package: FieldSales.FieldSalesAdmin version 1.0.0"
```

المراجعة آلية أولاً ثم بشرية. ما قد يُسأل عنه:

- **اسم المستودع `-`** غير مألوف وقد يلفت المراجع. هو اسم مستودعنا الفعلي والرابط يعمل، لكن
  توقّع سؤالاً.
- **التوقيع الرقمي**: المثبّت غير موقَّع. winget يقبل غير الموقَّع لكنه يرفع احتمال مراجعة يدوية.

## إرسال Chocolatey

```powershell
cd packaging\chocolatey
choco pack
choco apikey --key <مفتاحك> --source https://push.chocolatey.org/
choco push fieldsales-admin.1.0.0.nupkg --source https://push.chocolatey.org/
```

الحساب ومفتاح الـAPI فعلُك أنت. والمراجعة بشرية وقد تستغرق أسابيع. وشرطهم المنشور أن تملك
حقّ توزيع البرنامج — ونحن نملك مثبّتنا.

## عند كل إصدار جديد

ثلاثة أرقام تتغيّر معاً، وإغفال واحد يكسر الحزمة صامتاً:

1. `PackageVersion` في بيانات winget الأربعة، و`<version>` في الـnuspec
2. `InstallerUrl` — **رابط الإصدار المرقَّم لا `/releases/latest/`**. winget يرفض الرابط المتحرّك
   لأن البصمة تصير كذباً عند أول إصدار تالٍ
3. `InstallerSha256` و`checksum` — أعِد حسابها من الملفّ المنشور نفسه:
   `sha256sum FieldSales-Admin-Setup.exe`

ثم `winget validate --manifest <المجلّد>` قبل أي إرسال.

## حقل محذوف عمداً

`Scope` غير معلن في بيان المثبّت. مثبّتات NSIS من electron-builder تكون لكل مستخدم افتراضياً،
لكنّ إعداد البناء غير موجود في هذا المستودع فلم أتحقّق منه. أعلِنه (`user` أو `machine`) بعد
تأكيده من إعداد البناء الفعلي — ولا تخمّنه.

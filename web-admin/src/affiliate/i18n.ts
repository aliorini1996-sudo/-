// ============================================================================
// قاموس بوابة «سفير فيلد سيلز» بخمس لغات (ar · en · fr · tr · zh).
//
// · النوع `Record<AxKey, Record<Lang, string>>` يجعل أي مفتاحٍ ينقصه لغةٌ خطأَ تصريف،
//   واختبار i18n.test.ts يرفض القيمة الفارغة والفاصلة العليا اللاتينية في الفرنسية.
// · العربية منسوخة حرفياً من الواجهة كما كانت — لا تُعاد صياغتها هنا.
// · المتغيّرات بصيغة {name} وتُملأ بـ`translate` أو بـ`rich` لعُقد React.
// · نصوص الخادم (أسباب الرفض، ملاحظات العمولة، الشروط، الإفصاح) عربية وتُعرض كما هي.
// ============================================================================
import { Fragment, createElement, useMemo, type ReactNode } from 'react';
import { useLang, type Lang } from '../i18n/lang';

export const AX_LANGS: readonly Lang[] = ['ar', 'en', 'fr', 'tr', 'zh'];

type Entry = Record<Lang, string>;

const DICT = {
  // ─── عام ───
  'app.title': { ar: 'سفير فيلد سيلز', en: 'Field Sales Ambassador', fr: 'Ambassadeur Field Sales', tr: 'Field Sales Elçisi', zh: 'Field Sales 推荐大使' },
  'common.loading': { ar: 'جارٍ التحميل…', en: 'Loading…', fr: 'Chargement…', tr: 'Yükleniyor…', zh: '加载中…' },
  'common.retry': { ar: 'إعادة المحاولة', en: 'Try again', fr: 'Réessayer', tr: 'Tekrar dene', zh: '重试' },
  'common.login': { ar: 'تسجيل الدخول', en: 'Sign in', fr: 'Se connecter', tr: 'Giriş yap', zh: '登录' },
  'common.logout': { ar: 'تسجيل الخروج', en: 'Sign out', fr: 'Se déconnecter', tr: 'Çıkış yap', zh: '退出登录' },
  'common.logoutShort': { ar: 'خروج', en: 'Sign out', fr: 'Déconnexion', tr: 'Çıkış', zh: '退出' },
  'common.cancel': { ar: 'إلغاء', en: 'Cancel', fr: 'Annuler', tr: 'İptal', zh: '取消' },
  'common.backToLogin': { ar: 'العودة لتسجيل الدخول', en: 'Back to sign in', fr: 'Retour à la connexion', tr: 'Girişe dön', zh: '返回登录' },
  'nav.sections': { ar: 'أقسام البوابة', en: 'Portal sections', fr: 'Sections du portail', tr: 'Portal bölümleri', zh: '门户栏目' },
  'session.expired': { ar: 'انتهت الجلسة — سجّل الدخول من جديد', en: 'Your session has expired — please sign in again', fr: 'Votre session a expiré — reconnectez-vous', tr: 'Oturumunuzun süresi doldu — lütfen tekrar giriş yapın', zh: '会话已过期，请重新登录' },
  'me.loadFailed': { ar: 'تعذّر تحميل حسابك', en: 'We couldn’t load your account', fr: 'Impossible de charger votre compte', tr: 'Hesabınız yüklenemedi', zh: '无法加载您的账户' },

  // ─── التبويبات ───
  'tab.home': { ar: 'الرئيسية', en: 'Home', fr: 'Accueil', tr: 'Ana sayfa', zh: '首页' },
  'tab.link': { ar: 'رابطي', en: 'My link', fr: 'Mon lien', tr: 'Bağlantım', zh: '我的链接' },
  'tab.claims': { ar: 'رشّح شركة', en: 'Nominate a company', fr: 'Recommander une entreprise', tr: 'Şirket öner', zh: '推荐企业' },
  'tab.companies': { ar: 'شركاتي', en: 'My companies', fr: 'Mes entreprises', tr: 'Şirketlerim', zh: '我的企业' },
  'tab.earnings': { ar: 'أرباحي', en: 'My earnings', fr: 'Mes gains', tr: 'Kazançlarım', zh: '我的收益' },
  'tab.profile': { ar: 'الملف', en: 'Profile', fr: 'Profil', tr: 'Profil', zh: '个人资料' },
  'tab.terms': { ar: 'الشروط', en: 'Terms', fr: 'Conditions', tr: 'Şartlar', zh: '条款' },

  // ─── الأخطاء والرسائل المعروفة ───
  'err.generic': { ar: 'حدث خطأ غير متوقع', en: 'Something went wrong', fr: 'Une erreur inattendue s’est produite', tr: 'Beklenmeyen bir hata oluştu', zh: '发生意外错误' },
  'err.loadData': { ar: 'تعذّر تحميل البيانات', en: 'We couldn’t load this data', fr: 'Impossible de charger les données', tr: 'Veriler yüklenemedi', zh: '无法加载数据' },
  'err.tooMany': { ar: 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة', en: 'Too many attempts — please wait a moment and try again', fr: 'Trop de tentatives — patientez un instant puis réessayez', tr: 'Çok fazla deneme — lütfen biraz bekleyip tekrar deneyin', zh: '尝试次数过多，请稍候再试' },
  'err.tooManyOpenClaims': { ar: 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها', en: 'You have too many nominations under review — please wait for a decision on them', fr: 'Vous avez trop de recommandations en cours d’examen — attendez qu’une décision soit prise', tr: 'İncelemede çok fazla öneriniz var — lütfen bunlar hakkında karar verilmesini bekleyin', zh: '您待审核的推荐过多，请等待审核结果后再提交' },
  'err.network': { ar: 'تعذّر الاتصال بالخادم — تحقق من الإنترنت', en: 'Can’t reach the server — check your internet connection', fr: 'Connexion au serveur impossible — vérifiez votre accès Internet', tr: 'Sunucuya bağlanılamadı — internet bağlantınızı kontrol edin', zh: '无法连接服务器，请检查网络连接' },
  'err.termsOutdated': { ar: 'نُشرت شروطٌ جديدة — اقرأها واقبلها للمتابعة', en: 'New program terms have been published — please review and accept them to continue', fr: 'De nouvelles conditions ont été publiées — lisez-les et acceptez-les pour continuer', tr: 'Yeni program şartları yayımlandı — devam etmek için okuyup kabul edin', zh: '已发布新的计划条款，请阅读并接受后继续' },
  'accepted.register': { ar: 'إن كانت البيانات صحيحة فستصلك رسالة تأكيد على بريدك', en: 'If your details are correct, you’ll receive a confirmation email shortly', fr: 'Si vos informations sont correctes, vous recevrez un e-mail de confirmation', tr: 'Bilgileriniz doğruysa e-posta adresinize bir onay mesajı gönderilecek', zh: '如信息无误，您将收到一封确认邮件' },
  'accepted.resend': { ar: 'إن كان البريد مسجّلاً وغير مؤكَّد فستصلك رسالة تأكيد جديدة', en: 'If this email is registered and not yet confirmed, a new confirmation email is on its way', fr: 'Si cette adresse est associée à un compte non encore confirmé, un nouvel e-mail de confirmation vous sera envoyé', tr: 'Bu e-posta kayıtlıysa ve henüz onaylanmadıysa yeni bir onay mesajı gönderilecek', zh: '如该邮箱已注册但尚未确认，我们将发送新的确认邮件' },
  'accepted.forgot': { ar: 'إن كان البريد مسجّلاً فستصلك رسالة لاستعادة كلمة المرور', en: 'If this email is registered, you’ll receive a link to reset your password', fr: 'Si cette adresse est associée à un compte, vous recevrez un lien pour réinitialiser votre mot de passe', tr: 'Bu e-posta kayıtlıysa şifre sıfırlama bağlantısı gönderilecek', zh: '如该邮箱已注册，您将收到重置密码的链接' },

  // ─── الحقول المشتركة ───
  'f.email': { ar: 'البريد الإلكتروني', en: 'Email', fr: 'E-mail', tr: 'E-posta', zh: '电子邮箱' },
  'f.password': { ar: 'كلمة المرور', en: 'Password', fr: 'Mot de passe', tr: 'Şifre', zh: '密码' },
  'f.passwordHint': { ar: '8 أحرف على الأقل', en: 'At least 8 characters', fr: '8 caractères minimum', tr: 'En az 8 karakter', zh: '至少 8 个字符' },
  'f.fullName': { ar: 'الاسم الكامل', en: 'Full name', fr: 'Nom complet', tr: 'Ad soyad', zh: '姓名' },
  'f.phone': { ar: 'رقم الجوال', en: 'Mobile number', fr: 'Numéro de mobile', tr: 'Cep telefonu', zh: '手机号码' },
  'f.phoneHint': { ar: 'اختر مفتاح الدولة ثم أدخل رقم الجوال', en: 'Choose the country code, then enter the mobile number', fr: 'Choisissez l’indicatif du pays, puis saisissez le numéro de mobile', tr: 'Ülke kodunu seçin, ardından cep numarasını girin', zh: '选择国家代码，然后输入手机号码' },
  'f.phoneCountry': { ar: 'مفتاح الدولة', en: 'Country code', fr: 'Indicatif du pays', tr: 'Ülke kodu', zh: '国家代码' },
  'f.arabCountries': { ar: 'الدول العربية', en: 'Arab countries', fr: 'Pays arabes', tr: 'Arap ülkeleri', zh: '阿拉伯国家' },
  'f.otherCountries': { ar: 'دول أخرى', en: 'Other countries', fr: 'Autres pays', tr: 'Diğer ülkeler', zh: '其他国家' },
  'f.city': { ar: 'المدينة', en: 'City', fr: 'Ville', tr: 'Şehir', zh: '城市' },
  'f.vat': { ar: 'الرقم الضريبي', en: 'VAT number', fr: 'Numéro de TVA', tr: 'KDV numarası', zh: '增值税号' },
  'f.vatOptional': { ar: 'الرقم الضريبي (اختياري)', en: 'VAT number (optional)', fr: 'Numéro de TVA (facultatif)', tr: 'KDV numarası (isteğe bağlı)', zh: '增值税号（选填）' },
  'f.vatHint': { ar: 'إن كنت مسجّلاً في ضريبة القيمة المضافة — 15 رقماً', en: 'If you’re VAT-registered — 15 digits', fr: 'Si vous êtes assujetti à la TVA — 15 chiffres', tr: 'KDV mükellefiyseniz — 15 hane', zh: '如已进行增值税登记，请填写 15 位数字' },

  // ─── الدخول ───
  'login.title': { ar: 'دخول السفراء', en: 'Ambassador sign-in', fr: 'Connexion ambassadeurs', tr: 'Elçi girişi', zh: '推荐大使登录' },
  'login.subtitle': { ar: 'تابع رابطك وترشيحاتك وعمولاتك', en: 'Track your link, nominations and commissions', fr: 'Suivez votre lien, vos recommandations et vos commissions', tr: 'Bağlantınızı, önerilerinizi ve komisyonlarınızı takip edin', zh: '随时查看您的推荐链接、推荐记录与佣金' },
  'login.submit': { ar: 'دخول', en: 'Sign in', fr: 'Se connecter', tr: 'Giriş yap', zh: '登录' },
  'login.fillBoth': { ar: 'أدخل البريد وكلمة المرور', en: 'Enter your email and password', fr: 'Saisissez votre e-mail et votre mot de passe', tr: 'E-posta ve şifrenizi girin', zh: '请输入邮箱和密码' },
  'login.failed': { ar: 'تعذّر تسجيل الدخول', en: 'Sign-in failed', fr: 'Connexion impossible', tr: 'Giriş yapılamadı', zh: '登录失败' },
  'login.invalid': { ar: 'تعذّر الدخول — تحقّق من البريد وكلمة المرور. إن سجّلت حديثاً فأكّد بريدك أولاً، وبعد محاولات متكرّرة يُقفل الدخول ربع ساعة', en: 'Sign-in failed — check your email and password. If you’ve just registered, confirm your email first. After repeated attempts, sign-in is locked for 15 minutes', fr: 'Connexion impossible — vérifiez votre e-mail et votre mot de passe. Si vous venez de vous inscrire, confirmez d’abord votre adresse. Après plusieurs tentatives, la connexion est bloquée 15 minutes', tr: 'Giriş yapılamadı — e-posta ve şifrenizi kontrol edin. Yeni kayıt olduysanız önce e-postanızı onaylayın. Tekrarlanan denemelerden sonra giriş 15 dakika kilitlenir', zh: '登录失败：请检查邮箱和密码。如刚完成注册，请先确认邮箱。多次尝试失败后，登录将锁定 15 分钟' },
  'login.forgot': { ar: 'نسيت كلمة المرور؟', en: 'Forgot your password?', fr: 'Mot de passe oublié ?', tr: 'Şifrenizi mi unuttunuz?', zh: '忘记密码？' },
  'login.noVerifyMail': { ar: 'لم تصلك رسالة التأكيد؟', en: 'Didn’t get the confirmation email?', fr: 'Vous n’avez pas reçu l’e-mail de confirmation ?', tr: 'Onay e-postası gelmedi mi?', zh: '没有收到确认邮件？' },
  'login.notAmbassador': { ar: 'لست سفيراً بعد؟', en: 'Not an ambassador yet?', fr: 'Pas encore ambassadeur ?', tr: 'Henüz elçi değil misiniz?', zh: '还不是推荐大使？' },
  'login.apply': { ar: 'قدّم طلب انضمام', en: 'Apply to join', fr: 'Déposer une candidature', tr: 'Katılım başvurusu yapın', zh: '申请加入' },

  // ─── التسجيل ───
  'reg.title': { ar: 'انضم إلى سفراء فيلد سيلز', en: 'Become a Field Sales Ambassador', fr: 'Devenez ambassadeur Field Sales', tr: 'Field Sales elçisi olun', zh: '成为 Field Sales 推荐大使' },
  'reg.subtitle': { ar: 'عمولتك {rate} من مبلغ الدفعة الأولى المؤكَّدة (شاملة الضريبة) لكل منشأة تشترك عبرك، تُعتمد بعد {days} يوماً من الدفع، وتُحوَّل يدوياً إلى حسابك البنكي متى بلغ رصيدك {min}. كل طلب يُراجع قبل القبول.', en: 'Earn {rate} of the first confirmed payment (VAT included) from every business that subscribes through you. Commissions are approved {days} days after payment and transferred manually to your bank account once your balance reaches {min}. Every application is reviewed before approval.', fr: 'Gagnez {rate} du premier paiement confirmé (TVA incluse) de chaque entreprise qui s’abonne grâce à vous. La commission est validée {days} jours après le paiement, puis virée manuellement sur votre compte bancaire une fois que votre solde atteint {min}. Chaque candidature est examinée avant acceptation.', tr: 'Sizin aracılığınızla abone olan her işletmenin onaylanan ilk ödemesi (KDV dahil) üzerinden {rate} oranında komisyon kazanın. Komisyon, ödemeden {days} gün sonra onaylanır ve bakiyeniz {min} tutarına ulaştığında banka hesabınıza manuel olarak aktarılır. Her başvuru kabul edilmeden önce incelenir.', zh: '每家经您推荐订阅的企业，您可获得其首笔确认付款（含增值税）的 {rate} 作为佣金。佣金在付款 {days} 天后审核通过，余额达到 {min} 后人工转入您的银行账户。每份申请均须经过审核，通过后方可加入。' },
  'reg.termsChanged': { ar: 'صدر إصدار جديد من الشروط — راجعه ووافق عليه ثم أعد الإرسال', en: 'A new version of the terms was just published — review and accept it, then submit again', fr: 'Une nouvelle version des conditions vient d’être publiée — prenez-en connaissance, acceptez-la puis renvoyez le formulaire', tr: 'Şartların yeni bir sürümü yayımlandı — inceleyip kabul edin, ardından tekrar gönderin', zh: '条款已更新，请阅读并同意新版本后重新提交' },
  'reg.failed': { ar: 'تعذّر إرسال الطلب', en: 'We couldn’t submit your application', fr: 'Impossible d’envoyer votre candidature', tr: 'Başvurunuz gönderilemedi', zh: '申请提交失败' },
  'reg.doneTitle': { ar: 'تم استلام طلبك', en: 'Application received', fr: 'Candidature reçue', tr: 'Başvurunuz alındı', zh: '申请已收到' },
  'reg.doneHint': { ar: 'افتح الرابط في رسالة التأكيد وأدخل كلمة المرور التي اخترتها الآن، ثم يراجع فريقنا طلبك ويصلك القرار على بريدك.', en: 'Open the link in the confirmation email and enter the password you just chose. Our team will then review your application and email you the decision.', fr: 'Ouvrez le lien de l’e-mail de confirmation et saisissez le mot de passe que vous venez de choisir. Notre équipe examinera ensuite votre candidature et vous enverra sa décision par e-mail.', tr: 'Onay e-postasındaki bağlantıyı açın ve az önce belirlediğiniz şifreyi girin. Ardından ekibimiz başvurunuzu inceleyip kararı e-postanıza gönderecek.', zh: '请打开确认邮件中的链接，并输入您刚设置的密码。随后我们的团队将审核您的申请，并通过邮件告知结果。' },
  'reg.goLogin': { ar: 'الذهاب لتسجيل الدخول', en: 'Go to sign in', fr: 'Aller à la connexion', tr: 'Girişe git', zh: '前往登录' },
  'reg.resendCta': { ar: 'لم تصلك الرسالة؟ أعد الإرسال', en: 'No email? Send it again', fr: 'Pas d’e-mail ? Renvoyer', tr: 'E-posta gelmedi mi? Tekrar gönder', zh: '没收到邮件？重新发送' },
  'reg.closedTitle': { ar: 'الانضمام مغلق حالياً', en: 'Applications are currently closed', fr: 'Les candidatures sont actuellement fermées', tr: 'Başvurular şu anda kapalı', zh: '暂不接受新申请' },
  'reg.closedBody': { ar: 'لا نستقبل طلبات سفراء جدد في الوقت الحالي. إن كان لديك حساب فيمكنك الدخول كالمعتاد.', en: 'We’re not accepting new ambassador applications right now. If you already have an account, you can sign in as usual.', fr: 'Nous n’acceptons pas de nouvelles candidatures d’ambassadeurs pour le moment. Si vous avez déjà un compte, vous pouvez vous connecter normalement.', tr: 'Şu anda yeni elçi başvurusu kabul etmiyoruz. Hesabınız varsa her zamanki gibi giriş yapabilirsiniz.', zh: '目前暂不接受新的推荐大使申请。如已有账户，可照常登录。' },
  'reg.acceptTerms': { ar: 'قرأت شروط البرنامج وأوافق عليها', en: 'I have read and agree to the program terms', fr: 'J’ai lu et j’accepte les conditions du programme', tr: 'Program şartlarını okudum ve kabul ediyorum', zh: '我已阅读并同意计划条款' },
  'reg.marketingOptional': { ar: 'أوافق على تلقي رسائل عن البرنامج وتحديثاته (اختياري)', en: 'Send me news and updates about the program (optional)', fr: 'J’accepte de recevoir des actualités sur le programme (facultatif)', tr: 'Program ve güncellemeleri hakkında bilgilendirme mesajları almayı kabul ediyorum (isteğe bağlı)', zh: '我愿意接收有关本计划的消息与更新（选填）' },
  'reg.submit': { ar: 'إرسال طلب الانضمام', en: 'Submit application', fr: 'Envoyer ma candidature', tr: 'Başvuruyu gönder', zh: '提交申请' },
  'reg.haveAccount': { ar: 'لديك حساب؟', en: 'Already have an account?', fr: 'Vous avez déjà un compte ?', tr: 'Hesabınız var mı?', zh: '已有账户？' },
  'reg.signIn': { ar: 'سجّل الدخول', en: 'Sign in', fr: 'Connectez-vous', tr: 'Giriş yapın', zh: '登录' },

  // ─── الشروط ───
  'terms.label': { ar: 'شروط البرنامج', en: 'Program terms', fr: 'Conditions du programme', tr: 'Program şartları', zh: '计划条款' },
  'terms.arabicBinding': { ar: 'النصّ العربي هو النسخة المعتمدة.', en: 'The Arabic text is the binding version.', fr: 'Le texte arabe fait foi.', tr: 'Bağlayıcı olan metin Arapça metindir.', zh: '以阿拉伯语文本为准。' },
  'terms.summary': { ar: 'ملخّص البرنامج', en: 'Program summary', fr: 'Résumé du programme', tr: 'Program özeti', zh: '计划概要' },
  'terms.commission': { ar: 'العمولة: {rate} من مبلغ الدفعة الأولى المؤكَّدة للمنشأة (شاملة الضريبة) — مرة واحدة لكل منشأة.', en: 'Commission: {rate} of the business’s first confirmed payment (VAT included) — once per business.', fr: 'Commission : {rate} du premier paiement confirmé de l’entreprise (TVA incluse) — une seule fois par entreprise.', tr: 'Komisyon: İşletmenin onaylanan ilk ödemesi (KDV dahil) üzerinden {rate} — her işletme için yalnızca bir kez.', zh: '佣金：企业首笔确认付款（含增值税）的 {rate}，每家企业仅计一次。' },
  'terms.hold': { ar: 'فترة الحجز: {days} يوماً من تاريخ الدفع قبل الاعتماد.', en: 'Holding period: {days} days from the payment date before approval.', fr: 'Période de blocage : {days} jours à compter de la date de paiement, avant validation.', tr: 'Bekleme süresi: Onaydan önce ödeme tarihinden itibaren {days} gün.', zh: '冻结期：自付款之日起 {days} 天，期满后方可审核批准。' },
  'terms.min': { ar: 'الحد الأدنى للتحويل: {min}.', en: 'Minimum payout: {min}.', fr: 'Montant minimum de virement : {min}.', tr: 'Asgari aktarım tutarı: {min}.', zh: '最低打款金额：{min}。' },
  'terms.acceptedVersion': { ar: 'وافقت على الإصدار {version}', en: 'You accepted version {version}', fr: 'Vous avez accepté la version {version}', tr: '{version} sürümünü kabul ettiniz', zh: '您已同意版本 {version}' },
  'gate.title': { ar: 'تحديث على شروط البرنامج', en: 'Program terms update', fr: 'Mise à jour des conditions du programme', tr: 'Program şartları güncellendi', zh: '计划条款已更新' },
  'gate.subtitle': { ar: 'نشرنا إصداراً جديداً من شروط برنامج السفراء. اقرأه ووافق عليه للمتابعة.', en: 'We’ve published a new version of the ambassador program terms. Please read and accept it to continue.', fr: 'Nous avons publié une nouvelle version des conditions du programme ambassadeurs. Lisez-la et acceptez-la pour continuer.', tr: 'Elçi programı şartlarının yeni bir sürümünü yayımladık. Devam etmek için okuyup kabul edin.', zh: '我们发布了新版推荐大使计划条款，请阅读并同意后继续。' },
  'gate.newVersion': { ar: 'الإصدار الجديد', en: 'New version', fr: 'Nouvelle version', tr: 'Yeni sürüm', zh: '新版本' },
  'gate.currentVersion': { ar: 'إصدارك الحالي:', en: 'Your current version:', fr: 'Votre version actuelle :', tr: 'Mevcut sürümünüz:', zh: '您当前的版本：' },
  'gate.agree': { ar: 'قرأت الإصدار الجديد وأوافق عليه', en: 'I have read and agree to the new version', fr: 'J’ai lu et j’accepte la nouvelle version', tr: 'Yeni sürümü okudum ve kabul ediyorum', zh: '我已阅读并同意新版本' },
  'gate.submit': { ar: 'أوافق وأتابع', en: 'Agree and continue', fr: 'Accepter et continuer', tr: 'Kabul et ve devam et', zh: '同意并继续' },
  'gate.thanks': { ar: 'شكراً — تم تسجيل موافقتك', en: 'Thank you — your acceptance has been recorded', fr: 'Merci — votre acceptation a été enregistrée', tr: 'Teşekkürler — onayınız kaydedildi', zh: '谢谢！您的同意已记录' },
  'gate.newer': { ar: 'صدر إصدار أحدث من الشروط — راجعه ثم وافق', en: 'An even newer version of the terms was published — review it, then accept', fr: 'Une version plus récente des conditions a été publiée — prenez-en connaissance puis acceptez-la', tr: 'Şartların daha yeni bir sürümü yayımlandı — inceleyip kabul edin', zh: '条款又有更新版本，请阅读后再同意' },
  'gate.failed': { ar: 'تعذّر تسجيل الموافقة', en: 'We couldn’t record your acceptance', fr: 'Impossible d’enregistrer votre acceptation', tr: 'Onayınız kaydedilemedi', zh: '无法记录您的同意' },

  // ─── تأكيد البريد ───
  'verify.title': { ar: 'تأكيد البريد', en: 'Confirm your email', fr: 'Confirmer votre e-mail', tr: 'E-postanızı onaylayın', zh: '确认邮箱' },
  'verify.subtitle': { ar: 'أدخل كلمة المرور التي اخترتها عند التسجيل لتأكيد بريدك', en: 'Enter the password you chose when you registered to confirm your email', fr: 'Saisissez le mot de passe choisi lors de votre inscription pour confirmer votre adresse', tr: 'E-postanızı onaylamak için kayıt olurken belirlediğiniz şifreyi girin', zh: '请输入注册时设置的密码以确认邮箱' },
  'verify.submit': { ar: 'تأكيد البريد', en: 'Confirm email', fr: 'Confirmer l’e-mail', tr: 'E-postayı onayla', zh: '确认邮箱' },
  'verify.enterPassword': { ar: 'أدخل كلمة المرور', en: 'Enter your password', fr: 'Saisissez votre mot de passe', tr: 'Şifrenizi girin', zh: '请输入密码' },
  'verify.retry': { ar: 'تعذّر تأكيد البريد — أعد المحاولة', en: 'We couldn’t confirm your email — please try again', fr: 'Impossible de confirmer votre e-mail — réessayez', tr: 'E-postanız onaylanamadı — lütfen tekrar deneyin', zh: '邮箱确认失败，请重试' },
  'verify.mismatch': { ar: 'كلمة المرور لا تطابق طلب الانضمام', en: 'This password doesn’t match the latest application for this email. If you didn’t submit it, please apply again', fr: 'Ce mot de passe ne correspond pas à la dernière candidature associée à cette adresse. Si vous ne l’avez pas envoyée, déposez une nouvelle candidature', tr: 'Bu şifre, bu e-postayla yapılan son başvuruyla eşleşmiyor. Başvuruyu siz yapmadıysanız yeniden başvurun', zh: '该密码与此邮箱最近一次申请不匹配。如非本人提交，请重新申请' },
  'verify.invalid': { ar: 'رابط التأكيد غير صالح أو منتهٍ', en: 'This confirmation link is invalid or has expired', fr: 'Ce lien de confirmation est invalide ou a expiré', tr: 'Bu onay bağlantısı geçersiz veya süresi dolmuş', zh: '确认链接无效或已过期' },
  'verify.failedTitle': { ar: 'تعذّر تأكيد البريد', en: 'Email not confirmed', fr: 'E-mail non confirmé', tr: 'E-posta onaylanamadı', zh: '邮箱确认失败' },
  'verify.sendNew': { ar: 'أرسل رابط تأكيد جديداً', en: 'Send a new confirmation link', fr: 'Envoyer un nouveau lien de confirmation', tr: 'Yeni onay bağlantısı gönder', zh: '发送新的确认链接' },
  'verify.review.title': { ar: 'تم تأكيد بريدك', en: 'Your email is confirmed', fr: 'Votre e-mail est confirmé', tr: 'E-postanız onaylandı', zh: '邮箱已确认' },
  'verify.review.body': { ar: 'طلبك الآن قيد مراجعة فريق فيلد سيلز، وسيصلك بريد بالقرار.', en: 'Your application is now being reviewed by the Field Sales team. We’ll email you the decision.', fr: 'Votre candidature est en cours d’examen par l’équipe Field Sales. Vous recevrez la décision par e-mail.', tr: 'Başvurunuz şu anda Field Sales ekibi tarafından inceleniyor. Karar size e-postayla bildirilecek.', zh: 'Field Sales 团队正在审核您的申请，结果将通过邮件通知您。' },
  'verify.approved.title': { ar: 'بريدك مؤكَّد وحسابك مقبول', en: 'Email confirmed — your account is approved', fr: 'E-mail confirmé — votre compte est accepté', tr: 'E-posta onaylandı — hesabınız kabul edildi', zh: '邮箱已确认，账户已通过审核' },
  'verify.approved.body': { ar: 'يمكنك الآن الدخول إلى بوابة السفراء.', en: 'You can now sign in to the ambassador portal.', fr: 'Vous pouvez maintenant vous connecter au portail ambassadeurs.', tr: 'Artık elçi portalına giriş yapabilirsiniz.', zh: '现在即可登录推荐大使门户。' },
  'verify.already.title': { ar: 'بريدك مؤكَّد مسبقاً', en: 'Your email is already confirmed', fr: 'Votre e-mail est déjà confirmé', tr: 'E-postanız zaten onaylı', zh: '邮箱此前已确认' },
  'verify.already.body': { ar: 'لا حاجة لتأكيده مرّةً أخرى — ادخل لمتابعة حالة حسابك.', en: 'No need to confirm it again — sign in to check your account status.', fr: 'Inutile de le confirmer à nouveau — connectez-vous pour suivre l’état de votre compte.', tr: 'Tekrar onaylamanıza gerek yok — hesap durumunuzu görmek için giriş yapın.', zh: '无需再次确认，请登录查看账户状态。' },

  // ─── نسيت كلمة المرور · إعادة الإرسال ───
  'mail.sendFailed': { ar: 'تعذّر الإرسال', en: 'We couldn’t send the email', fr: 'Envoi impossible', tr: 'Gönderilemedi', zh: '发送失败' },
  'mail.checkSpam': { ar: 'تفقّد مجلد الرسائل غير المرغوب فيها إن لم تجدها.', en: 'Can’t find it? Check your spam folder.', fr: 'Vous ne le trouvez pas ? Vérifiez vos courriers indésirables.', tr: 'Bulamazsanız istenmeyen e-posta klasörünü kontrol edin.', zh: '如未收到，请检查垃圾邮件文件夹。' },
  'forgot.title': { ar: 'استعادة كلمة المرور', en: 'Reset your password', fr: 'Réinitialiser le mot de passe', tr: 'Şifrenizi sıfırlayın', zh: '找回密码' },
  'forgot.subtitle': { ar: 'أدخل بريدك وسنرسل لك رابطاً لتعيين كلمة مرور جديدة.', en: 'Enter your email and we’ll send you a link to set a new password.', fr: 'Saisissez votre e-mail et nous vous enverrons un lien pour définir un nouveau mot de passe.', tr: 'E-postanızı girin, yeni şifre belirlemeniz için size bir bağlantı gönderelim.', zh: '输入邮箱，我们将发送设置新密码的链接。' },
  'forgot.action': { ar: 'أرسل رابط الاستعادة', en: 'Send reset link', fr: 'Envoyer le lien', tr: 'Sıfırlama bağlantısı gönder', zh: '发送重置链接' },
  'resend.title': { ar: 'إعادة إرسال رسالة التأكيد', en: 'Resend confirmation email', fr: 'Renvoyer l’e-mail de confirmation', tr: 'Onay e-postasını tekrar gönder', zh: '重新发送确认邮件' },
  'resend.subtitle': { ar: 'أدخل البريد الذي سجّلت به وسنرسل رابط تأكيد جديداً.', en: 'Enter the email you registered with and we’ll send a new confirmation link.', fr: 'Saisissez l’adresse utilisée lors de votre inscription et nous vous enverrons un nouveau lien de confirmation.', tr: 'Kayıt olduğunuz e-postayı girin, yeni bir onay bağlantısı gönderelim.', zh: '输入注册时使用的邮箱，我们将发送新的确认链接。' },
  'resend.action': { ar: 'أعد الإرسال', en: 'Resend', fr: 'Renvoyer', tr: 'Tekrar gönder', zh: '重新发送' },

  // ─── تعيين كلمة مرور جديدة ───
  'reset.title': { ar: 'كلمة مرور جديدة', en: 'New password', fr: 'Nouveau mot de passe', tr: 'Yeni şifre', zh: '设置新密码' },
  'reset.newPassword': { ar: 'كلمة المرور الجديدة', en: 'New password', fr: 'Nouveau mot de passe', tr: 'Yeni şifre', zh: '新密码' },
  'reset.save': { ar: 'حفظ كلمة المرور', en: 'Save password', fr: 'Enregistrer le mot de passe', tr: 'Şifreyi kaydet', zh: '保存密码' },
  'reset.requestNew': { ar: 'اطلب رابطاً جديداً', en: 'Request a new link', fr: 'Demander un nouveau lien', tr: 'Yeni bağlantı iste', zh: '重新获取链接' },
  'reset.success': { ar: 'تم تعيين كلمة المرور', en: 'Your password has been set', fr: 'Votre mot de passe a été défini', tr: 'Şifreniz belirlendi', zh: '密码已设置' },
  'reset.invalid': { ar: 'رابط الاستعادة غير صالح أو منتهٍ', en: 'This reset link is invalid or has expired', fr: 'Ce lien de réinitialisation est invalide ou a expiré', tr: 'Bu sıfırlama bağlantısı geçersiz veya süresi dolmuş', zh: '重置链接无效或已过期' },
  'reset.doneTitle': { ar: 'تم تغيير كلمة المرور', en: 'Password changed', fr: 'Mot de passe modifié', tr: 'Şifre değiştirildi', zh: '密码已修改' },
  'reset.doneBody': { ar: 'يمكنك الآن الدخول بكلمة المرور الجديدة.', en: 'You can now sign in with your new password.', fr: 'Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.', tr: 'Artık yeni şifrenizle giriş yapabilirsiniz.', zh: '现在可以使用新密码登录。' },

  // ─── شاشات الحالة ───
  'status.review.title': { ar: 'طلبك قيد المراجعة', en: 'Your application is under review', fr: 'Votre candidature est en cours d’examen', tr: 'Başvurunuz inceleniyor', zh: '您的申请正在审核中' },
  'status.review.body': { ar: 'شكراً لانضمامك. يراجع فريق فيلد سيلز كل طلب يدوياً، وسيصلك بريد بالقرار. لا حاجة لأي إجراء منك الآن.', en: 'Thank you for applying. The Field Sales team reviews every application personally and will email you the decision. There’s nothing you need to do right now.', fr: 'Merci pour votre candidature. L’équipe Field Sales examine chaque demande individuellement et vous enverra sa décision par e-mail. Aucune action n’est requise pour le moment.', tr: 'Başvurunuz için teşekkürler. Field Sales ekibi her başvuruyu tek tek inceler ve kararı size e-postayla bildirir. Şu anda yapmanız gereken bir şey yok.', zh: '感谢您的申请。Field Sales 团队会逐一人工审核，并通过邮件告知结果。目前您无需进行任何操作。' },
  'status.rejected.title': { ar: 'لم يُقبل طلب الانضمام', en: 'Application not accepted', fr: 'Candidature non retenue', tr: 'Başvuru kabul edilmedi', zh: '申请未通过' },
  'status.rejected.body': { ar: 'نعتذر، لم نتمكن من قبول طلبك في البرنامج حالياً.', en: 'We’re sorry, we’re unable to accept your application to the program at this time.', fr: 'Nous sommes désolés, nous ne pouvons pas accepter votre candidature pour le moment.', tr: 'Üzgünüz, başvurunuzu şu anda programa kabul edemiyoruz.', zh: '很抱歉，您加入本计划的申请目前未能通过。' },
  'status.suspended.title': { ar: 'حسابك موقوف', en: 'Your account is suspended', fr: 'Votre compte est suspendu', tr: 'Hesabınız askıya alındı', zh: '您的账户已暂停' },
  'status.suspended.body': { ar: 'أُوقف حسابك في برنامج السفراء. للاستفسار راسل فريق فيلد سيلز من بريدك المسجّل.', en: 'Your ambassador account has been suspended. For questions, email the Field Sales team from your registered email address.', fr: 'Votre compte ambassadeur a été suspendu. Pour toute question, écrivez à l’équipe Field Sales depuis votre adresse e-mail enregistrée.', tr: 'Elçi hesabınız askıya alındı. Sorularınız için kayıtlı e-posta adresinizden Field Sales ekibine yazın.', zh: '您的推荐大使账户已被暂停。如有疑问，请使用注册邮箱联系 Field Sales 团队。' },
  'status.pendingEmail.title': { ar: 'أكّد بريدك أولاً', en: 'Please confirm your email first', fr: 'Confirmez d’abord votre e-mail', tr: 'Önce e-postanızı onaylayın', zh: '请先确认邮箱' },
  'status.pendingEmail.body': { ar: 'افتح رابط التأكيد المرسل إلى بريدك ثم عد لتسجيل الدخول.', en: 'Open the confirmation link we emailed you, then come back to sign in.', fr: 'Ouvrez le lien de confirmation reçu par e-mail, puis revenez vous connecter.', tr: 'E-postanıza gönderilen onay bağlantısını açın, ardından giriş yapmak için geri dönün.', zh: '请打开发送到您邮箱的确认链接，然后返回登录。' },
  'status.reason': { ar: 'السبب', en: 'Reason', fr: 'Motif', tr: 'Gerekçe', zh: '原因' },

  // ─── الرئيسية ورابطي ───
  'home.hello': { ar: 'أهلاً {name}', en: 'Welcome, {name}', fr: 'Bonjour {name}', tr: 'Merhaba {name}', zh: '{name}，您好' },
  'home.intro': { ar: 'عمولتك {rate} من مبلغ الدفعة الأولى المؤكَّدة لكل منشأة تشترك عبرك، وتُعتمد بعد {days} يوماً من الدفع.', en: 'You earn {rate} of the first confirmed payment from every business that subscribes through you. Commissions are approved {days} days after payment.', fr: 'Vous touchez {rate} du premier paiement confirmé de chaque entreprise abonnée grâce à vous ; la commission est validée {days} jours après le paiement.', tr: 'Sizin aracılığınızla abone olan her işletmenin onaylanan ilk ödemesi üzerinden {rate} oranında komisyon kazanırsınız; komisyon, ödemeden {days} gün sonra onaylanır.', zh: '每家经您推荐订阅的企业，您可获得其首笔确认付款的 {rate}，佣金于付款 {days} 天后审核通过。' },
  'stat.clicks': { ar: 'نقرات آخر 30 يوماً', en: 'Clicks (last 30 days)', fr: 'Clics (30 derniers jours)', tr: 'Tıklamalar (son 30 gün)', zh: '近 30 天点击' },
  'stat.signups': { ar: 'منشآت سجّلت', en: 'Businesses signed up', fr: 'Entreprises inscrites', tr: 'Kaydolan işletmeler', zh: '已注册企业' },
  'stat.paid': { ar: 'منشآت دفعت', en: 'Businesses that paid', fr: 'Entreprises ayant payé', tr: 'Ödeme yapan işletmeler', zh: '已付款企业' },
  'stat.pending': { ar: 'عمولات معلّقة', en: 'Pending commissions', fr: 'Commissions en attente', tr: 'Bekleyen komisyonlar', zh: '待审核佣金' },
  'stat.approved': { ar: 'عمولات معتمدة', en: 'Approved commissions', fr: 'Commissions validées', tr: 'Onaylanan komisyonlar', zh: '已批准佣金' },
  'stat.paidCommissions': { ar: 'عمولات مدفوعة', en: 'Paid commissions', fr: 'Commissions versées', tr: 'Ödenen komisyonlar', zh: '已支付佣金' },
  'home.adjustments': { ar: 'تسويات تُحتسب في دفعتك القادمة', en: 'Adjustments applied to your next payout', fr: 'Ajustements à imputer sur votre prochain virement', tr: 'Bir sonraki aktarımınıza yansıyacak düzeltmeler', zh: '将计入下次打款的调整项' },
  'home.payoutNote': { ar: 'تُحوَّل مستحقاتك المعتمدة يدوياً إلى حسابك البنكي متى بلغ رصيدك {min}.', en: 'Your approved earnings are transferred manually to your bank account once your balance reaches {min}.', fr: 'Vos gains validés sont virés manuellement sur votre compte bancaire une fois que votre solde atteint {min}.', tr: 'Onaylanan kazançlarınız, bakiyeniz {min} tutarına ulaştığında banka hesabınıza manuel olarak aktarılır.', zh: '余额达到 {min} 后，已批准的收益将人工转入您的银行账户。' },
  'link.title': { ar: 'رابط الإحالة الخاص بك', en: 'Your referral link', fr: 'Votre lien de parrainage', tr: 'Referans bağlantınız', zh: '您的推荐链接' },
  'link.copy': { ar: 'نسخ الرابط', en: 'Copy link', fr: 'Copier le lien', tr: 'Bağlantıyı kopyala', zh: '复制链接' },
  'link.whatsapp': { ar: 'واتساب', en: 'WhatsApp', fr: 'WhatsApp', tr: 'WhatsApp', zh: 'WhatsApp' },
  'link.disclosureTitle': { ar: 'نصّ الإفصاح — أرفقه دائماً مع الرابط', en: 'Disclosure — always include it with your link', fr: 'Mention de transparence — joignez-la toujours à votre lien', tr: 'Açıklama metni — bağlantınızla birlikte her zaman paylaşın', zh: '披露声明：分享链接时请务必附上' },
  'link.copyWithDisclosure': { ar: 'نسخ الإفصاح مع الرابط', en: 'Copy disclosure with link', fr: 'Copier la mention avec le lien', tr: 'Açıklamayı bağlantıyla kopyala', zh: '复制披露声明和链接' },
  'link.code': { ar: 'رمز الإحالة', en: 'Referral code', fr: 'Code de parrainage', tr: 'Referans kodu', zh: '推荐码' },
  'link.codeHint': { ar: 'تستطيع المنشأة كتابته يدوياً في خانة «رمز الإحالة» عند التسجيل', en: 'Businesses can also type it into the “Referral code” field when they sign up', fr: 'L’entreprise peut aussi le saisir dans le champ « Code de parrainage » lors de son inscription', tr: 'İşletmeler kayıt sırasında bu kodu “Referans kodu” alanına elle de yazabilir', zh: '企业注册时也可在“推荐码”栏手动填写' },
  'link.copyCode': { ar: 'نسخ الرمز', en: 'Copy code', fr: 'Copier le code', tr: 'Kodu kopyala', zh: '复制推荐码' },
  'copy.default': { ar: 'نسخ', en: 'Copy', fr: 'Copier', tr: 'Kopyala', zh: '复制' },
  'copy.done': { ar: 'تم النسخ', en: 'Copied', fr: 'Copié', tr: 'Kopyalandı', zh: '已复制' },
  'copy.failed': { ar: 'تعذّر النسخ — انسخه يدوياً', en: 'Couldn’t copy — please copy it manually', fr: 'Copie impossible — copiez-le manuellement', tr: 'Kopyalanamadı — lütfen elle kopyalayın', zh: '复制失败，请手动复制' },
  'pw.show': { ar: 'إظهار كلمة المرور', en: 'Show password', fr: 'Afficher le mot de passe', tr: 'Şifreyi göster', zh: '显示密码' },
  'pw.hide': { ar: 'إخفاء كلمة المرور', en: 'Hide password', fr: 'Masquer le mot de passe', tr: 'Şifreyi gizle', zh: '隐藏密码' },

  // ─── شركاتي ───
  'companies.empty': { ar: 'لا منشآت مُسندة إليك بعد', en: 'No businesses attributed to you yet', fr: 'Aucune entreprise ne vous est encore attribuée', tr: 'Size atanmış işletme henüz yok', zh: '暂无归属于您的企业' },
  'companies.emptyHint': { ar: 'حين تسجّل منشأة عبر رابطك أو رمزك، أو يُعتمد ترشيحك وتشترك، تظهر هنا.', en: 'Businesses appear here when they sign up with your link or code, or when your nomination is accepted and they subscribe.', fr: 'Les entreprises apparaissent ici lorsqu’elles s’inscrivent avec votre lien ou votre code, ou lorsque votre recommandation est acceptée et qu’elles s’abonnent.', tr: 'Bağlantınız veya kodunuzla kaydolan ya da öneriniz kabul edilip abone olan işletmeler burada görünür.', zh: '企业通过您的链接或推荐码注册，或您的推荐获批且企业完成订阅后，将显示在这里。' },
  'companies.firstPaid': { ar: 'أول دفعة: {date}', en: 'First payment: {date}', fr: 'Premier paiement : {date}', tr: 'İlk ödeme: {date}', zh: '首笔付款：{date}' },
  'companies.payBefore': { ar: 'تُحتسب العمولة إن دفعت قبل {date}', en: 'Commission applies if they pay before {date}', fr: 'Commission prise en compte si l’entreprise paie avant le {date}', tr: '{date} tarihinden önce ödeme yaparsa komisyon hesaplanır', zh: '须于 {date} 前付款方可产生佣金' },
  'companies.commission': { ar: 'العمولة', en: 'Commission', fr: 'Commission', tr: 'Komisyon', zh: '佣金' },
  'companies.eligibleIn': { ar: 'تصبح قابلة للاعتماد في {date} (بعد {days})', en: 'Eligible for approval on {date} (in {days})', fr: 'Validation possible à partir du {date} (dans {days})', tr: '{date} tarihinde onaya uygun hale gelir ({days} sonra)', zh: '{date} 起可审核批准（{days}后）' },
  'companies.holdEnded': { ar: 'انتهت فترة الحجز في {date} — بانتظار المراجعة', en: 'Holding period ended on {date} — awaiting review', fr: 'Période de blocage terminée le {date} — en attente d’examen', tr: 'Bekleme süresi {date} tarihinde bitti — inceleme bekleniyor', zh: '冻结期已于 {date} 结束，等待审核' },
  'companies.dueDate': { ar: 'تاريخ الاستحقاق {date}', en: 'Eligibility date: {date}', fr: 'Date d’exigibilité : {date}', tr: 'Hak ediş tarihi {date}', zh: '可结算日期 {date}' },

  // ─── أرباحي ───
  'earn.info1': { ar: 'تُنشأ العمولة {pending} عند تأكيد أول دفعة للمنشأة، وتبقى محجوزة {days} يوماً من تاريخ الدفع للتأكد من عدم استرداد المبلغ، ثم تُراجع وتصبح {approved}.', en: 'A commission is created as {pending} once the business’s first payment is confirmed. It is held for {days} days from the payment date to make sure the payment isn’t refunded, then reviewed and marked {approved}.', fr: 'La commission est créée avec le statut {pending} dès la confirmation du premier paiement de l’entreprise. Elle reste bloquée {days} jours à compter de la date de paiement, le temps de vérifier que ce paiement n’est pas remboursé, puis elle est examinée et passe au statut {approved}.', tr: 'Komisyon, işletmenin ilk ödemesi onaylandığında {pending} durumunda oluşturulur. Ödemenin iade edilmediğinden emin olmak için ödeme tarihinden itibaren {days} gün bekletilir, ardından incelenir ve durumu {approved} olarak güncellenir.', zh: '企业首笔付款确认后，佣金以{pending}状态生成，并自付款之日起冻结 {days} 天，以确保该笔款项未发生退款，随后经审核变为{approved}。' },
  'earn.info2': { ar: 'تُحوَّل المستحقات المعتمدة يدوياً إلى حسابك البنكي متى بلغ صافيها {min}، وتصبح {paid}. إن استُردّت دفعةٌ بعد تحويل عمولتها يُخصم مقدارها من دفعتك القادمة.', en: 'Approved earnings are transferred manually to your bank account once their net total reaches {min}, and are then marked {paid}. If a payment is refunded after its commission was paid out, the corresponding commission amount is deducted from your next payout.', fr: 'Les gains validés sont virés manuellement sur votre compte bancaire une fois que leur montant net atteint {min}, puis passent au statut {paid}. Si un paiement est remboursé après le versement de sa commission, le montant de commission correspondant est déduit de votre prochain virement.', tr: 'Onaylanan kazançlarınız, net toplamı {min} tutarına ulaştığında banka hesabınıza manuel olarak aktarılır ve durumları {paid} olarak güncellenir. Komisyonu size aktarıldıktan sonra bir ödeme iade edilirse, komisyonun buna karşılık gelen kısmı bir sonraki aktarımınızdan düşülür.', zh: '已批准的收益净额达到 {min} 后，将人工转入您的银行账户并标记为{paid}。若某笔付款在佣金打款后被退款，相应金额将从下次打款中扣除。' },
  'earn.commissions': { ar: 'العمولات', en: 'Commissions', fr: 'Commissions', tr: 'Komisyonlar', zh: '佣金' },
  'earn.noCommissions': { ar: 'لا عمولات بعد', en: 'No commissions yet', fr: 'Aucune commission pour le moment', tr: 'Henüz komisyon yok', zh: '暂无佣金' },
  'earn.noCommissionsHint': { ar: 'تظهر العمولة هنا حين تدفع منشأةٌ مُسندة إليك أول دفعة.', en: 'A commission appears here when a business attributed to you makes its first payment.', fr: 'Une commission apparaît ici dès qu’une entreprise qui vous est attribuée effectue son premier paiement.', tr: 'Size atanmış bir işletme ilk ödemesini yaptığında komisyon burada görünür.', zh: '归属于您的企业完成首笔付款后，佣金会显示在这里。' },
  'earn.paymentAmount': { ar: 'مبلغ الدفعة (شاملة الضريبة)', en: 'Payment amount (VAT incl.)', fr: 'Montant du paiement (TVA incluse)', tr: 'Ödeme tutarı (KDV dahil)', zh: '付款金额（含增值税）' },
  'earn.refunded': { ar: 'مستردّ من الدفعة', en: 'Amount refunded', fr: 'Montant remboursé', tr: 'İade edilen tutar', zh: '已退款金额' },
  'earn.rate': { ar: 'النسبة', en: 'Rate', fr: 'Taux', tr: 'Oran', zh: '比例' },
  'earn.paymentDate': { ar: 'تاريخ الدفع', en: 'Payment date', fr: 'Date du paiement', tr: 'Ödeme tarihi', zh: '付款日期' },
  'earn.holdEnd': { ar: 'نهاية فترة الحجز', en: 'End of holding period', fr: 'Fin de la période de blocage', tr: 'Bekleme süresi sonu', zh: '冻结期结束' },
  'earn.holdEndValue': { ar: '{date} (بعد {days})', en: '{date} (in {days})', fr: '{date} (dans {days})', tr: '{date} ({days} sonra)', zh: '{date}（{days}后）' },
  'earn.paidOn': { ar: 'حُوّلت في', en: 'Paid out on', fr: 'Versée le', tr: 'Aktarıldığı tarih', zh: '打款日期' },
  'earn.note': { ar: 'ملاحظة: ', en: 'Note: ', fr: 'Remarque : ', tr: 'Not: ', zh: '备注：' },
  'earn.adjustments': { ar: 'التسويات', en: 'Adjustments', fr: 'Ajustements', tr: 'Düzeltmeler', zh: '调整项' },
  'earn.noAdjustments': { ar: 'لا تسويات', en: 'No adjustments', fr: 'Aucun ajustement', tr: 'Düzeltme yok', zh: '暂无调整项' },
  'earn.settled': { ar: 'سُوّيت في دفعة سابقة', en: 'Settled in a previous payout', fr: 'Réglé lors d’un virement précédent', tr: 'Önceki bir aktarımda mahsup edildi', zh: '已在之前的打款中结算' },
  'earn.nextPayout': { ar: 'تُحتسب في دفعتك القادمة', en: 'Applied to your next payout', fr: 'À imputer sur votre prochain virement', tr: 'Bir sonraki aktarımınıza yansıtılır', zh: '计入下次打款' },
  'earn.payouts': { ar: 'التحويلات', en: 'Payouts', fr: 'Virements', tr: 'Aktarımlar', zh: '打款记录' },
  'earn.noPayouts': { ar: 'لا تحويلات بعد', en: 'No payouts yet', fr: 'Aucun virement pour le moment', tr: 'Henüz aktarım yok', zh: '暂无打款记录' },
  'earn.commissionsTotal': { ar: 'العمولات', en: 'Commissions', fr: 'Commissions', tr: 'Komisyonlar', zh: '佣金' },
  'earn.transferDate': { ar: 'تاريخ التحويل', en: 'Transfer date', fr: 'Date du virement', tr: 'Aktarım tarihi', zh: '转账日期' },
  'earn.bankRef': { ar: 'مرجع التحويل', en: 'Transfer reference', fr: 'Référence du virement', tr: 'Aktarım referansı', zh: '转账参考号' },
  'earn.toAccount': { ar: 'إلى الحساب', en: 'To account', fr: 'Compte bénéficiaire', tr: 'Alıcı hesap', zh: '收款账户' },

  // ─── رشّح شركة ───
  'claims.formTitle': { ar: 'رشّح منشأة', en: 'Nominate a business', fr: 'Recommander une entreprise', tr: 'Bir işletme önerin', zh: '推荐企业' },
  'claims.formIntro': { ar: 'عرّفت منشأةً بفيلد سيلز ولم تسجّل برابطك؟ رشّحها هنا. إن قُبل الترشيح تُحجز لك مدةً، وتُحتسب عمولتك إن اشتركت.', en: 'Introduced Field Sales to a business that didn’t sign up with your link? Nominate it here. If your nomination is accepted, the business is reserved for you for a set period, and you earn your commission if it subscribes.', fr: 'Vous avez présenté Field Sales à une entreprise qui ne s’est pas inscrite avec votre lien ? Recommandez-la ici. Si la recommandation est acceptée, l’entreprise vous est réservée pendant une durée limitée et votre commission est comptabilisée si elle s’abonne.', tr: 'Field Sales’i bir işletmeye tanıttınız ama bağlantınızla kaydolmadı mı? Buradan önerin. Öneriniz kabul edilirse işletme belirli bir süre sizin adınıza ayrılır ve abone olursa komisyonunuzu kazanırsınız.', zh: '您向企业介绍了 Field Sales，但对方未通过您的链接注册？请在此提交推荐。推荐获批后，该企业将在一段时间内为您保留；若该企业订阅，佣金将归属于您。' },
  'claims.companyName': { ar: 'اسم المنشأة', en: 'Business name', fr: 'Nom de l’entreprise', tr: 'İşletme adı', zh: '企业名称' },
  'claims.cr': { ar: 'السجل التجاري', en: 'Commercial Registration (CR)', fr: 'N° de registre du commerce (RC)', tr: 'Ticari sicil (CR)', zh: '商业登记号（CR）' },
  'claims.crHint': { ar: '10 أرقام', en: '10 digits', fr: '10 chiffres', tr: '10 hane', zh: '10 位数字' },
  'claims.how': { ar: 'كيف عرّفتهم؟', en: 'How did you introduce Field Sales to them?', fr: 'Comment leur avez-vous présenté Field Sales ?', tr: 'Onlara nasıl ulaştınız?', zh: '您通过什么方式介绍该企业？' },
  'claims.choose': { ar: 'اختر', en: 'Select', fr: 'Choisir', tr: 'Seçin', zh: '请选择' },
  'claims.noteOptional': { ar: 'ملاحظة (اختياري)', en: 'Note (optional)', fr: 'Remarque (facultatif)', tr: 'Not (isteğe bağlı)', zh: '备注（选填）' },
  'claims.contactHint': { ar: 'احذف رقم الجوال أو البريد', en: 'Remove the phone number or email', fr: 'Retirez le numéro de téléphone ou l’e-mail', tr: 'Telefon numarasını veya e-postayı kaldırın', zh: '请删除手机号或邮箱' },
  'claims.noteContact': { ar: 'احذف رقم الجوال أو البريد — رقم التواصل يُكتب في خانته', en: 'Remove the phone number or email — the contact number has its own field', fr: 'Retirez le numéro ou l’e-mail — le numéro de contact a son propre champ', tr: 'Telefon numarasını veya e-postayı kaldırın — iletişim numarasının kendi alanı var', zh: '请删除手机号或邮箱，联系电话请填写在专用栏位' },
  'claims.noteHint': { ar: 'بلا أرقام جوال أو بريد — رقم التواصل له خانته', en: 'No phone numbers or emails — the contact number has its own field', fr: 'Sans numéro de téléphone ni e-mail — le numéro de contact a son propre champ', tr: 'Telefon numarası veya e-posta yazmayın — iletişim numarasının kendi alanı var', zh: '请勿填写手机号或邮箱，联系电话另有专用栏位' },
  'claims.privacy': { ar: 'أدخل رقم التواصل في خانته — ولا تكتب بيانات اتصال في الملاحظة.', en: 'Enter the contact number in its own field — don’t put contact details in the note.', fr: 'Saisissez le numéro de contact dans le champ prévu à cet effet — n’indiquez aucune coordonnée dans la remarque.', tr: 'İletişim numarasını kendi alanına girin — nota iletişim bilgisi yazmayın.', zh: '请在专用栏位填写联系电话，备注中请勿填写联系方式。' },
  'claims.contactPhone': { ar: 'رقم التواصل', en: 'Contact number', fr: 'Numéro de contact', tr: 'İletişim numarası', zh: '联系电话' },
  'claims.contactPhoneHint': { ar: 'جوال أو هاتف المنشأة أو المسؤول', en: 'Mobile or landline of the business or the person in charge', fr: 'Mobile ou fixe de l’entreprise ou du responsable', tr: 'İşletmenin veya yetkilinin cep ya da sabit telefonu', zh: '企业或负责人的手机或座机' },
  'claims.submit': { ar: 'إرسال الترشيح', en: 'Submit nomination', fr: 'Envoyer la recommandation', tr: 'Öneriyi gönder', zh: '提交推荐' },
  'claims.received': { ar: 'استلمنا الترشيح وسيُراجع', en: 'Nomination received — we’ll review it', fr: 'Recommandation reçue — elle sera examinée', tr: 'Öneriniz alındı — incelenecek', zh: '推荐已收到，我们将进行审核' },
  'claims.submitFailed': { ar: 'تعذّر إرسال الترشيح', en: 'We couldn’t submit your nomination', fr: 'Impossible d’envoyer la recommandation', tr: 'Öneri gönderilemedi', zh: '推荐提交失败' },
  'claims.withdrawn': { ar: 'سُحب الترشيح', en: 'Nomination withdrawn', fr: 'Recommandation retirée', tr: 'Öneri geri çekildi', zh: '推荐已撤回' },
  'claims.withdrawFailed': { ar: 'تعذّر سحب الترشيح', en: 'We couldn’t withdraw this nomination', fr: 'Impossible de retirer la recommandation', tr: 'Öneri geri çekilemedi', zh: '撤回推荐失败' },
  'claims.mine': { ar: 'ترشيحاتي', en: 'My nominations', fr: 'Mes recommandations', tr: 'Önerilerim', zh: '我的推荐' },
  'claims.empty': { ar: 'لا ترشيحات بعد', en: 'No nominations yet', fr: 'Aucune recommandation pour le moment', tr: 'Henüz öneri yok', zh: '暂无推荐' },
  'claims.emptyHint': { ar: 'ترشيحاتك وحالاتها تظهر هنا.', en: 'Your nominations and their status will appear here.', fr: 'Vos recommandations et leur statut apparaîtront ici.', tr: 'Önerileriniz ve durumları burada görünür.', zh: '您的推荐及其状态将显示在这里。' },
  'claims.crShort': { ar: 'سجل', en: 'CR', fr: 'RC', tr: 'Sicil', zh: '登记号' },
  'claims.sentOn': { ar: 'أُرسل {date}', en: 'Submitted {date}', fr: 'Envoyée le {date}', tr: 'Gönderildi: {date}', zh: '提交于 {date}' },
  'claims.withdraw': { ar: 'سحب', en: 'Withdraw', fr: 'Retirer', tr: 'Geri çek', zh: '撤回' },
  'claims.withdrawConfirm': { ar: 'سحب ترشيح «{name}»؟', en: 'Withdraw your nomination of “{name}”?', fr: 'Retirer la recommandation « {name} » ?', tr: '“{name}” önerisi geri çekilsin mi?', zh: '确定撤回对“{name}”的推荐吗？' },
  'claims.lockedUntil': { ar: 'محجوز لك حتى {date}', en: 'Reserved for you until {date}', fr: 'Réservée pour vous jusqu’au {date}', tr: '{date} tarihine kadar size ayrıldı', zh: '为您保留至 {date}' },

  // ─── الملف ───
  'profile.mine': { ar: 'بياناتي', en: 'My details', fr: 'Mes informations', tr: 'Bilgilerim', zh: '我的信息' },
  'profile.name': { ar: 'الاسم', en: 'Name', fr: 'Nom', tr: 'Ad', zh: '姓名' },
  'profile.email': { ar: 'البريد', en: 'Email', fr: 'E-mail', tr: 'E-posta', zh: '邮箱' },
  'profile.phone': { ar: 'الجوال', en: 'Mobile', fr: 'Mobile', tr: 'Cep telefonu', zh: '手机' },
  'profile.code': { ar: 'رمز الإحالة', en: 'Referral code', fr: 'Code de parrainage', tr: 'Referans kodu', zh: '推荐码' },
  'profile.memberSince': { ar: 'عضو منذ', en: 'Member since', fr: 'Membre depuis', tr: 'Üyelik tarihi', zh: '加入时间' },
  'profile.editHint': { ar: 'لتعديل الاسم أو البريد أو الجوال راسل فريق فيلد سيلز من بريدك المسجّل.', en: 'To change your name, email or mobile number, email the Field Sales team from your registered address.', fr: 'Pour modifier votre nom, votre e-mail ou votre mobile, écrivez à l’équipe Field Sales depuis votre adresse enregistrée.', tr: 'Adınızı, e-postanızı veya cep telefonunuzu değiştirmek için kayıtlı adresinizden Field Sales ekibine yazın.', zh: '如需修改姓名、邮箱或手机号，请使用注册邮箱联系 Field Sales 团队。' },
  'profile.prefs': { ar: 'تفضيلاتي', en: 'My preferences', fr: 'Mes préférences', tr: 'Tercihlerim', zh: '我的偏好' },
  'profile.marketing': { ar: 'أوافق على تلقي رسائل عن البرنامج وتحديثاته', en: 'Send me news and updates about the program', fr: 'J’accepte de recevoir des actualités sur le programme', tr: 'Program ve güncellemeleri hakkında bilgilendirme mesajları almayı kabul ediyorum', zh: '我愿意接收有关本计划的消息与更新' },
  'profile.save': { ar: 'حفظ التغييرات', en: 'Save changes', fr: 'Enregistrer', tr: 'Değişiklikleri kaydet', zh: '保存更改' },
  'profile.saved': { ar: 'تم حفظ بياناتك', en: 'Your details have been saved', fr: 'Vos informations ont été enregistrées', tr: 'Bilgileriniz kaydedildi', zh: '信息已保存' },
  'profile.saveFailed': { ar: 'تعذّر حفظ البيانات', en: 'We couldn’t save your details', fr: 'Impossible d’enregistrer vos informations', tr: 'Bilgiler kaydedilemedi', zh: '保存失败' },
  'profile.noChanges': { ar: 'لا تغييرات للحفظ', en: 'No changes to save', fr: 'Aucune modification à enregistrer', tr: 'Kaydedilecek değişiklik yok', zh: '没有需要保存的更改' },
  'payout.title': { ar: 'بيانات الاستلام', en: 'Payout details', fr: 'Coordonnées de versement', tr: 'Ödeme bilgileri', zh: '收款信息' },
  'payout.updatedAt': { ar: 'آخر تحديث {date}', en: 'Last updated {date}', fr: 'Mis à jour le {date}', tr: 'Son güncelleme: {date}', zh: '最后更新 {date}' },
  'payout.update': { ar: 'تحديث', en: 'Update', fr: 'Modifier', tr: 'Güncelle', zh: '更新' },
  'payout.locked': { ar: 'تحديث بيانات الاستلام غير متاح حالياً.', en: 'Updating payout details isn’t available right now.', fr: 'La modification des coordonnées de versement n’est pas disponible pour le moment.', tr: 'Ödeme bilgilerini güncelleme şu anda kullanılamıyor.', zh: '暂时无法更新收款信息。' },
  'payout.unlockAfter': { ar: 'يُفتح نموذج الحساب البنكي بعد اعتماد أول عمولة لك.', en: 'The bank account form unlocks once your first commission is approved.', fr: 'Le formulaire bancaire sera disponible dès la validation de votre première commission.', tr: 'Banka hesabı formu, ilk komisyonunuz onaylandığında açılır.', zh: '首笔佣金获批后即可填写银行账户信息。' },
  'payout.iban': { ar: 'الآيبان', en: 'IBAN', fr: 'IBAN', tr: 'IBAN', zh: 'IBAN' },
  'payout.ibanHint': { ar: 'آيبان سعودي يبدأ بـSA ويتبعه 22 رقماً', en: 'Saudi IBAN: SA followed by 22 digits', fr: 'IBAN saoudien : SA suivi de 22 chiffres', tr: 'Suudi IBAN: SA ve ardından 22 hane', zh: '沙特 IBAN：SA 开头，后接 22 位数字' },
  'payout.ibanInvalidHint': { ar: 'الآيبان غير صالح — راجع الأرقام', en: 'Invalid IBAN — please check the digits', fr: 'IBAN invalide — vérifiez les chiffres', tr: 'Geçersiz IBAN — lütfen rakamları kontrol edin', zh: 'IBAN 无效，请核对数字' },
  'payout.holder': { ar: 'اسم صاحب الحساب', en: 'Account holder name', fr: 'Titulaire du compte', tr: 'Hesap sahibinin adı', zh: '账户持有人姓名' },
  'payout.holderHint': { ar: 'كما هو مسجّل في البنك', en: 'As registered with your bank', fr: 'Tel qu’enregistré auprès de votre banque', tr: 'Bankada kayıtlı olduğu şekilde', zh: '与银行登记信息一致' },
  'payout.bank': { ar: 'اسم البنك', en: 'Bank name', fr: 'Nom de la banque', tr: 'Banka adı', zh: '银行名称' },
  'payout.save': { ar: 'حفظ بيانات الاستلام', en: 'Save payout details', fr: 'Enregistrer les coordonnées', tr: 'Ödeme bilgilerini kaydet', zh: '保存收款信息' },
  'payout.saved': { ar: 'تم حفظ بيانات الاستلام', en: 'Payout details saved', fr: 'Coordonnées de versement enregistrées', tr: 'Ödeme bilgileri kaydedildi', zh: '收款信息已保存' },
  'payout.saveFailed': { ar: 'تعذّر حفظ بيانات الاستلام', en: 'We couldn’t save your payout details', fr: 'Impossible d’enregistrer les coordonnées de versement', tr: 'Ödeme bilgileri kaydedilemedi', zh: '收款信息保存失败' },

  // ─── رسائل التحقّق ───
  'val.fullName': { ar: 'الاسم الكامل بين حرفين و80 حرفاً', en: 'Full name must be 2–80 characters', fr: 'Le nom complet doit comporter entre 2 et 80 caractères', tr: 'Ad soyad 2–80 karakter olmalıdır', zh: '姓名须为 2–80 个字符' },
  'val.email': { ar: 'البريد الإلكتروني غير صحيح', en: 'Please enter a valid email address', fr: 'Adresse e-mail invalide', tr: 'Geçerli bir e-posta adresi girin', zh: '邮箱地址无效' },
  'val.phone': { ar: 'أدخل رقم جوال صحيحا مع مفتاح دولته', en: 'Enter a valid mobile number with its country code', fr: 'Saisissez un numéro de mobile valide avec son indicatif', tr: 'Ülke koduyla birlikte geçerli bir cep numarası girin', zh: '请输入带国家代码的有效手机号码' },
  'val.cityTooLong': { ar: 'اسم المدينة {max} حرفاً كحدّ أقصى', en: 'City name can be at most {max} characters', fr: 'Le nom de la ville ne doit pas dépasser {max} caractères', tr: 'Şehir adı en fazla {max} karakter olabilir', zh: '城市名称最多 {max} 个字符' },
  'val.passwordMin': { ar: 'كلمة المرور 8 أحرف على الأقل', en: 'Password must be at least 8 characters', fr: 'Le mot de passe doit contenir au moins 8 caractères', tr: 'Şifre en az 8 karakter olmalıdır', zh: '密码至少需要 8 个字符' },
  'val.passwordMax': { ar: 'كلمة المرور طويلة جداً', en: 'Password is too long', fr: 'Le mot de passe est trop long', tr: 'Şifre çok uzun', zh: '密码过长' },
  'val.vat': { ar: 'الرقم الضريبي 15 رقماً', en: 'VAT number must be 15 digits', fr: 'Le numéro de TVA doit comporter 15 chiffres', tr: 'KDV numarası 15 hane olmalıdır', zh: '增值税号须为 15 位数字' },
  'val.acceptTerms': { ar: 'يجب قراءة الشروط والموافقة عليها', en: 'Please read and accept the terms', fr: 'Vous devez lire et accepter les conditions', tr: 'Şartları okuyup kabul etmelisiniz', zh: '请阅读并同意条款' },
  'val.companyName': { ar: 'اسم المنشأة بين حرفين و120 حرفاً', en: 'Business name must be 2–120 characters', fr: 'Le nom de l’entreprise doit comporter entre 2 et 120 caractères', tr: 'İşletme adı 2–120 karakter olmalıdır', zh: '企业名称须为 2–120 个字符' },
  'val.companyContact': { ar: 'اكتب اسم المنشأة فقط — بلا جوال أو بريد', en: 'Enter the business name only — no phone numbers or emails', fr: 'Indiquez uniquement le nom de l’entreprise — sans téléphone ni e-mail', tr: 'Yalnızca işletme adını yazın — telefon veya e-posta olmadan', zh: '仅填写企业名称，请勿包含手机号或邮箱' },
  'val.cr': { ar: 'السجل التجاري 10 أرقام', en: 'CR number must be 10 digits', fr: 'Le numéro de registre doit comporter 10 chiffres', tr: 'Ticari sicil numarası 10 hane olmalıdır', zh: '商业登记号须为 10 位数字' },
  'val.cityContact': { ar: 'اكتب اسم المدينة فقط — بلا جوال أو بريد', en: 'Enter the city name only — no phone numbers or emails', fr: 'Indiquez uniquement la ville — sans téléphone ni e-mail', tr: 'Yalnızca şehir adını yazın — telefon veya e-posta olmadan', zh: '仅填写城市名称，请勿包含手机号或邮箱' },
  'val.how': { ar: 'اختر كيف عرّفت المنشأة', en: 'Select how you introduced Field Sales to the business', fr: 'Indiquez comment vous avez présenté Field Sales à l’entreprise', tr: 'İşletmeye nasıl ulaştığınızı seçin', zh: '请选择您介绍该企业的方式' },
  'val.noteTooLong': { ar: 'الملاحظة {max} حرف كحدّ أقصى', en: 'Note can be at most {max} characters', fr: 'La remarque ne doit pas dépasser {max} caractères', tr: 'Not en fazla {max} karakter olabilir', zh: '备注最多 {max} 个字符' },
  'val.noteContact': { ar: 'الملاحظة لا تقبل أرقام جوال أو بريداً — اكتب رقم التواصل في خانته', en: 'Notes can’t include phone numbers or emails — enter the contact number in its own field', fr: 'La remarque ne peut pas contenir de numéro ni d’e-mail — saisissez le numéro de contact dans le champ prévu à cet effet', tr: 'Not telefon numarası veya e-posta içeremez — iletişim numarasını kendi alanına girin', zh: '备注不能包含手机号或邮箱，请在专用栏位填写联系电话' },
  'val.contactPhoneRequired': { ar: 'أدخل رقم التواصل', en: 'Enter a contact number', fr: 'Saisissez un numéro de contact', tr: 'Bir iletişim numarası girin', zh: '请输入联系电话' },
  'val.contactPhone': { ar: 'رقم التواصل غير صحيح', en: 'The contact number is not valid', fr: 'Le numéro de contact est invalide', tr: 'İletişim numarası geçersiz', zh: '联系电话无效' },
  'val.iban': { ar: 'آيبان غير صالح — يبدأ بـSA ويتبعه 22 رقماً', en: 'Invalid IBAN — it must start with SA followed by 22 digits', fr: 'IBAN invalide — il doit commencer par SA suivi de 22 chiffres', tr: 'Geçersiz IBAN — SA ile başlamalı ve ardından 22 hane gelmelidir', zh: 'IBAN 无效：须以 SA 开头，后接 22 位数字' },
  'val.holder': { ar: 'اسم صاحب الحساب بين حرفين و120 حرفاً', en: 'Account holder name must be 2–120 characters', fr: 'Le nom du titulaire doit comporter entre 2 et 120 caractères', tr: 'Hesap sahibinin adı 2–120 karakter olmalıdır', zh: '账户持有人姓名须为 2–120 个字符' },
  'val.bank': { ar: 'اسم البنك طويل', en: 'Bank name is too long', fr: 'Le nom de la banque est trop long', tr: 'Banka adı çok uzun', zh: '银行名称过长' },

  // ─── التسميات (labels.ts) ───
  'st.user.pending_email': { ar: 'بانتظار تأكيد البريد', en: 'Awaiting email confirmation', fr: 'E-mail à confirmer', tr: 'E-posta onayı bekleniyor', zh: '待确认邮箱' },
  'st.user.pending_review': { ar: 'قيد المراجعة', en: 'Under review', fr: 'En cours d’examen', tr: 'İnceleniyor', zh: '审核中' },
  'st.user.approved': { ar: 'معتمد', en: 'Approved', fr: 'Accepté', tr: 'Onaylandı', zh: '已通过' },
  'st.user.rejected': { ar: 'مرفوض', en: 'Rejected', fr: 'Refusé', tr: 'Reddedildi', zh: '未通过' },
  'st.user.suspended': { ar: 'موقوف', en: 'Suspended', fr: 'Suspendu', tr: 'Askıya alındı', zh: '已暂停' },
  'st.claim.under_review': { ar: 'قيد المراجعة', en: 'Under review', fr: 'En cours d’examen', tr: 'İnceleniyor', zh: '审核中' },
  'st.claim.approved': { ar: 'مقبول', en: 'Accepted', fr: 'Acceptée', tr: 'Kabul edildi', zh: '已通过' },
  'st.claim.rejected': { ar: 'مرفوض', en: 'Rejected', fr: 'Refusée', tr: 'Reddedildi', zh: '未通过' },
  'st.claim.withdrawn': { ar: 'مسحوب', en: 'Withdrawn', fr: 'Retirée', tr: 'Geri çekildi', zh: '已撤回' },
  'st.claim.expired': { ar: 'منتهٍ', en: 'Expired', fr: 'Expirée', tr: 'Süresi doldu', zh: '已过期' },
  'st.claim.converted': { ar: 'تحوّل لعميل', en: 'Became a customer', fr: 'Devenue cliente', tr: 'Müşteriye dönüştü', zh: '已成为客户' },
  'st.attr.active': { ar: 'ساري', en: 'Active', fr: 'Active', tr: 'Aktif', zh: '有效' },
  'st.attr.disputed': { ar: 'قيد المراجعة', en: 'Under review', fr: 'En cours d’examen', tr: 'İnceleniyor', zh: '审核中' },
  'st.attr.void': { ar: 'ملغى', en: 'Void', fr: 'Annulée', tr: 'Geçersiz', zh: '已作废' },
  'st.commission.pending': { ar: 'معلّقة', en: 'Pending', fr: 'En attente', tr: 'Beklemede', zh: '待审核' },
  'st.commission.on_hold': { ar: 'موقوفة', en: 'Suspended', fr: 'Suspendue', tr: 'Askıya alındı', zh: '已暂停' },
  'st.commission.approved': { ar: 'معتمدة', en: 'Approved', fr: 'Validée', tr: 'Onaylandı', zh: '已批准' },
  'st.commission.paid': { ar: 'مدفوعة', en: 'Paid', fr: 'Versée', tr: 'Ödendi', zh: '已支付' },
  'st.commission.reversed': { ar: 'مُلغاة بالاسترداد', en: 'Cancelled (payment refunded)', fr: 'Annulée (remboursement)', tr: 'İptal edildi (iade)', zh: '已取消（退款）' },
  'st.commission.declined': { ar: 'مرفوضة', en: 'Declined', fr: 'Refusée', tr: 'Reddedildi', zh: '已拒绝' },
  'st.payout.draft': { ar: 'قيد الإعداد', en: 'Being prepared', fr: 'En préparation', tr: 'Hazırlanıyor', zh: '准备中' },
  'st.payout.recorded': { ar: 'تم التحويل', en: 'Transferred', fr: 'Virement effectué', tr: 'Aktarıldı', zh: '已转账' },
  'st.payout.void': { ar: 'ملغاة', en: 'Cancelled', fr: 'Annulé', tr: 'İptal edildi', zh: '已取消' },
  'st.company.trial': { ar: 'تجربة', en: 'Trial', fr: 'Essai', tr: 'Deneme', zh: '试用中' },
  'st.company.paid': { ar: 'دفعت', en: 'Paid', fr: 'Paiement reçu', tr: 'Ödeme yaptı', zh: '已付款' },
  'st.company.disputed': { ar: 'قيد المراجعة', en: 'Under review', fr: 'En cours d’examen', tr: 'İnceleniyor', zh: '审核中' },
  'st.company.void': { ar: 'ملغاة', en: 'Cancelled', fr: 'Annulée', tr: 'Geçersiz', zh: '已作废' },
  'st.company.expired': { ar: 'انتهت المهلة', en: 'Deadline passed', fr: 'Délai dépassé', tr: 'Süre doldu', zh: '已逾期' },
  'src.signup_code': { ar: 'سجّلت برابطك أو رمزك', en: 'Signed up with your link or code', fr: 'Inscrite avec votre lien ou votre code', tr: 'Bağlantınız veya kodunuzla kaydoldu', zh: '通过您的链接或推荐码注册' },
  'src.claim': { ar: 'ترشيح معتمد', en: 'Accepted nomination', fr: 'Recommandation acceptée', tr: 'Kabul edilen öneri', zh: '推荐已获批' },
  'src.owner': { ar: 'إسناد من الإدارة', en: 'Assigned by Field Sales', fr: 'Attribuée par Field Sales', tr: 'Field Sales tarafından atandı', zh: '由 Field Sales 指派' },
  'adj.clawback_refund': { ar: 'خصم بسبب استرداد', en: 'Refund deduction', fr: 'Déduction pour remboursement', tr: 'İade kesintisi', zh: '退款扣减' },
  'adj.correction': { ar: 'تصحيح', en: 'Correction', fr: 'Correction', tr: 'Düzeltme', zh: '更正' },
  'how.visit': { ar: 'زيارة ميدانية', en: 'Field visit', fr: 'Visite sur le terrain', tr: 'Saha ziyareti', zh: '实地拜访' },
  'how.relationship': { ar: 'معرفة أو علاقة سابقة', en: 'Existing contact or relationship', fr: 'Contact ou relation existante', tr: 'Mevcut tanıdık veya ilişki', zh: '既有人脉或合作关系' },
  'how.event': { ar: 'فعالية أو معرض', en: 'Event or exhibition', fr: 'Événement ou salon', tr: 'Etkinlik veya fuar', zh: '活动或展会' },
  'how.online': { ar: 'تواصل عبر الإنترنت', en: 'Online outreach', fr: 'Échange en ligne', tr: 'Çevrim içi iletişim', zh: '线上沟通' },
  'how.other': { ar: 'أخرى', en: 'Other', fr: 'Autre', tr: 'Diğer', zh: '其他' },

  // ─── التنسيق (format.ts) ───
  'fmt.sar': { ar: 'ر.س', en: 'SAR', fr: 'SAR', tr: 'SAR', zh: 'SAR' },
  'days.today': { ar: 'اليوم', en: 'today', fr: 'aujourd’hui', tr: 'bugün', zh: '今天' },
  'days.one': { ar: 'يوم واحد', en: '1 day', fr: '1 jour', tr: '1 gün', zh: '1 天' },
  'days.other': { ar: '{n} يوماً', en: '{n} days', fr: '{n} jours', tr: '{n} gün', zh: '{n} 天' },
} satisfies Record<string, Entry>;

export type AxKey = keyof typeof DICT;
export const AX_DICT: Record<AxKey, Entry> = DICT;

export type Vars = Record<string, string | number>;
/** رسالةٌ بمفتاحٍ ومتغيّرات — تُعيدها وحدات التحقّق النقيّة وتترجمها الواجهة */
export interface AxMsg { key: AxKey; vars?: Vars }
export const msg = (key: AxKey, vars?: Vars): AxMsg => (vars ? { key, vars } : { key });

/** ملء {name} بقيمها — متغيّرٌ غائب يبقى كما هو ظاهراً لا فراغاً */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function translate(lang: Lang, key: AxKey, vars?: Vars): string {
  const entry = AX_DICT[key];
  const text = entry ? (entry[lang] || entry.ar) : key;
  return interpolate(text, vars);
}

/** يقسم القالب إلى نصوصٍ ومتغيّرات — لإدراج عُقد React (نصّ عريض، أرقام معزولة الاتجاه) */
export function splitTemplate(template: string): Array<string | { name: string }> {
  const out: Array<string | { name: string }> = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const i = m.index ?? 0;
    if (i > last) out.push(template.slice(last, i));
    out.push({ name: m[1] });
    last = i + m[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return out;
}

/** locale التنسيق لكل لغة — أرقام لاتينية دائماً وتقويم ميلادي */
export const AX_LOCALE: Record<Lang, string> = {
  ar: 'ar-u-nu-latn-ca-gregory',
  en: 'en-GB',
  fr: 'fr-FR',
  tr: 'tr-TR',
  zh: 'zh-CN-u-nu-latn',
};

export function dirOf(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

export type AxT = (key: AxKey, vars?: Vars) => string;

export interface AxI18n {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  t: AxT;
  /** رسالة تحقّق {key, vars} */
  m: (message: AxMsg) => string;
  /** قالبٌ بعُقد React مكان المتغيّرات */
  rich: (key: AxKey, vars: Record<string, ReactNode>) => ReactNode;
}

export function makeAxI18n(lang: Lang): AxI18n {
  const t: AxT = (key, vars) => translate(lang, key, vars);
  return {
    lang,
    dir: dirOf(lang),
    t,
    m: (message) => translate(lang, message.key, message.vars),
    rich: (key, vars) => splitTemplate(translate(lang, key)).map((part, i) =>
      typeof part === 'string'
        ? part
        : createElement(Fragment, { key: `${part.name}-${i}` }, part.name in vars ? vars[part.name] : `{${part.name}}`)),
  };
}

/** مترجم البوابة — يتبع لغة التطبيق (`useLang`) ومبدّلها */
export function useAxT(): AxI18n {
  const lang = useLang((s) => s.lang);
  return useMemo(() => makeAxI18n(lang), [lang]);
}

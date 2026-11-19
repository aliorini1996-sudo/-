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
  'tab.pricing': { ar: 'الباقات والأسعار', en: 'Plans & pricing', fr: 'Offres et tarifs', tr: 'Paketler ve fiyatlar', zh: '套餐与价格' },
  'pricing.title': { ar: 'باقات فيلد سيلز وأسعارها', en: 'Field Sales plans and prices', fr: 'Offres et tarifs Field Sales', tr: 'Field Sales paketleri ve fiyatları', zh: 'Field Sales 套餐与价格' },
  'pricing.regionBanner': { ar: 'أسعار خاصة بسفراء اليمن — خصم {pct} على كل الباقات', en: 'Special prices for ambassadors in Yemen — {pct} off every plan', fr: 'Tarifs spéciaux pour les ambassadeurs au Yémen — {pct} de remise sur toutes les offres', tr: 'Yemen’deki elçilere özel fiyatlar — tüm paketlerde {pct} indirim', zh: '也门推广大使专属价格 — 所有套餐优惠 {pct}' },
  'pricing.starter': { ar: 'المبتدئة', en: 'Starter', fr: 'Débutant', tr: 'Başlangıç', zh: '入门版' },
  'pricing.growth': { ar: 'المتوسطة', en: 'Growth', fr: 'Croissance', tr: 'Büyüme', zh: '成长版' },
  'pricing.pro': { ar: 'الاحترافية', en: 'Professional', fr: 'Professionnel', tr: 'Profesyonel', zh: '专业版' },
  'pricing.starterLimit': { ar: 'حتى ٥ مناديب ومستخدم إداري واحد', en: 'Up to 5 reps · 1 admin user', fr: 'Jusqu’à 5 commerciaux · 1 utilisateur admin', tr: '5 temsilciye kadar · 1 yönetici', zh: '最多 5 名业务员 · 1 个管理账号' },
  'pricing.growthLimit': { ar: 'حتى ١٠ مناديب ومستخدمَين إداريَّين', en: 'Up to 10 reps · 2 admin users', fr: 'Jusqu’à 10 commerciaux · 2 utilisateurs admin', tr: '10 temsilciye kadar · 2 yönetici', zh: '最多 10 名业务员 · 2 个管理账号' },
  'pricing.proLimit': { ar: 'حتى ٢٠ مندوباً و٥ مستخدمين إداريين', en: 'Up to 20 reps · 5 admin users', fr: 'Jusqu’à 20 commerciaux · 5 utilisateurs admin', tr: '20 temsilciye kadar · 5 yönetici', zh: '最多 20 名业务员 · 5 个管理账号' },
  'pricing.monthly': { ar: 'شهرياً', en: 'Monthly', fr: 'Mensuel', tr: 'Aylık', zh: '按月' },
  'pricing.yearly': { ar: 'سنوياً', en: 'Yearly', fr: 'Annuel', tr: 'Yıllık', zh: '按年' },
  'pricing.vatNote': { ar: 'كل الأسعار شاملة ضريبة القيمة المضافة', en: 'All prices include VAT', fr: 'Tous les prix incluent la TVA', tr: 'Tüm fiyatlara KDV dahildir', zh: '所有价格均含增值税' },
  'pricing.commissionNote': { ar: 'عمولتك {rate} من مبلغ الدفعة الأولى لكل منشأة تشترك عبرك', en: 'Your commission is {rate} of the first payment of every company that subscribes through you', fr: 'Votre commission est de {rate} du premier paiement de chaque entreprise abonnée via vous', tr: 'Komisyonunuz, sizin aracılığınızla abone olan her şirketin ilk ödemesinin {rate} kadarıdır', zh: '您的佣金为通过您订阅的每家公司首笔付款的 {rate}' },
  'tab.claims': { ar: 'رشّح شركة', en: 'Nominate a company', fr: 'Recommander une entreprise', tr: 'Şirket öner', zh: '推荐企业' },
  'tab.trial': { ar: 'افتح حساباً تجريبياً', en: 'Open a trial account', fr: 'Ouvrir un compte d’essai', tr: 'Deneme hesabı aç', zh: '开通试用账户' },
  'tab.companies': { ar: 'شركاتي', en: 'My companies', fr: 'Mes entreprises', tr: 'Şirketlerim', zh: '我的企业' },
  'tab.earnings': { ar: 'أرباحي', en: 'My earnings', fr: 'Mes gains', tr: 'Kazançlarım', zh: '我的收益' },
  'tab.profile': { ar: 'ملفي', en: 'My profile', fr: 'Mon profil', tr: 'Profilim', zh: '我的资料' },
  'tab.terms': { ar: 'الشروط', en: 'Terms', fr: 'Conditions', tr: 'Şartlar', zh: '条款' },

  // ─── الأخطاء والرسائل المعروفة ───
  'err.generic': { ar: 'حدث خطأ غير متوقع', en: 'Something went wrong', fr: 'Une erreur inattendue s’est produite', tr: 'Beklenmeyen bir hata oluştu', zh: '发生意外错误' },
  'err.loadData': { ar: 'تعذّر تحميل البيانات', en: 'We couldn’t load this data', fr: 'Impossible de charger les données', tr: 'Veriler yüklenemedi', zh: '无法加载数据' },
  'err.tooMany': { ar: 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة', en: 'Too many attempts — please wait a moment and try again', fr: 'Trop de tentatives — patientez un instant puis réessayez', tr: 'Çok fazla deneme — lütfen biraz bekleyip tekrar deneyin', zh: '尝试次数过多，请稍候再试' },
  'err.tooManyOpenClaims': { ar: 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها', en: 'You have too many nominations under review — please wait for a decision on them', fr: 'Vous avez trop de recommandations en cours d’examen — attendez qu’une décision soit prise', tr: 'İncelemede çok fazla öneriniz var — lütfen bunlar hakkında karar verilmesini bekleyin', zh: '您待审核的推荐过多，请等待审核结果后再提交' },
  'err.network': { ar: 'تعذّر الاتصال بالخادم — تحقق من الإنترنت', en: 'Can’t reach the server — check your internet connection', fr: 'Connexion au serveur impossible — vérifiez votre accès Internet', tr: 'Sunucuya bağlanılamadı — internet bağlantınızı kontrol edin', zh: '无法连接服务器，请检查网络连接' },
  'err.termsOutdated': { ar: 'نُشرت شروطٌ جديدة — اقرأها واقبلها للمتابعة', en: 'New program terms have been published — please review and accept them to continue', fr: 'De nouvelles conditions ont été publiées — lisez-les et acceptez-les pour continuer', tr: 'Yeni program şartları yayımlandı — devam etmek için okuyup kabul edin', zh: '已发布新的计划条款，请阅读并接受后继续' },
  'err.trialDailyCap': { ar: 'بلغت حدّ الحسابات التجريبية لهذا اليوم — حاول غداً', en: 'You’ve reached today’s limit for trial accounts — please try again tomorrow', fr: 'Vous avez atteint la limite quotidienne de comptes d’essai — réessayez demain', tr: 'Bugünkü deneme hesabı sınırına ulaştınız — lütfen yarın tekrar deneyin', zh: '您今日开通试用账户的次数已达上限，请明天再试' },
  'err.trialPendingCap': { ar: 'لديك حسابات كثيرة لم تُفعَّل بعد — ذكّر مسؤوليها بتفعيلها أو اسحب ما فيه خطأ', en: 'You have too many accounts awaiting activation — remind their managers to activate them, or withdraw any with mistakes', fr: 'Vous avez trop de comptes en attente d’activation — rappelez à leurs responsables de les activer, ou retirez ceux qui comportent une erreur', tr: 'Etkinleştirilmeyi bekleyen çok fazla hesabınız var — yetkililerine etkinleştirmelerini hatırlatın veya hatalı olanları geri çekin', zh: '您有过多待激活的账户，请提醒负责人完成激活，或撤回信息有误的账户' },
  'err.resendCooldown': { ar: 'أُرسل بريد التفعيل قبل قليل — انتظر دقائق ثم أعد المحاولة', en: 'An activation email was sent a moment ago — wait a few minutes and try again', fr: 'Un e-mail d’activation vient d’être envoyé — patientez quelques minutes puis réessayez', tr: 'Az önce bir etkinleştirme e-postası gönderildi — birkaç dakika bekleyip tekrar deneyin', zh: '激活邮件刚刚已发送，请几分钟后再试' },
  'err.resendLimit': { ar: 'بلغت حدّ إعادة الإرسال لهذا الحساب — تواصل مع فريق فيلد سيلز', en: 'You’ve reached the resend limit for this account — please contact the Field Sales team', fr: 'Vous avez atteint la limite de renvois pour ce compte — contactez l’équipe Field Sales', tr: 'Bu hesap için tekrar gönderme sınırına ulaştınız — lütfen Field Sales ekibiyle iletişime geçin', zh: '该账户的重新发送次数已达上限，请联系 Field Sales 团队' },
  'err.resendWindow': { ar: 'انقضت مدّة إعادة الإرسال لهذا الحساب — تواصل مع فريق فيلد سيلز', en: 'The resend period for this account has ended — please contact the Field Sales team', fr: 'La période de renvoi pour ce compte est terminée — contactez l’équipe Field Sales', tr: 'Bu hesap için tekrar gönderme süresi doldu — lütfen Field Sales ekibiyle iletişime geçin', zh: '该账户的重新发送期限已过，请联系 Field Sales 团队' },
  'err.notPending': { ar: 'فُعّل هذا الحساب أو لم يعد بانتظار التفعيل', en: 'This account is already activated or no longer awaiting activation', fr: 'Ce compte est déjà activé ou n’est plus en attente d’activation', tr: 'Bu hesap zaten etkinleştirildi veya artık etkinleştirme beklemiyor', zh: '该账户已激活或不再处于待激活状态' },
  'err.portalTrialDisabled': { ar: 'فتح الحسابات التجريبية من البوابة متوقّف حالياً', en: 'Opening trial accounts from the portal is currently unavailable', fr: 'L’ouverture de comptes d’essai depuis le portail est actuellement indisponible', tr: 'Portaldan deneme hesabı açma şu anda kullanılamıyor', zh: '目前暂停通过门户开通试用账户' },
  'err.notFound': { ar: 'لم يعد هذا العنصر متاحاً — حدّث الصفحة', en: 'This item is no longer available — please refresh the page', fr: 'Cet élément n’est plus disponible — actualisez la page', tr: 'Bu öğe artık mevcut değil — lütfen sayfayı yenileyin', zh: '该项目已不可用，请刷新页面' },
  'err.hasPayment': { ar: 'لا يُسحب حسابٌ دفعت عنه الشركة', en: 'An account the company has already paid for can’t be withdrawn', fr: 'Un compte déjà payé par l’entreprise ne peut pas être retiré', tr: 'Şirketin ödeme yaptığı bir hesap geri çekilemez', zh: '公司已付费的账户无法撤回' },
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
  'login.invalid': { ar: 'تعذّر الدخول — تحقّق من البريد وكلمة المرور. وبعد محاولات متكرّرة يُقفل الدخول ربع ساعة', en: 'Sign-in failed — check your email and password. After repeated attempts, sign-in is locked for 15 minutes', fr: 'Connexion impossible — vérifiez votre e-mail et votre mot de passe. Après plusieurs tentatives, la connexion est bloquée 15 minutes', tr: 'Giriş yapılamadı — e-posta ve şifrenizi kontrol edin. Tekrarlanan denemelerden sonra giriş 15 dakika kilitlenir', zh: '登录失败：请检查邮箱和密码。多次尝试失败后，登录将锁定 15 分钟' },
  'login.forgot': { ar: 'نسيت كلمة المرور؟', en: 'Forgot your password?', fr: 'Mot de passe oublié ?', tr: 'Şifrenizi mi unuttunuz?', zh: '忘记密码？' },
  'login.notAmbassador': { ar: 'لست سفيراً بعد؟', en: 'Not an ambassador yet?', fr: 'Pas encore ambassadeur ?', tr: 'Henüz elçi değil misiniz?', zh: '还不是推荐大使？' },
  'login.apply': { ar: 'انضم الآن', en: 'Join now', fr: 'Rejoindre le programme', tr: 'Hemen katılın', zh: '立即加入' },

  // ─── التسجيل ───
  'reg.title': { ar: 'انضم إلى سفراء فيلد سيلز', en: 'Become a Field Sales Ambassador', fr: 'Devenez ambassadeur Field Sales', tr: 'Field Sales elçisi olun', zh: '成为 Field Sales 推荐大使' },
  'reg.subtitle': { ar: 'عمولتك {rate} من أول دفعة مؤكَّدة (شاملة الضريبة) لكل منشأة تشترك عبرك. تُحجز العمولة {days} من الدفع ثم تُعتمد تلقائياً، وتُسوّى كل {every} متى بلغ رصيدك {min}.', en: 'Earn {rate} of the first confirmed payment (VAT included) from every business that subscribes through you. Commissions are held for {days} after payment, then approved automatically, and settled every {every} once your balance reaches {min}.', fr: 'Gagnez {rate} du premier paiement confirmé (TVA incluse) de chaque entreprise qui s’abonne grâce à vous. La commission est bloquée {days} après le paiement, puis validée automatiquement et réglée tous les {every} dès que votre solde atteint {min}.', tr: 'Sizin aracılığınızla abone olan her işletmenin onaylanan ilk ödemesi (KDV dahil) üzerinden {rate} kazanın. Komisyon ödemeden sonra {days} bekletilir, ardından otomatik onaylanır ve bakiyeniz {min} tutarına ulaştığında {every} arayla ödenir.', zh: '每家经您推荐订阅的企业，您可获得其首笔确认付款（含增值税）的 {rate}。佣金在付款后冻结 {days}，随后自动批准，余额达到 {min} 后每 {every}结算一次。' },
  'reg.termsChanged': { ar: 'صدر إصدار جديد من الشروط — راجعه ووافق عليه ثم أعد الإرسال', en: 'A new version of the terms was just published — review and accept it, then submit again', fr: 'Une nouvelle version des conditions vient d’être publiée — prenez-en connaissance, acceptez-la puis renvoyez le formulaire', tr: 'Şartların yeni bir sürümü yayımlandı — inceleyip kabul edin, ardından tekrar gönderin', zh: '条款已更新，请阅读并同意新版本后重新提交' },
  'reg.failed': { ar: 'تعذّر إنشاء الحساب', en: 'We couldn’t create your account', fr: 'Impossible de créer votre compte', tr: 'Hesabınız oluşturulamadı', zh: '账户创建失败' },
  'reg.closedTitle': { ar: 'الانضمام مغلق حالياً', en: 'Applications are currently closed', fr: 'Les candidatures sont actuellement fermées', tr: 'Başvurular şu anda kapalı', zh: '暂不接受新申请' },
  'reg.closedBody': { ar: 'لا نستقبل طلبات سفراء جدد في الوقت الحالي. إن كان لديك حساب فيمكنك الدخول كالمعتاد.', en: 'We’re not accepting new ambassador applications right now. If you already have an account, you can sign in as usual.', fr: 'Nous n’acceptons pas de nouvelles candidatures d’ambassadeurs pour le moment. Si vous avez déjà un compte, vous pouvez vous connecter normalement.', tr: 'Şu anda yeni elçi başvurusu kabul etmiyoruz. Hesabınız varsa her zamanki gibi giriş yapabilirsiniz.', zh: '目前暂不接受新的推荐大使申请。如已有账户，可照常登录。' },
  'reg.acceptTerms': { ar: 'قرأت شروط البرنامج وأوافق عليها', en: 'I have read and agree to the program terms', fr: 'J’ai lu et j’accepte les conditions du programme', tr: 'Program şartlarını okudum ve kabul ediyorum', zh: '我已阅读并同意计划条款' },
  'reg.marketingOptional': { ar: 'أوافق على تلقي رسائل عن البرنامج وتحديثاته (اختياري)', en: 'Send me news and updates about the program (optional)', fr: 'J’accepte de recevoir des actualités sur le programme (facultatif)', tr: 'Program ve güncellemeleri hakkında bilgilendirme mesajları almayı kabul ediyorum (isteğe bağlı)', zh: '我愿意接收有关本计划的消息与更新（选填）' },
  'reg.submit': { ar: 'أنشئ حسابي وابدأ', en: 'Create my account', fr: 'Créer mon compte', tr: 'Hesabımı oluştur', zh: '创建我的账户' },
  'reg.haveAccount': { ar: 'لديك حساب؟', en: 'Already have an account?', fr: 'Vous avez déjà un compte ?', tr: 'Hesabınız var mı?', zh: '已有账户？' },
  'reg.signIn': { ar: 'سجّل الدخول', en: 'Sign in', fr: 'Connectez-vous', tr: 'Giriş yapın', zh: '登录' },

  // ─── الشروط ───
  'terms.label': { ar: 'شروط البرنامج', en: 'Program terms', fr: 'Conditions du programme', tr: 'Program şartları', zh: '计划条款' },
  'terms.arabicBinding': { ar: 'النصّ العربي هو النسخة المعتمدة.', en: 'The Arabic text is the binding version.', fr: 'Le texte arabe fait foi.', tr: 'Bağlayıcı olan metin Arapça metindir.', zh: '以阿拉伯语文本为准。' },
  'terms.summary': { ar: 'ملخّص البرنامج', en: 'Program summary', fr: 'Résumé du programme', tr: 'Program özeti', zh: '计划概要' },
  'terms.commission': { ar: 'العمولة: {rate} من مبلغ الدفعة الأولى المؤكَّدة للمنشأة (شاملة الضريبة) — مرة واحدة لكل منشأة.', en: 'Commission: {rate} of the business’s first confirmed payment (VAT included) — once per business.', fr: 'Commission : {rate} du premier paiement confirmé de l’entreprise (TVA incluse) — une seule fois par entreprise.', tr: 'Komisyon: İşletmenin onaylanan ilk ödemesi (KDV dahil) üzerinden {rate} — her işletme için yalnızca bir kez.', zh: '佣金：企业首笔确认付款（含增值税）的 {rate}，每家企业仅计一次。' },
  'terms.hold': { ar: 'فترة الحجز: {days} من تاريخ الدفع، ثم تُعتمد العمولة تلقائياً.', en: 'Holding period: {days} from the payment date, then the commission is approved automatically.', fr: 'Période de blocage : {days} à compter de la date de paiement, puis la commission est validée automatiquement.', tr: 'Bekleme süresi: ödeme tarihinden itibaren {days}, ardından komisyon otomatik olarak onaylanır.', zh: '冻结期：自付款之日起 {days}，期满后佣金自动批准。' },
  'terms.min': { ar: 'التسوية كل {every} بحدٍّ أدنى {min} — وما دونه يُرحَّل للدورة التالية.', en: 'Settlement every {every} with a minimum of {min} — anything below rolls over to the next cycle.', fr: 'Règlement tous les {every} avec un minimum de {min} — tout montant inférieur est reporté au cycle suivant.', tr: 'Ödeme {every} arayla, asgari {min} ile yapılır — altındaki tutar bir sonraki döngüye aktarılır.', zh: '每 {every}结算一次，最低 {min}，不足部分顺延至下一周期。' },
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


  // ─── نسيت كلمة المرور ───
  'mail.sendFailed': { ar: 'تعذّر الإرسال', en: 'We couldn’t send the email', fr: 'Envoi impossible', tr: 'Gönderilemedi', zh: '发送失败' },
  'mail.checkSpam': { ar: 'تفقّد مجلد الرسائل غير المرغوب فيها إن لم تجدها.', en: 'Can’t find it? Check your spam folder.', fr: 'Vous ne le trouvez pas ? Vérifiez vos courriers indésirables.', tr: 'Bulamazsanız istenmeyen e-posta klasörünü kontrol edin.', zh: '如未收到，请检查垃圾邮件文件夹。' },
  'forgot.title': { ar: 'استعادة كلمة المرور', en: 'Reset your password', fr: 'Réinitialiser le mot de passe', tr: 'Şifrenizi sıfırlayın', zh: '找回密码' },
  'forgot.subtitle': { ar: 'أدخل بريدك وسنرسل لك رابطاً لتعيين كلمة مرور جديدة.', en: 'Enter your email and we’ll send you a link to set a new password.', fr: 'Saisissez votre e-mail et nous vous enverrons un lien pour définir un nouveau mot de passe.', tr: 'E-postanızı girin, yeni şifre belirlemeniz için size bir bağlantı gönderelim.', zh: '输入邮箱，我们将发送设置新密码的链接。' },
  'forgot.action': { ar: 'أرسل رابط الاستعادة', en: 'Send reset link', fr: 'Envoyer le lien', tr: 'Sıfırlama bağlantısı gönder', zh: '发送重置链接' },

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
  'status.rejected.title': { ar: 'لم يُقبل طلب الانضمام', en: 'Application not accepted', fr: 'Candidature non retenue', tr: 'Başvuru kabul edilmedi', zh: '申请未通过' },
  'status.rejected.body': { ar: 'نعتذر، لم نتمكن من قبول طلبك في البرنامج حالياً.', en: 'We’re sorry, we’re unable to accept your application to the program at this time.', fr: 'Nous sommes désolés, nous ne pouvons pas accepter votre candidature pour le moment.', tr: 'Üzgünüz, başvurunuzu şu anda programa kabul edemiyoruz.', zh: '很抱歉，您加入本计划的申请目前未能通过。' },
  'status.suspended.title': { ar: 'حسابك موقوف', en: 'Your account is suspended', fr: 'Votre compte est suspendu', tr: 'Hesabınız askıya alındı', zh: '您的账户已暂停' },
  'status.suspended.body': { ar: 'أُوقف حسابك في برنامج السفراء. للاستفسار راسل فريق فيلد سيلز من بريدك المسجّل.', en: 'Your ambassador account has been suspended. For questions, email the Field Sales team from your registered email address.', fr: 'Votre compte ambassadeur a été suspendu. Pour toute question, écrivez à l’équipe Field Sales depuis votre adresse e-mail enregistrée.', tr: 'Elçi hesabınız askıya alındı. Sorularınız için kayıtlı e-posta adresinizden Field Sales ekibine yazın.', zh: '您的推荐大使账户已被暂停。如有疑问，请使用注册邮箱联系 Field Sales 团队。' },
  'status.reason': { ar: 'السبب', en: 'Reason', fr: 'Motif', tr: 'Gerekçe', zh: '原因' },

  // ─── الرئيسية ورابطي ───
  'home.hello': { ar: 'أهلاً {name}', en: 'Welcome, {name}', fr: 'Bonjour {name}', tr: 'Merhaba {name}', zh: '{name}，您好' },
  'home.intro': { ar: 'عمولتك {rate} من أول دفعة مؤكَّدة لكل منشأة تشترك عبرك، تُحجز {days} ثم تُعتمد تلقائياً.', en: 'You earn {rate} of the first confirmed payment from every business that subscribes through you. Commissions are held for {days}, then approved automatically.', fr: 'Vous touchez {rate} du premier paiement confirmé de chaque entreprise abonnée grâce à vous ; la commission est bloquée {days}, puis validée automatiquement.', tr: 'Sizin aracılığınızla abone olan her işletmenin onaylanan ilk ödemesi üzerinden {rate} kazanırsınız; komisyon {days} bekletilir, ardından otomatik onaylanır.', zh: '每家经您推荐订阅的企业，您可获得其首笔确认付款的 {rate}，佣金冻结 {days}后自动批准。' },
  'stat.clicks': { ar: 'نقرات آخر 30 يوماً', en: 'Clicks (last 30 days)', fr: 'Clics (30 derniers jours)', tr: 'Tıklamalar (son 30 gün)', zh: '近 30 天点击' },
  'stat.signups': { ar: 'منشآت سجّلت', en: 'Businesses signed up', fr: 'Entreprises inscrites', tr: 'Kaydolan işletmeler', zh: '已注册企业' },
  'stat.paid': { ar: 'منشآت دفعت', en: 'Businesses that paid', fr: 'Entreprises ayant payé', tr: 'Ödeme yapan işletmeler', zh: '已付款企业' },
  'stat.pending': { ar: 'عمولات معلّقة', en: 'Pending commissions', fr: 'Commissions en attente', tr: 'Bekleyen komisyonlar', zh: '待审核佣金' },
  'stat.approved': { ar: 'عمولات معتمدة', en: 'Approved commissions', fr: 'Commissions validées', tr: 'Onaylanan komisyonlar', zh: '已批准佣金' },
  'stat.paidCommissions': { ar: 'عمولات مدفوعة', en: 'Paid commissions', fr: 'Commissions versées', tr: 'Ödenen komisyonlar', zh: '已支付佣金' },
  'home.adjustments': { ar: 'تعديلات تُحتسب في تسويتك القادمة', en: 'Adjustments applied to your next settlement', fr: 'Ajustements à imputer sur votre prochain règlement', tr: 'Bir sonraki ödemenize yansıyacak düzeltmeler', zh: '将计入下次结算的调整项' },
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
  'companies.holdEnded': { ar: 'انتهت فترة الحجز في {date} — تُعتمد تلقائياً', en: 'Holding period ended on {date} — approval is automatic', fr: 'Période de blocage terminée le {date} — validation automatique', tr: 'Bekleme süresi {date} tarihinde bitti — onay otomatik', zh: '冻结期已于 {date} 结束，将自动批准' },
  'companies.dueDate': { ar: 'تاريخ الاستحقاق {date}', en: 'Eligibility date: {date}', fr: 'Date d’exigibilité : {date}', tr: 'Hak ediş tarihi {date}', zh: '可结算日期 {date}' },

  // ─── أرباحي ───
  'earn.info1': { ar: 'تُنشأ العمولة {pending} عند تأكيد أول دفعة للمنشأة، وتُحجز {days} من تاريخ الدفع للتأكد من عدم استرداد المبلغ، ثم تصبح {approved} تلقائياً.', en: 'A commission is created as {pending} once the business’s first payment is confirmed. It is held for {days} from the payment date to make sure the payment isn’t refunded, then becomes {approved} automatically.', fr: 'La commission est créée avec le statut {pending} dès la confirmation du premier paiement de l’entreprise. Elle reste bloquée {days} à compter de la date de paiement, le temps de vérifier que ce paiement n’est pas remboursé, puis passe automatiquement au statut {approved}.', tr: 'Komisyon, işletmenin ilk ödemesi onaylandığında {pending} durumunda oluşturulur. Ödemenin iade edilmediğinden emin olmak için ödeme tarihinden itibaren {days} bekletilir, ardından otomatik olarak {approved} olur.', zh: '企业首笔付款确认后，佣金以{pending}状态生成，并自付款之日起冻结 {days}，以确保该笔款项未发生退款，随后自动变为{approved}。' },
  'earn.info2': { ar: 'كل {every} تُجمع عمولاتك المعتمدة في تسويةٍ متى بلغ صافيها {min} (وما دونه يُرحَّل)، ويحوّلها فريق فيلد سيلز إلى حسابك البنكي فتصبح {paid} — ويلزم لذلك اكتمال ملفك. إن استُردّت دفعةٌ بعد تحويل عمولتها يُخصم مقدارها من تسويتك القادمة.', en: 'Every {every}, your approved commissions are grouped into a settlement once their net total reaches {min} (anything below rolls over). The Field Sales team transfers it to your bank account and it becomes {paid} — this requires a complete profile. If a payment is refunded after its commission was paid out, that amount is deducted from your next settlement.', fr: 'Tous les {every}, vos commissions validées sont regroupées dans un règlement dès que leur montant net atteint {min} (tout montant inférieur est reporté). L’équipe Field Sales le vire sur votre compte bancaire et il passe au statut {paid} — un profil complet est requis. Si un paiement est remboursé après le versement de sa commission, ce montant est déduit de votre prochain règlement.', tr: '{every} arayla, onaylanan komisyonlarınız net toplamı {min} tutarına ulaştığında bir ödemede toplanır (altındaki tutar aktarılır). Field Sales ekibi bunu banka hesabınıza aktarır ve durumu {paid} olur — bunun için profilinizin tamamlanmış olması gerekir. Komisyonu ödendikten sonra bir ödeme iade edilirse, bu tutar bir sonraki ödemenizden düşülür.', zh: '每 {every}，已批准佣金的净额达到 {min} 后会汇总为一笔结算（不足部分顺延），由 Field Sales 团队转入您的银行账户并标记为{paid}——前提是资料已完善。若某笔付款在佣金支付后被退款，相应金额将从下次结算中扣除。' },
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
  'earn.adjustments': { ar: 'التعديلات', en: 'Adjustments', fr: 'Ajustements', tr: 'Düzeltmeler', zh: '调整项' },
  'earn.noAdjustments': { ar: 'لا تعديلات', en: 'No adjustments', fr: 'Aucun ajustement', tr: 'Düzeltme yok', zh: '暂无调整项' },
  'earn.settled': { ar: 'احتُسبت في تسوية سابقة', en: 'Applied in a previous settlement', fr: 'Imputé lors d’un règlement précédent', tr: 'Önceki bir ödemede mahsup edildi', zh: '已在之前的结算中计入' },
  'earn.nextPayout': { ar: 'تُحتسب في تسويتك القادمة', en: 'Applied to your next settlement', fr: 'À imputer sur votre prochain règlement', tr: 'Bir sonraki ödemenize yansıtılır', zh: '计入下次结算' },
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

  // ─── افتح حساباً تجريبياً ───
  'trial.title': { ar: 'افتح حساباً تجريبياً لشركة', en: 'Open a trial account for a business', fr: 'Ouvrir un compte d’essai pour une entreprise', tr: 'Bir işletme için deneme hesabı açın', zh: '为企业开通试用账户' },
  'trial.intro': { ar: 'شركةٌ طلبت تجربة فيلد سيلز؟ افتح لها الحساب من هنا فيُسند إليك مباشرة. يصل مسؤولَ الشركة بريدٌ ليختار كلمة مروره بنفسه ويبدأ تجربته — ولا تصلك كلمة المرور ولا رابط التفعيل أبداً.', en: 'Has a business asked to try Field Sales? Open its account here and it’s attributed to you directly. The company’s manager receives an email to choose their own password and start the trial — you never receive the password or the activation link.', fr: 'Une entreprise souhaite essayer Field Sales ? Ouvrez son compte ici : il vous est attribué directement. Le responsable de l’entreprise reçoit un e-mail pour choisir lui-même son mot de passe et démarrer l’essai — vous ne recevez jamais ni le mot de passe ni le lien d’activation.', tr: 'Bir işletme Field Sales’i denemek mi istiyor? Hesabını buradan açın; doğrudan size atanır. Şirket yetkilisine kendi şifresini belirleyip denemeyi başlatması için bir e-posta gönderilir — şifre veya etkinleştirme bağlantısı size asla gönderilmez.', zh: '有企业想试用 Field Sales？在此为其开通账户，该企业将直接归属于您。企业负责人会收到一封邮件，自行设置密码并开始试用——您不会收到密码或激活链接。' },
  'trial.companyName': { ar: 'اسم الشركة', en: 'Business name', fr: 'Nom de l’entreprise', tr: 'İşletme adı', zh: '企业名称' },
  'trial.country': { ar: 'دولة الشركة', en: 'Business country', fr: 'Pays de l’entreprise', tr: 'İşletmenin ülkesi', zh: '企业所在国家' },
  'trial.countryHint': { ar: 'تضبط عملة الحساب وضريبته', en: 'Sets the account’s currency and VAT', fr: 'Définit la devise et la TVA du compte', tr: 'Hesabın para birimini ve KDV oranını belirler', zh: '用于设置账户的币种和增值税' },
  'trial.adminName': { ar: 'اسم مسؤول الشركة', en: 'Manager’s name', fr: 'Nom du responsable', tr: 'Yetkilinin adı', zh: '负责人姓名' },
  'trial.adminEmail': { ar: 'بريد مسؤول الشركة', en: 'Manager’s email', fr: 'E-mail du responsable', tr: 'Yetkilinin e-postası', zh: '负责人邮箱' },
  'trial.adminEmailHint': { ar: 'يصله رابط التفعيل، ويصير اسم دخوله إلى الحساب', en: 'The activation link is sent here, and it becomes their sign-in username', fr: 'Le lien d’activation y est envoyé ; ce sera son identifiant de connexion', tr: 'Etkinleştirme bağlantısı bu adrese gider ve giriş kullanıcı adı olur', zh: '激活链接将发送至此邮箱，该邮箱也将作为其登录用户名' },
  'trial.adminPhone': { ar: 'جوال مسؤول الشركة', en: 'Manager’s mobile', fr: 'Mobile du responsable', tr: 'Yetkilinin cep telefonu', zh: '负责人手机' },
  'trial.cr': { ar: 'السجل التجاري (اختياري)', en: 'Commercial Registration (optional)', fr: 'N° de registre du commerce (facultatif)', tr: 'Ticari sicil (isteğe bağlı)', zh: '商业登记号（选填）' },
  'trial.crHint': { ar: '10 أرقام — يربط الحساب بترشيحك المعتمد لهذه الشركة إن وُجد', en: '10 digits — links the account to your accepted nomination for this business, if any', fr: '10 chiffres — relie le compte à votre recommandation acceptée pour cette entreprise, le cas échéant', tr: '10 hane — varsa bu işletme için kabul edilmiş önerinizle hesabı eşleştirir', zh: '10 位数字——如您对该企业的推荐已获批，将据此关联' },
  'trial.consent': { ar: 'أقرّ بأن الشركة طلبت فتح هذا الحساب، ووافقت على أن يصل مسؤولَها بريد التفعيل', en: 'I confirm the business asked for this account and agreed that its manager receives the activation email', fr: 'Je confirme que l’entreprise a demandé ce compte et accepte que son responsable reçoive l’e-mail d’activation', tr: 'İşletmenin bu hesabı talep ettiğini ve yetkilisine etkinleştirme e-postası gönderilmesini kabul ettiğini onaylıyorum', zh: '我确认该企业已申请开通此账户，并同意其负责人接收激活邮件' },
  'trial.privacy': { ar: 'رابط التفعيل يصل بريد المسؤول وحده. لا تُعرض لك كلمة المرور ولا الرابط، ولا تستطيع دخول حساب الشركة.', en: 'The activation link goes to the manager’s email only. You never see the password or the link, and you can’t sign in to the company’s account.', fr: 'Le lien d’activation est envoyé uniquement à l’e-mail du responsable. Vous ne voyez jamais le mot de passe ni le lien, et vous ne pouvez pas accéder au compte de l’entreprise.', tr: 'Etkinleştirme bağlantısı yalnızca yetkilinin e-postasına gider. Şifreyi veya bağlantıyı asla görmezsiniz ve şirket hesabına giriş yapamazsınız.', zh: '激活链接仅发送至负责人邮箱。您不会看到密码或链接，也无法登录该企业账户。' },
  'trial.submit': { ar: 'افتح الحساب وأرسل بريد التفعيل', en: 'Open account and send activation email', fr: 'Ouvrir le compte et envoyer l’e-mail d’activation', tr: 'Hesabı aç ve etkinleştirme e-postasını gönder', zh: '开通账户并发送激活邮件' },
  'trial.accepted': { ar: 'استلمنا الطلب — إن كانت البيانات صحيحة فسيصل مسؤولَ الشركة بريدُ تفعيل الحساب', en: 'Request received — if the details are correct, the company’s manager will receive an account activation email', fr: 'Demande reçue — si les informations sont correctes, le responsable de l’entreprise recevra un e-mail d’activation du compte', tr: 'Talep alındı — bilgiler doğruysa şirket yetkilisine hesap etkinleştirme e-postası gönderilecek', zh: '已收到请求——如信息无误，企业负责人将收到账户激活邮件' },
  'trial.failed': { ar: 'تعذّر إرسال الطلب', en: 'We couldn’t submit the request', fr: 'Impossible d’envoyer la demande', tr: 'Talep gönderilemedi', zh: '请求提交失败' },
  'trial.mine': { ar: 'حسابات فتحتها', en: 'Accounts you opened', fr: 'Comptes que vous avez ouverts', tr: 'Açtığınız hesaplar', zh: '您开通的账户' },
  'trial.empty': { ar: 'لم تفتح حساباً بعد', en: 'You haven’t opened any accounts yet', fr: 'Vous n’avez encore ouvert aucun compte', tr: 'Henüz hesap açmadınız', zh: '您尚未开通任何账户' },
  'trial.emptyHint': { ar: 'الحسابات التي فتحتها وحالة تفعيلها تظهر هنا.', en: 'Accounts you’ve opened and their activation status appear here.', fr: 'Les comptes que vous avez ouverts et leur statut d’activation apparaissent ici.', tr: 'Açtığınız hesaplar ve etkinleştirme durumları burada görünür.', zh: '您开通的账户及其激活状态将显示在这里。' },
  'trial.openedOn': { ar: 'فُتح {date}', en: 'Opened {date}', fr: 'Ouvert le {date}', tr: 'Açıldı: {date}', zh: '开通于 {date}' },
  'trial.resend': { ar: 'أعد إرسال بريد التفعيل', en: 'Resend activation email', fr: 'Renvoyer l’e-mail d’activation', tr: 'Etkinleştirme e-postasını tekrar gönder', zh: '重新发送激活邮件' },
  'trial.resent': { ar: 'أُعيد إرسال بريد التفعيل إلى البريد المسجَّل', en: 'The activation email was sent again to the registered address', fr: 'L’e-mail d’activation a été renvoyé à l’adresse enregistrée', tr: 'Etkinleştirme e-postası kayıtlı adrese tekrar gönderildi', zh: '激活邮件已重新发送至登记邮箱' },
  'trial.resendFailed': { ar: 'تعذّرت إعادة الإرسال', en: 'We couldn’t resend the email', fr: 'Impossible de renvoyer l’e-mail', tr: 'E-posta tekrar gönderilemedi', zh: '重新发送失败' },
  'trial.withdraw': { ar: 'سحب الحساب', en: 'Withdraw account', fr: 'Retirer le compte', tr: 'Hesabı geri çek', zh: '撤回账户' },
  'trial.withdrawConfirm': { ar: 'سحب حساب «{name}»؟ يُلغى قبل تفعيله، ويمكنك فتحه من جديد ببياناتٍ صحيحة.', en: 'Withdraw the account for “{name}”? It’s cancelled before activation, and you can open it again with the correct details.', fr: 'Retirer le compte « {name} » ? Il est annulé avant son activation et vous pourrez le rouvrir avec les bonnes informations.', tr: '“{name}” hesabı geri çekilsin mi? Etkinleştirilmeden iptal edilir ve doğru bilgilerle yeniden açabilirsiniz.', zh: '确定撤回“{name}”的账户吗？该账户将在激活前取消，您可使用正确信息重新开通。' },
  'trial.withdrawn': { ar: 'سُحب الحساب', en: 'Account withdrawn', fr: 'Compte retiré', tr: 'Hesap geri çekildi', zh: '账户已撤回' },
  'trial.withdrawFailed': { ar: 'تعذّر سحب الحساب', en: 'We couldn’t withdraw this account', fr: 'Impossible de retirer le compte', tr: 'Hesap geri çekilemedi', zh: '撤回账户失败' },

  // ─── الملف ───
  'profile.mine': { ar: 'بياناتي', en: 'My details', fr: 'Mes informations', tr: 'Bilgilerim', zh: '我的信息' },
  'profile.name': { ar: 'الاسم', en: 'Name', fr: 'Nom', tr: 'Ad', zh: '姓名' },
  'profile.email': { ar: 'البريد', en: 'Email', fr: 'E-mail', tr: 'E-posta', zh: '邮箱' },
  'profile.phone': { ar: 'الجوال', en: 'Mobile', fr: 'Mobile', tr: 'Cep telefonu', zh: '手机' },
  'profile.code': { ar: 'رمز الإحالة', en: 'Referral code', fr: 'Code de parrainage', tr: 'Referans kodu', zh: '推荐码' },
  'profile.memberSince': { ar: 'عضو منذ', en: 'Member since', fr: 'Membre depuis', tr: 'Üyelik tarihi', zh: '加入时间' },
  'profile.editHint': { ar: 'لتعديل الاسم أو البريد أو الجوال راسل فريق فيلد سيلز من بريدك المسجّل.', en: 'To change your name, email or mobile number, email the Field Sales team from your registered address.', fr: 'Pour modifier votre nom, votre e-mail ou votre mobile, écrivez à l’équipe Field Sales depuis votre adresse enregistrée.', tr: 'Adınızı, e-postanızı veya cep telefonunuzu değiştirmek için kayıtlı adresinizden Field Sales ekibine yazın.', zh: '如需修改姓名、邮箱或手机号，请使用注册邮箱联系 Field Sales 团队。' },
  'profile.marketing': { ar: 'أوافق على تلقي رسائل عن البرنامج وتحديثاته', en: 'Send me news and updates about the program', fr: 'J’accepte de recevoir des actualités sur le programme', tr: 'Program ve güncellemeleri hakkında bilgilendirme mesajları almayı kabul ediyorum', zh: '我愿意接收有关本计划的消息与更新' },
  'profile.save': { ar: 'حفظ التغييرات', en: 'Save changes', fr: 'Enregistrer', tr: 'Değişiklikleri kaydet', zh: '保存更改' },
  'profile.saved': { ar: 'تم حفظ بياناتك', en: 'Your details have been saved', fr: 'Vos informations ont été enregistrées', tr: 'Bilgileriniz kaydedildi', zh: '信息已保存' },
  'profile.saveFailed': { ar: 'تعذّر حفظ البيانات', en: 'We couldn’t save your details', fr: 'Impossible d’enregistrer vos informations', tr: 'Bilgiler kaydedilemedi', zh: '保存失败' },
  'profile.noChanges': { ar: 'لا تغييرات للحفظ', en: 'No changes to save', fr: 'Aucune modification à enregistrer', tr: 'Kaydedilecek değişiklik yok', zh: '没有需要保存的更改' },
  'payout.title': { ar: 'الحساب البنكي', en: 'Bank account', fr: 'Compte bancaire', tr: 'Banka hesabı', zh: '银行账户' },
  'payout.updatedAt': { ar: 'آخر تحديث {date}', en: 'Last updated {date}', fr: 'Mis à jour le {date}', tr: 'Son güncelleme: {date}', zh: '最后更新 {date}' },
  'payout.update': { ar: 'تحديث', en: 'Update', fr: 'Modifier', tr: 'Güncelle', zh: '更新' },
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
  'val.adminName': { ar: 'اسم المسؤول بين حرفين و80 حرفاً', en: 'Manager’s name must be 2–80 characters', fr: 'Le nom du responsable doit comporter entre 2 et 80 caractères', tr: 'Yetkilinin adı 2–80 karakter olmalıdır', zh: '负责人姓名须为 2–80 个字符' },
  'val.adminEmail': { ar: 'بريد المسؤول غير صحيح', en: 'Enter a valid email for the manager', fr: 'Saisissez un e-mail valide pour le responsable', tr: 'Yetkili için geçerli bir e-posta girin', zh: '请输入负责人的有效邮箱' },
  'val.adminPhone': { ar: 'أدخل جوال المسؤول صحيحاً مع مفتاح دولته', en: 'Enter the manager’s valid mobile number with its country code', fr: 'Saisissez un numéro de mobile valide du responsable avec son indicatif', tr: 'Yetkilinin geçerli cep numarasını ülke koduyla girin', zh: '请输入负责人带国家代码的有效手机号码' },
  'val.selfContact': { ar: 'هذا بريدك أو جوالك — أدخل بريد مسؤول الشركة وجواله. ولمنشأتك أنت سجّل من صفحة التسجيل برمزك', en: 'That’s your own email or mobile — enter the company manager’s email and mobile. To register your own business, sign up on the sign-up page with your code', fr: 'C’est votre propre e-mail ou mobile — saisissez ceux du responsable de l’entreprise. Pour inscrire votre propre entreprise, utilisez la page d’inscription avec votre code', tr: 'Bu sizin e-postanız veya cep telefonunuz — şirket yetkilisinin e-postasını ve cep telefonunu girin. Kendi işletmenizi kaydetmek için kodunuzla kayıt sayfasını kullanın', zh: '这是您本人的邮箱或手机——请填写企业负责人的邮箱和手机。如需注册您自己的企业，请在注册页面使用您的推荐码注册' },
  'val.linkLike': { ar: 'اكتب الاسم فقط — بلا روابط أو مواقع أو بيانات اتصال', en: 'Enter the name only — no links, websites or contact details', fr: 'Indiquez uniquement le nom — sans lien, site web ni coordonnées', tr: 'Yalnızca adı yazın — bağlantı, web sitesi veya iletişim bilgisi olmadan', zh: '仅填写名称，请勿包含链接、网址或联系方式' },
  'val.consent': { ar: 'أكّد أن الشركة طلبت الحساب ووافقت على بريد التفعيل', en: 'Confirm that the business asked for the account and agreed to the activation email', fr: 'Confirmez que l’entreprise a demandé le compte et accepté l’e-mail d’activation', tr: 'İşletmenin hesabı talep ettiğini ve etkinleştirme e-postasını kabul ettiğini onaylayın', zh: '请确认该企业已申请开通账户并同意接收激活邮件' },

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
  'st.payout.draft': { ar: 'قيد المعالجة', en: 'Processing', fr: 'En cours de traitement', tr: 'İşleniyor', zh: '处理中' },
  'st.payout.recorded': { ar: 'مدفوعة', en: 'Paid', fr: 'Payé', tr: 'Ödendi', zh: '已支付' },
  'st.payout.void': { ar: 'ملغاة', en: 'Cancelled', fr: 'Annulé', tr: 'İptal edildi', zh: '已取消' },
  'st.company.trial': { ar: 'تجربة', en: 'Trial', fr: 'Essai', tr: 'Deneme', zh: '试用中' },
  'st.company.paid': { ar: 'دفعت', en: 'Paid', fr: 'Paiement reçu', tr: 'Ödeme yaptı', zh: '已付款' },
  'st.company.disputed': { ar: 'قيد المراجعة', en: 'Under review', fr: 'En cours d’examen', tr: 'İnceleniyor', zh: '审核中' },
  'st.company.void': { ar: 'ملغاة', en: 'Cancelled', fr: 'Annulée', tr: 'Geçersiz', zh: '已作废' },
  'st.company.expired': { ar: 'انتهت المهلة', en: 'Deadline passed', fr: 'Délai dépassé', tr: 'Süre doldu', zh: '已逾期' },
  'src.signup_code': { ar: 'سجّلت برابطك أو رمزك', en: 'Signed up with your link or code', fr: 'Inscrite avec votre lien ou votre code', tr: 'Bağlantınız veya kodunuzla kaydoldu', zh: '通过您的链接或推荐码注册' },
  'src.claim': { ar: 'ترشيح معتمد', en: 'Accepted nomination', fr: 'Recommandation acceptée', tr: 'Kabul edilen öneri', zh: '推荐已获批' },
  'src.owner': { ar: 'إسناد من الإدارة', en: 'Assigned by Field Sales', fr: 'Attribuée par Field Sales', tr: 'Field Sales tarafından atandı', zh: '由 Field Sales 指派' },
  'src.portal': { ar: 'فتحتَ حسابها من البوابة', en: 'Account opened by you in the portal', fr: 'Compte ouvert par vous depuis le portail', tr: 'Hesabını portaldan siz açtınız', zh: '由您在门户中开通' },
  'st.activation.pending': { ar: 'بانتظار التفعيل', en: 'Awaiting activation', fr: 'En attente d’activation', tr: 'Etkinleştirme bekleniyor', zh: '待激活' },
  'st.activation.active': { ar: 'مُفعَّل', en: 'Activated', fr: 'Activé', tr: 'Etkinleştirildi', zh: '已激活' },
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

  // ─── v2: التنقّل (شريط سفليّ + «المزيد» + شريط جانبيّ) ───
  'nav.more': { ar: 'المزيد', en: 'More', fr: 'Plus', tr: 'Daha fazla', zh: '更多' },
  'nav.close': { ar: 'إغلاق', en: 'Close', fr: 'Fermer', tr: 'Kapat', zh: '关闭' },
  'nav.bottom': { ar: 'التنقّل الرئيسي', en: 'Main navigation', fr: 'Navigation principale', tr: 'Ana gezinme', zh: '主导航' },
  'tab.missed': { ar: 'مطالبة بإحالة فائتة', en: 'Missed referral claim', fr: 'Réclamation de parrainage manqué', tr: 'Kaçırılan referans talebi', zh: '遗漏推荐申诉' },
  'tab.materials': { ar: 'المواد التسويقية', en: 'Marketing materials', fr: 'Supports marketing', tr: 'Pazarlama materyalleri', zh: '营销素材' },
  'tab.faq': { ar: 'الأسئلة الشائعة', en: 'FAQ', fr: 'Questions fréquentes', tr: 'Sık sorulan sorular', zh: '常见问题' },
  'tab.support': { ar: 'الدعم', en: 'Support', fr: 'Assistance', tr: 'Destek', zh: '帮助与支持' },

  // ─── v2: التسجيل الفوريّ ونوع السفير ───
  'reg.instant': { ar: 'حسابك يُفتح فوراً — بلا انتظار ولا تأكيد بريد.', en: 'Your account opens instantly — no waiting, no email confirmation.', fr: 'Votre compte est ouvert immédiatement — sans attente ni confirmation par e-mail.', tr: 'Hesabınız anında açılır — bekleme ve e-posta onayı yok.', zh: '账户即时开通，无需等待，也无需邮箱确认。' },
  'reg.partnerType': { ar: 'نوع السفير', en: 'Ambassador type', fr: 'Type d’ambassadeur', tr: 'Elçi türü', zh: '大使类型' },
  'reg.emailTaken': { ar: 'يوجد حساب بهذا البريد — سجّل الدخول', en: 'An account with this email already exists — please sign in', fr: 'Un compte existe déjà avec cet e-mail — connectez-vous', tr: 'Bu e-postayla bir hesap zaten var — lütfen giriş yapın', zh: '该邮箱已有账户，请直接登录' },
  'reg.welcome': { ar: 'أهلاً بك في سفراء فيلد سيلز!', en: 'Welcome to the Field Sales Ambassadors!', fr: 'Bienvenue parmi les ambassadeurs Field Sales !', tr: 'Field Sales Elçilerine hoş geldiniz!', zh: '欢迎加入 Field Sales 推荐大使！' },
  'partner.individual': { ar: 'فرد', en: 'Individual', fr: 'Particulier', tr: 'Bireysel', zh: '个人' },
  'partner.company': { ar: 'شركة', en: 'Company', fr: 'Entreprise', tr: 'Şirket', zh: '企业' },
  'partner.influencer': { ar: 'مؤثّر', en: 'Influencer', fr: 'Influenceur', tr: 'Influencer', zh: '博主/达人' },
  'partner.individualHint': { ar: 'تحيل الشركات من معارفك', en: 'Refer businesses from your network', fr: 'Recommandez des entreprises de votre réseau', tr: 'Çevrenizdeki işletmeleri yönlendirin', zh: '向您的人脉推荐企业' },
  'partner.companyHint': { ar: 'وكالة أو منشأة تحيل عملاءها', en: 'An agency or business referring its clients', fr: 'Une agence ou entreprise qui recommande ses clients', tr: 'Müşterilerini yönlendiren ajans veya işletme', zh: '推荐自有客户的机构或企业' },
  'partner.influencerHint': { ar: 'تنشر لجمهورك على المنصّات', en: 'You publish to your audience online', fr: 'Vous publiez pour votre audience en ligne', tr: 'Kitlenize çevrim içi içerik yayınlarsınız', zh: '面向您的线上受众发布内容' },
  'f.companyName': { ar: 'اسم الشركة', en: 'Company name', fr: 'Nom de l’entreprise', tr: 'Şirket adı', zh: '公司名称' },
  'val.partnerType': { ar: 'اختر نوع السفير', en: 'Choose your ambassador type', fr: 'Choisissez votre type d’ambassadeur', tr: 'Elçi türünüzü seçin', zh: '请选择大使类型' },
  'status.legacy.title': { ar: 'جارٍ تفعيل حسابك', en: 'Your account is being activated', fr: 'Votre compte est en cours d’activation', tr: 'Hesabınız etkinleştiriliyor', zh: '正在激活您的账户' },
  'status.legacy.body': { ar: 'سجّل الخروج ثم ادخل من جديد بكلمة مرورك ليُفعَّل حسابك فوراً.', en: 'Sign out, then sign in again with your password to activate your account instantly.', fr: 'Déconnectez-vous, puis reconnectez-vous avec votre mot de passe pour activer votre compte immédiatement.', tr: 'Hesabınızı hemen etkinleştirmek için çıkış yapın ve şifrenizle tekrar giriş yapın.', zh: '请退出后使用密码重新登录，账户将立即激活。' },

  // ─── v2: الرئيسية ───
  'home.completeTitle': { ar: 'أكمل ملفك لاستلام أرباحك', en: 'Complete your profile to receive your earnings', fr: 'Complétez votre profil pour recevoir vos gains', tr: 'Kazançlarınızı almak için profilinizi tamamlayın', zh: '完善资料以领取收益' },
  'home.completeMissing': { ar: 'ينقصك: {items}', en: 'Still needed: {items}', fr: 'Il manque : {items}', tr: 'Eksik: {items}', zh: '尚缺：{items}' },
  'home.completeCta': { ar: 'أكمل ملفي', en: 'Complete my profile', fr: 'Compléter mon profil', tr: 'Profilimi tamamla', zh: '去完善资料' },
  'share.cta': { ar: 'مشاركة رابطي', en: 'Share my link', fr: 'Partager mon lien', tr: 'Bağlantımı paylaş', zh: '分享我的链接' },
  'share.whatsapp': { ar: 'مشاركة عبر واتساب', en: 'Share on WhatsApp', fr: 'Partager sur WhatsApp', tr: 'WhatsApp ile paylaş', zh: '通过 WhatsApp 分享' },
  'share.invite': { ar: 'جرّب فيلد سيلز لإدارة مبيعاتك الميدانية ومندوبيك:', en: 'Try Field Sales to run your field sales team:', fr: 'Essayez Field Sales pour gérer vos ventes terrain :', tr: 'Saha satış ekibinizi yönetmek için Field Sales’i deneyin:', zh: '试用 Field Sales，轻松管理您的外勤销售团队：' },
  'steps.title': { ar: 'خطوات البداية', en: 'Getting started', fr: 'Premiers pas', tr: 'Başlangıç adımları', zh: '入门步骤' },
  'steps.account': { ar: 'أُنشئ حسابك', en: 'Account created', fr: 'Compte créé', tr: 'Hesabınız oluşturuldu', zh: '账户已创建' },
  'steps.shared': { ar: 'شارك رابطك', en: 'Share your link', fr: 'Partagez votre lien', tr: 'Bağlantınızı paylaşın', zh: '分享您的链接' },
  'steps.firstPaid': { ar: 'أول شركة تدفع', en: 'Your first paying company', fr: 'Votre première entreprise cliente', tr: 'İlk ödeme yapan şirketiniz', zh: '首家付费企业' },
  'kpi.totalEarned': { ar: 'إجمالي الأرباح', en: 'Total earnings', fr: 'Gains totaux', tr: 'Toplam kazanç', zh: '累计收益' },
  'kpi.pendingSettlement': { ar: 'تسوية معلّقة', en: 'Pending settlement', fr: 'Règlement en attente', tr: 'Bekleyen ödeme', zh: '待结算' },
  'kpi.activeReferrals': { ar: 'إحالات نشطة', en: 'Active referrals', fr: 'Parrainages actifs', tr: 'Aktif referanslar', zh: '有效推荐' },
  'kpi.conversion': { ar: 'معدل التحويل', en: 'Conversion rate', fr: 'Taux de conversion', tr: 'Dönüşüm oranı', zh: '转化率' },
  'chart.title': { ar: 'أرباحك في آخر ٦ أشهر', en: 'Your earnings over the last 6 months', fr: 'Vos gains sur les 6 derniers mois', tr: 'Son 6 aydaki kazançlarınız', zh: '近 6 个月收益' },
  'chart.empty': { ar: 'لا أرباح بعد — شارك رابطك لتبدأ', en: 'No earnings yet — share your link to get started', fr: 'Aucun gain pour le moment — partagez votre lien pour commencer', tr: 'Henüz kazanç yok — başlamak için bağlantınızı paylaşın', zh: '暂无收益，分享链接即可开始' },
  'settle.next': { ar: 'التسوية القادمة: {date}', en: 'Next settlement: {date}', fr: 'Prochain règlement : {date}', tr: 'Sonraki ödeme: {date}', zh: '下次结算：{date}' },
  'settle.every': { ar: 'تُسوّى أرباحك المعتمدة كل {every} متى بلغت {min}', en: 'Approved earnings are settled every {every} once they reach {min}', fr: 'Les gains validés sont réglés tous les {every} dès qu’ils atteignent {min}', tr: 'Onaylanan kazançlar {min} tutarına ulaştığında {every} arayla ödenir', zh: '已批准收益达到 {min} 后，每 {every}结算一次' },
  'quick.title': { ar: 'تنقّل سريع', en: 'Quick links', fr: 'Accès rapide', tr: 'Hızlı erişim', zh: '快捷入口' },

  // ─── v2: شركاتي ───
  'companies.company': { ar: 'الشركة', en: 'Company', fr: 'Entreprise', tr: 'Şirket', zh: '企业' },
  'companies.method': { ar: 'الطريقة', en: 'Method', fr: 'Méthode', tr: 'Yöntem', zh: '方式' },
  'companies.status': { ar: 'الحالة', en: 'Status', fr: 'Statut', tr: 'Durum', zh: '状态' },
  'companies.signedUp': { ar: 'تاريخ التسجيل', en: 'Signed up', fr: 'Inscription', tr: 'Kayıt tarihi', zh: '注册日期' },
  'companies.missedCta': { ar: 'شركة سجّلت دون رابطك؟ قدّم مطالبة بإحالة فائتة', en: 'A company signed up without your link? Submit a missed referral claim', fr: 'Une entreprise s’est inscrite sans votre lien ? Déposez une réclamation de parrainage manqué', tr: 'Bir şirket bağlantınız olmadan mı kaydoldu? Kaçırılan referans talebi gönderin', zh: '有企业未通过您的链接注册？提交遗漏推荐申诉' },
  'method.link': { ar: 'رابط', en: 'Link', fr: 'Lien', tr: 'Bağlantı', zh: '链接' },
  'method.code': { ar: 'رمز', en: 'Code', fr: 'Code', tr: 'Kod', zh: '推荐码' },
  'method.linkOrCode': { ar: 'رابط أو رمز', en: 'Link or code', fr: 'Lien ou code', tr: 'Bağlantı veya kod', zh: '链接或推荐码' },
  'method.nomination': { ar: 'ترشيح', en: 'Nomination', fr: 'Recommandation', tr: 'Öneri', zh: '提名推荐' },
  'method.trial': { ar: 'حساب تجريبي', en: 'Trial account', fr: 'Compte d’essai', tr: 'Deneme hesabı', zh: '试用账户' },
  'method.admin': { ar: 'إداري', en: 'Assigned by Field Sales', fr: 'Attribuée par Field Sales', tr: 'Field Sales ataması', zh: '由 Field Sales 指派' },

  // ─── v2: المطالبة بإحالة فائتة (غير «رشّح شركة») ───
  'missed.intro': { ar: 'شركةٌ عرّفتها بفيلد سيلز فسجّلت دون رابطك أو رمزك؟ قدّم مطالبة خلال 30 يوماً من تسجيلها، فيراجعها فريق فيلد سيلز ويُسندها إليك إن ثبتت. وللشركة التي لم تسجّل بعد استعمل «رشّح شركة».', en: 'Did a company you introduced to Field Sales sign up without your link or code? Submit a missed referral claim within 30 days of its sign-up. The Field Sales team will review it and attribute the company to you if confirmed. For a company that hasn’t signed up yet, use “Nominate a company”.', fr: 'Une entreprise à qui vous avez présenté Field Sales s’est inscrite sans votre lien ni votre code ? Déposez une réclamation de parrainage manqué dans les 30 jours suivant son inscription. L’équipe Field Sales l’examinera et vous attribuera l’entreprise si elle est confirmée. Pour une entreprise pas encore inscrite, utilisez « Recommander une entreprise ».', tr: 'Field Sales’i tanıttığınız bir şirket bağlantınız veya kodunuz olmadan mı kaydoldu? Kaydından itibaren 30 gün içinde kaçırılan referans talebi gönderin. Field Sales ekibi talebi inceler ve doğrulanırsa şirketi size atar. Henüz kaydolmamış bir şirket için “Şirket öner” bölümünü kullanın.', zh: '您介绍给 Field Sales 的企业未通过您的链接或推荐码注册？请在其注册后 30 天内提交遗漏推荐申诉。Field Sales 团队审核确认后，将该企业归属于您。尚未注册的企业，请使用“推荐企业”。' },
  'missed.contactPhoneOptional': { ar: 'رقم التواصل (اختياري)', en: 'Contact number (optional)', fr: 'Numéro de contact (facultatif)', tr: 'İletişim numarası (isteğe bağlı)', zh: '联系电话（选填）' },
  'missed.submit': { ar: 'إرسال المطالبة', en: 'Submit claim', fr: 'Envoyer la réclamation', tr: 'Talebi gönder', zh: '提交申诉' },
  'missed.received': { ar: 'استلمنا مطالبتك وستُراجع', en: 'Missed referral claim received — we’ll review it', fr: 'Réclamation reçue — elle sera examinée', tr: 'Talebiniz alındı — incelenecek', zh: '申诉已收到，我们将进行审核' },
  'missed.failed': { ar: 'تعذّر إرسال المطالبة', en: 'We couldn’t submit your claim', fr: 'Impossible d’envoyer la réclamation', tr: 'Talep gönderilemedi', zh: '申诉提交失败' },
  'missed.mine': { ar: 'مطالباتي', en: 'My missed referral claims', fr: 'Mes réclamations de parrainage manqué', tr: 'Kaçırılan referans taleplerim', zh: '我的遗漏推荐申诉' },
  'missed.empty': { ar: 'لا مطالبات بعد', en: 'No missed referral claims yet', fr: 'Aucune réclamation pour le moment', tr: 'Henüz talep yok', zh: '暂无申诉' },
  'missed.withdrawConfirm': { ar: 'سحب المطالبة بـ«{name}»؟', en: 'Withdraw your missed referral claim for “{name}”?', fr: 'Retirer la réclamation pour « {name} » ?', tr: '“{name}” için talep geri çekilsin mi?', zh: '确定撤回关于“{name}”的申诉吗？' },
  'missed.withdrawn': { ar: 'سُحبت المطالبة', en: 'Claim withdrawn', fr: 'Réclamation retirée', tr: 'Talep geri çekildi', zh: '申诉已撤回' },
  'missed.withdrawFailed': { ar: 'تعذّر سحب المطالبة', en: 'We couldn’t withdraw this claim', fr: 'Impossible de retirer la réclamation', tr: 'Talep geri çekilemedi', zh: '撤回申诉失败' },
  'missed.reviewedOn': { ar: 'رُوجعت {date}', en: 'Reviewed {date}', fr: 'Examinée le {date}', tr: 'İncelendi: {date}', zh: '审核于 {date}' },
  'st.missed.under_review': { ar: 'قيد المراجعة', en: 'Under review', fr: 'En cours d’examen', tr: 'İnceleniyor', zh: '审核中' },
  'st.missed.accepted': { ar: 'مقبولة — أُسندت إليك', en: 'Accepted — attributed to you', fr: 'Acceptée — vous est attribuée', tr: 'Kabul edildi — size atandı', zh: '已通过，已归属于您' },
  'st.missed.rejected': { ar: 'مرفوضة', en: 'Rejected', fr: 'Refusée', tr: 'Reddedildi', zh: '未通过' },
  'st.missed.withdrawn': { ar: 'مسحوبة', en: 'Withdrawn', fr: 'Retirée', tr: 'Geri çekildi', zh: '已撤回' },
  'err.tooManyMissedClaims': { ar: 'لديك مطالبات كثيرة قيد المراجعة — انتظر البتّ فيها', en: 'You have too many missed referral claims under review — please wait for a decision on them', fr: 'Vous avez trop de réclamations en cours d’examen — attendez qu’une décision soit prise', tr: 'İncelemede çok fazla talebiniz var — lütfen bunlar hakkında karar verilmesini bekleyin', zh: '您待审核的申诉过多，请等待审核结果后再提交' },
  // 409 `not_under_review`: بُتّ في المطالبة (أو سُحبت) والقائمة على الشاشة قديمة
  'err.notUnderReview': { ar: 'لم تعد المطالبة قيد المراجعة — حدّث الصفحة لترى حالتها', en: 'This claim is no longer under review — refresh the page to see its status', fr: 'Cette réclamation n’est plus en cours d’examen — actualisez la page pour voir son statut', tr: 'Bu talep artık incelemede değil — durumunu görmek için sayfayı yenileyin', zh: '该申诉已不在审核中，请刷新页面查看其状态' },
  // 400 `contact_in_text`: جوالٌ أو بريد في اسم المنشأة أو الملاحظة (الخادم لا يميّز الحقل)
  'err.contactInText': { ar: 'لا تكتب جوالاً أو بريداً في اسم المنشأة ولا في الملاحظة — رقم التواصل في خانته', en: 'Don’t include phone numbers or emails in the business name or the note — enter the contact number in its own field', fr: 'N’indiquez ni téléphone ni e-mail dans le nom de l’entreprise ou la remarque — saisissez le numéro de contact dans le champ prévu à cet effet', tr: 'İşletme adına veya nota telefon numarası ya da e-posta yazmayın — iletişim numarasını kendi alanına girin', zh: '企业名称和备注中请勿包含手机号或邮箱，请在专用栏位填写联系电话' },

  // ─── v2: أرباحي والتسويات ───
  'earn.heldUntil': { ar: 'محجوزة حتى', en: 'Held until', fr: 'Bloquée jusqu’au', tr: 'Bekleme bitişi', zh: '冻结至' },
  'settle.title': { ar: 'التسويات', en: 'Settlements', fr: 'Règlements', tr: 'Ödemeler', zh: '结算记录' },
  'settle.period': { ar: 'الفترة', en: 'Period', fr: 'Période', tr: 'Dönem', zh: '周期' },
  'settle.net': { ar: 'الصافي', en: 'Net', fr: 'Net', tr: 'Net', zh: '净额' },
  'settle.paidOn': { ar: 'تاريخ التحويل', en: 'Paid on', fr: 'Payé le', tr: 'Ödeme tarihi', zh: '支付日期' },
  'settle.failedHint': { ar: 'تعذّر التحويل — تحقّق من بيانات حسابك البنكي في «ملفي»، وتدخل مستحقاتك الدورة التالية تلقائياً.', en: 'The transfer failed — check your bank details in “My profile”. Your earnings will join the next cycle automatically.', fr: 'Le virement a échoué — vérifiez vos coordonnées bancaires dans « Mon profil ». Vos gains entreront automatiquement dans le cycle suivant.', tr: 'Aktarım başarısız oldu — “Profilim” bölümünde banka bilgilerinizi kontrol edin. Kazançlarınız otomatik olarak bir sonraki döngüye girer.', zh: '转账失败：请在“我的资料”中核对银行信息，您的收益将自动进入下一个结算周期。' },
  'settle.empty': { ar: 'لا تسويات بعد', en: 'No settlements yet', fr: 'Aucun règlement pour le moment', tr: 'Henüz ödeme yok', zh: '暂无结算记录' },
  'settle.emptyHint': { ar: 'كل {every} تُنشأ تسويتك متى بلغت عمولاتك المعتمدة {min} واكتمل ملفك.', en: 'Every {every}, a settlement is created once your approved commissions reach {min} and your profile is complete.', fr: 'Tous les {every}, un règlement est créé dès que vos commissions validées atteignent {min} et que votre profil est complet.', tr: 'Onaylanan komisyonlarınız {min} tutarına ulaştığında ve profiliniz tamamlandığında {every} arayla bir ödeme oluşturulur.', zh: '已批准佣金达到 {min} 且资料完善后，每 {every}生成一笔结算。' },
  'st.payout.failed': { ar: 'فشل التحويل', en: 'Transfer failed', fr: 'Échec du virement', tr: 'Aktarım başarısız', zh: '转账失败' },

  // ─── v2: ملفي ───
  'profile.details': { ar: 'بيانات الشراكة', en: 'Partnership details', fr: 'Informations de partenariat', tr: 'Ortaklık bilgileri', zh: '合作信息' },
  'profile.completeTitle': { ar: 'اكتمال الملف', en: 'Profile completion', fr: 'Complétude du profil', tr: 'Profil tamamlama', zh: '资料完整度' },
  'profile.completeDone': { ar: 'ملفك مكتمل — تدخل أرباحك دورة التسوية تلقائياً', en: 'Your profile is complete — your earnings join the settlement cycle automatically', fr: 'Votre profil est complet — vos gains entrent automatiquement dans le cycle de règlement', tr: 'Profiliniz tamamlandı — kazançlarınız otomatik olarak ödeme döngüsüne girer', zh: '资料已完善，您的收益将自动进入结算周期' },
  'profile.completeHint': { ar: 'اكتمال الملف شرطٌ لصرف أرباحك فقط — حسابك يعمل الآن.', en: 'A complete profile is only required to pay out your earnings — your account already works.', fr: 'Un profil complet n’est requis que pour le versement de vos gains — votre compte fonctionne déjà.', tr: 'Tamamlanmış profil yalnızca kazançlarınızın ödenmesi için gereklidir — hesabınız şimdiden çalışıyor.', zh: '完善资料仅为领取收益的前提，您的账户现已可用。' },
  'missing.partnerType': { ar: 'نوع الشراكة', en: 'Partner type', fr: 'Type de partenaire', tr: 'Ortaklık türü', zh: '合作类型' },
  'missing.iban': { ar: 'الحساب البنكي', en: 'Bank account', fr: 'Compte bancaire', tr: 'Banka hesabı', zh: '银行账户' },
  'missing.national_id': { ar: 'صورة الهوية أو الإقامة', en: 'ID or residence permit', fr: 'Pièce d’identité ou titre de séjour', tr: 'Kimlik veya ikamet belgesi', zh: '身份证或居留证' },
  'missing.commercial_reg': { ar: 'السجل التجاري', en: 'Commercial registration', fr: 'Registre du commerce', tr: 'Ticari sicil', zh: '商业登记' },
  'payout.hint': { ar: 'متاحٌ في أي وقت — ويلزم لدخول دورة التسوية.', en: 'Available any time — required to join the settlement cycle.', fr: 'Disponible à tout moment — requis pour entrer dans le cycle de règlement.', tr: 'Her zaman kullanılabilir — ödeme döngüsüne katılmak için gereklidir.', zh: '可随时填写，参与结算周期时必填。' },
  'social.title': { ar: 'روابط التواصل', en: 'Social links', fr: 'Réseaux sociaux', tr: 'Sosyal medya bağlantıları', zh: '社交链接' },
  'social.hint': { ar: 'حساباتك التي تنشر فيها — حتى {max} روابط تبدأ بـ https://', en: 'The accounts where you publish — up to {max} links starting with https://', fr: 'Les comptes sur lesquels vous publiez — jusqu’à {max} liens commençant par https://', tr: 'Paylaşım yaptığınız hesaplar — https:// ile başlayan en fazla {max} bağlantı', zh: '您发布内容的账号，最多 {max} 个以 https:// 开头的链接' },
  'social.platform': { ar: 'المنصّة', en: 'Platform', fr: 'Plateforme', tr: 'Platform', zh: '平台' },
  'social.url': { ar: 'الرابط', en: 'Link', fr: 'Lien', tr: 'Bağlantı', zh: '链接' },
  'social.add': { ar: 'إضافة رابط', en: 'Add link', fr: 'Ajouter un lien', tr: 'Bağlantı ekle', zh: '添加链接' },
  'social.remove': { ar: 'حذف الرابط', en: 'Remove link', fr: 'Supprimer le lien', tr: 'Bağlantıyı kaldır', zh: '删除链接' },
  'social.save': { ar: 'حفظ الروابط', en: 'Save links', fr: 'Enregistrer les liens', tr: 'Bağlantıları kaydet', zh: '保存链接' },
  'social.saved': { ar: 'تم حفظ الروابط', en: 'Links saved', fr: 'Liens enregistrés', tr: 'Bağlantılar kaydedildi', zh: '链接已保存' },
  'social.empty': { ar: 'لم تُضف روابط بعد', en: 'No links added yet', fr: 'Aucun lien ajouté', tr: 'Henüz bağlantı eklenmedi', zh: '尚未添加链接' },
  'social.x': { ar: 'إكس (تويتر)', en: 'X (Twitter)', fr: 'X (Twitter)', tr: 'X (Twitter)', zh: 'X（推特）' },
  'social.instagram': { ar: 'إنستغرام', en: 'Instagram', fr: 'Instagram', tr: 'Instagram', zh: 'Instagram' },
  'social.snapchat': { ar: 'سناب شات', en: 'Snapchat', fr: 'Snapchat', tr: 'Snapchat', zh: 'Snapchat' },
  'social.tiktok': { ar: 'تيك توك', en: 'TikTok', fr: 'TikTok', tr: 'TikTok', zh: 'TikTok' },
  'social.youtube': { ar: 'يوتيوب', en: 'YouTube', fr: 'YouTube', tr: 'YouTube', zh: 'YouTube' },
  'social.linkedin': { ar: 'لينكدإن', en: 'LinkedIn', fr: 'LinkedIn', tr: 'LinkedIn', zh: '领英' },
  'social.website': { ar: 'موقع إلكتروني', en: 'Website', fr: 'Site web', tr: 'Web sitesi', zh: '网站' },
  'social.other': { ar: 'أخرى', en: 'Other', fr: 'Autre', tr: 'Diğer', zh: '其他' },
  'val.socialUrl': { ar: 'رابط غير صالح — يبدأ بـ https:// (حتى 300 حرف)', en: 'Invalid link — it must start with https:// (up to 300 characters)', fr: 'Lien invalide — il doit commencer par https:// (300 caractères max.)', tr: 'Geçersiz bağlantı — https:// ile başlamalı (en fazla 300 karakter)', zh: '链接无效：须以 https:// 开头（最多 300 个字符）' },
  'val.socialMax': { ar: 'حتى {max} روابط', en: 'Up to {max} links', fr: 'Jusqu’à {max} liens', tr: 'En fazla {max} bağlantı', zh: '最多 {max} 个链接' },
  'docs.title': { ar: 'المستندات', en: 'Documents', fr: 'Documents', tr: 'Belgeler', zh: '证件' },
  'docs.hint': { ar: 'تُشفَّر مستنداتك ولا يطّلع عليها إلا فريق الصرف في فيلد سيلز. صوّرها بالكاميرا أو اخترها من الاستديو (صورة أو PDF حتى 5 ميغابايت).', en: 'Your documents are encrypted and only seen by the Field Sales payouts team. Take a photo or choose one from your gallery (image or PDF, up to 5 MB).', fr: 'Vos documents sont chiffrés et consultés uniquement par l’équipe des versements de Field Sales. Prenez une photo ou choisissez-la dans votre galerie (image ou PDF, 5 Mo max.).', tr: 'Belgeleriniz şifrelenir ve yalnızca Field Sales ödeme ekibi tarafından görülür. Fotoğraf çekin veya galeriden seçin (görsel ya da PDF, en fazla 5 MB).', zh: '您的证件经加密存储，仅 Field Sales 打款团队可查看。可拍照或从相册选择（图片或 PDF，最大 5 MB）。' },
  'doc.national_id': { ar: 'الهوية الوطنية أو الإقامة', en: 'National ID or residence permit', fr: 'Carte d’identité ou titre de séjour', tr: 'Kimlik kartı veya ikamet izni', zh: '身份证或居留证' },
  'doc.commercial_reg': { ar: 'السجل التجاري', en: 'Commercial registration', fr: 'Registre du commerce', tr: 'Ticari sicil', zh: '商业登记证' },
  'doc.camera': { ar: 'تصوير', en: 'Take a photo', fr: 'Prendre une photo', tr: 'Fotoğraf çek', zh: '拍照' },
  'doc.gallery': { ar: 'من الاستديو أو الملفات', en: 'From gallery or files', fr: 'Depuis la galerie ou les fichiers', tr: 'Galeriden veya dosyalardan', zh: '从相册或文件选择' },
  'doc.replace': { ar: 'استبدال', en: 'Replace', fr: 'Remplacer', tr: 'Değiştir', zh: '替换' },
  'doc.delete': { ar: 'حذف', en: 'Delete', fr: 'Supprimer', tr: 'Sil', zh: '删除' },
  'doc.deleteConfirm': { ar: 'حذف «{name}» نهائياً؟', en: 'Permanently delete “{name}”?', fr: 'Supprimer définitivement « {name} » ?', tr: '“{name}” kalıcı olarak silinsin mi?', zh: '确定永久删除“{name}”吗？' },
  'doc.view': { ar: 'معاينة', en: 'Preview', fr: 'Aperçu', tr: 'Önizle', zh: '预览' },
  'doc.hide': { ar: 'إخفاء المعاينة', en: 'Hide preview', fr: 'Masquer l’aperçu', tr: 'Önizlemeyi gizle', zh: '隐藏预览' },
  'doc.uploaded': { ar: 'رُفع {date} · {size}', en: 'Uploaded {date} · {size}', fr: 'Envoyé le {date} · {size}', tr: 'Yüklendi: {date} · {size}', zh: '上传于 {date} · {size}' },
  'doc.notUploaded': { ar: 'لم يُرفع بعد', en: 'Not uploaded yet', fr: 'Pas encore envoyé', tr: 'Henüz yüklenmedi', zh: '尚未上传' },
  'doc.required': { ar: 'مطلوب', en: 'Required', fr: 'Requis', tr: 'Gerekli', zh: '必填' },
  'doc.saved': { ar: 'رُفع المستند', en: 'Document uploaded', fr: 'Document envoyé', tr: 'Belge yüklendi', zh: '证件已上传' },
  'doc.deleted': { ar: 'حُذف المستند', en: 'Document deleted', fr: 'Document supprimé', tr: 'Belge silindi', zh: '证件已删除' },
  'doc.failed': { ar: 'تعذّر رفع المستند', en: 'We couldn’t upload the document', fr: 'Impossible d’envoyer le document', tr: 'Belge yüklenemedi', zh: '证件上传失败' },
  'doc.deleteFailed': { ar: 'تعذّر حذف المستند', en: 'We couldn’t delete the document', fr: 'Impossible de supprimer le document', tr: 'Belge silinemedi', zh: '证件删除失败' },
  'doc.previewFailed': { ar: 'تعذّرت المعاينة', en: 'Preview unavailable', fr: 'Aperçu indisponible', tr: 'Önizleme yapılamadı', zh: '无法预览' },
  'doc.pdf': { ar: 'ملف PDF', en: 'PDF file', fr: 'Fichier PDF', tr: 'PDF dosyası', zh: 'PDF 文件' },
  'doc.preparing': { ar: 'جارٍ تجهيز الملف…', en: 'Preparing the file…', fr: 'Préparation du fichier…', tr: 'Dosya hazırlanıyor…', zh: '正在处理文件…' },
  'val.docType': { ar: 'نوع الملف غير مدعوم — صورة (JPG أو PNG أو WEBP) أو PDF', en: 'Unsupported file — use an image (JPG, PNG or WEBP) or a PDF', fr: 'Fichier non pris en charge — utilisez une image (JPG, PNG ou WEBP) ou un PDF', tr: 'Desteklenmeyen dosya — görsel (JPG, PNG veya WEBP) ya da PDF kullanın', zh: '不支持的文件类型：请使用图片（JPG、PNG 或 WEBP）或 PDF' },
  'val.docTooLarge': { ar: 'الملف أكبر من {max} ميغابايت', en: 'The file is larger than {max} MB', fr: 'Le fichier dépasse {max} Mo', tr: 'Dosya {max} MB sınırını aşıyor', zh: '文件超过 {max} MB' },

  // ─── v2: المواد التسويقية ───
  'mat.intro': { ar: 'صورٌ وفيديوهات ونصوصٌ جاهزة من فريق فيلد سيلز لتنشرها — وأرفق رابطك والإفصاح دائماً.', en: 'Ready-made images, videos and texts from the Field Sales team for you to share — always include your link and the disclosure.', fr: 'Images, vidéos et textes prêts à l’emploi de l’équipe Field Sales à partager — joignez toujours votre lien et la mention de transparence.', tr: 'Field Sales ekibinden paylaşmanız için hazır görseller, videolar ve metinler — bağlantınızı ve açıklama metnini her zaman ekleyin.', zh: 'Field Sales 团队提供的现成图片、视频和文案，供您分享——请始终附上您的链接和披露声明。' },
  'mat.all': { ar: 'الكل', en: 'All', fr: 'Tout', tr: 'Tümü', zh: '全部' },
  'mat.cat.image': { ar: 'صور', en: 'Images', fr: 'Images', tr: 'Görseller', zh: '图片' },
  'mat.cat.video': { ar: 'فيديو', en: 'Videos', fr: 'Vidéos', tr: 'Videolar', zh: '视频' },
  'mat.cat.document': { ar: 'مستندات', en: 'Documents', fr: 'Documents', tr: 'Belgeler', zh: '文档' },
  'mat.cat.text': { ar: 'نصوص جاهزة', en: 'Ready texts', fr: 'Textes prêts', tr: 'Hazır metinler', zh: '现成文案' },
  'mat.cat.link': { ar: 'روابط', en: 'Links', fr: 'Liens', tr: 'Bağlantılar', zh: '链接' },
  'mat.download': { ar: 'تنزيل', en: 'Download', fr: 'Télécharger', tr: 'İndir', zh: '下载' },
  'mat.share': { ar: 'مشاركة', en: 'Share', fr: 'Partager', tr: 'Paylaş', zh: '分享' },
  'mat.copyText': { ar: 'نسخ النص', en: 'Copy text', fr: 'Copier le texte', tr: 'Metni kopyala', zh: '复制文案' },
  'mat.open': { ar: 'فتح الرابط', en: 'Open link', fr: 'Ouvrir le lien', tr: 'Bağlantıyı aç', zh: '打开链接' },
  // بجوار «نسخ النص» في المادّة نفسها (فيديو برابطٍ وتعليق) — «نسخ» وحدها ملتبسة
  'mat.copyLink': { ar: 'نسخ الرابط', en: 'Copy link', fr: 'Copier le lien', tr: 'Bağlantıyı kopyala', zh: '复制链接' },
  'mat.empty': { ar: 'لا مواد هنا بعد', en: 'No materials here yet', fr: 'Aucun support ici pour le moment', tr: 'Burada henüz materyal yok', zh: '暂无素材' },
  'mat.emptyHint': { ar: 'يضيف فريق فيلد سيلز موادّ جديدة تباعاً.', en: 'The Field Sales team adds new materials regularly.', fr: 'L’équipe Field Sales ajoute régulièrement de nouveaux supports.', tr: 'Field Sales ekibi düzenli olarak yeni materyaller ekler.', zh: 'Field Sales 团队会持续更新素材。' },
  'mat.downloadFailed': { ar: 'تعذّر تنزيل الملف', en: 'We couldn’t download the file', fr: 'Impossible de télécharger le fichier', tr: 'Dosya indirilemedi', zh: '文件下载失败' },

  // ─── v2: الدعم والأسئلة الشائعة ───
  'support.title': { ar: 'نحن هنا لمساعدتك', en: 'We’re here to help', fr: 'Nous sommes là pour vous aider', tr: 'Size yardımcı olmak için buradayız', zh: '我们随时为您提供帮助' },
  'support.intro': { ar: 'لأي سؤال عن رابطك أو شركاتك أو أرباحك راسلنا — الأسرع واتساب.', en: 'For any question about your link, companies or earnings, get in touch — WhatsApp is fastest.', fr: 'Pour toute question sur votre lien, vos entreprises ou vos gains, contactez-nous — WhatsApp est le plus rapide.', tr: 'Bağlantınız, şirketleriniz veya kazançlarınızla ilgili her soru için bize yazın — en hızlısı WhatsApp.', zh: '关于链接、企业或收益的任何问题，欢迎联系我们，WhatsApp 回复最快。' },
  'support.whatsapp': { ar: 'راسلنا على واتساب', en: 'Message us on WhatsApp', fr: 'Écrivez-nous sur WhatsApp', tr: 'WhatsApp’tan yazın', zh: '通过 WhatsApp 联系我们' },
  'support.email': { ar: 'راسلنا بالبريد', en: 'Email us', fr: 'Écrivez-nous par e-mail', tr: 'E-posta gönderin', zh: '发送邮件' },
  'support.codeNote': { ar: 'اذكر رمزك {code} في رسالتك ليُعرف حسابك.', en: 'Mention your code {code} in your message so we can find your account.', fr: 'Indiquez votre code {code} dans votre message pour que nous retrouvions votre compte.', tr: 'Hesabınızı bulabilmemiz için mesajınızda {code} kodunuzu belirtin.', zh: '请在消息中注明您的推荐码 {code}，以便我们找到您的账户。' },
  'support.faqCta': { ar: 'اطّلع على الأسئلة الشائعة', en: 'Browse the FAQ', fr: 'Consulter les questions fréquentes', tr: 'Sık sorulan sorulara göz atın', zh: '查看常见问题' },
  'support.fab': { ar: 'تواصل مع الدعم عبر واتساب', en: 'Chat with support on WhatsApp', fr: 'Contacter l’assistance sur WhatsApp', tr: 'WhatsApp’tan destekle iletişime geçin', zh: '通过 WhatsApp 联系客服' },
  'support.waMessage': { ar: 'مرحباً، أنا سفير فيلد سيلز (رمزي {code}) وأحتاج مساعدة', en: 'Hello, I’m a Field Sales Ambassador (code {code}) and I need help', fr: 'Bonjour, je suis ambassadeur Field Sales (code {code}) et j’ai besoin d’aide', tr: 'Merhaba, Field Sales elçisiyim (kodum {code}) ve yardıma ihtiyacım var', zh: '您好，我是 Field Sales 推荐大使（推荐码 {code}），需要帮助' },
  'faq.q.commission': { ar: 'كم عمولتي ومتى تُحتسب؟', en: 'How much do I earn, and when?', fr: 'Combien est-ce que je gagne, et quand ?', tr: 'Ne kadar ve ne zaman kazanırım?', zh: '我能获得多少佣金？何时计算？' },
  'faq.a.commission': { ar: 'عمولتك {rate} من أول دفعة مؤكَّدة شاملة الضريبة لكل منشأة تشترك عبرك — مرةً واحدة لكل منشأة، ولو كانت دفعتها الأولى اشتراكاً سنوياً.', en: 'You earn {rate} of the first confirmed payment (VAT included) from every business that subscribes through you — once per business, even if that first payment is a yearly plan.', fr: 'Vous touchez {rate} du premier paiement confirmé (TVA incluse) de chaque entreprise qui s’abonne grâce à vous — une seule fois par entreprise, même si ce premier paiement est un abonnement annuel.', tr: 'Sizin aracılığınızla abone olan her işletmenin onaylanan ilk ödemesi (KDV dahil) üzerinden {rate} kazanırsınız — işletme başına bir kez, ilk ödeme yıllık bir abonelik olsa bile.', zh: '每家经您推荐订阅的企业，您可获得其首笔确认付款（含增值税）的 {rate}——每家企业仅计一次，即使首笔付款为年度订阅也同样适用。' },
  'faq.q.hold': { ar: 'متى تُعتمد العمولة ومتى تُصرف؟', en: 'When is a commission approved and paid out?', fr: 'Quand une commission est-elle validée et versée ?', tr: 'Komisyon ne zaman onaylanır ve ödenir?', zh: '佣金何时批准、何时发放？' },
  'faq.a.hold': { ar: 'تُحجز العمولة {days} من تاريخ الدفع ثم تُعتمد تلقائياً. وكل {every} (أيام 1 و11 و21 من كل شهر) تُجمع عمولاتك المعتمدة في تسوية متى بلغ صافيها {min}، وما دون ذلك يُرحَّل للدورة التالية، ثم يحوّلها فريق فيلد سيلز إلى حسابك البنكي.', en: 'A commission is held for {days} from the payment date, then approved automatically. Every {every} (on the 1st, 11th and 21st of each month), your approved commissions are grouped into a settlement once their net total reaches {min}; anything below rolls over to the next cycle. The Field Sales team then transfers it to your bank account.', fr: 'La commission est bloquée {days} à compter de la date de paiement, puis validée automatiquement. Tous les {every} (le 1er, le 11 et le 21 de chaque mois), vos commissions validées sont regroupées dans un règlement dès que leur montant net atteint {min} ; tout montant inférieur est reporté au cycle suivant. L’équipe Field Sales le vire ensuite sur votre compte bancaire.', tr: 'Komisyon ödeme tarihinden itibaren {days} bekletilir, ardından otomatik onaylanır. {every} arayla (her ayın 1’i, 11’i ve 21’inde) onaylanan komisyonlarınız net toplamı {min} tutarına ulaştığında bir ödemede toplanır; altındaki tutar bir sonraki döngüye aktarılır. Ardından Field Sales ekibi bunu banka hesabınıza aktarır.', zh: '佣金自付款之日起冻结 {days}，随后自动批准。每 {every}（每月 1 日、11 日和 21 日），已批准佣金净额达到 {min} 后汇总为一笔结算，不足部分顺延至下一周期，随后由 Field Sales 团队转入您的银行账户。' },
  'faq.q.referral': { ar: 'متى تُحسب المنشأة لي؟', en: 'When is a business attributed to me?', fr: 'Quand une entreprise m’est-elle attribuée ?', tr: 'Bir işletme bana ne zaman atanır?', zh: '企业何时归属于我？' },
  'faq.a.referral': { ar: 'حين تسجّل المنشأة عبر رابطك، أو تكتب رمزك في خانة «رمز الإحالة» عند التسجيل، خلال {window} من فتحها رابطك — أو حين يُقبل ترشيحك لها قبل تسجيلها. وتظهر في «شركاتي» بطريقتها وحالتها.', en: 'When the business signs up through your link, or types your code into the “Referral code” field at sign-up, within {window} of opening your link — or when your nomination for it is accepted before it signs up. It then appears in “My companies” with its method and status.', fr: 'Lorsque l’entreprise s’inscrit via votre lien, ou saisit votre code dans le champ « Code de parrainage » lors de l’inscription, dans les {window} suivant l’ouverture de votre lien — ou lorsque votre recommandation est acceptée avant son inscription. Elle apparaît alors dans « Mes entreprises » avec sa méthode et son statut.', tr: 'İşletme bağlantınızı açtıktan sonraki {window} içinde bağlantınızla kaydolduğunda veya kayıt sırasında “Referans kodu” alanına kodunuzu yazdığında — ya da kaydolmadan önce öneriniz kabul edildiğinde. Ardından “Şirketlerim” bölümünde yöntemi ve durumuyla görünür.', zh: '企业在打开您的链接后 {window}内通过该链接注册，或在注册时于“推荐码”栏填写您的推荐码；或在其注册前您的推荐已获批。之后它将连同方式和状态显示在“我的企业”中。' },
  'faq.q.trial': { ar: 'ما «الحساب التجريبي» الذي أفتحه لشركة؟', en: 'What is the trial account I can open for a business?', fr: 'Qu’est-ce que le compte d’essai que je peux ouvrir pour une entreprise ?', tr: 'Bir işletme için açabildiğim deneme hesabı nedir?', zh: '我可以为企业开通的“试用账户”是什么？' },
  'faq.a.trial': { ar: 'إن طلبت منك شركةٌ تجربة فيلد سيلز فافتح لها الحساب من «افتح حساباً تجريبياً»، فيُسند إليك مباشرةً. يصل مسؤولَها بريدٌ ليختار كلمة مروره بنفسه، ولا ترى أنت كلمة المرور ولا تدخل حساب الشركة.', en: 'If a business asks to try Field Sales, open its account from “Open a trial account” and it’s attributed to you directly. Its manager receives an email to choose their own password — you never see the password or sign in to the company’s account.', fr: 'Si une entreprise souhaite essayer Field Sales, ouvrez son compte depuis « Ouvrir un compte d’essai » : il vous est attribué directement. Son responsable reçoit un e-mail pour choisir lui-même son mot de passe — vous ne voyez jamais le mot de passe et n’accédez pas au compte de l’entreprise.', tr: 'Bir işletme Field Sales’i denemek isterse hesabını “Deneme hesabı aç” bölümünden açın; doğrudan size atanır. Yetkilisi kendi şifresini belirlemesi için bir e-posta alır — şifreyi asla görmez ve şirket hesabına giriş yapmazsınız.', zh: '如有企业希望试用 Field Sales，可在“开通试用账户”中为其开通，该企业将直接归属于您。企业负责人会收到邮件自行设置密码——您不会看到密码，也无法登录企业账户。' },
  'faq.q.missed': { ar: 'سجّلت شركةٌ دون رابطي — ماذا أفعل؟', en: 'A company signed up without my link — what can I do?', fr: 'Une entreprise s’est inscrite sans mon lien — que faire ?', tr: 'Bir şirket bağlantım olmadan kaydoldu — ne yapabilirim?', zh: '企业未通过我的链接注册，怎么办？' },
  'faq.a.missed': { ar: 'قدّم «مطالبة بإحالة فائتة» خلال 30 يوماً من تسجيل الشركة باسمها، ورقم سجلها أو جوالها إن عرفته. يراجعها فريق فيلد سيلز، وإن قُبلت أُسندت إليك الشركة. وهي غير «رشّح شركة» التي تكون قبل تسجيل الشركة.', en: 'Submit a “Missed referral claim” within 30 days of the company’s sign-up, with its name and, if you know them, its CR or phone number. The Field Sales team reviews it and, if accepted, attributes the company to you. This is different from “Nominate a company”, which happens before the company signs up.', fr: 'Déposez une « Réclamation de parrainage manqué » dans les 30 jours suivant l’inscription de l’entreprise, avec son nom et, si vous les connaissez, son numéro de registre ou de téléphone. L’équipe Field Sales l’examine et, si elle est acceptée, vous attribue l’entreprise. C’est différent de « Recommander une entreprise », qui intervient avant l’inscription.', tr: 'Şirketin kaydından itibaren 30 gün içinde adını ve biliyorsanız ticari sicil ya da telefon numarasını içeren bir “Kaçırılan referans talebi” gönderin. Field Sales ekibi talebi inceler ve kabul edilirse şirketi size atar. Bu, şirket kaydolmadan önce yapılan “Şirket öner” işleminden farklıdır.', zh: '请在企业注册后 30 天内提交“遗漏推荐申诉”，填写企业名称，以及您知道的商业登记号或电话。Field Sales 团队审核通过后，将该企业归属于您。这与企业注册前使用的“推荐企业”不同。' },
  'faq.q.profile': { ar: 'لماذا أُكمل ملفي؟', en: 'Why should I complete my profile?', fr: 'Pourquoi compléter mon profil ?', tr: 'Profilimi neden tamamlamalıyım?', zh: '为什么要完善资料？' },
  'faq.a.profile': { ar: 'حسابك يعمل فوراً بلا انتظار، لكن صرف أرباحك يتطلّب ملفاً مكتملاً: نوع الشراكة والحساب البنكي (آيبان سعودي) وصورة الهوية أو الإقامة — والسجل التجاري إن كنت شركة. مستنداتك مشفّرة ولا يطّلع عليها إلا فريق الصرف.', en: 'Your account works right away, but paying out your earnings requires a complete profile: partner type, bank account (Saudi IBAN) and a photo of your ID or residence permit — plus the commercial registration if you’re a company. Your documents are encrypted and only seen by the payouts team.', fr: 'Votre compte fonctionne immédiatement, mais le versement de vos gains exige un profil complet : type de partenaire, compte bancaire (IBAN saoudien) et photo de votre pièce d’identité ou titre de séjour — plus le registre du commerce si vous êtes une entreprise. Vos documents sont chiffrés et consultés uniquement par l’équipe des versements.', tr: 'Hesabınız hemen çalışır, ancak kazançlarınızın ödenmesi için profilinizin tamamlanmış olması gerekir: ortaklık türü, banka hesabı (Suudi IBAN) ve kimlik ya da ikamet belgenizin fotoğrafı — şirketseniz ticari sicil de. Belgeleriniz şifrelenir ve yalnızca ödeme ekibi tarafından görülür.', zh: '您的账户可立即使用，但发放收益需要完善资料：合作类型、银行账户（沙特 IBAN）以及身份证或居留证照片——企业还需提供商业登记证。您的证件经加密存储，仅打款团队可查看。' },
  // ── «اعرف النظام» (طلب المالك ١٨ نوفمبر ٢٠٢٦): شرح المنصة ليفهمها السفير قبل الترويج لها، وفي آخره رابط فيديو الشرح ──
  'guide.title': { ar: 'اعرف النظام', en: 'Know the system', fr: 'Découvrir le système', tr: 'Sistemi tanıyın', zh: '了解系统' },
  'guide.intro': {
    ar: 'قبل أن تروّج لفيلد سيلز، اعرف ماذا تبيع: هذه الصفحة تشرح النظام بلغةٍ بسيطة، ومن يحتاجه، وكيف تعرضه على العميل بصدق.',
    en: 'Before you promote FieldSales, know what you are offering: this page explains the system in plain words, who needs it, and how to present it honestly.',
    fr: 'Avant de promouvoir FieldSales, sachez ce que vous proposez : cette page explique le système simplement, à qui il s’adresse et comment le présenter honnêtement.',
    tr: 'FieldSales’i tanıtmadan önce ne sunduğunuzu bilin: bu sayfa sistemi sade bir dille, kimin ihtiyaç duyduğunu ve müşteriye dürüstçe nasıl sunulacağını anlatır.',
    zh: '在推广 FieldSales 之前，先了解您在推荐什么：本页用简单的语言介绍系统、适合哪些客户，以及如何如实地向客户介绍。',
  },
  'guide.s1.t': { ar: 'ما هو فيلد سيلز؟', en: 'What is FieldSales?', fr: 'Qu’est-ce que FieldSales ?', tr: 'FieldSales nedir?', zh: '什么是 FieldSales？' },
  'guide.s1.b': {
    ar: 'نظامٌ سحابي لإدارة المبيعات الميدانية والتوزيع: مندوبون يبيعون ويحصّلون من سياراتهم، وإدارة تتابعهم لحظةً بلحظة.\nثلاثة أجزاء: تطبيق المندوب، ولوحة الإدارة على الويب، وتطبيق الإدارة على الجوال.\nيعمل بالعربية والإنجليزية ولغاتٍ أخرى، ولا يحتاج خوادم عند الشركة.',
    en: 'A cloud system for field sales and distribution: reps sell and collect from their vans, and management follows them in real time.\nThree parts: the rep app, the web admin panel, and the mobile admin app.\nWorks in Arabic, English and other languages, with no servers needed at the company.',
    fr: 'Un système cloud pour la vente terrain et la distribution : les commerciaux vendent et encaissent depuis leur véhicule, et la direction les suit en temps réel.\nTrois parties : l’application du commercial, le panneau d’administration web et l’application d’administration mobile.\nFonctionne en arabe, en anglais et dans d’autres langues, sans serveur à installer chez l’entreprise.',
    tr: 'Saha satışı ve dağıtım için bulut sistemi: temsilciler araçlarından satış ve tahsilat yapar, yönetim onları anlık izler.\nÜç bölüm: temsilci uygulaması, web yönetim paneli ve mobil yönetim uygulaması.\nArapça, İngilizce ve başka dillerde çalışır; şirkette sunucu gerektirmez.',
    zh: '面向外勤销售与分销的云系统：业务员在车上完成销售与收款，管理层实时跟进。\n三个部分：业务员应用、网页管理后台和手机管理应用。\n支持阿拉伯语、英语等多种语言，企业无需自建服务器。',
  },
  'guide.s2.t': { ar: 'تطبيق المندوب', en: 'The rep app', fr: 'L’application du commercial', tr: 'Temsilci uygulaması', zh: '业务员应用' },
  'guide.s2.b': {
    ar: 'فواتير بيعٍ ومرتجع نقداً أو آجلاً، وسندات قبض، وطباعة بالبلوتوث.\nيعمل بلا إنترنت ثم يزامن تلقائياً حين يعود الاتصال.\nزيارات العملاء بالصور والموقع، وخط سير اليوم، ومخزون السيارة تحميلاً وتنزيلاً.',
    en: 'Sales and return invoices in cash or on credit, receipt vouchers, and Bluetooth printing.\nWorks offline and syncs automatically when the connection returns.\nCustomer visits with photos and location, the day’s route, and van stock loading and unloading.',
    fr: 'Factures de vente et de retour au comptant ou à crédit, reçus d’encaissement et impression Bluetooth.\nFonctionne hors ligne et se synchronise automatiquement au retour de la connexion.\nVisites clients avec photos et position, tournée du jour, chargement et déchargement du stock du véhicule.',
    tr: 'Peşin veya vadeli satış ve iade faturaları, tahsilat makbuzları ve Bluetooth yazdırma.\nİnternetsiz çalışır, bağlantı gelince otomatik eşitler.\nFotoğraf ve konumla müşteri ziyaretleri, günün rotası, araç stoğunun yüklenmesi ve boşaltılması.',
    zh: '现金或赊销的销售与退货发票、收款单，以及蓝牙打印。\n离线可用，网络恢复后自动同步。\n带照片和定位的客户拜访、当日路线，以及车辆库存的装货与卸货。',
  },
  'guide.s3.t': { ar: 'الإدارة والمتابعة', en: 'Management and tracking', fr: 'Gestion et suivi', tr: 'Yönetim ve takip', zh: '管理与跟踪' },
  'guide.s3.b': {
    ar: 'خريطة تتبّعٍ حيّة لمواقع المندوبين وزياراتهم.\nالعملاء والأصناف بوحداتٍ متعددة وقوائم أسعار، والمستودعات ومخزون كل سيارة.\nأهداف المندوبين، والحضور والانصراف، وصلاحياتٌ لكل مستخدم.',
    en: 'A live tracking map of reps’ locations and visits.\nCustomers and products with multiple units and price lists, warehouses and each van’s stock.\nRep targets, attendance, and permissions for every user.',
    fr: 'Une carte de suivi en direct des positions et des visites des commerciaux.\nClients et articles avec plusieurs unités et listes de prix, entrepôts et stock de chaque véhicule.\nObjectifs des commerciaux, présence et droits pour chaque utilisateur.',
    tr: 'Temsilcilerin konum ve ziyaretleri için canlı takip haritası.\nÇoklu birim ve fiyat listeleriyle müşteriler ve ürünler, depolar ve her aracın stoğu.\nTemsilci hedefleri, puantaj ve her kullanıcı için yetkiler.',
    zh: '实时跟踪地图，显示业务员的位置与拜访。\n客户和商品支持多单位与价格表，管理仓库及每辆车的库存。\n业务员目标、考勤，以及每个用户的权限。',
  },
  'guide.s4.t': { ar: 'التقارير', en: 'Reports', fr: 'Rapports', tr: 'Raporlar', zh: '报表' },
  'guide.s4.b': {
    ar: 'المبيعات صافيةً من المرتجع، والتحصيل، والمديونيات وأعمارها.\nأداء كل مندوب، والعملاء الذين لم تتمّ زيارتهم، وحركة المخزون.\nتصديرٌ وطباعة، وتطبيق الإدارة على الجوال يعرضها في أي مكان.',
    en: 'Sales net of returns, collections, and receivables with their ageing.\nEach rep’s performance, customers not visited, and stock movements.\nExport and print, and the mobile admin app shows them anywhere.',
    fr: 'Ventes nettes des retours, encaissements et créances avec leur ancienneté.\nPerformance de chaque commercial, clients non visités et mouvements de stock.\nExport et impression, et l’application d’administration mobile les affiche partout.',
    tr: 'İadeler düşülmüş net satışlar, tahsilatlar ve yaşlandırmalı alacaklar.\nHer temsilcinin performansı, ziyaret edilmeyen müşteriler ve stok hareketleri.\nDışa aktarma ve yazdırma; mobil yönetim uygulaması her yerde gösterir.',
    zh: '扣除退货后的净销售额、收款，以及应收账款及其账龄。\n每位业务员的业绩、未拜访的客户和库存变动。\n可导出和打印，手机管理应用随时随地查看。',
  },
  'guide.s5.t': { ar: 'الفوترة الإلكترونية والضريبة', en: 'E-invoicing and tax', fr: 'Facturation électronique et TVA', tr: 'E-fatura ve vergi', zh: '电子发票与税务' },
  'guide.s5.b': {
    ar: 'في السعودية: فوترة إلكترونية متوافقة مع هيئة الزكاة والضريبة والجمارك (فاتورة) بمرحلتيها، مع رمز QR على كل فاتورة.\nنسبة الضريبة قابلةٌ للضبط حسب دولة الشركة، ويمكن إيقاف الضريبة كلياً لمن لا تنطبق عليه.',
    en: 'In Saudi Arabia: e-invoicing compliant with ZATCA (FATOORA) in both phases, with a QR code on every invoice.\nThe tax rate is configurable for the company’s country, and tax can be switched off entirely where it does not apply.',
    fr: 'En Arabie saoudite : facturation électronique conforme à la ZATCA (FATOORA) dans ses deux phases, avec un code QR sur chaque facture.\nLe taux de TVA se règle selon le pays de l’entreprise, et la TVA peut être entièrement désactivée là où elle ne s’applique pas.',
    tr: 'Suudi Arabistan’da: ZATCA (FATOORA) ile iki aşamada uyumlu e-fatura, her faturada QR kod.\nVergi oranı şirketin ülkesine göre ayarlanır; uygulanmadığı yerde vergi tamamen kapatılabilir.',
    zh: '在沙特阿拉伯：电子发票符合 ZATCA（FATOORA）两个阶段的要求，每张发票带二维码。\n税率可按企业所在国家设置，不适用时也可完全关闭税务。',
  },
  'guide.s6.t': { ar: 'الربط مع الأنظمة الأخرى', en: 'Integrations', fr: 'Intégrations', tr: 'Entegrasyonlar', zh: '系统对接' },
  'guide.s6.b': {
    ar: 'واجهة برمجية (API) بمفتاحٍ لكل شركة لربط نظامها المحاسبي أو متجرها.\nربطٌ جاهز مع Odoo، واستيراد العملاء والأصناف من ملفات Excel.',
    en: 'An API with a key per company to connect its accounting system or store.\nA ready connector for Odoo, and import of customers and products from Excel files.',
    fr: 'Une API avec une clé par entreprise pour connecter son logiciel comptable ou sa boutique.\nUn connecteur prêt pour Odoo, et l’import des clients et des articles depuis des fichiers Excel.',
    tr: 'Muhasebe sistemini veya mağazasını bağlamak için şirket başına anahtarlı API.\nOdoo için hazır bağlantı; müşteri ve ürünleri Excel dosyalarından içe aktarma.',
    zh: '每家企业一个密钥的 API，可对接其会计系统或商城。\n现成的 Odoo 连接器，并支持从 Excel 文件导入客户和商品。',
  },
  'guide.s7.t': { ar: 'لمن يناسب؟', en: 'Who is it for?', fr: 'Pour qui ?', tr: 'Kimler için?', zh: '适合谁？' },
  'guide.s7.b': {
    ar: 'شركات التوزيع وتجّار الجملة والمصانع التي لديها مندوبون ميدانيون أو سيارات توزيع.\nمثل: المواد الغذائية والمشروبات والمياه، والمنظّفات، والأدوية والمستلزمات، وقطع الغيار.\nمن مندوبٍ واحد حتى مئات المندوبين.',
    en: 'Distribution companies, wholesalers and factories that have field reps or delivery vans.\nFor example: food, beverages and water, cleaning products, pharmaceuticals and supplies, and spare parts.\nFrom one rep to hundreds.',
    fr: 'Les sociétés de distribution, grossistes et usines qui ont des commerciaux terrain ou des véhicules de livraison.\nPar exemple : alimentation, boissons et eau, produits d’entretien, pharmacie et fournitures, pièces détachées.\nD’un seul commercial à plusieurs centaines.',
    tr: 'Saha temsilcisi veya dağıtım aracı olan dağıtım şirketleri, toptancılar ve fabrikalar.\nÖrneğin: gıda, içecek ve su, temizlik ürünleri, ilaç ve sarf malzemeleri, yedek parça.\nTek temsilciden yüzlerce temsilciye kadar.',
    zh: '拥有外勤业务员或配送车辆的分销公司、批发商和工厂。\n例如：食品、饮料和饮用水、清洁用品、医药及耗材、汽配。\n从一名业务员到数百名业务员都适用。',
  },
  'guide.s8.t': { ar: 'كيف تعرضه على العميل؟', en: 'How to present it to a client', fr: 'Comment le présenter au client', tr: 'Müşteriye nasıl sunulur?', zh: '如何向客户介绍' },
  'guide.s8.b': {
    ar: 'ابدأ بمشكلته لا بالمزايا: نقدٌ يضيع مع المندوبين، أو لا يعرف أين مندوبوه، أو فواتير ورقية، أو التزام الفوترة الإلكترونية.\nاعرض الجزء الذي يحلّ مشكلته، ثم اقترح التجربة المجانية ٥ أيام — تفتحها له من تبويب «افتح حساباً تجريبياً» فتُحسب لك.\nالأسعار في تبويب «الأسعار»، وللأسئلة التقنية تواصل مع الدعم.',
    en: 'Start with the client’s problem, not the features: cash lost with reps, not knowing where the reps are, paper invoices, or the e-invoicing obligation.\nShow the part that solves it, then suggest the free 5-day trial — open it for them from the “Open a trial account” tab so it counts for you.\nPrices are in the “Pricing” tab, and for technical questions contact support.',
    fr: 'Partez du problème du client, pas des fonctionnalités : argent perdu avec les commerciaux, ne pas savoir où ils sont, factures papier ou obligation de facturation électronique.\nMontrez la partie qui le résout, puis proposez l’essai gratuit de 5 jours — ouvrez-le pour lui depuis l’onglet « Ouvrir un compte d’essai » pour qu’il vous soit attribué.\nLes prix sont dans l’onglet « Tarifs », et pour les questions techniques, contactez l’assistance.',
    tr: 'Özelliklerle değil müşterinin sorunuyla başlayın: temsilcilerde kaybolan nakit, temsilcilerin nerede olduğunu bilmemek, kâğıt faturalar veya e-fatura zorunluluğu.\nSorunu çözen bölümü gösterin, sonra 5 günlük ücretsiz denemeyi önerin — size sayılması için “Deneme hesabı aç” sekmesinden onun adına açın.\nFiyatlar “Fiyatlar” sekmesindedir; teknik sorular için destekle iletişime geçin.',
    zh: '从客户的问题入手，而不是功能：业务员手上的现金流失、不知道业务员在哪里、纸质发票，或电子发票的合规要求。\n展示能解决问题的部分，然后建议 5 天免费试用——在“开通试用账户”标签中为客户开通，即可计入您的推荐。\n价格见“价格”标签，技术问题请联系支持团队。',
  },
  'guide.s9.t': { ar: 'ما لا تَعِد به', en: 'What not to promise', fr: 'Ce qu’il ne faut pas promettre', tr: 'Neleri vaat etmemeli', zh: '不要承诺的内容' },
  'guide.s9.b': {
    ar: 'لا تَعِد بميزةٍ غير مذكورة هنا أو في الفيديو، ولا بأسعارٍ أو خصوماتٍ غير المعروضة في تبويب «الأسعار».\nلا تتحدّث باسم فيلد سيلز رسمياً، وأفصح أن منشورك إعلانٌ أو إحالة.\nإن لم تعرف الجواب فقل: «سأسأل الدعم وأعود إليك».',
    en: 'Do not promise a feature that is not mentioned here or in the video, nor prices or discounts other than those in the “Pricing” tab.\nDo not speak officially on behalf of FieldSales, and disclose that your post is an ad or a referral.\nIf you do not know the answer, say: “I will ask support and get back to you.”',
    fr: 'Ne promettez pas une fonctionnalité non mentionnée ici ou dans la vidéo, ni des prix ou remises autres que ceux de l’onglet « Tarifs ».\nNe parlez pas officiellement au nom de FieldSales, et indiquez que votre publication est une annonce ou une recommandation.\nSi vous ne connaissez pas la réponse, dites : « Je demande à l’assistance et je reviens vers vous. »',
    tr: 'Burada veya videoda geçmeyen bir özelliği, “Fiyatlar” sekmesindekiler dışında fiyat veya indirimi vaat etmeyin.\nFieldSales adına resmî olarak konuşmayın ve paylaşımınızın reklam ya da yönlendirme olduğunu belirtin.\nCevabı bilmiyorsanız: “Destek ekibine sorup size döneceğim” deyin.',
    zh: '不要承诺本页或视频中未提及的功能，也不要承诺“价格”标签以外的价格或折扣。\n不要以 FieldSales 官方身份发言，并说明您的帖子是广告或推荐。\n如果不知道答案，就说：“我会询问支持团队后回复您。”',
  },
  'guide.videos.t': { ar: 'شاهد شرح النظام بالفيديو', en: 'Watch the video walkthrough', fr: 'Regarder la présentation vidéo', tr: 'Video anlatımını izleyin', zh: '观看系统视频讲解' },
  'guide.videos.d': {
    ar: 'فيديوهات تعليمية تشرح لوحة الإدارة خطوةً بخطوة — شاهدها قبل أول عرضٍ لعميل.',
    en: 'Tutorial videos that walk through the admin panel step by step — watch them before your first client demo.',
    fr: 'Des vidéos qui présentent le panneau d’administration pas à pas — regardez-les avant votre première démonstration client.',
    tr: 'Yönetim panelini adım adım anlatan eğitim videoları — ilk müşteri sunumunuzdan önce izleyin.',
    zh: '逐步讲解管理后台的教学视频——在第一次向客户演示前先看一遍。',
  },
  'guide.videos.cta': { ar: 'صفحة الفيديوهات التعليمية', en: 'Tutorial videos page', fr: 'Page des vidéos tutoriels', tr: 'Eğitim videoları sayfası', zh: '教学视频页面' },
  // ── «حقيبة السفير الجاهزة» (طلب المالك ١٩ نوفمبر ٢٠٢٦) — المحتوى في public/ambassador-kit/kit.json ──
  'kit.title': { ar: 'حقيبة السفير الجاهزة', en: 'Ready-made ambassador kit', fr: 'Kit prêt de l’ambassadeur', tr: 'Hazır elçi kiti', zh: '大使现成素材包' },
  'kit.intro': {
    ar: 'صور ومنشورات ورسائل من فيلد سيلز جاهزة للنشر — رابطك يُضاف تلقائياً إلى كل نصٍّ تنسخه أو تشاركه.',
    en: 'Images, posts and messages from FieldSales, ready to publish — your link is added automatically to every text you copy or share.',
    fr: 'Images, publications et messages de FieldSales prêts à publier — votre lien est ajouté automatiquement à chaque texte copié ou partagé.',
    tr: 'FieldSales’ten yayına hazır görseller, gönderiler ve mesajlar — kopyaladığınız veya paylaştığınız her metne bağlantınız otomatik eklenir.',
    zh: '来自 FieldSales 的现成图片、帖子和消息——您复制或分享的每段文字都会自动加上您的链接。',
  },
  'kit.images': { ar: 'صور ومنشورات وقصص', en: 'Images, posts and stories', fr: 'Images, publications et stories', tr: 'Görseller, gönderiler ve hikâyeler', zh: '图片、帖子和快拍' },
  'kit.docs': { ar: 'ملفات وفيديو', en: 'Files and video', fr: 'Fichiers et vidéo', tr: 'Dosyalar ve video', zh: '文件与视频' },
  'kit.texts': { ar: 'رسائل جاهزة للنسخ', en: 'Ready-to-copy messages', fr: 'Messages prêts à copier', tr: 'Kopyalamaya hazır mesajlar', zh: '可直接复制的消息' },
  'kit.download': { ar: 'تنزيل', en: 'Download', fr: 'Télécharger', tr: 'İndir', zh: '下载' },
  'kit.share': { ar: 'مشاركة', en: 'Share', fr: 'Partager', tr: 'Paylaş', zh: '分享' },
  'kit.open': { ar: 'فتح', en: 'Open', fr: 'Ouvrir', tr: 'Aç', zh: '打开' },
  'kit.copyCaption': { ar: 'نسخ النص مع رابطك', en: 'Copy text with your link', fr: 'Copier le texte avec votre lien', tr: 'Metni bağlantınızla kopyala', zh: '复制带链接的文字' },
  'kit.whatsapp': { ar: 'إرسال بواتساب', en: 'Send on WhatsApp', fr: 'Envoyer sur WhatsApp', tr: 'WhatsApp ile gönder', zh: '通过 WhatsApp 发送' },
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

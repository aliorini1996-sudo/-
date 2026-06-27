import { useLang } from './lang';

// قاموس نصوص واجهة النظام (عربي/إنجليزي) — يُستخدم عبر useT()
export const DICT: Record<string, { ar: string; en: string }> = {
  // مشترك
  'common.toggleLang': { ar: 'English', en: 'العربية' },
  'common.backHome': { ar: 'الرئيسية', en: 'Home' },
  'common.cancel': { ar: 'إلغاء', en: 'Cancel' },

  // تسجيل دخول الأدمن
  'login.welcome': { ar: 'مرحباً بك 👋', en: 'Welcome back 👋' },
  'login.subtitle': { ar: 'سجّل دخولك للمتابعة إلى لوحة التحكم', en: 'Sign in to continue to your dashboard' },
  'login.email': { ar: 'البريد الإلكتروني', en: 'Email' },
  'login.password': { ar: 'كلمة المرور', en: 'Password' },
  'login.submit': { ar: 'دخول', en: 'Sign in' },
  'login.forgot': { ar: 'نسيت كلمة المرور؟', en: 'Forgot your password?' },
  'login.fillAll': { ar: 'يرجى ملء جميع الحقول', en: 'Please fill in all fields' },
  'login.welcomeName': { ar: 'مرحباً', en: 'Welcome' },
  'login.error': { ar: 'خطأ في تسجيل الدخول', en: 'Sign-in error' },
  'login.heroLead': { ar: 'منصّتك المتكاملة لإدارة وتتبّع مبيعات المناديب الميدانيين — من الطلب والتحصيل إلى الفوترة والتقارير.', en: 'Your all-in-one platform to manage and track field sales — from orders and collections to invoicing and reports.' },
  'login.demoTitle': { ar: 'بيانات تجريبية:', en: 'Demo credentials:' },
  'login.salesToday': { ar: 'مبيعات اليوم', en: "Today's sales" },
  'login.collectToday': { ar: 'التحصيل اليوم', en: "Today's collection" },

  // التسجيل الذاتي
  'signup.badge': { ar: 'تجربة مجانية 14 يوماً', en: '14-day free trial' },
  'signup.title': { ar: 'ابدأ تجربتك المجانية', en: 'Start your free trial' },
  'signup.subtitle': { ar: 'أنشئ حساب شركتك في دقيقة — بدون بطاقة ائتمان.', en: 'Create your company account in a minute — no credit card required.' },
  'signup.company': { ar: 'اسم الشركة', en: 'Company name' },
  'signup.yourName': { ar: 'اسمك', en: 'Your name' },
  'signup.email': { ar: 'البريد الإلكتروني', en: 'Email' },
  'signup.phone': { ar: 'رقم الجوال', en: 'Mobile number' },
  'signup.password': { ar: 'كلمة المرور', en: 'Password' },
  'signup.confirm': { ar: 'تأكيد كلمة المرور', en: 'Confirm password' },
  'signup.agreePre': { ar: 'بالتسجيل، أنت توافق على', en: 'By signing up, you agree to the' },
  'signup.terms': { ar: 'شروط الخدمة', en: 'Terms of Service' },
  'signup.and': { ar: 'و', en: 'and' },
  'signup.privacy': { ar: 'سياسة الخصوصية', en: 'Privacy Policy' },
  'signup.submit': { ar: 'ابدأ التجربة المجانية', en: 'Start free trial' },
  'signup.haveAccount': { ar: 'هل لديك حساب بالفعل؟', en: 'Already have an account?' },
  'signup.signin': { ar: 'تسجيل الدخول', en: 'Sign in' },
  'signup.heroLead': { ar: 'جرّب المنصّة كاملةً مجاناً، وأدِر فريقك الميداني من أول يوم.', en: 'Try the full platform free, and run your field team from day one.' },
  'signup.perk1': { ar: '14 يوماً مجاناً بالكامل', en: 'Full 14 days free' },
  'signup.perk2': { ar: 'بدون بطاقة ائتمان', en: 'No credit card' },
  'signup.perk3': { ar: 'كل المميزات مفعّلة', en: 'All features enabled' },
  'signup.perk4': { ar: 'إلغاء في أي وقت', en: 'Cancel anytime' },
  'signup.errCompany': { ar: 'اسم الشركة مطلوب', en: 'Company name is required' },
  'signup.errName': { ar: 'اسمك مطلوب', en: 'Your name is required' },
  'signup.errEmail': { ar: 'البريد الإلكتروني غير صحيح', en: 'Invalid email address' },
  'signup.errPass': { ar: 'كلمة المرور 6 أحرف على الأقل', en: 'Password must be at least 6 characters' },
  'signup.errMatch': { ar: 'كلمتا المرور غير متطابقتين', en: 'Passwords do not match' },
  'signup.errAgree': { ar: 'يرجى الموافقة على الشروط وسياسة الخصوصية', en: 'Please accept the Terms and Privacy Policy' },
  'signup.success': { ar: 'تم إنشاء حسابك — مرحباً بك في تجربتك المجانية!', en: 'Account created — welcome to your free trial!' },
  'signup.failed': { ar: 'تعذّر إنشاء الحساب', en: 'Could not create account' },

  // لوحة المالك (تسجيل الدخول)
  'owner.title': { ar: 'مدخل مالك المنصّة', en: 'Platform owner access' },
  'owner.subtitle': { ar: 'هذا المدخل مخصّص لإدارة المنصّة فقط.', en: 'This entrance is for platform administration only.' },

  // تطبيق المندوب (تسجيل الدخول)
  'rep.tagline': { ar: 'إدارة مبيعات المناديب', en: 'Field sales management' },
  'rep.loginTitle': { ar: 'تسجيل دخول المندوب', en: 'Rep sign in' },
  'rep.username': { ar: 'اسم المستخدم', en: 'Username' },
  'rep.badCreds': { ar: 'بيانات الدخول غير صحيحة', en: 'Invalid login credentials' },

  // صفحة التواصل
  'contact.title': { ar: 'تواصل معنا', en: 'Contact us' },
  'contact.cardEmail': { ar: 'البريد الإلكتروني', en: 'Email' },
  'contact.cardPhone': { ar: 'الهاتف', en: 'Phone' },
  'contact.cardWhatsapp': { ar: 'واتساب', en: 'WhatsApp' },
  'contact.cardAddress': { ar: 'العنوان', en: 'Address' },
  'contact.formTitle': { ar: 'أرسل لنا رسالة', en: 'Send us a message' },
  'contact.name': { ar: 'الاسم', en: 'Name' },
  'contact.namePh': { ar: 'اسمك', en: 'Your name' },
  'contact.email': { ar: 'البريد الإلكتروني', en: 'Email' },
  'contact.phone': { ar: 'الجوال', en: 'Mobile' },
  'contact.message': { ar: 'رسالتك', en: 'Your message' },
  'contact.messagePh': { ar: 'كيف يمكننا مساعدتك؟', en: 'How can we help you?' },
  'contact.send': { ar: 'إرسال الرسالة', en: 'Send message' },
  'contact.sentTitle': { ar: 'تم إرسال رسالتك', en: 'Your message has been sent' },
  'contact.sentBody': { ar: 'شكراً لتواصلك معنا، سنردّ عليك في أقرب وقت.', en: 'Thanks for reaching out — we’ll reply as soon as possible.' },
  'contact.errName': { ar: 'الاسم مطلوب', en: 'Name is required' },
  'contact.errEmail': { ar: 'البريد الإلكتروني غير صحيح', en: 'Invalid email address' },
  'contact.errMsg': { ar: 'اكتب رسالتك', en: 'Please write your message' },
  'contact.successToast': { ar: 'تم إرسال رسالتك — سنردّ عليك قريباً', en: 'Message sent — we’ll get back to you soon' },
  'contact.failToast': { ar: 'تعذّر إرسال الرسالة، حاول مجدداً', en: 'Could not send the message, please try again' },

  // قائمة لوحة التحكم
  'nav.dashboard': { ar: 'لوحة التحكم', en: 'Dashboard' },
  'nav.customers': { ar: 'العملاء', en: 'Customers' },
  'nav.products': { ar: 'المنتجات', en: 'Products' },
  'nav.reps': { ar: 'المناديب', en: 'Sales reps' },
  'nav.vanStock': { ar: 'مخزون السيارات', en: 'Van stock' },
  'nav.tracking': { ar: 'تتبّع المناديب', en: 'Rep tracking' },
  'nav.invoices': { ar: 'الفواتير', en: 'Invoices' },
  'nav.receipts': { ar: 'سندات القبض', en: 'Receipts' },
  'nav.reports': { ar: 'التقارير', en: 'Reports' },
  'nav.company': { ar: 'إعدادات الشركة', en: 'Company settings' },
  'nav.notifications': { ar: 'الإشعارات', en: 'Notifications' },
  'nav.logout': { ar: 'تسجيل الخروج', en: 'Sign out' },
  'nav.changePassword': { ar: 'تغيير كلمة المرور', en: 'Change password' },
  'nav.support': { ar: 'الدعم الفني', en: 'Technical support' },

  // الدعم الفني
  'support.title': { ar: 'الدعم الفني', en: 'Technical support' },
  'support.subtitle': { ar: 'صف مشكلتك أو استفسارك وسيصلك ردّ فريق الدعم على بريدك.', en: 'Describe your issue or question and our support team will reply to your email.' },
  'support.subject': { ar: 'الموضوع', en: 'Subject' },
  'support.subjectPh': { ar: 'عنوان مختصر للمشكلة', en: 'Short title for the issue' },
  'support.category': { ar: 'التصنيف', en: 'Category' },
  'support.catGeneral': { ar: 'عام', en: 'General' },
  'support.catTechnical': { ar: 'مشكلة تقنية', en: 'Technical issue' },
  'support.catBilling': { ar: 'الاشتراك والفوترة', en: 'Subscription & billing' },
  'support.catFeature': { ar: 'اقتراح ميزة', en: 'Feature request' },
  'support.message': { ar: 'تفاصيل الطلب', en: 'Request details' },
  'support.messagePh': { ar: 'اكتب تفاصيل مشكلتك هنا…', en: 'Write the details of your issue here…' },
  'support.send': { ar: 'إرسال للدعم', en: 'Send to support' },
  'support.errMsg': { ar: 'يرجى كتابة تفاصيل الطلب', en: 'Please write the request details' },
  'support.success': { ar: 'تم إرسال طلبك للدعم — سنردّ عليك قريباً', en: 'Your request was sent to support — we’ll reply soon' },
  'support.failed': { ar: 'تعذّر إرسال الطلب، حاول مجدداً', en: 'Could not send the request, please try again' },
  'support.note': { ar: 'يصل طلبك إلى فريق الدعم على help@fieldsa.net', en: 'Your request reaches our support team at help@fieldsa.net' },
  'nav.impersonating': { ar: 'أنت تتصفّح شركة', en: 'You are browsing company' },
  'nav.asOwner': { ar: 'كمالك المنصّة', en: 'as platform owner' },
  'nav.backToPlatform': { ar: 'العودة للوحة المالك', en: 'Back to owner panel' },
};

export function useT() {
  const lang = useLang((s) => s.lang);
  return (key: string): string => DICT[key]?.[lang] ?? key;
}

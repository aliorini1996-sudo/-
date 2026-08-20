// مولد آليا من scratchpad/gen_landing.cjs — لا تحرره يدويا
// مصدر واحد للنصوص الافتراضية للصفحة التعريفية ولوسوم حقولها في لوحة المالك
// المفاتيح يجب أن تطابق CONTENT_KEYS في backend/src/routes/hunter.ts

export interface LandingField {
  key: string;
  label: string;
  long: boolean;
}

export const LANDING_FIELDS: LandingField[] = [
  {
    "key": "hero_eyebrow",
    "label": "شارة أعلى العنوان",
    "long": false
  },
  {
    "key": "hero_title_1",
    "label": "العنوان الرئيسي السطر الأول",
    "long": false
  },
  {
    "key": "hero_title_2",
    "label": "العنوان الرئيسي السطر المميز",
    "long": false
  },
  {
    "key": "hero_lead",
    "label": "الوصف تحت العنوان",
    "long": true
  },
  {
    "key": "cta_primary",
    "label": "زر الإجراء الرئيسي",
    "long": false
  },
  {
    "key": "cta_secondary",
    "label": "الزر الثانوي",
    "long": false
  },
  {
    "key": "trust_1",
    "label": "شارة ثقة ١",
    "long": false
  },
  {
    "key": "trust_2",
    "label": "شارة ثقة ٢",
    "long": false
  },
  {
    "key": "trust_3",
    "label": "شارة ثقة ٣",
    "long": false
  },
  {
    "key": "how_title",
    "label": "عنوان قسم كيف يعمل",
    "long": false
  },
  {
    "key": "how_lead",
    "label": "وصف قسم كيف يعمل",
    "long": true
  },
  {
    "key": "step1_t",
    "label": "الخطوة ١ العنوان",
    "long": false
  },
  {
    "key": "step1_d",
    "label": "الخطوة ١ الوصف",
    "long": true
  },
  {
    "key": "step2_t",
    "label": "الخطوة ٢ العنوان",
    "long": false
  },
  {
    "key": "step2_d",
    "label": "الخطوة ٢ الوصف",
    "long": true
  },
  {
    "key": "step3_t",
    "label": "الخطوة ٣ العنوان",
    "long": false
  },
  {
    "key": "step3_d",
    "label": "الخطوة ٣ الوصف",
    "long": true
  },
  {
    "key": "ai_title",
    "label": "قسم التأهيل الذكي العنوان",
    "long": false
  },
  {
    "key": "ai_body",
    "label": "قسم التأهيل الذكي النص",
    "long": true
  },
  {
    "key": "features_title",
    "label": "عنوان قسم المميزات",
    "long": false
  },
  {
    "key": "sources_title",
    "label": "عنوان قسم المصادر",
    "long": false
  },
  {
    "key": "sources_lead",
    "label": "وصف قسم المصادر",
    "long": true
  },
  {
    "key": "final_title",
    "label": "الدعوة الأخيرة العنوان",
    "long": false
  },
  {
    "key": "final_lead",
    "label": "الدعوة الأخيرة الوصف",
    "long": true
  },
  {
    "key": "final_cta",
    "label": "الدعوة الأخيرة الزر",
    "long": false
  },
  {
    "key": "footer_note",
    "label": "سطر التذييل",
    "long": false
  }
];

export const LANDING_DEFAULTS: Record<string, string> = {
  "hero_eyebrow": "وكيل ذكاء لصيد العملاء",
  "hero_title_1": "اصطد عملاءك المحتملين",
  "hero_title_2": "تلقائيا",
  "hero_lead": "وكيل ذكاء اصطناعي يبحث عن شركاتك المستهدفة من عدة مصادر يزيل التكرار ويقيم كل عميل مقابل هدفك على الطلب بضغطة واحدة",
  "cta_primary": "أنشئ حسابا ←",
  "cta_secondary": "تسجيل الدخول",
  "trust_1": "٤ مصادر بحث حية",
  "trust_2": "تقييم ١ ١٠ لكل عميل",
  "trust_3": "عزل تام لكل حساب",
  "how_title": "افتح حسابك وابدأ في ٣ خطوات",
  "how_lead": "بلا بطاقة ولا تعقيد من التسجيل إلى أول قائمة عملاء مؤهلة في دقائق",
  "step1_t": "أنشئ حسابك",
  "step1_d": "سجل ببريدك وكلمة مرور في خطوتين بلا بطاقة وتدخل المنصة فورا",
  "step2_t": "صف عميلك المستهدف",
  "step2_d": "اكتب وصف عميلك المثالي وكلمات البحث والدول والمدن بالعربية أو الإنجليزية",
  "step3_t": "اصطد وصدر",
  "step3_d": "الوكيل يجلب من عدة مصادر يزيل التكرار يقيم كل عميل ١ ١٠ وتصدر النتائج CSV.",
  "ai_title": "ذكاء يفرق بين الموزع الحقيقي والضجيج",
  "ai_body": "لا يكفي أن تجمع الأسماء الوكيل يقرأ كل شركة ويقيمها مقابل وصف هدفك فيرفع الموزعين المطابقين وينزل متاجر التجزئة والضجيج أنت تفلتر على «درجة ≥ ٧» وتبدأ من الأفضل",
  "features_title": "أداة صيد لا قائمة باردة",
  "sources_title": "يصطاد من حيث يوجد عملاؤك",
  "sources_lead": "عدة قنوات بحث حية تعمل معا في الطلب الواحد فتغطية أوسع ونتائج أدق",
  "final_title": "جاهز لتصطاد عملاءك",
  "final_lead": "أنشئ حسابك وابدأ أول عملية صيد في أقل من دقيقة",
  "final_cta": "أنشئ حسابك ←",
  "footer_note": "وكيل ذكاء لصيد العملاء المحتملين على الطلب"
};

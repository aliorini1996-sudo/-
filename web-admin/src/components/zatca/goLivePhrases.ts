/**
 * عبارات قسمَي «تفعيل المرحلة الثانية» ومراجعة الانتقال (Z5.8) — en/fr/tr/zh — في ملفٍ مستقلّ يُحمَّل كسولاً مع
 * مكوّنَيهما وحدهما (ZatcaActivationSection / ZatcaCutoverPanel)، فلا يدخل حزمة تبويب الربط ولا حزمة الدخول.
 *
 * useGoLiveTr يبحث هنا أولاً ثمّ يفوّض إلى zatcaTranslate (عبارات التبويب فالقاموس العامّ) — فالعبارات المشتركة
 * (إلغاء، تأكيد، المبلغ…) تُقرأ من القاموس العامّ بلا تكرار، والحارس في goLiveLogic.test.ts يفرض أربع لغات لكلّ نصّ.
 */
import { useLang } from '../../i18n/lang';
import { zatcaTranslate } from './zatcaPhrases';

export const GO_LIVE_PHRASES: Record<string, { en: string; fr: string; tr: string; zh: string }> = {
  // ── قائمة الجاهزية ──
  'وحدة فوترة إنتاجيّة مفعّلة وشهادتها سارية': { en: 'An active production invoicing unit with a valid certificate', fr: 'Une unité de facturation de production active avec un certificat valide', tr: 'Sertifikası geçerli, etkin bir üretim faturalama birimi', zh: '已启用且证书有效的生产开票单元' },
  'بيانات المنشأة (البائع) مكتملة': { en: 'Business (seller) details are complete', fr: 'Les données de l’entreprise (vendeur) sont complètes', tr: 'İşletme (satıcı) bilgileri eksiksiz', zh: '企业（卖方）信息已完整' },
  'عملة الفوترة هي الريال السعودي': { en: 'The invoicing currency is the Saudi riyal', fr: 'La devise de facturation est le riyal saoudien', tr: 'Fatura para birimi Suudi riyalidir', zh: '开票币种为沙特里亚尔' },
  'كل مندوب نشط زامن جهازه بعد التسليح': { en: 'Every active rep has synced their device after arming', fr: 'Chaque représentant actif a synchronisé son appareil après l’armement', tr: 'Her etkin temsilci hazırlıktan sonra cihazını eşitledi', zh: '每位在岗业务员已在预备后同步其设备' },
  'لم يفتح التطبيق ليبلّغ حالة صندوقه بعد': { en: 'Has not opened the app to report their outbox status yet', fr: 'N’a pas encore ouvert l’application pour signaler l’état de sa file d’envoi', tr: 'Giden kutusu durumunu bildirmek için uygulamayı henüz açmadı', zh: '尚未打开应用以上报其待发箱状态' },
  'آخر مزامنة قبل التسليح — يفتح التطبيق ليبلّغ من جديد': { en: 'Last sync was before arming — open the app to report again', fr: 'Dernière synchronisation avant l’armement — ouvrez l’application pour signaler à nouveau', tr: 'Son eşitleme hazırlıktan önceydi — yeniden bildirmek için uygulamayı açın', zh: '最近一次同步在预备之前——请打开应用重新上报' },
  'لديه مستندات معلّقة لم تُرفع بعد': { en: 'Has pending documents not yet uploaded', fr: 'A des documents en attente non encore téléversés', tr: 'Henüz yüklenmemiş bekleyen belgeleri var', zh: '有尚未上传的待处理单据' },
  'لم يزامن جهازه بعد': { en: 'Has not synced their device yet', fr: 'N’a pas encore synchronisé son appareil', tr: 'Cihazını henüz eşitlemedi', zh: '尚未同步其设备' },
  // ── أسباب مراجعة الانتقال ──
  'أُنشئ على الجهاز بعد لحظة التفعيل': { en: 'Created on the device after the activation moment', fr: 'Créé sur l’appareil après le moment de l’activation', tr: 'Cihazda etkinleştirme anından sonra oluşturuldu', zh: '在启用时刻之后于设备上创建' },
  'وصل بعد مهلة اثنتين وسبعين ساعة من التفعيل': { en: 'Arrived after the 72-hour window from activation', fr: 'Arrivé après le délai de 72 heures suivant l’activation', tr: 'Etkinleştirmeden sonraki 72 saatlik süreden sonra ulaştı', zh: '在启用后 72 小时时限之后送达' },
  'تاريخ إنشائه أقدم من الحدّ المسموح قبل التفعيل': { en: 'Its creation date is older than the allowed limit before activation', fr: 'Sa date de création est antérieure à la limite autorisée avant l’activation', tr: 'Oluşturulma tarihi, etkinleştirmeden önce izin verilen sınırdan daha eski', zh: '其创建日期早于启用前允许的期限' },
  'بلا لحظة إنشاء على الجهاز — يتعذّر تصنيفه تلقائياً': { en: 'No device creation time — cannot be classified automatically', fr: 'Aucune heure de création sur l’appareil — impossible de le classer automatiquement', tr: 'Cihazda oluşturma zamanı yok — otomatik sınıflandırılamıyor', zh: '无设备创建时间——无法自动分类' },
  'يحتاج مراجعة الإدارة': { en: 'Needs admin review', fr: 'Nécessite une revue de l’administration', tr: 'Yönetici incelemesi gerektirir', zh: '需要管理员审核' },
  // ── إجراءات التسليح والتفعيل ──
  'التفعيل مُسلَّح مسبقا': { en: 'Activation was already armed', fr: 'L’activation était déjà armée', tr: 'Etkinleştirme zaten hazırlanmıştı', zh: '启用已处于预备状态' },
  'بدأ تسليح التفعيل — بانتظار مزامنة المناديب': { en: 'Activation arming started — waiting for reps to sync', fr: 'Armement de l’activation commencé — en attente de la synchronisation des représentants', tr: 'Etkinleştirme hazırlığı başladı — temsilcilerin eşitlenmesi bekleniyor', zh: '启用预备已开始——等待业务员同步' },
  'فُعّلت المرحلة الثانية — كل فاتورة توقّع وترسل للهيئة الآن': { en: 'Phase 2 activated — every invoice is now signed and sent to ZATCA', fr: 'Phase 2 activée — chaque facture est désormais signée et transmise à la ZATCA', tr: '2. aşama etkinleştirildi — artık her fatura imzalanıp ZATCA’ya gönderiliyor', zh: '第二阶段已启用——现在每张发票都会签名并提交至 ZATCA' },
  'قائمة الجاهزية للتفعيل': { en: 'Activation readiness checklist', fr: 'Liste de préparation à l’activation', tr: 'Etkinleştirme hazırlık listesi', zh: '启用就绪清单' },
  'كل ما يلزم قبل تفعيل المرحلة الثانية — يتحدّث تلقائيا': { en: 'Everything required before activating Phase 2 — updates automatically', fr: 'Tout ce qui est requis avant d’activer la phase 2 — mise à jour automatique', tr: '2. aşamayı etkinleştirmeden önce gereken her şey — otomatik güncellenir', zh: '启用第二阶段前所需的一切——自动更新' },
  'مناديب لم يزامنوا أجهزتهم بعد': { en: 'Reps who have not synced their devices yet', fr: 'Représentants n’ayant pas encore synchronisé leurs appareils', tr: 'Cihazlarını henüz eşitlememiş temsilciler', zh: '尚未同步设备的业务员' },
  'يفتح المندوب التطبيق ويزامن حتى يفرغ صندوقه بعد التسليح ثم يظهر هنا مزامنا': { en: 'The rep opens the app and syncs until their outbox is empty after arming, then appears here as synced', fr: 'Le représentant ouvre l’application et synchronise jusqu’à ce que sa file d’envoi soit vide après l’armement, puis apparaît ici comme synchronisé', tr: 'Temsilci uygulamayı açar ve hazırlıktan sonra giden kutusu boşalana kadar eşitler, ardından burada eşitlenmiş olarak görünür', zh: '业务员打开应用并同步，直到预备后待发箱清空，随后在此显示为已同步' },
  'تسليح التفعيل': { en: 'Arm activation', fr: 'Armer l’activation', tr: 'Etkinleştirmeyi hazırla', zh: '预备启用' },
  'التسليح يوقف إصدار الفواتير دون اتصال على أجهزة المناديب ويبدأ عدّ المزامنة — تصدر الفواتير أونلاين فقط بعده': { en: 'Arming stops offline invoice issuance on reps’ devices and starts the sync count — invoices are issued online only afterwards', fr: 'L’armement arrête l’émission de factures hors ligne sur les appareils des représentants et démarre le décompte de synchronisation — les factures ne sont ensuite émises qu’en ligne', tr: 'Hazırlık, temsilcilerin cihazlarında çevrimdışı fatura kesimini durdurur ve eşitleme sayımını başlatır — sonrasında faturalar yalnızca çevrimiçi kesilir', zh: '预备会停止业务员设备上的离线开票并开始同步计数——此后仅能联网开票' },
  'ابدأ التسليح': { en: 'Start arming', fr: 'Démarrer l’armement', tr: 'Hazırlığı başlat', zh: '开始预备' },
  'التفعيل مُسلَّح': { en: 'Activation armed', fr: 'Activation armée', tr: 'Etkinleştirme hazır', zh: '启用已预备' },
  'مُسلَّح منذ': { en: 'Armed since', fr: 'Armé depuis', tr: 'Hazırlanma zamanı', zh: '预备于' },
  'بانتظار أن يزامن كل مندوب نشط جهازه بعد التسليح': { en: 'Waiting for every active rep to sync their device after arming', fr: 'En attente que chaque représentant actif synchronise son appareil après l’armement', tr: 'Her etkin temsilcinin hazırlıktan sonra cihazını eşitlemesi bekleniyor', zh: '等待每位在岗业务员在预备后同步其设备' },
  // ── نزع التسليح (تعافٍ، نقد 2/4) ──
  'نزع التسليح': { en: 'Disarm', fr: 'Désarmer', tr: 'Hazırlığı geri al', zh: '取消预备' },
  'يعيد نزع التسليح إصدار الفواتير دون اتصال — استخدمه إن سُلّح بالخطأ أو لتأجيل التفعيل': { en: 'Disarming restores offline invoice issuance — use it if armed by mistake or to postpone activation', fr: 'Le désarmement rétablit l’émission de factures hors ligne — à utiliser en cas d’armement par erreur ou pour reporter l’activation', tr: 'Hazırlığı geri almak çevrimdışı fatura kesimini yeniden etkinleştirir — yanlışlıkla hazırlandıysa veya etkinleştirmeyi ertelemek için kullanın', zh: '取消预备将恢复离线开票——如误预备或需推迟启用时使用' },
  'أُلغي التسليح — عاد إصدار الفواتير دون اتصال': { en: 'Arming cancelled — offline invoice issuance is restored', fr: 'Armement annulé — l’émission de factures hors ligne est rétablie', tr: 'Hazırlık iptal edildi — çevrimdışı fatura kesimi yeniden etkin', zh: '已取消预备——离线开票已恢复' },
  'بعد التفعيل لا عودة إلى المرحلة الأولى': { en: 'After activation there is no return to Phase 1', fr: 'Après l’activation, il n’y a pas de retour à la phase 1', tr: 'Etkinleştirmeden sonra 1. aşamaya dönüş yoktur', zh: '启用后无法回到第一阶段' },
  'من لحظة التفعيل توقّع كل فاتورة وترسل إلى الهيئة، ولا يمكن إصدار فاتورة دون اتصال، ولا إلغاء فاتورة (يستخدم الإشعار الدائن بدلا منها)': { en: 'From the moment of activation every invoice is signed and sent to ZATCA, no invoice can be issued offline, and no invoice can be cancelled (a credit note is used instead)', fr: 'Dès l’activation, chaque facture est signée et transmise à la ZATCA, aucune facture ne peut être émise hors ligne, et aucune facture ne peut être annulée (un avoir est utilisé à la place)', tr: 'Etkinleştirme anından itibaren her fatura imzalanıp ZATCA’ya gönderilir, çevrimdışı fatura kesilemez ve fatura iptal edilemez (yerine alacak dekontu kullanılır)', zh: '自启用起，每张发票都会签名并提交至 ZATCA，不能离线开票，也不能作废发票（改用贷项通知单）' },
  'أقر أن كل المناديب النشطين زامنوا أجهزتهم بعد التسليح': { en: 'I confirm that all active reps have synced their devices after arming', fr: 'Je confirme que tous les représentants actifs ont synchronisé leurs appareils après l’armement', tr: 'Tüm etkin temsilcilerin hazırlıktan sonra cihazlarını eşitlediğini onaylıyorum', zh: '我确认所有在岗业务员已在预备后同步其设备' },
  'فعّل المرحلة الثانية': { en: 'Activate Phase 2', fr: 'Activer la phase 2', tr: '2. aşamayı etkinleştir', zh: '启用第二阶段' },
  'كل الشروط مكتملة — يمكنك التفعيل الآن': { en: 'All conditions are met — you can activate now', fr: 'Toutes les conditions sont remplies — vous pouvez activer maintenant', tr: 'Tüm koşullar sağlandı — şimdi etkinleştirebilirsiniz', zh: '所有条件均已满足——现在即可启用' },
  'أكمل الشروط أعلاه قبل التفعيل': { en: 'Complete the conditions above before activating', fr: 'Complétez les conditions ci-dessus avant d’activer', tr: 'Etkinleştirmeden önce yukarıdaki koşulları tamamlayın', zh: '请在启用前满足上述条件' },
  // ── مراجعة الانتقال (D11) ──
  'حُسم المستند': { en: 'The document was resolved', fr: 'Le document a été traité', tr: 'Belge sonuçlandırıldı', zh: '单据已处理' },
  'مراجعة مستندات الانتقال': { en: 'Cut-over document review', fr: 'Revue des documents de bascule', tr: 'Geçiş belgesi incelemesi', zh: '过渡单据审核' },
  'مستندات أصدرت دون اتصال قبل التفعيل ووصلت بعده — راجع كلا منها': { en: 'Documents issued offline before activation that arrived after it — review each one', fr: 'Documents émis hors ligne avant l’activation et arrivés après — examinez chacun', tr: 'Etkinleştirmeden önce çevrimdışı kesilip sonrasında ulaşan belgeler — her birini inceleyin', zh: '在启用前离线开具、启用后送达的单据——请逐一审核' },
  'وقت الإنشاء على الجهاز': { en: 'Device creation time', fr: 'Heure de création sur l’appareil', tr: 'Cihazda oluşturma zamanı', zh: '设备创建时间' },
  'قبول مرحلة أولى': { en: 'Accept as Phase 1', fr: 'Accepter en phase 1', tr: '1. aşama olarak kabul et', zh: '接受为第一阶段' },
  'إعادة إصدار مرحلة ثانية': { en: 'Reissue as Phase 2', fr: 'Réémettre en phase 2', tr: '2. aşama olarak yeniden düzenle', zh: '重开为第二阶段' },
  'رفض': { en: 'Reject', fr: 'Rejeter', tr: 'Reddet', zh: '拒绝' },
  'قبول المستند مرحلةً أولى': { en: 'Accept the document as Phase 1', fr: 'Accepter le document en phase 1', tr: 'Belgeyi 1. aşama olarak kabul et', zh: '将单据接受为第一阶段' },
  'يسجّل المستند فاتورة من المرحلة الأولى كما أصدر على الجهاز': { en: 'The document is recorded as a Phase 1 invoice, as issued on the device', fr: 'Le document est enregistré comme facture de phase 1, tel qu’émis sur l’appareil', tr: 'Belge, cihazda kesildiği şekilde bir 1. aşama faturası olarak kaydedilir', zh: '该单据将按其在设备上开具的方式记录为第一阶段发票' },
  'إعادة إصدار المستند مرحلةً ثانية': { en: 'Reissue the document as Phase 2', fr: 'Réémettre le document en phase 2', tr: 'Belgeyi 2. aşama olarak yeniden düzenle', zh: '将单据重开为第二阶段' },
  'يعاد إصدار المستند فاتورة من المرحلة الثانية توقّع وترسل للهيئة': { en: 'The document is reissued as a Phase 2 invoice that is signed and sent to ZATCA', fr: 'Le document est réémis comme facture de phase 2 signée et transmise à la ZATCA', tr: 'Belge, imzalanıp ZATCA’ya gönderilen bir 2. aşama faturası olarak yeniden düzenlenir', zh: '该单据将重开为第二阶段发票，并签名提交至 ZATCA' },
  'رفض المستند': { en: 'Reject the document', fr: 'Rejeter le document', tr: 'Belgeyi reddet', zh: '拒绝该单据' },
  'يرفض المستند ولا يصدر — أبلغ المندوب لإلغاء الورقة إن سلّمها للعميل': { en: 'The document is rejected and not issued — tell the rep to void the paper if it was handed to the customer', fr: 'Le document est rejeté et non émis — dites au représentant d’annuler le papier s’il a été remis au client', tr: 'Belge reddedilir ve düzenlenmez — müşteriye verildiyse temsilciye kağıdı iptal etmesini söyleyin', zh: '该单据被拒绝且不予开具——若纸质单据已交给客户，请告知业务员作废' },
  // ── تسميات حالة مراجعة الانتقال ──
  'بانتظار المراجعة': { en: 'Awaiting review', fr: 'En attente de revue', tr: 'İnceleme bekliyor', zh: '等待审核' },
  'قُبل مرحلةً أولى': { en: 'Accepted as Phase 1', fr: 'Accepté en phase 1', tr: '1. aşama olarak kabul edildi', zh: '已接受为第一阶段' },
  'أُعيد إصداره مرحلةً ثانية': { en: 'Reissued as Phase 2', fr: 'Réémis en phase 2', tr: '2. aşama olarak yeniden düzenlendi', zh: '已重开为第二阶段' },
  'مرفوض': { en: 'Rejected', fr: 'Rejeté', tr: 'Reddedildi', zh: '已拒绝' },
};

/** tr() لقسمَي التفعيل والانتقال: العربية كما هي، وإلا عبارات هذا القسم ثمّ عبارات التبويب فالقاموس العامّ. */
export function goLiveTranslate(lang: string, ar: string): string {
  if (lang === 'ar') return ar;
  const l = lang as 'en' | 'fr' | 'tr' | 'zh';
  return GO_LIVE_PHRASES[ar]?.[l] ?? zatcaTranslate(lang, ar);
}

export function useGoLiveTr() {
  const lang = useLang(s => s.lang);
  return (ar: string): string => goLiveTranslate(lang, ar);
}

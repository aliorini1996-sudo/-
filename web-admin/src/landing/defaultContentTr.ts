// المحتوى التركي لصفحة الهبوط (يُستخدم عندما تكون اللغة = TR) — سوق تصدير يرى الأسعار بالريال
export const defaultContentTr = {
  cta: { tryFree: 'Ücretsiz denemenizi başlatın' },
  hero: {
    badge: 'Saha satış yönetimi platformu',
    titleLine1: 'Saha temsilcilerinizi',
    titleLine2: 'siparişten tahsilata yönetin',
    subtitle: 'Dağıtım temsilcilerinizi ofisle gerçek zamanlı buluşturan hepsi bir arada bir sistem — siparişler, vergi faturaları, tahsilat, makbuzlar ve doğru raporlar tek bir yerde.',
    ctaSecondary: 'Demoyu izleyin',
  },
  features: {
    title: 'Dağıtım ekiplerinin ihtiyaç duyduğu her şey, tek platformda',
    subtitle: 'Sahada sipariş oluşturmaktan yöneticinin masasına ulaşan rapora kadar — her şey birbirine bağlı ve senkronize.',
    items: [
      { title: 'Saha sipariş yönetimi', desc: 'Temsilciler, ürün kataloğu ve fiyatlarla siparişi telefonlarından oluşturur; sipariş anında ofise ve depoya ulaşır.' },
      { title: 'Tahsilat', desc: 'Nakit, havale veya çek ile yapılan ödemeleri kaydedin; her müşterinin bekleyen ve geciken bakiyelerini gerçek zamanlı takip edin.' },
      { title: 'Vergi faturaları', desc: 'Mevzuata uygun (Suudi Arabistan’da ZATCA) QR kodlu vergi faturaları düzenleyin ve doğrudan müşteriye gönderin.' },
      { title: 'Tahsilat makbuzları', desc: 'Her tahsilat için doğrulanmış dijital bir makbuz — müşteriye gönderilir ve hesap ekstresine otomatik kaydedilir.' },
      { title: 'Raporlar ve ekstreler', desc: 'Müşteri bazında ayrıntılı hesap ekstresi; ayrıca tek tıkla temsilci, satış ve tahsilat performans raporları.' },
      { title: 'Temsilciler ve yetkiler', desc: 'Temsilci hesapları oluşturun ve her birinin yetkilerini ayrıntılı olarak kontrol edin: indirimler, fiyat altında satış, müşteri ekleme ve azami indirim limiti.' },
      { title: 'Araç stoku', desc: 'Temsilciler araca yükledikleri ürünleri ürün bazında kaydeder; stok her satışta otomatik azalır, yöneticiler kalan miktarları ve mal hareketlerini (neyin ne zaman çıktığını) gerçek zamanlı izler.' },
      { title: 'GPS ile canlı temsilci takibi', desc: 'Sahada çalışırlarken temsilcilerin canlı konumlarını haritada ve her temsilcinin günlük rotasını GPS ile takip edin.' },
      { title: 'Müşteriler ve hesap ekstreleri', desc: 'Kredi limitleri, bakiyeler ve müşteri bazında ayrıntılı ekstre ile düzenli bir müşteri tabanı — her fatura ve ödemede otomatik güncellenir; müşteri kredi limitini aştığında uyarı verir.' },
      { title: 'Ürün kataloğu ve fiyatlandırma', desc: 'Miktara göre kademeli fiyatlar ve müşteriye özel fiyatlarla tek bir ürün kataloğu; sahadaki temsilcilere anında ulaşır.' },
      { title: 'Şirket ekibi ve roller', desc: 'Yönetici, müdür ve muhasebeci kullanıcılar ekleyin; bölüm bazında ayrıntılı yetkilerle her üye yalnızca izin verdiklerinizi görür ve yapar.' },
      { title: 'ERP entegrasyonu', desc: 'Müşterilerinizi, ürünlerinizi, faturalarınızı ve makbuzlarınızı güvenli bir bağlantı üzerinden ERP sisteminizle senkronize edin; ayrıntılı senkronizasyon kayıtlarıyla.' },
      { title: 'Satış kanalı sınıflandırması', desc: 'Müşterileri satış kanalına göre sınıflandırın (Modern Kanal, Toptan, Geleneksel Kanal, İndirim Marketleri, Sıcak Satış, E-Ticaret) ve satışları kanal ve coğrafi bölge bazında analiz edin.' },
      { title: 'Çevrimdışı çalışır', desc: 'Temsilci uygulaması gün boyu internetsiz çalışır: QR kodlu vergi faturalarını ve makbuzları düzenleyip yazdırın ve müşterilere teslim edin; bağlantı geri geldiğinde her belge ofise otomatik yüklenir — mükerrer kayıt yok, veri kaybı yok.' },
      { title: 'Barkod okuma', desc: 'Temsilcinin telefon kamerasıyla ürün barkodlarını okutun; ürünleri sahada faturaya hızlı ve hatasız ekleyin.' },
      { title: 'Akıllı iadeler (hasarlı/değişim)', desc: 'Sınıflandırılmış iadeler oluşturun (normal/hasarlı/değişim); her iadenin araç stokuna dönüp dönmeyeceği yönetici kontrolünde, üstelik ürün bazında stok iade politikasıyla.' },
    ],
  },
  how: {
    title: 'Dakikalar içinde başlayın',
    subtitle: 'Saha ekibinizi eksiksiz yönetmenizle aranızda yalnızca üç adım var.',
    steps: [
      { title: 'Hesabınızı oluşturun', desc: 'Şirketinizi kaydedin; ürünlerinizi, müşterilerinizi ve temsilcilerinizi dakikalar içinde ekleyin.' },
      { title: 'Temsilciler sahaya çıkar', desc: 'Her temsilci müşterilerini ziyaret eder, siparişleri oluşturur ve tahsilatı telefonundan yapar.' },
      { title: 'Takip edin ve analiz edin', desc: 'Satışları, tahsilatı ve performansı tek bir panelden gerçek zamanlı izleyin.' },
    ],
  },
  roles: {
    title: 'Her rol için tasarlanmış bir arayüz',
    items: [
      { title: 'Saha temsilcisi', desc: 'Hafif bir mobil uygulama: müşteriler, siparişler, tahsilat ve vergi faturaları — doğrudan telefondan.' },
      { title: 'Satış müdürü', desc: 'Ekipleri, hedefleri, tahsilatı ve her temsilcinin performansını izlemek için eksiksiz bir yönetim paneli.' },
      { title: 'Üst yönetim', desc: 'Tüm şube ve bölgelerde karar almayı destekleyen yönetim raporları ve büyüme göstergeleri.' },
    ],
  },
  pricing: {
    title: 'Şirketinizle birlikte büyüyen planlar',
    subtitle: '10 gün ücretsiz başlayın — kredi kartı gerekmez.',
    plans: [
      { name: 'Başlangıç', price: '299', limit: '5 temsilciye kadar' },
      { name: 'Profesyonel', price: '799', limit: '20 temsilciye kadar', badge: 'En popüler' },
      { name: 'Kurumsal', price: 'Özel', limit: 'Sınırsız temsilci' },
    ],
  },
  faq: {
    title: 'Sık sorulan sorular',
    items: [
      { q: 'Faturalar mevzuata uygun mu?', a: 'Sistem, e-faturanın 1. Aşaması (oluşturma aşaması) kapsamında QR kodlu basitleştirilmiş vergi faturaları düzenler. 2. Aşama (entegrasyon) henüz hazır değildir ve ZATCA yazılım sağlayıcılarına sertifika vermez. Vergi ayarları şirketin ülkesine göre uyarlanır.' },
      { q: 'Özel bir donanıma ihtiyacım var mı?', a: 'Hayır — uygulama her akıllı telefonda çalışır. Sahada yazdırmak için 58 mm termal yazıcı (Bluetooth veya dahili) yeterlidir.' },
      { q: 'Uygulama çevrimdışı çalışıyor mu?', a: 'Evet — temsilci uygulaması gün boyu internetsiz çalışır: QR kodlu vergi faturalarını ve makbuzları düzenleyip yazdırın ve müşterilere teslim edin; bağlantı geri geldiğinde her belge ofise otomatik yüklenir, mükerrer kayıt ve veri kaybı olmaz.' },
      { q: 'Kurulum ne kadar sürer?', a: 'Şirketinizi, ürünlerinizi ve temsilcilerinizi dakikalar içinde tanımlayıp hemen fatura düzenlemeye başlayabilirsiniz.' },
      { q: 'Abone olmadan önce sistemi deneyebilir miyim?', a: 'Evet, info@fieldsa.net adresinden bize ulaşın; abonelik öncesinde sistemi denemenize yardımcı olalım.' },
    ],
  },
  finalCta: {
    title: 'Saha ekibinizin verimliliğini ikiye katlamaya hazır mısınız?',
    subtitle: 'Vergi faturalarınızı düzenleyin, tahsilatınızı yapın ve saha ekibinizi izleyin — hepsi tek bir platformdan.',
    ctaSecondary: 'Demo talep edin',
    note: '10 gün ücretsiz · Kredi kartı gerekmez · İstediğiniz zaman iptal edin',
  },
  footer: {
    desc: 'Dağıtım saha satışlarını yönetmek için eksiksiz bir platform — siparişten tahsilata.',
  },
  contact: {
    intro: 'Size yardımcı olmak için buradayız. Bize ulaşın, en kısa sürede size dönelim.',
    email: 'info@fieldsa.net',
    phone: '',
    whatsapp: '',
    address: 'Suudi Arabistan',
  },
  pages: {
    about: {
      title: 'Hakkımızda',
      body: 'Field Sales, dağıtım saha temsilcilerini yönetmek için eksiksiz bir platformdur — sahada siparişin oluşturulmasından vergi faturasının düzenlenmesine, tahsilata ve raporlamaya kadar. Dağıtım şirketlerinin saha ekiplerini tam verimlilik ve şeffaflıkla yönetmesine yardımcı oluyoruz.',
    },
    terms: {
      title: 'Şartlar ve Koşullar',
      body: `Son güncelleme: Temmuz 2026

Bu Şartlar ve Koşullar, FieldSales platformunu kullanımınızı düzenler. Hesap oluşturarak veya platformu kullanarak bu Şartları okuduğunuzu ve kabul ettiğinizi beyan edersiniz. Kabul etmiyorsanız lütfen hizmeti kullanmayın.

1. Tanımlar
"Platform": FieldSales hizmeti, uygulamaları ve fieldsa.net web sitesi. "Abone": hesabın sahibi olan şirket. "Kullanıcı": platformu Abone adına kullanan herkes (yönetici, kullanıcı veya saha temsilcisi).

2. Hizmetin Tanımı
Platform, saha dağıtım temsilcilerini yönetmeye yönelik bir bulut sistemidir ve şunları içerir: sipariş yönetimi, vergi faturaları, tahsilat ve tahsilat makbuzları, müşteri ve ürün yönetimi, araç stoku, temsilci takibi ve raporlar.

3. Hesap ve Kayıt
• Kayıt sırasında doğru ve güncel bilgiler vermeyi kabul edersiniz.
• Giriş bilgilerinizin gizliliğinden ve hesabınız altındaki tüm etkinliklerden siz sorumlusunuz.
• Hesabınızın yetkisiz kullanımını derhal bize bildirmelisiniz.

4. Ücretsiz Deneme ve Abonelik
• Kredi kartı gerektirmeyen 10 günlük ücretsiz deneme sunuyoruz.
• Deneme sonrasında kullanıma devam etmek, seçilen plana göre ücretli abonelik gerektirir.
• Fiyatlar, önceden bildirimle ve ödenmiş bir dönemi etkilemeksizin gelecekte değişebilir.

5. Kabul Edilebilir Kullanım
Şunları yapmamayı kabul edersiniz:
• Platformu hukuka aykırı bir amaçla veya yürürlükteki mevzuata aykırı şekilde kullanmak.
• Sisteme sızmaya, hizmeti aksatmaya veya başkalarının verilerine yetkisiz erişmeye çalışmak.
• Yazılı izin olmadan hizmete tersine mühendislik uygulamak, hizmeti kopyalamak veya yeniden satmak.
• Başkalarının haklarını, gizliliğini veya fikri mülkiyetini ihlal eden veriler girmek.

6. Veri Sahipliği
Abonenin verileri (müşteriler, ürünler, faturalar ve kayıtlar) yalnızca kendisine aittir. Abone, bu verileri yalnızca hizmetin işletilmesi için gerekli olduğu ölçüde işlememiz amacıyla bize sınırlı bir lisans verir.

7. E-Fatura ve Vergi Uyumu
Platform, yetkili kurumun gerekliliklerine (örneğin Suudi Arabistan’da ZATCA) uygun vergi faturaları düzenlemenize yardımcı olur. Vergi verilerinin doğruluğu ve faaliyet gösterilen ülkenin e-fatura mevzuatına uyum sorumluluğu Aboneye aittir.

8. Fikri Mülkiyet
Platforma, yazılımlarına, tasarımlarına ve markasına ilişkin tüm haklar FieldSales’e aittir ve hizmetin izin verilen kapsamı dışında kullanılamaz.

9. Erişilebilirlik ve Destek
Hizmetin erişilebilir kalması ve info@fieldsa.net ile help@fieldsa.net üzerinden destek sağlanması için makul çabayı gösteririz. Mümkün olduğunda önceden bildirimde bulunarak dönemsel bakım yapabiliriz.

10. Askıya Alma ve Fesih
Bu Şartların ihlali veya ödeme yapılmaması hâlinde, yasal bir engel bulunmadıkça verileri dışa aktarmanız için makul bir imkân tanıyarak hesabı askıya alabilir veya feshedebiliriz.

11. Garanti Reddi
Hizmet "olduğu gibi" sunulur. Gerekli mesleki özeni göstermeyi taahhüt etmekle birlikte, hizmetin kesinti veya hatalardan tamamen arınmış olacağını garanti etmeyiz.

12. Sorumluluğun Sınırlandırılması
Dolaylı, netice kabilinden veya kâr kaybı zararlarından sorumlu değiliz. Her durumda sorumluluğumuz, talepten önceki üç ayda ödenen toplam abonelik ücretlerini aşmaz.

13. Tazminat
Abone, platformu bu Şartlara veya yürürlükteki hukuka aykırı kullanımından doğan her türlü talep veya zarara karşı FieldSales’i tazmin etmeyi kabul eder.

14. Şartlarda Değişiklik
Bu Şartları zaman zaman değiştirebilir ve güncel sürümü bu sayfada yayımlayabiliriz; kullanıma devam edilmesi kabul anlamına gelir.

15. Uygulanacak Hukuk ve Uyuşmazlıklar
Bu Şartlar, hizmetin faaliyet gösterildiği ülkede yürürlükteki mevzuata tabidir. Uyuşmazlıklar mümkün olduğunca dostane yolla, aksi hâlde yetkili merciler önünde çözülür.

16. İletişim
Her türlü soru için: info@fieldsa.net`,
    },
    serviceAgreement: {
      title: 'Hizmet Sözleşmesi',
      body: `Son güncelleme: Temmuz 2026

Bu sözleşme, FieldSales hizmetinin kapsamını, sunum düzeyini ve iki tarafın yükümlülüklerini tanımlar. "Şartlar ve Koşullar"ı tamamlar.

1. Hizmetin Kapsamı
Hizmet, abonelik planınıza göre FieldSales bulut platformuna ve bileşenlerine erişimi içerir: sipariş yönetimi, vergi faturaları, tahsilat ve tahsilat makbuzları, müşteri ve ürün yönetimi, araç stoku, temsilci takibi ve raporlar — temsilci mobil uygulamasıyla birlikte.

2. Erişilebilirlik
Hizmetin 7/24 yüksek erişilebilirliğini korumaya çalışırız. Bakım veya kontrolümüz dışındaki nedenlerle (altyapı sağlayıcıları veya bağlantı) geçici kesintiler yaşanabilir. Planlı bakımları mümkün olduğunda önceden bildiririz.

3. Teknik Destek
E-posta ile destek sağlarız: genel sorular için info@fieldsa.net, teknik destek için help@fieldsa.net. İş günlerinde makul bir süre içinde yanıt vermeyi hedefleriz.

4. Yedekleme ve Veri Sürekliliği
Verilerinizi kayıptan mümkün olduğunca korumak için, kurtarma prosedürlerimiz kapsamında platform verilerinin düzenli yedeklerini alırız.

5. Güvenlik ve Veri İzolasyonu
Her abonenin verileri izole bir alanda saklanır, bağlantılar şifrelenir ve ayrıntılı yetki kontrolleri uygulanır. (Ayrıntılar için "Gizlilik Politikası"na bakın.)

6. Güncellemeler ve Geliştirme
Platformu sürekli geliştirir; temel işlevlerinizi olumsuz etkilemeden düzenli olarak yeni özellikler ve iyileştirmeler ekleriz.

7. Abonenin Yükümlülükleri
• Doğru veri girmek ve kullanıcı ile temsilci hesaplarını gizli tutmak.
• Hizmeti hukuka uygun kullanmak ve faaliyet gösterilen ülkenin mevzuatına uymak.
• Faturalarının, vergi ve mali verilerinin doğruluğunu takip etmek.

8. Kullanım Sınırları
Tüm aboneler için hizmet kalitesini güvence altına almak amacıyla hizmet, plan sınırlarına (temsilci ve kullanıcı sayısı) ve adil kullanım politikasına tabidir.

9. Fesihte Veri Dışa Aktarımı
Abonelik sona erdiğinde, verileriniz yürürlükteki saklama politikasına göre silinmeden önce bunları dışa aktarmanız için makul bir imkân tanınır.

10. Değişiklikler
Bu sözleşmeyi hizmetin gelişimine hizmet edecek şekilde güncelleyebilir ve güncel sürümü bu sayfada yayımlarız.

11. İletişim
info@fieldsa.net`,
    },
    privacy: {
      title: 'Gizlilik Politikası',
      body: `Son güncelleme: Temmuz 2026

FieldSales ("biz", "platform"), müşterilerinin ve kullanıcılarının gizliliğini korumayı taahhüt eder. Bu politika, saha satış ve dağıtım yönetimi platformumuzu kullanırken hangi verileri topladığımızı, bunları nasıl kullandığımızı ve koruduğumuzu açıklar.

1. Kapsam
Bu politika tüm platform kullanıcıları için geçerlidir: abone şirketler, yöneticileri ve kullanıcıları, saha temsilcileri ve fieldsa.net web sitemizin ziyaretçileri.

2. Topladığımız Veriler
• Hesap verileri: şirket adı, kullanıcı adı, e-posta, telefon numarası ve parola (şifrelenmiş olarak saklanır).
• Şirketin girdiği operasyonel veriler: müşteriler, ürünler, fiyatlar, siparişler, faturalar, tahsilat makbuzları ve hesap bakiyeleri.
• Konum (GPS) verileri: yalnızca çalışma saatlerinde, ziyaret ve rota takibi amacıyla temsilci uygulamasından toplanır ve şirket yöneticisi tarafından etkinleştirilir.
• Teknik veriler: cihaz türü, IP adresi ve kullanım kayıtları; güvenlik ve performans amacıyla.

3. Verilerinizi Nasıl Kullanırız
Verileri yalnızca şu amaçlarla kullanırız:
• Platformu işletmek ve hizmetlerini size sunmak.
• Teknik destek sağlamak ve hesabınızla ilgili iletişim kurmak.
• Performansı ve güvenliği iyileştirmek ve kötüye kullanımı önlemek.
• Yasal ve düzenleyici yükümlülükleri yerine getirmek.
Verilerinizi reklam amacıyla kullanmayız ve hiçbir tarafa satmayız.

4. Şirket Bazında Veri İzolasyonu
Her abone şirketin verileri mantıksal olarak izole bir alanda saklanır (çok kiracılı izolasyon); hiçbir şirket bir başkasının verilerine erişemez ve verileriniz yalnızca size ait kalır.

5. Veri Paylaşımı
Verilerinizi üçüncü taraflarla paylaşmayız; şu durumlar hariç:
• Bizim adımıza hareket eden güvenilir hizmet sağlayıcıları (barındırma, e-posta) ve yalnızca hizmetin işletilmesi için gerekli olduğu ölçüde.
• Yasal bir yükümlülük veya yetkili bir merci gerektirdiğinde.

6. Konum Takibi
Temsilci takibi şirketin bilgisi dahilinde etkinleştirilir; çalışma saatleriyle ve mesleki amaçlarla (ziyaretleri düzenleme ve kapsamı iyileştirme) sınırlıdır ve şirket tarafından temsilci bazında yapılandırılabilir veya devre dışı bırakılabilir.

7. Veri Güvenliği
Teknik ve idari önlemler uygularız: bağlantı şifreleme (HTTPS), parola şifreleme ve yetki kontrolleri. Tüm özenimize rağmen hiçbir sistem %100 güvenli değildir; bu nedenle giriş bilgilerinizi korumanızı öneririz.

8. Veri Saklama
Verilerinizi aboneliğiniz süresince saklarız. Abonelik sona erdiğinde verilerinizin dışa aktarımını talep edebilirsiniz; ardından, yasal bir saklama zorunluluğu olmadıkça verileriniz makul bir süre içinde politikamıza uygun olarak silinir.

9. Haklarınız
info@fieldsa.net üzerinden bize ulaşarak verilerinize erişme, bunları düzeltme, dışa aktarma ve silinmesini talep etme hakkına sahipsiniz.

10. Çerezler
Platformu işletmek ve oturumunuz ile tercihlerinizi saklamak için gerekli çerezleri kullanırız. Reklam takipçileri kullanmayız.

11. Çocukların Gizliliği
Platform ticari kullanım içindir ve 18 yaşından küçükler tarafından kullanılamaz.

12. Bu Politikadaki Değişiklikler
Bu politikayı zaman zaman güncelleyebilir ve güncel sürümü güncelleme tarihiyle birlikte bu sayfada yayımlarız.

13. İletişim
Gizlilik veya verilerinizle ilgili her soru için: info@fieldsa.net`,
    },
  },
  social: { x: '', instagram: '', linkedin: '', whatsapp: '', snapchat: '', youtube: '', facebook: '', tiktok: '' },
};

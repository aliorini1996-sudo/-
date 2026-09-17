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
      { name: 'Başlangıç', price: '299', limit: '5 temsilciye kadar · 1 yönetici' },
      { name: 'Büyüme', price: '399', limit: '10 temsilciye kadar · 2 yönetici' },
      { name: 'Profesyonel', price: '599', limit: '20 temsilciye kadar · 5 yönetici', badge: 'En çok tercih edilen' },
      { name: 'Kurumsal', price: 'Teklife göre', limit: 'Sınırsız temsilci' },
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
      body: `Son güncelleme: Eylül 2026

FieldSales ("biz", "platform"), müşterilerinin, kullanıcılarının ve web sitesi ziyaretçilerinin gizliliğini korumayı taahhüt eder. Bu politika hangi verileri topladığımızı, bunları nasıl kullandığımızı ve koruduğumuzu, kimlerle paylaştığımızı ve Suudi Arabistan Kişisel Verilerin Korunması Kanunu (PDPL) kapsamındaki haklarınızı açıklar.

1. Biz Kimiz
FieldSales platformu, 7040371671 numaralı ticaret sicil kaydına sahip ve Riyad, Suudi Arabistan Krallığı'nda yerleşik "مؤسسة تكامل الميدان للتجارة والإستيراد" tarafından işletilmektedir. Bu kuruluş, bu politikada açıklanan kişisel veri işleme faaliyetlerinden sorumlu taraftır.
Abone bir şirketin kendi hesabına girdiği operasyonel veriler, o şirket adına ve yalnızca ona hizmet sunmak amacıyla işlenir.

2. Kapsam
Bu politika tüm platform kullanıcıları (abone şirketler, yöneticileri ve kullanıcıları ile saha temsilcileri), fieldsa.net web sitemizin ziyaretçileri, bize WhatsApp, iletişim formu, abonelik talep formu veya e-posta yoluyla ulaşan herkes, FieldSales elçileri, platformdaki çevrimiçi ödeme bağlantılarıyla ödeme yapan herkes ve pazarlama amacıyla iletişim kurduğumuz işletmeler için geçerlidir.

3. Topladığımız Veriler
• Hesap verileri: şirket adı, kullanıcı adı, e-posta, telefon numarası ve parola (şifrelenmiş olarak saklanır).
• Şirketin girdiği operasyonel veriler: müşteriler, ürünler, fiyatlar, siparişler, faturalar, tahsilat makbuzları ve hesap bakiyeleri.
• Temsilci uygulamasından alınan konum (GPS) verileri (11. bölümde açıklandığı şekilde).
• Teknik veriler: cihaz türü, IP adresi ve kullanım kayıtları; güvenlik ve performans amacıyla. Ayrıca, 11. bölümde açıklandığı şekilde temsilcinin çalışma saatlerini şirketi için hesaplamak amacıyla temsilci uygulamasının açık ve bağlı olduğu zamanlar.
• Herkese açık web sitesinde gezinme ve reklam ölçümü verileri (5. ve 6. bölümlerde açıklandığı şekilde).
• Bize yazdığınızda WhatsApp yazışma verileri (8. bölümde açıklandığı şekilde).
• Web sitemizdeki iletişim formu ile abonelik talep formunun verileri ve e-posta adresimize gönderdiğiniz mesajlar: ad, işletme adı, e-posta, cep telefonu numarası, ülke, şehir, temsilci sayısı ve mesaj metni veya notlar.
• Çevrimiçi ödeme verileri (bir abonelik veya fatura bir ödeme bağlantısıyla ödendiğinde): tutar, ödeme açıklaması (şirket adı ve fatura numarası gibi), WhatsApp üzerinden talep edilen yeni abonelikte cep telefonu numarası ve ödeme geçidi sağlayıcımız Moyasar nezdindeki ödeme durumu ve referansı. Kart bilgileri Moyasar'ın barındırdığı ödeme sayfasına girilir; bu nedenle sunucularımızdan geçmez ve bunları saklamayız.
• FieldSales elçilerinin verileri: ad, e-posta, cep telefonu numarası, şehir, parola (şifrelenmiş olarak saklanır), (varsa) Mawthooq lisans numarası ve bitiş tarihi ile KDV numarası, hak edişlerin ödenmesi için banka bilgileri (şifrelenmiş olarak saklanan IBAN, hesap sahibinin adı ve banka adı) ve program koşulları kabul edilirken IP adresinden türetilen bir değer; ayrıca elçilerin önerdiği işletmelere ait veriler: işletme adı, ticaret sicil numarası, şehir, iletişim numarası, elçinin işletmeyi nasıl tanıdığı ve elçinin notu.
• Abone şirketin kendi hesap anahtarlarıyla sağlayıcıları nezdinde etkinleştirdiği entegrasyonların verileri; örneğin iş numaraları için Hatif (iş numaralarını ve arama kayıtlarını alırız: iki tarafın numaraları, zaman, süre, sağlayıcıdaki kayıt bağlantısı ve sağlayıcı gönderirse döküm ile özet) ve PetroApp (şirketin araçlarını ve plakalarını, sürücülerinin adlarını ve telefon numaralarını, yakıt, bakım ve yıkama faturalarını alırız) ile adresini şirketin belirlediği bir ERP sistemi (şirketin talebi üzerine bu sisteme şirketin adları, telefon numaraları, adresleri ve harita konumları dahil müşterilerini; ürünlerini; temsilcinin adı ve telefon numarası dahil faturalarını ve tahsilat makbuzlarını göndeririz). Bu verileri 1. bölümde belirtildiği gibi şirket adına ve onun talimatları doğrultusunda işleriz.
• Pazarlama amacıyla iletişim kurduğumuz işletmelere ait, herkese açık ticari iletişim verileri (4. bölümde açıklandığı şekilde).
• Web sitemizdeki ücretsiz fatura oluşturucuyla oluşturduğunuz faturaların verileri (4. bölümde açıklandığı şekilde).

4. Verilerinizi Nasıl Kullanırız
Verileri yalnızca şu amaçlarla kullanırız:
• Platformu işletmek ve hizmetlerini size sunmak.
• Teknik destek sağlamak ve hesabınızla ilgili iletişim kurmak.
• Abonelik öncesinde ve sonrasında sorularınızı yanıtlamak.
• FieldSales elçi programını yürütmek, elçilerin hak edişlerini hesaplamak ve ödemek.
• Aşağıda açıklandığı şekilde işletmelerle pazarlama amaçlı iletişim kurmak.
• Hangi kanalların ve sayfaların bize ziyaretçi getirdiğini anlamak, reklamlarımızın etkinliğini ölçmek ve iyileştirmek.
• Performansı ve güvenliği iyileştirmek ve kötüye kullanımı önlemek.
• Yasal ve düzenleyici yükümlülükleri yerine getirmek.
Abone şirket hesaplarında saklanan operasyonel verileri hiçbir reklam amacıyla kullanmayız ve hiçbir veriyi hiç kimseye satmayız.
Hesap ve operasyonel verilerin işlenmesinin hukuki dayanağı abonelik sözleşmesinin ifası ve yasal yükümlülüklerin yerine getirilmesidir; ödeme verilerinde talep ettiğiniz ödemenin gerçekleştirilmesi, elçi verilerinde ise elçi programı koşullarının ifasıdır. Ziyaret istatistikleri, reklam ölçümü ve WhatsApp yazışmalarının hukuki dayanakları kendi bölümlerinde belirtilmiştir.
Haritalar, işletme rehberleri, arama motorları ve işletmelerin kendi web siteleri gibi herkese açık kaynaklardan ve harita, arama ve işletme verisi sağlayıcılarından işletmelere ait herkese açık ticari iletişim verilerini toplarız: işletme adı, faaliyet alanı, telefon, e-posta, web sitesi, adres, şehir, ülke ve harita konumu. Bu verileri bu işletmelerle e-posta ve WhatsApp üzerinden pazarlama amaçlı iletişim kurmak için kullanır; e-postaların açılması, bağlantılarına tıklanması, yanıtlar ve mesajlaşmayı durdurma talepleri gibi mesajlarımızla etkileşimlerini kaydederiz. Her işletme ve bu verilerin ilgili olduğu herkes buna itiraz edebilir ve kendisiyle iletişimin durdurulmasını talep edebilir: e-postalarımızdaki abonelikten çıkma bağlantısı e-postalarımızı, bir WhatsApp mesajına durdurma kelimesiyle yanıt vermek WhatsApp mesajlarımızı durdurur; tüm kanallardan iletişimi durdurmak için info@fieldsa.net adresine yazın.
Web sitemizdeki ücretsiz fatura oluşturucudan bir fatura indirdiğinizde veya yazdırdığınızda satıcı işletmenin adını, KDV numarasını, adresini ve ülkesini, alıcının adını ve KDV numarasını, faturanın toplam tutarını ve para birimini saklar ve satıcı işletmeyi potansiyel müşteri olarak kaydederiz. Bu verileri hizmeti iyileştirmek ve satıcı işletmeyle pazarlama amaçlı iletişim kurmak için kullanırız. Bu veriler aracın kullanıcısı tarafından girilir ve herkese açık değildir. Satıcı işletme buna itiraz edebilir ve yukarıda açıklanan yollarla kendisiyle iletişim kurulmamasını talep edebilir.

5. Herkese Açık Web Sitesi Ziyaret İstatistikleri
Herkese açık web sitemiz fieldsa.net'te gezinirken (giriş yaptıktan sonra platformun içinde değil) sunucularımız ziyaret ettiğiniz her sayfa için şunları kaydeder:
• Sayfa adresi, sayfanın dili ve varsa sizi yönlendiren web sitesi.
• Tarayıcınızın gönderdiği şekliyle tarayıcı ve cihaz türü.
• IP adresinizin harici bir IP konum belirleme hizmetine gönderilmesiyle elde edilen yaklaşık ülke, bölge ve şehir.
• IP adresinin kendisi yerine sakladığımız, IP adresinden karma (hash) fonksiyonuyla türetilen bir değer; Eylül 2026'dan bu yana bu değeri gizli bir anahtarla türetiriz. Bu değer aynı IP adresinden yapılan her ziyarette aynıdır; bu nedenle benzersiz ziyaretçi sayısını tahmin etmek için kullanırız.
• Ziyaret bağlantısındaki utm_source, utm_medium ve utm_campaign gibi kampanya etiketleri.
• Rastgele ve anonim bir ziyaretçi kimliği, 30 dakika hareketsizlikten sonra sona eren bir oturum kimliği ve bir kampanyadan veya harici bir web sitesinden gelen ilk ziyaretinizin kaynağı ile ilk açtığınız sayfa.
Bu kimlikler çerezlerde değil, tarayıcınızın yerel depolamasında (localStorage) tutulur ve siz silene veya 7. bölümde açıklanan düğmeyle ölçümü durdurana kadar orada kalır. Bu kayıtlar adınızı, e-posta adresinizi veya telefon numaranızı içermez ve cihaz parmak izi (fingerprinting) kullanmayız.
Web sitemizdeki bir WhatsApp düğmesine dokunduğunuzda bu dokunuşu, geldiği sayfayı ve (varsa) ziyaretçi kimliğinizi kaydeder, önceden doldurulmuş mesaja "FS" ile başlayan kısa bir referans kodu ekleriz. Mesajı bu kodla birlikte gönderirseniz, bu kod sayesinde yazışmanızı ve telefon numaranızı aynı tarayıcıdan sitemizdeki gezinme geçmişinizle, ilk ziyaret kaynağınızla ve sizi getiren kampanyayla ilişkilendiririz. Kodu göndermeden önce silebilirsiniz; bu durumda bu ilişkilendirme yapılmaz.
Bir FieldSales elçisinin yönlendirme bağlantısıyla gelirseniz, kaydolduğunuzda aboneliğinizin o elçiye atfedilebilmesi için yönlendirme kodunu tarayıcınızda saklarız. Kod, kaydedilmesinden 365 gün sonra geçerliliğini yitirir ve bu sürenin ardından sitemize yaptığınız ilk ziyarette tarayıcınızdan silinir.
Bu verileri hangi kanalların ve sayfaların ziyaret ve yazışma getirdiğini anlamak için kullanırız. Saklama süresi 13. bölümde açıklanmıştır.
Hukuki dayanak: web sitemizin ve pazarlama kanallarımızın performansını anlamaya yönelik meşru menfaatimiz; bu ölçüme itiraz etme ve 7. bölümdeki yöntemlerle durdurma hakkınız saklıdır.

6. Google Ads ile Reklam Ölçümü
Google arama sonuçlarında reklam veriyoruz ve Google LLC tarafından sağlanan Google Ads etiketini yalnızca herkese açık web sitemizde (giriş yaptıktan sonra platformun içinde değil) kullanıyoruz. Amacı, reklamlarımızdan gelen bir ziyaretin ücretsiz deneme başlatılmasıyla veya bizimle WhatsApp yazışması başlatılmasıyla sonuçlanıp sonuçlanmadığını ölçmektir.
Bu ölçüm kapsamında şunlar işlenir:
• Google'ın reklam bağlantısına eklediği reklam tıklama tanımlayıcısı.
• Herkese açık web sitemizde etiketin çalıştığı sayfalar.
• Dönüşüm olayının kendisi (ücretsiz deneme veya WhatsApp yazışması başlatma).
• Google tarafından doğrudan işlenen, IP adresiniz ile tarayıcı ve cihaz bilgileri gibi teknik veriler.
Bu amaçla Google, alan adımızda _gcl_au ve _gcl_aw gibi birinci taraf çerezler yerleştirir.
Bu ölçümdeki taahhütlerimiz:
• Etiket ayarlarında reklam kişiselleştirme sinyallerini devre dışı bıraktık.
• Yeniden pazarlama (remarketing) kitleleri oluşturmayız.
• Google'a müşteri listesi yüklemeyiz, Google Ads'te Gelişmiş Dönüşümler (Enhanced Conversions) özelliğini etkinleştirmeyiz ve Google'a adınızı, e-posta adresinizi veya telefon numaranızı bilerek göndermeyiz.
Amaç: reklamlarımızın etkinliğini ölçmek ve reklam harcamalarımızı yönlendirmek.
Hukuki dayanak: reklamlarımızın performansını gerekli asgari veriyle ölçmeye yönelik meşru menfaatimiz; bu ölçüme itiraz etme ve 7. bölümdeki yöntemlerle her zaman durdurma hakkınız saklıdır.
Google bu verileri kendi gizlilik politikasına uygun olarak Suudi Arabistan Krallığı dışındaki sunucularda işleyebilir: https://policies.google.com/privacy

7. Ölçümü Nasıl Durdurabilirsiniz
• Bu sayfanın sonundaki (fieldsa.net/privacy) "Ölçümü durdur" düğmesi: kullandığınız tarayıcıda ölçümü durdurur, böylece Google Ads etiketi artık yüklenmez; etiketin fieldsa.net alan adında yerleştirdiği çerezleri siler ve tarayıcıda kayıtlı ziyaretçi kimliği, oturum kimliği ve ilk ziyaret kaynağı gibi ilişkilendirme verilerini temizler. Google'ın kendi alan adlarında yerleştirdiği çerezler Google ayarlarından ve Google hesabınızdan yönetilir. Ölçümü aynı düğmeyle yeniden başlatabilirsiniz.
• Tarayıcı gizlilik sinyalleri: Tarayıcınızda Do Not Track veya Global Privacy Control özelliğini etkinleştirirseniz bunu ölçümün durdurulması olarak kabul ederiz.
• Yerel depolamayı engelleme: Tarayıcınız sitemizin yerel depolamaya erişimini engellerse bunu ölçümün durdurulması olarak kabul ederiz.
• Tarayıcı ayarları: Çerezleri engelleyebilir veya silebilir ve sitemizin sakladığı verileri temizleyebilirsiniz. Silme veya temizleme tek başına ölçümü durdurmaz: kayıtlı kimlikleri, düğmenin kaydettiği ölçümü durdurma işaretiyle birlikte kaldırır; tarayıcınızda bir gizlilik sinyali etkin değilse ve yerel depolama engellenmemişse bir sonraki ziyaretinizde yeni kimlikler oluştururuz.
Ölçüm ilk üç yöntemden biriyle durdurulduğunda ziyaretçi kimliği ve oturum kimliği oluşturmayız, kampanya etiketlerini ve ilk ziyaret kaynağını kaydetmeyiz, Google Ads etiketini yüklemeyiz, IP adresinizden herhangi bir değer türetmeyiz ve IP adresinizi konum belirleme hizmetine göndermeyiz.
Bu durumda yalnızca asgari ziyaret istatistiklerini (sayfa adresi ve dili, yönlendiren site, tarayıcınızın gönderdiği şekliyle tarayıcı ve cihaz türü) ve WhatsApp düğmesine yapılan dokunuşları referans kodlarıyla birlikte, hiçbirini bir ziyaretçi kimliğine bağlamadan kaydederiz.
Ölçümün durdurulması, elçilerin hak edişlerini hesaplamak için gerekli olan yönlendirme kodunu kapsamaz.
Google reklam ayarları sayfası (https://adssettings.google.com), Google'ın size gösterdiği reklamların kişiselleştirilmesini yönetir; sitemizdeki dönüşüm ölçümünü durdurmaz.

8. WhatsApp Yazışmaları
Bize WhatsApp üzerinden yazdığınızda mesajlarınız, yanıtları yazıp önceden insan incelemesi olmadan size otomatik olarak gönderen yapay zekâ destekli bir asistan tarafından yanıtlanabilir. Talebiniz insan müdahalesi gerektirdiğinde yazışma ekibimizden birine aktarılır.
Sorularınızı yanıtlamak ve talebinizi takip etmek için telefon numaranızı, (varsa) WhatsApp görünen adınızı ve mesajlarınızın içeriğini işleriz. Yanıtların oluşturulması için yazışma metnini, bizim adımıza işleyen Anthropic ve Google gibi yapay zekâ hizmet sağlayıcılarına göndeririz.
Bize bir abone şirketin ayarlarında kayıtlı telefon numarasından yazarsanız, bu numarayla şirketin hesap özetini (şirket adı, abonelik durumu, paketi ve bitiş tarihi, temsilci sayısı) ve hesabınızın rakamlarını sorduğunuzda ayın faaliyet göstergelerini (fatura sayısı, toplam satış ve tahsilat, müşteri sayısı ve vadesi gelmiş bakiyesi olan müşteri sayısı, numarası ve tutarıyla son fatura) çıkarırız. Sorularınızı yanıtlayabilmesi için bu özeti otomatik asistana ve yapay zekâ sağlayıcılarına iletiriz. Talebiniz üzerine bir temsilcinin parolasını sıfırlamak, bir temsilciyi devre dışı bırakmak veya yeniden etkinleştirmek ya da bize verdiğiniz ad ve e-postayla bir deneme hesabı oluşturmak gibi sınırlı işlemler de yaparız; ilgili temsilciyi belirlemek için şirket temsilcilerinin adlarını ve kullanıcı adlarını, ayrıca geçici parolayı veya yeni hesabın parolasını aynı yazışmada size göndeririz.
İlk mesajınız bir FS referans kodu içeriyorsa, 5. bölümde açıklandığı şekilde yazışmayı sitemizdeki gezinme geçmişinizle ve sizi getiren kampanyayla ilişkilendiririz.
Hukuki dayanak: bize yazarak başlattığınız talebin karşılanması ve bu talebi takip etmeye yönelik meşru menfaatimiz.
WhatsApp'ın kendisi Meta'nın gizlilik politikasına tabidir.

9. Şirket Bazında Veri İzolasyonu
Her abone şirketin verileri mantıksal olarak izole bir alanda saklanır (çok kiracılı izolasyon); hiçbir şirket bir başkasının verilerine erişemez ve verileriniz yalnızca size ait kalır.

10. Veri Paylaşımı ve Krallık Dışına Aktarım
Verilerinizi satmayız ve üçüncü taraflarla yalnızca şu durumlarda paylaşırız:
• Bizim adımıza hareket eden hizmet sağlayıcıları; yalnızca hizmetin işletilmesi için gerekli olduğu ölçüde. Bunlar arasında bulut barındırma sağlayıcımız, veritabanının düzenli yedek kopyalarını sakladığımız GitHub, e-posta gönderme, alma ve yönlendirme sağlayıcılarımız, bir IP konum belirleme hizmeti, temsilci rotalarını yollarla eşleştirmek için kullandığımız bir harita hizmeti, WhatsApp yazışmalarını yanıtlamada kullanılan yapay zekâ sağlayıcıları, WhatsApp'ı işleten ve WhatsApp mesajlarının üzerinden geçtiği Meta, ödeme geçidi sağlayıcımız Moyasar ve işletmelerin ticari iletişim verilerini edindiğimiz harita, arama ve işletme verisi sağlayıcıları bulunur.
• 6. bölümde açıklandığı şekilde, herkese açık web sitemizde reklam ölçümü için Google LLC; ayrıca tarayıcınız web sitemizin ve platformun yazı tiplerini ve temsilci takip ekranlarındaki harita karolarını Google sunucularından yüklediğinde Google, IP adresinizi ve görüntülenen harita alanını alır. Ölçümün durdurulması bu yazı tiplerinin yüklenmesini engellemez.
• Abone şirketin etkinleştirdiği entegrasyonların sağlayıcıları; şirketin talebi üzerine onlarla veri alışverişi yaparız: Hatif ve PetroApp'tan 3. bölümde açıklanan verileri alır, adresini şirketin belirlediği ERP sistemine müşteri, ürün, fatura ve tahsilat makbuzu verilerini göndeririz. Bu sistem, şirketin tercihine bağlı olarak Krallık dışında bulunabilir.
• Yasal bir yükümlülük veya yetkili bir merci gerektirdiğinde.
Platform ve veritabanı Suudi Arabistan Krallığı içindeki sunucularda barındırılır; hesap, operasyonel ve konum verileri, ziyaret istatistikleri ve WhatsApp yazışmaları dahil platform verileri bu sunucularda saklanır. Bu verilerin hiçbiri, bu bölümde belirtilen hizmet sağlayıcılarına ve taraflara aktardıklarımız dışında Krallık dışında işlenmez.
GitHub, e-posta, konum belirleme, harita, arama ve işletme verisi ile yapay zekâ sağlayıcılarımız, Meta ve Google ise Krallık dışında bulunmaktadır. Bu sağlayıcılara yalnızca hizmetin sunulması ve bu politikada açıklanan amaçlar için gerekli olan verileri aktarırız.

11. Konum Takibi
Temsilci uygulaması konum verilerini iki şekilde toplar:
• Rota takibi: yalnızca şirket yöneticisi etkinleştirirse çalışır ve temsilcinin oturumu ve uygulama cihazında açık olduğu sürece birkaç saniyede bir konumunu kaydeder. Uygulama bunu çalışma saatleriyle sınırlamaz; bu nedenle temsilcilerin çalışma saatleri dışında oturumu kapatmasını veya uygulamayı kapatmasını öneririz. Şirket yöneticisi bunu istediği zaman kapatabilir; bu durumda şirketin tüm temsilcileri için durur.
• Takip ayarından bağımsız olarak, temsilci bir saha ziyareti kaydettiğinde (ziyaret fotoğraflarıyla birlikte varış kanıtı olarak) veya bir müşterinin konumunu haritada işaretlediğinde alınan anlık konum. Uygulama ayrıca bir müşteriye yakınlığı kontrol etmek veya en yakın akaryakıt istasyonlarını bulmak için mevcut konumu kaydetmeden okur.
Rota noktaları, yollarla eşleştirilip haritada gösterilmesi için bir harita hizmeti sağlayıcısına gönderilir.
Temsilci uygulaması ayrıca, takip ayarından bağımsız olarak, temsilcinin oturumu ve uygulama açık olduğu sürece uygulamanın açık ve sunucularımıza bağlı olduğu zamanları kaydeder; bu nedenle takibin kapatılması bu kaydı durdurmaz. Bu zamanlardan, rota noktalarından ve ziyaretlerden temsilcinin çalışma saatleri ile işte bulunduğu ve bulunmadığı günler hesaplanır ve şirket yönetimine gösterilir.
Şirket bu verileri ziyaretleri düzenleme ve doğrulama, kapsamı iyileştirme ve çalışma saatlerini ölçme gibi mesleki amaçlarla kullanır. Bu verileri 1. bölümde belirtildiği gibi abone şirket adına ve onun talimatları doğrultusunda işleriz.

12. Veri Güvenliği
Teknik ve idari önlemler uygularız: tarayıcınız veya uygulamanız ile sunucularımız arasındaki bağlantının şifrelenmesi (HTTPS), parola şifreleme ve yetki kontrolleri. Tüm özenimize rağmen hiçbir sistem %100 güvenli değildir; bu nedenle giriş bilgilerinizi korumanızı öneririz.

13. Veri Saklama
Hesap ve operasyonel verilerinizi aboneliğiniz süresince saklarız ve abonelik sona erdiğinde otomatik olarak silmeyiz. Abonelik sona erdiğinde verilerinizin dışa aktarımını, ardından silinmesini talep edebilirsiniz.
Ziyaret istatistikleri, WhatsApp düğmesi dokunuş kayıtları ve WhatsApp yazışmaları için henüz otomatik silme süresi belirlemedik; bu nedenle bu kayıtlar şu anda otomatik olarak silinmeden saklanmaktadır.
Hesabınızın veya sizinle ilgili herhangi bir verinin silinmesini talep etmek için fieldsa.net/delete-account/ sayfasında açıklandığı şekilde help@fieldsa.net adresine yazın. Silme işlemini talebinizin doğrulanmasından itibaren 30 gün içinde gerçekleştiririz; vergi faturaları ve muhasebe kayıtları gibi yasal olarak saklamakla yükümlü olduğumuz veriler bunun dışındadır ve yasal süre boyunca saklanır. Şirketin yasal olarak saklamakla yükümlü olduğumuz kesinleşmiş muhasebe kayıtları varsa, bu kayıtlarla bağlantılı veriler yasal süre dolmadan silinemeyebilir; bu durumda hesabı askıya alır ve bu verileri yalnızca yasal süre boyunca saklarız. Silinen verilerin kopyaları, olağan yedekleme döngüsünde yenileriyle değiştirilene kadar yedeklerimizde kalır.
Ziyaretçi kimliği, oturum kimliği ve ilk ziyaret kaynağı, siz silene veya 7. bölümde açıklandığı şekilde düğmeyle ölçümü durdurana kadar tarayıcınızda kalır.

14. Haklarınız
Kişisel Verilerin Korunması Kanunu size şu hakları tanır:
• Hakkınızda topladığımız veriler ile bunların işlenme amaçları ve hukuki dayanağı hakkında bilgilendirilme (bu politikada açıklandığı şekilde).
• Verilerinize erişme, bir kopyasını alma ve dışa aktarma.
• Verilerinizi düzeltme, tamamlama ve güncelleme.
• Artık gerekli olmadığında verilerinizin silinmesini talep etme.
• Reklam ölçümüne itiraz etme ve 7. bölümdeki yöntemlerle durdurma.
• Sizinle pazarlama amaçlı iletişimimize itiraz etme ve durdurulmasını talep etme (4. bölümde açıklandığı şekilde).
• İşleme rızaya dayandığında rızanızı her zaman geri alma.
Bu haklardan herhangi birini kullanmak için info@fieldsa.net adresinden bize yazın; silme talepleri için 13. bölümde açıklandığı şekilde help@fieldsa.net adresine yazın. Ayrıca Krallık'taki yetkili kişisel verileri koruma merciine şikâyette bulunma hakkınız vardır.

15. Çerezler ve Yerel Depolama
• Platformu işletmek ve oturumunuz ile tercihlerinizi saklamak için gerekli çerezler ve veriler.
• 5. ve 7. bölümlerde açıklandığı şekilde yerel depolamada tutulan birinci taraf ölçüm kimlikleri, yönlendirme kodu ve ölçümü durdurma işareti.
• 6. bölümde açıklandığı şekilde, dönüşümleri ölçmek için herkese açık web sitesinde kullanılan _gcl_au ve _gcl_aw gibi Google Ads çerezleri ile etiketin yerel depolamada tutabileceği veriler.
Çerezleri reklamları kişiselleştirmek veya yeniden pazarlama kitleleri oluşturmak için kullanmayız.

16. Çocukların Gizliliği
Platform ticari kullanım içindir ve 18 yaşından küçükler tarafından kullanılamaz.

17. Bu Politikadaki Değişiklikler
Bu politikayı zaman zaman güncelleyebilir ve güncel sürümü güncelleme tarihiyle birlikte bu sayfada yayımlarız.

18. İletişim
Gizlilik veya verilerinizle ilgili her soru için:
"مؤسسة تكامل الميدان للتجارة والإستيراد" (FieldSales), Riyad, Suudi Arabistan Krallığı
info@fieldsa.net`,
    },
  },
  social: { x: '', instagram: '', linkedin: '', whatsapp: '', snapchat: '', youtube: '', facebook: '', tiktok: '' },
};

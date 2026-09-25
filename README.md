# TechAvıV1

## Kullanıcıya özel ReefAPI
TechAvıV1 artık ortak `REEF_API_KEY` kullanmaz. Siteye ilk girişte kullanıcıdan kendi ReefAPI anahtarını ister. Arama, mağaza karşılaştırması ve sıcak fırsat istekleri `x-reef-api-key` başlığıyla kullanıcının anahtarına gönderilir.

Cache anahtar bazında ayrılır; böylece bir kullanıcının önbelleği başka kullanıcının ReefAPI kotasını veya verisini kullanmaz. API anahtarı GitHub'a veya Render Environment Variables'a konulmaz.

> Not: Tarayıcıdaki API anahtarı bu sürümde localStorage'da tutulur. Üretimde daha güçlü güvenlik istenirse hesap oturumu + sunucu tarafı şifreli saklama modeline geçirilebilir.

## E-posta doğrulama
Resend önerilir. Render > Environment Variables bölümünde:
- `RESEND_API_KEY`
- `RESEND_FROM` (doğrulanmış alan adından bir gönderici)
- `APP_URL=https://techav1.onrender.com`

ayarlarını yapın. SMTP yedek olarak desteklenir. E-posta servisi yapılandırılmamışsa kayıt işlemi artık kullanıcıya açık bir hata döndürür; sahte/dev doğrulama linki üretmez.

## Render
1. Bu klasörü GitHub'a yükleyin.
2. Mevcut Render Web Service'in Settings > Build > Source bölümünden bu repoyu seçin.
3. Build: `npm install`
4. Start: `npm start`
5. Environment Variables: `APP_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
6. `REEF_API_KEY` artık gerekli değildir.
7. Deploy sonrası canlı siteyi açıp ilk API kurulum ekranından kendi ReefAPI anahtarınızı girin.

> Önemli: JSON dosyaları bu sürümde yerel veri deposudur. Aile kullanımı için kalıcı kullanıcı/fiyat geçmişi gerektiğinde Render Postgres veya başka kalıcı veritabanına geçirilmelidir. API anahtarlarını GitHub'a koymayın.


## E-posta doğrulama düzeltmesi
- Doğrulama bağlantıları artık şifreli ve kendi içinde taşınan token kullanır; Render yeniden başlasa bile gönderilmiş bağlantı yalnızca dosya kaybolduğu için bozulmaz.
- Kayıt hesabı, e-posta gönderilmeden önce kaydedilir; gönderim başarısız olursa geri alınır.
- Render Environment Variables bölümüne `AUTH_SECRET` olarak en az 32 karakterlik rastgele bir değer ekleyin. `APP_URL=https://techav1.onrender.com` olarak kalmalıdır.

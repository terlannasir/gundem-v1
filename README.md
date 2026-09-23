# Gündəm — müstəqil versiya (veb + iOS), pulsuz qurulum

Bu versiya claude.ai-dan asılı deyil. Hər istifadəçi **öz Google hesabı ilə** daxil olur, poçtunu, təqvimini və sənədlərini görür. Süni intellekt köməkçisi **Google Gemini**-nin pulsuz planı ilə işləyir.

```
gundem-saas/
├── server/     Node.js server: Google girişi, Gmail/Təqvim/Drive, AI, veb tətbiq (Render-də işləyir)
├── ios/        iPhone tətbiqi (Capacitor) — eyni interfeys, TestFlight üçün
└── render.yaml Render üçün hazır quraşdırma
```

| Xidmət | Nə üçün | Qiymət |
|---|---|---|
| Supabase | baza (ayarlar, tapşırıqlar, brifinq) | pulsuz |
| Google AI Studio | Gemini API açarı | pulsuz plan |
| Google Cloud | "Google ilə daxil ol" + Gmail/Təqvim/Drive icazəsi | pulsuz |
| GitHub | kodu saxlamaq, Render-ə vermək | pulsuz |
| Render | serveri internetə çıxarmaq | pulsuz plan |
| Apple Developer | TestFlight | səndə var |

Təxmini vaxt: 45–60 dəqiqə. Addımları **bu ardıcıllıqla** et.

---

## 1. Supabase — baza (5 dəq)

1. **supabase.com** → *Start your project* → GitHub ilə daxil ol.
2. **New project**:
   - Name: `gundem`
   - Database Password: **Generate** bas və parolu bir yerə yaz.
   - Region: **Central EU (Frankfurt)**
   - Plan: Free
3. Layihə hazır olanda yuxarıdakı **Connect** düyməsini bas.
4. **Connection string → URI** hissəsində **Session pooler** sətrini kopyala. Belə görünür:
   `postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`
5. `[YOUR-PASSWORD]` yerinə 2-ci addımdakı parolu yaz. Bu sənin **DATABASE_URL** dəyərindir.

Cədvəlləri özün yaratmağa ehtiyac yoxdur — server ilk açılışda onları avtomatik yaradır.

## 2. Gemini API açarı (2 dəq)

1. **aistudio.google.com/apikey** → Google ilə daxil ol.
2. **Create API key** → layihə seç (və ya yenisini yarat) → açarı kopyala. Bu sənin **GEMINI_API_KEY** dəyərindir.

> ⚠️ Pulsuz planda Google göndərilən mətni (məktub parçaları, sənəd xülasələri) öz modellərini yaxşılaşdırmaq üçün istifadə edə bilər. Test üçün bu normaldır. Real istifadəçilərə açanda ya Gemini-nin ödənişli planına keç (billing aktivləşdir), ya da Claude-a keç — aşağıda **"Claude-a keçid"** bölməsinə bax.

## 3. GitHub — kodu yüklə (5 dəq)

1. **github.com** → **New repository** → ad: `gundem` → **Private** → *Create repository*.
2. Mac-də Terminal aç:
   ```bash
   cd ~/Downloads/gundem-saas        # zip-i açdığın yer
   git init && git add . && git commit -m "Gündəm"
   git branch -M main
   git remote add origin https://github.com/<SƏNİN-ADIN>/gundem.git
   git push -u origin main
   ```
   (Git parol soruşsa, GitHub → Settings → Developer settings → *Personal access tokens* bölməsindən token yarat və onu parol kimi yaz.)

## 4. Render — serveri işə sal (10 dəq)

1. **render.com** → GitHub ilə daxil ol.
2. **New + → Blueprint** → `gundem` repo-nu seç → **Connect**.
3. Render `render.yaml` faylını oxuyur və 4 dəyər soruşur:
   - `DATABASE_URL` → 1-ci addımdakı sətir
   - `GEMINI_API_KEY` → 2-ci addımdakı açar
   - `GOOGLE_CLIENT_ID` → hələlik `temp` yaz
   - `GOOGLE_CLIENT_SECRET` → hələlik `temp` yaz
4. **Apply** → 2–4 dəqiqə gözlə. Servis **Live** olanda yuxarıda ünvanı görəcəksən, məsələn:
   **`https://gundem-ab12.onrender.com`** — bu sənin **SERVER ÜNVANIN**-dır. Yaz, hər yerdə lazım olacaq.
5. Yoxla: brauzerdə `SERVER ÜNVANIN/health` aç → `{"ok":true}` görməlisən.

> Pulsuz planda server 15 dəqiqə istifadə olunmayanda "yatır". Sonra ilk açılış 30–60 saniyə çəkir. Tətbiq bu vaxt "Server oyanır…" yazır. Oyaq saxlamaq istəsən, **cron-job.org** saytında pulsuz olaraq hər 10 dəqiqədən bir `SERVER ÜNVANIN/health` ünvanını çağıran iş qur.

## 5. Google Cloud — "Google ilə daxil ol" (15 dəq)

1. **console.cloud.google.com** → yuxarıda layihə seçici → **New project** → ad: `Gundem` → *Create* → layihəni seç.
2. **API-ləri aç:** axtarışa yaz və hər birində **Enable** bas:
   - **Gmail API**
   - **Google Calendar API**
   - **Google Drive API**
3. **Google Auth Platform** → *Get started*:
   - **App name:** Gündəm · **User support email:** öz e-poçtun
   - **Audience:** **External**
   - **Contact information:** öz e-poçtun → *Create*
4. **Branding** bölməsi:
   - App home page: `SERVER ÜNVANIN`
   - Privacy policy: `SERVER ÜNVANIN/privacy.html`
   - Authorized domains: `onrender.com` → *Save*
5. **Audience** bölməsi:
   - Publishing status **Testing** qalsın. **Publish** basma — bunu etsən, Google yoxlaması tələb olunacaq.
   - **Test users → Add users**: özünün və testerlərin **Gmail ünvanlarını** əlavə et (100 nəfərə qədər).
6. **Data Access → Add or remove scopes** → bu üçünü seçib *Update → Save*:
   - `.../auth/gmail.modify`
   - `.../auth/calendar.events`
   - `.../auth/drive`
7. **Clients → Create client**:
   - Application type: **Web application** · Name: `Gundem web`
   - **Authorized redirect URIs → Add URI:** `SERVER ÜNVANIN/auth/google/callback`
     (məs. `https://gundem-ab12.onrender.com/auth/google/callback` — sonunda `/` olmasın)
   - *Create* → **Client ID** və **Client secret** kopyala.
8. **Render → gundem servisi → Environment**:
   - `GOOGLE_CLIENT_ID` və `GOOGLE_CLIENT_SECRET` dəyərlərini dəyiş → **Save, rebuild and deploy**.

## 6. Vebdə yoxla (5 dəq)

1. `SERVER ÜNVANIN` aç → **Google ilə daxil ol**.
2. Google **"Google hasn't verified this app"** yazacaq. Bu test rejimində normaldır: **Continue** bas (bəzən *Advanced → Go to Gündəm*).
3. İcazə ekranında **bütün qutuları işarələ** (Gmail, Təqvim, Drive).
4. Gündəm açılır: qısa qurulum → poçt, təqvim, sənədlər, brifinq və köməkçi.

Telefonda da işləyir: Safari-də aç → **Paylaş → Ana ekrana əlavə et**.

> **Test rejimində Google girişi 7 gündən bir bitir.** Bu, Google-un qaydasıdır. Vaxt bitəndə tətbiq özü "yenidən daxil ol" ekranını göstərir — bir klikdir. Tətbiq Google yoxlamasından keçəndən sonra bu məhdudiyyət aradan qalxır.

## 7. iOS — TestFlight (15 dəq)

Mac-də Terminal:

```bash
cd ~/Downloads/gundem-saas/ios
npm install
npm run build:web -- --api https://gundem-ab12.onrender.com     # ← SƏNİN SERVER ÜNVANIN
npx cap sync ios
npx cap open ios
```

Xcode-da:

1. **App → Signing & Capabilities → Team:** öz hesabın.
   - Bundle ID `az.gundem.app`. Əvvəlki build-i bu ID ilə yükləmisənsə, eyni qalsın.
2. Build nömrəsi artıq **2**-dir. Hər yeni yükləmədə **General → Build** sahəsini 1 artır.
3. Yuxarıda cihaz olaraq **Any iOS Device (arm64)** seç → **Product → Archive**.
4. **Distribute App → App Store Connect → Upload**.
5. 10–30 dəqiqə sonra App Store Connect → **TestFlight**-da görünəcək. **Internal Testing** qrupuna testerləri əlavə et (Apple yoxlaması yoxdur).

Tətbiqdə giriş belə işləyir: **Google ilə daxil ol** Safari pəncərəsində açılır, sonra avtomatik tətbiqə qayıdır.

**Xarici testerlər** (public link) üçün Apple **Beta App Review** tələb edir. Review qeydlərinə Google "Test users" siyahısındakı bir test Gmail hesabı və parolunu yaz:

> "Sign in with Google using the test account below (the app is in Google's testing mode; tap Continue on the 'unverified app' screen). The app shows the user's Gmail, Calendar and Drive with an AI daily brief. Account deletion: Settings → Hesabı birdəfəlik sil."

## 8. Testerlərə nə demək

1. Gmail ünvanını ver — onu Google Cloud → **Audience → Test users** siyahısına əlavə edirsən.
2. TestFlight dəvəti gələcək → **TestFlight** tətbiqini qur → **Gündəm**-i qur.
3. **Google ilə daxil ol** → "unverified app" ekranında **Continue** → **bütün qutuları işarələ**.

---

## Server ünvanı dəyişsə

- Render → Environment-də heç nəyi dəyişmək lazım deyil.
- Google Cloud → Clients-də redirect URI-ni yenilə.
- iOS-da yenidən `npm run build:web -- --api YENİ-ÜNVAN` və `npx cap sync ios` işlət, sonra yeni build yüklə.

## Claude-a keçid (istəyə bağlı, ödənişli)

1. **platform.claude.com** → API Keys → açar yarat. Balansa ən azı $5 yüklə.
2. Render → Environment:
   - `AI_PROVIDER=anthropic`
   - `ANTHROPIC_API_KEY=...`
3. iOS-da build-i belə yığ:
   ```bash
   npm run build:web -- --api SERVER-ÜNVANIN --ai anthropic
   ```
   Veb versiya adı özü dəyişir, iOS isə yenidən yığılmalıdır.

Claude-un məlumat siyasəti: API ilə göndərilən məzmun modelin öyrədilməsində istifadə olunmur.

## Google yoxlaması (hamıya açmaq üçün, sonra)

Test rejimi 100 istifadəçi ilə məhdudlaşır. Hamıya açmaq üçün Google Auth Platform → **Publish app** lazımdır. `gmail.modify` və `drive` "restricted" icazələrdir, ona görə Google yoxlaması və illik təhlükəsizlik auditi (CASA) tələb olunur.

Xərci azaltmaq üçün:
- Drive-ı `DRIVE_SCOPE=file` rejiminə keçirmək olar. Bu rejim audit tələb etmir, amma Sənədlər bölməsi yalnız Gündəmin yaratdığı faylları göstərir.
- Gmail üçün alternativ yoxdur.

## Nə yoxlanılıb

- **Server testləri — 54/54:** real PostgreSQL üzərində. Google API-ləri və Gemini/Claude cavabları saxta (mock) idi. Əhatə edir:
  - bütün Gmail/Təqvim/Drive alətləri: cavab, hamıya cavab, yönləndirmə, UTF-8 başlıqlar, PDF/Word/Excel oxuma;
  - AI alət çağırışları və limitlər;
  - hesab silmə, iOS kod mübadiləsi.
- **Brauzer testi — 25/25:** real server və real Gündəm interfeysi Chromium-da işlədildi. Əhatə edir:
  - giriş ekranı, poçt, məktub açma, oxunmuş etmə, cavab göndərmə;
  - brifinq, sənədlər, alət çağıran söhbət;
  - ayarlar, çıxış;
  - iOS deep-link girişinin simulyasiyası.
- **Yoxlanmayıb:**
  - real Google hesabı və real Gemini açarı ilə iş (bunlar sənin açarlarınla ilk dəfə 6-cı addımda işləyəcək);
  - Xcode build və real iPhone.
- Xəta çıxsa: Render → **Logs**-dan son sətirləri, Xcode-dan xəta mətnini göndər.

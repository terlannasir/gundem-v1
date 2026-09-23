# Gündəm — iOS

Capacitor 8 (Swift Package Manager). Tətbiq interfeysi **serverdən** yükləyir: `capacitor.config.json` → `server.url = https://gundem-sesi.onrender.com`. İnterfeys dəyişiklikləri üçün yeni build lazım deyil — GitHub-a push → Render deploy → tətbiq növbəti açılışda yeni versiyanı göstərir.

```bash
npm install
npx cap sync ios
npx cap open ios      # Team seç → Product → Archive → Upload
```

Yeni TestFlight build yalnız bunlar dəyişəndə lazımdır: ikon/ad, Info.plist, server ünvanı, Capacitor plaginləri, Swift kodu. Hər build-də **General → Build** nömrəsini 1 artır.

| | |
|---|---|
| Bundle ID | `az.gundem.app` |
| Minimum iOS | 15.0 · iPhone · şaquli |
| Giriş | Google → Safari pəncərəsi → `gundem://auth?code=…` → tətbiq |
| İnternet yoxdursa | `www/error.html` — "Yenidən cəhd et" (server yatıbsa özü təkrar yoxlayır) |

**Face ID kilidi:** Ayarlar → «Face ID ilə kilidlə». Tətbiq 1 dəqiqədən çox arxa planda qalanda və ya yenidən açılanda Face ID istənir (alınmasa iPhone kodu ilə). Arxa plana keçəndə məzmun gizlədilir ki, tətbiq keçid ekranında görünməsin. Plagin: `@capgo/capacitor-native-biometric`.

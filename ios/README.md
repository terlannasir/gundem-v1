# Gündəm — iOS

Capacitor 8 (Swift Package Manager, CocoaPods lazım deyil). İnterfeys tətbiqin içinə yığılır (`www/`), məlumat isə sənin serverindən gəlir.

```bash
npm install
npm run build:web -- --api https://SENIN-SERVERIN.onrender.com   # interfeysi yığır (../server/app-dan)
npx cap sync ios
npx cap open ios
```

Ətraflı addımlar: `../README.md`, 7-ci bölmə.

| | |
|---|---|
| Bundle ID | `az.gundem.app` |
| Versiya | 1.0 (build 2) |
| Minimum iOS | 15.0 · iPhone · şaquli |
| Giriş | Google → Safari pəncərəsi → `gundem://auth?code=…` → tətbiq |

Fayllar:
- `ios/App/App/Info.plist` — `gundem://` URL sxemi, şifrələmə qeydi
- `ios/App/App/GundemViewController.swift` — aşağı çəkib yeniləmə
- `ios/App/App/SceneDelegate.swift` — əsas ekran
- `www/` — `npm run build:web` ilə yaranır, əl ilə dəyişmə

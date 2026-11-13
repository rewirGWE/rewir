# Rewir – gra rowerowa GPS

- `public/` – gra (strona, ikony, plik offline, polityka prywatności)
- `netlify/functions/api.mjs` – serwer gry: gracze bez kont, rankingi tras, trasy w okolicy, krótkie linki do wyzwań, zawody prędkości online
- `netlify.toml` – ustawienia dla Netlify
- `package.json` – biblioteka Netlify Blobs (baza danych serwera)

Nowa wersja gry: podmień `public/index.html` na GitHubie (Add file → Upload files), Netlify opublikuje ją sam w ok. minutę.
Każda publikacja zużywa kredyty Netlify – zbieraj zmiany i wrzucaj np. raz w tygodniu.

Sprawdzenie serwera: otwórz `https://TWOJA-STRONA.netlify.app/api/ping` – powinno pokazać `{"ok":true,"v":1}`.

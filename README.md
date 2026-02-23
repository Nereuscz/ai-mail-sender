# AI Třídič Faktur (PDF/Obrázky -> AI Třídění -> Odeslání)

Jednoduchá webová aplikace:
- nahraješ jednu nebo více příloh (PDF/obrázky),
- AI je roztřídí podle firmy,
- AI navrhne předmět pro každý soubor,
- každý soubor odešleš jedním kliknutím na `faktury.jic@inbox.grit.cz`.

## 1) Instalace

```bash
npm install
```

## 2) Nastavení Entra aplikace

V Entra app registration nastav:
- `Microsoft Graph` delegovaná oprávnění: `User.Read`, `Mail.Send`
- Redirect URI (Web):
  - `https://ai-mail-sender-production.up.railway.app/auth/redirect`

Vygeneruj `Client Secret` a ulož jeho `Value`.

## 3) Konfigurace

```bash
cp .env.example .env
```

Doplň v `.env`:
- `OPENAI_API_KEY`
- `MS_TENANT_ID`
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_REDIRECT_URI`
- `SESSION_SECRET`

## 4) Spuštění

```bash
npm start
```

Otevři: `http://localhost:3000`

## 5) Použití

1. Klikni `Přihlásit Microsoft`.
2. Přihlaš se firemním účtem.
3. Nahraj více faktur (PDF/obrázky).
4. Klikni `Roztřídit faktury`.
5. U každého souboru použij `Odeslat na faktury`.

## Railway

Nastav stejné proměnné jako v `.env` do Railway Variables a nasazení poběží na veřejné URL.

# AI Email Sender (PDF/Image -> AI Subject -> Microsoft Send)

Jednoduchá webová aplikace:
- nahraješ PDF nebo obrázek,
- AI vytáhne informace,
- AI vytvoří `subject` + tělo e-mailu,
- e-mail se odešle z tvého Microsoft 365 účtu přes Graph API.
- cílová adresa je pevně `faktury.jic@inbox.grit.cz`.

## 1) Instalace

```bash
npm install
```

## 2) Nastavení Entra aplikace

V Entra app registration nastav:
- `Microsoft Graph` delegovaná oprávnění: `Mail.Send`, `User.Read`
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
3. Nahraj PDF/obrázek a zadej cílový e-mail.
4. Odešli.

## Railway

Nastav stejné proměnné jako v `.env` do Railway Variables a nasazení poběží na veřejné URL.

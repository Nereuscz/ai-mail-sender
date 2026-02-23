# AI Email Sender (PDF/Image -> AI Subject -> Send)

Jednoduchá webová aplikace:
- nahraješ PDF nebo obrázek,
- AI vytáhne informace,
- AI vytvoří `subject` + tělo e-mailu,
- appka odešle e-mail s původní přílohou.

## 1) Instalace

```bash
npm install
```

## 2) Konfigurace

1. Zkopíruj env:
```bash
cp .env.example .env
```
2. Vyplň `.env`:
- `OPENAI_API_KEY` (OpenAI API klíč)
- SMTP údaje (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`)

### Gmail
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=465`
- `SMTP_USER=tvuj.email@gmail.com`
- `SMTP_PASS` musí být **App Password** (ne běžné heslo).

## 3) Spuštění

```bash
npm start
```

Otevři: `http://localhost:3000`

## Bezpečnostní poznámky

- API klíč i SMTP heslo drž pouze v `.env`.
- Nedávej `.env` do Gitu.
- Ve výchozím stavu může uživatel zadat libovolný cílový e-mail. Pokud chceš fixní adresu, uprav backend tak, aby `to` bral z env.

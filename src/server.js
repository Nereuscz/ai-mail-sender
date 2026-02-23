const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 20);
const FIXED_TARGET_EMAIL = 'faktury.jic@inbox.grit.cz';

function getMissingConfig() {
  const required = [
    'OPENAI_API_KEY',
    'MS_TENANT_ID',
    'MS_CLIENT_ID',
    'MS_CLIENT_SECRET',
    'MS_REDIRECT_URI',
    'SESSION_SECRET',
  ];
  return required.filter((key) => !process.env[key]);
}

function getOpenAiClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getAuthBaseUrl() {
  return `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0`;
}

function getAuthScopes() {
  return 'offline_access openid profile email User.Read Mail.Send';
}

function getState() {
  return crypto.randomBytes(24).toString('hex');
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.MS_REDIRECT_URI,
    scope: getAuthScopes(),
  });

  const response = await fetch(`${getAuthBaseUrl()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'OAuth token exchange failed');
  }

  return data;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: process.env.MS_REDIRECT_URI,
    scope: getAuthScopes(),
  });

  const response = await fetch(`${getAuthBaseUrl()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }

  return data;
}

async function fetchGraphMe(accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Graph /me failed');
  }

  return data;
}

async function getValidAccessToken(req) {
  const auth = req.session?.auth;
  if (!auth || !auth.accessToken || !auth.expiresAt) {
    throw new Error('Nejsi přihlášený přes Microsoft.');
  }

  const now = Date.now();
  if (now < auth.expiresAt - 60_000) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) {
    throw new Error('Session vypršela, přihlas se znovu.');
  }

  const refreshed = await refreshAccessToken(auth.refreshToken);
  req.session.auth = {
    ...auth,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
  };

  return req.session.auth.accessToken;
}

function toDataUrl(file) {
  const mime = file.mimetype || 'application/octet-stream';
  const b64 = file.buffer.toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function generateSubjectAndBodyFromFile(file, targetEmail, note) {
  const openai = getOpenAiClient();
  const mime = file.mimetype || '';
  const isPdf = mime.includes('pdf') || file.originalname.toLowerCase().endsWith('.pdf');

  const instructions = [
    'Jsi asistent pro zpracování dokumentů.',
    'Ze vstupního dokumentu vytáhni hlavní informace a navrhni krátký, profesionální email.',
    `Cílový email je: ${targetEmail}`,
    note ? `Poznámka od uživatele: ${note}` : '',
    'Vrať POUZE JSON bez markdownu v tomto tvaru:',
    '{"subject":"...","body":"..."}',
    'Předmět max 80 znaků. Tělo emailu v češtině, 4-10 řádků.',
  ].filter(Boolean).join('\n');

  let inputContent;
  if (isPdf) {
    inputContent = [
      { type: 'input_text', text: instructions },
      {
        type: 'input_file',
        filename: file.originalname,
        file_data: toDataUrl(file),
      },
    ];
  } else {
    inputContent = [
      { type: 'input_text', text: instructions },
      {
        type: 'input_image',
        image_url: toDataUrl(file),
      },
    ];
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [{ role: 'user', content: inputContent }],
    temperature: 0.2,
  });

  const raw = response.output_text || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AI response is not valid JSON: ${raw}`);
  }

  if (!parsed.subject || !parsed.body) {
    throw new Error(`AI response missing subject/body: ${raw}`);
  }

  return {
    subject: String(parsed.subject).slice(0, 120),
    body: String(parsed.body),
  };
}

async function sendMailViaGraph(accessToken, targetEmail, subject, body, file) {
  const payload = {
    message: {
      subject,
      body: {
        contentType: 'Text',
        content: body,
      },
      toRecipients: [
        {
          emailAddress: {
            address: targetEmail,
          },
        },
      ],
      attachments: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: file.originalname,
          contentType: file.mimetype || 'application/octet-stream',
          contentBytes: file.buffer.toString('base64'),
        },
      ],
    },
    saveToSentItems: true,
  };

  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph sendMail failed: ${text}`);
  }
}

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  name: 'ai-mail-sender.sid',
  secret: process.env.SESSION_SECRET || 'replace-me-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/auth/login', (req, res) => {
  const missing = getMissingConfig();
  if (missing.length > 0) {
    return res.status(500).send(`Chybí konfigurace v .env: ${missing.join(', ')}`);
  }

  const state = getState();
  req.session.oauthState = state;

  const authUrl = new URL(`${getAuthBaseUrl()}/authorize`);
  authUrl.searchParams.set('client_id', process.env.MS_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', process.env.MS_REDIRECT_URI);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', getAuthScopes());
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
});

app.get('/auth/redirect', async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      throw new Error(errorDescription || String(error));
    }

    if (!code || !state || state !== req.session.oauthState) {
      throw new Error('Neplatný OAuth callback (state mismatch).');
    }

    delete req.session.oauthState;
    const tokenSet = await exchangeCodeForToken(code);
    const me = await fetchGraphMe(tokenSet.access_token);

    req.session.auth = {
      accessToken: tokenSet.access_token,
      refreshToken: tokenSet.refresh_token,
      expiresAt: Date.now() + Number(tokenSet.expires_in || 3600) * 1000,
      userEmail: me.mail || me.userPrincipalName || 'unknown',
      userName: me.displayName || '',
    };

    res.redirect('/?login=ok');
  } catch (error) {
    console.error(error);
    res.redirect(`/?login=error&message=${encodeURIComponent(error.message || 'OAuth chyba')}`);
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/auth-status', (req, res) => {
  const auth = req.session.auth;
  if (!auth?.accessToken) {
    return res.json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    userEmail: auth.userEmail,
    userName: auth.userName,
  });
});

app.post('/api/draft', upload.single('file'), async (req, res) => {
  try {
    if (!req.session?.auth?.accessToken) {
      return res.status(401).json({ error: 'Nejdřív se přihlas přes Microsoft.' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Chybí konfigurace v .env: OPENAI_API_KEY' });
    }

    const { note } = req.body;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Chybí příloha (PDF nebo obrázek).' });
    }

    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > MAX_FILE_SIZE_MB) {
      return res.status(400).json({
        error: `Soubor je příliš velký. Max je ${MAX_FILE_SIZE_MB} MB.`,
      });
    }

    const { subject, body } = await generateSubjectAndBodyFromFile(file, FIXED_TARGET_EMAIL, note);
    res.json({
      ok: true,
      subject,
      previewBody: body,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Neočekávaná chyba.' });
  }
});

app.post('/api/send', upload.single('file'), async (req, res) => {
  try {
    const missing = getMissingConfig();
    if (missing.length > 0) {
      return res.status(500).json({
        error: `Chybí konfigurace v .env: ${missing.join(', ')}`,
      });
    }

    const { note, subject: subjectInput } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'Chybí příloha (PDF nebo obrázek).' });
    }

    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > MAX_FILE_SIZE_MB) {
      return res.status(400).json({
        error: `Soubor je příliš velký. Max je ${MAX_FILE_SIZE_MB} MB.`,
      });
    }

    const targetEmail = FIXED_TARGET_EMAIL;
    const accessToken = await getValidAccessToken(req);
    const aiDraft = await generateSubjectAndBodyFromFile(file, targetEmail, note);
    const manualSubject = String(subjectInput || '').trim();
    const subject = (manualSubject || aiDraft.subject).slice(0, 120);
    const body = aiDraft.body;
    await sendMailViaGraph(accessToken, targetEmail, subject, body, file);

    res.json({
      ok: true,
      subject,
      previewBody: body,
      from: req.session.auth.userEmail,
      to: targetEmail,
    });
  } catch (error) {
    console.error(error);
    const status = String(error.message || '').includes('Nejsi přihlášený') ? 401 : 500;
    res.status(status).json({ error: error.message || 'Neočekávaná chyba.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

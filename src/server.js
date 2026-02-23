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
const MAX_FILES = Number(process.env.MAX_FILES || 10);

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
  return 'offline_access openid profile email User.Read';
}

function getState() {
  return crypto.randomBytes(24).toString('hex');
}

function parseJsonResponse(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('AI vrátila prázdnou odpověď.');
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  return JSON.parse(candidate);
}

function toDataUrl(file) {
  const mime = file.mimetype || 'application/octet-stream';
  const b64 = file.buffer.toString('base64');
  return `data:${mime};base64,${b64}`;
}

function buildOpenAiInputFromFiles(files, instructions) {
  const content = [{ type: 'input_text', text: instructions }];

  for (const file of files) {
    const mime = file.mimetype || '';
    const isPdf = mime.includes('pdf') || file.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      content.push({
        type: 'input_file',
        filename: file.originalname,
        file_data: toDataUrl(file),
      });
      continue;
    }

    content.push({
      type: 'input_image',
      image_url: toDataUrl(file),
    });
  }

  return content;
}

function validateFiles(files) {
  if (!files || files.length === 0) {
    throw new Error('Chybí přílohy (PDF nebo obrázky).');
  }

  if (files.length > MAX_FILES) {
    throw new Error(`Moc příloh. Maximum je ${MAX_FILES}.`);
  }

  for (const file of files) {
    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > MAX_FILE_SIZE_MB) {
      throw new Error(`Soubor ${file.originalname} je příliš velký. Max je ${MAX_FILE_SIZE_MB} MB.`);
    }
  }
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

function normalizeInvoiceItems(aiItems, files) {
  const byIndex = new Map();
  const byFilename = new Map();

  for (const item of aiItems || []) {
    const idx = Number(item?.index);
    if (Number.isInteger(idx) && idx >= 0) {
      byIndex.set(idx, item);
    }

    const name = String(item?.filename || '').trim();
    if (name) {
      byFilename.set(name.toLowerCase(), item);
    }
  }

  return files.map((file, index) => {
    const item = byIndex.get(index) || byFilename.get(file.originalname.toLowerCase()) || {};
    const companyRaw = String(item.company || item.vendor || '').trim();
    const subjectRaw = String(item.subject || '').trim();

    return {
      index,
      filename: file.originalname,
      company: companyRaw || 'Neurčeno',
      subject: subjectRaw || `Faktura: ${file.originalname}`,
    };
  });
}

async function classifyInvoices(files) {
  const openai = getOpenAiClient();
  const fileLines = files.map((file, index) => `${index}: ${file.originalname}`).join('\n');

  const instructions = [
    'Jsi asistent pro třídění faktur.',
    'Pro KAŽDÝ soubor urči firmu (vendor/company) a navrhni stručný předmět emailu.',
    'Nevymýšlej detailní text emailu, pouze subject.',
    'Vrať POUZE JSON bez markdownu v tomto tvaru:',
    '{"items":[{"index":0,"filename":"soubor.pdf","company":"Firma","subject":"Faktura Firma ..."}]}',
    'Pokud firmu nepoznáš, použij company "Neurčeno".',
    'Subjekt max 120 znaků, česky.',
    'Seznam souborů dle indexu:',
    fileLines,
  ].join('\n');

  const inputContent = buildOpenAiInputFromFiles(files, instructions);
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [{ role: 'user', content: inputContent }],
    temperature: 0.1,
  });

  const parsed = parseJsonResponse(response.output_text || '');
  return normalizeInvoiceItems(parsed.items, files);
}

function buildGroupedResponse(items) {
  const groupsMap = new Map();
  for (const item of items) {
    if (!groupsMap.has(item.company)) {
      groupsMap.set(item.company, []);
    }
    groupsMap.get(item.company).push(item);
  }

  return [...groupsMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'cs'))
    .map(([company, files]) => ({ company, files }));
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
      userEmail: me.mail || me.userPrincipalName || 'unknown',
      userName: me.displayName || '',
      loginAt: Date.now(),
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
  if (!auth?.userEmail) {
    return res.json({ loggedIn: false });
  }

  return res.json({
    loggedIn: true,
    userEmail: auth.userEmail,
    userName: auth.userName,
  });
});

app.post('/api/sort', upload.array('files', MAX_FILES), async (req, res) => {
  try {
    if (!req.session?.auth?.userEmail) {
      return res.status(401).json({ error: 'Nejdřív se přihlas přes Microsoft.' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Chybí konfigurace v .env: OPENAI_API_KEY' });
    }

    const files = req.files || [];
    validateFiles(files);

    const aiItems = await classifyInvoices(files);
    const records = aiItems.map((item, index) => ({
      id: crypto.randomUUID(),
      index,
      filename: item.filename,
      company: item.company,
      subject: item.subject,
      mimetype: files[index].mimetype || 'application/octet-stream',
      contentBase64: files[index].buffer.toString('base64'),
      size: files[index].size,
    }));

    req.session.sortedInvoices = records;

    const groups = buildGroupedResponse(records.map((r) => ({
      id: r.id,
      filename: r.filename,
      company: r.company,
      subject: r.subject,
      size: r.size,
    })));

    return res.json({
      ok: true,
      total: records.length,
      groups,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Neočekávaná chyba.' });
  }
});

app.get('/api/download/:id', (req, res) => {
  const fileId = String(req.params.id || '');
  const records = req.session?.sortedInvoices || [];
  const record = records.find((item) => item.id === fileId);

  if (!record) {
    return res.status(404).json({ error: 'Soubor nebyl nalezen. Nahraj a roztřiď faktury znovu.' });
  }

  const buffer = Buffer.from(record.contentBase64, 'base64');
  res.setHeader('Content-Type', record.mimetype);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.filename)}"`);
  return res.send(buffer);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

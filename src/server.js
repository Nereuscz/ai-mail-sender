const path = require('path');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 20);

function getMissingConfig() {
  const required = [
    'OPENAI_API_KEY',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'MAIL_FROM',
  ];
  return required.filter((key) => !process.env[key]);
}

function getOpenAiClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.post('/api/send', upload.single('file'), async (req, res) => {
  try {
    const missing = getMissingConfig();
    if (missing.length > 0) {
      return res.status(500).json({
        error: `Chybí konfigurace v .env: ${missing.join(', ')}`,
      });
    }

    const { targetEmail, note } = req.body;
    const file = req.file;

    if (!targetEmail) {
      return res.status(400).json({ error: 'Chybí cílový email.' });
    }

    if (!file) {
      return res.status(400).json({ error: 'Chybí příloha (PDF nebo obrázek).' });
    }

    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > MAX_FILE_SIZE_MB) {
      return res.status(400).json({
        error: `Soubor je příliš velký. Max je ${MAX_FILE_SIZE_MB} MB.`,
      });
    }

    const { subject, body } = await generateSubjectAndBodyFromFile(file, targetEmail, note);
    const transporter = getTransporter();

    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: targetEmail,
      subject,
      text: body,
      attachments: [
        {
          filename: file.originalname,
          content: file.buffer,
          contentType: file.mimetype,
        },
      ],
    });

    res.json({
      ok: true,
      messageId: info.messageId,
      subject,
      previewBody: body,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Neočekávaná chyba.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

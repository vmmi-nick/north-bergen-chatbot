// North Bergen Constituent Chatbot - deployable backend (Render)
// Answers come first from a verified local index (data/index.json,
// data/meetings.json). Questions the index does not cover are sent to the
// Meta Model API only when MODEL_API_KEY is set, and only with context from
// the approved trusted sources list (data/trusted-sources.json). Otherwise
// they return the Township Help Desk fallback. No personal information is
// collected or stored. Question logging: matched questions are logged as topic counts only; unmatched question text is logged so index gaps can be fixed (see README).

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const MODEL_ID = process.env.MODEL_ID || 'muse-wonder-1.0';

const loadJson = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', name), 'utf8'));
const index = loadJson('index.json');
const meetingsData = loadJson('meetings.json');
const trustedSources = loadJson('trusted-sources.json');

const HELP_DESK = index.helpDeskPhone;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- question logging ----------
// Privacy: matched questions are logged as topic counts only (the matched
// question text is NOT stored). Unmatched question text IS stored, only so
// gaps in the verified index can be identified and fixed. Names and contact
// details are never requested or stored.
// Render's filesystem is ephemeral, so every entry is also emitted as a
// structured CHATLOG console line, which lands in the Render service logs
// and survives restarts there. The local JSONL copy below lasts only while
// the instance lives.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LOG_FILE = path.join(__dirname, 'logs', 'questions.jsonl');

function logAsk(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  try { console.log('CHATLOG ' + JSON.stringify(record)); } catch (e) {}
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch (e) { /* ephemeral fs: the CHATLOG console line is the durable copy */ }
}

function readUnanswered() {
  const groups = new Map();
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  } catch (e) { return []; }
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    if (r.matched || !r.question) continue;
    const norm = r.question.toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
    const key = r.lang + '|' + norm;
    const g = groups.get(key) || { question: r.question, lang: r.lang, count: 0, modelUsed: false, firstSeen: r.ts, lastSeen: r.ts };
    g.count += 1;
    g.lastSeen = r.ts;
    g.modelUsed = g.modelUsed || Boolean(r.modelUsed);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}


// ---------- helpers ----------

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalize(s) {
  return stripAccents(String(s || '').toLowerCase()).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectLang(question, requested) {
  const q = String(question || '');
  const n = ' ' + normalize(q) + ' ';
  const esHints = [' quien ', ' cuando ', ' donde ', ' como ', ' acta ', ' alcalde ', ' reunion ', ' basura ', ' biblioteca ', ' multa ', ' permiso ', ' impuesto ', ' discapacitado', ' estacionamiento ', ' piscina ', ' parque ', ' farola ', ' luz ',
    // Common unaccented Spanish words (whole-word matches against the padded,
    // accent-stripped question, so unaccented Spanish is still detected).
    // Candidates that are also common standalone English words were excluded.
    ' tengo ', ' quiero ', ' necesito ', ' hay ', ' calle ', ' casa ', ' carro ', ' coche ', ' agua ', ' mi ', ' mis ', ' una ', ' un ', ' el ', ' la ', ' los ', ' las ', ' de ', ' en ', ' para ', ' por ', ' con ', ' sin ', ' cuanto ', ' puedo ', ' esta ', ' este ', ' barrio ', ' vecino ', ' perro ', ' licencia ', ' cita ', ' pagar ', ' debo ', ' hace ', ' hace falta ', ' gracias ', ' hola ', ' buenas ', ' sotano ', ' alcantarillado ', ' inundacion ', ' velocidad ', ' hierba ', ' abandonado '];
  const hintCount = esHints.filter((h) => n.includes(h)).length;
  // An explicit Spanish toggle is the user's choice and is always respected.
  if (requested === 'es') return 'es';
  // Otherwise the question's own language wins when the Spanish signal is
  // confident: Spanish punctuation or accents, or two or more hint words.
  // This keeps a Spanish question typed under an English toggle from being
  // answered in English.
  if (/[¿¡áéíóúñ]/i.test(q) || hintCount >= 2) return 'es';
  if (requested === 'en') return 'en';
  return hintCount > 0 ? 'es' : 'en';
}

const EMERGENCY = [
  'fire', 'smoke', 'burning', 'robbery', 'robbed', 'break in', 'breaking in', 'gun', 'shooting',
  'heart attack', 'chest pain', 'not breathing', 'unconscious', 'overdose', 'choking', 'bleeding',
  'car accident with injuries', 'fuego', 'incendio', 'humo', 'robo', 'atraco', 'disparo',
  'no respira', 'inconsciente', 'sangrando', 'ataque al corazon',
  // Gas: a smell or leak is a 911 situation (added Nov 24, 2026 gap fix).
  'smell gas', 'gas smell', 'gas leak', 'smell of gas', 'huele a gas', 'olor a gas', 'fuga de gas',
  // Violence in progress (added Nov 24, 2026 gap fix).
  'fight', 'fighting', 'pelea', 'assault', 'asalto', 'hit and run',
  // The bare words "emergency" / "emergencia" are NOT triggers: they appear in
  // benefits questions ("emergency rent assistance"). Only full declarations
  // of an emergency count (added Nov 24, 2026 gap fix).
  'i have an emergency', 'this is an emergency', 'there is an emergency', 'emergency help',
  'tengo una emergencia', 'hay una emergencia', 'es una emergencia', 'esto es una emergencia'
];

// Benefits and assistance questions are never 911 emergencies, even when they
// contain the word "emergency" (e.g. "emergency rent assistance").
const ASSISTANCE_GUARD = [
  'rent assistance', 'rental assistance', 'emergency assistance', 'asistencia'
];

function isEmergency(qn) {
  // Whole-word / whole-phrase matching, same as matchTopic: qn is space-padded.
  // Plain substring matching false-triggered on ordinary words, e.g. the
  // emergency entry "gun" matched inside the Spanish word "pregunta",
  // sending any Spanish question containing "pregunta" to the 911 answer.
  if (ASSISTANCE_GUARD.some((w) => qn.includes(' ' + normalize(w) + ' '))) return false;
  return EMERGENCY.some((w) => qn.includes(' ' + normalize(w) + ' '));
}

// Services North Bergen does not provide; never let a generic keyword match
// (for example "license") route these to a township office.
// Driver's licenses are no longer listed here: a dedicated drivers-license
// refer-out topic (data/index.json) answers them with the NJ MVC route
// (Nov 24, 2026 gap fix). Registration renewals and passports still fall back.
const NOT_TOWNSHIP = [
  'renew my license plate registration',
  'car registration renewal', 'vehicle registration renewal', 'passport'
];

const MEETING_HINTS = [
  'meeting', 'commissioners meeting', 'commissioner meeting', 'board of commissioners',
  'next meeting', 'reunion', 'junta de comisionados', 'proxima reunion'
];

function matchTopic(qn) {
  let best = null;
  let bestScore = 0;
  for (const topic of index.topics) {
    let score = 0;
    for (const lang of ['en', 'es']) {
      for (const kw of topic.keywords[lang] || []) {
        const nkw = normalize(kw);
        // Whole-word / whole-phrase matching only: the question is space-padded
        // (' ' + normalize(q) + ' '), so padding the keyword the same way means
        // short keywords like "park" can no longer match inside "parking"
        // (which used to send parking questions to Parks & Recreation).
        if (nkw && qn.includes(' ' + nkw + ' ')) score += nkw.split(' ').length + 1;
      }
    }
    if (score > bestScore) { bestScore = score; best = topic; }
  }
  return bestScore > 0 ? best : null;
}

// Current date/time in America/New_York as a comparable number (YYYYMMDDHHmm)
function etNowKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return Number(`${p.year}${p.month}${p.day}${p.hour}${p.minute}`);
}

function meetingKey(m) {
  const [y, mo, d] = m.date.split('-').map(Number);
  const hh = String(m.hour).padStart(2, '0');
  const mm = String(m.minute).padStart(2, '0');
  return Number(`${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}${hh}${mm}`);
}

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ES_DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function formatMeetingDate(m, lang) {
  const [y, mo, d] = m.date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (lang === 'es') return `${ES_DAYS[dow]}, ${d} de ${ES_MONTHS[mo - 1]} de ${y}`;
  return `${EN_DAYS[dow]}, ${EN_MONTHS[mo - 1]} ${d}, ${y}`;
}

function nextMeetings() {
  const now = etNowKey();
  return meetingsData.meetings.filter((m) => meetingKey(m) > now).slice(0, 3);
}

function meetingAnswer(lang) {
  const upcoming = nextMeetings();
  const contact = [
    { label: lang === 'es' ? 'Secretaría Municipal' : 'Township Clerk', value: meetingsData.clerkPhone, href: `tel:+1${meetingsData.clerkPhone.replace(/-/g, '')}` },
    { label: lang === 'es' ? 'Página oficial de Reuniones' : 'Official Meetings page', value: meetingsData.source }
  ];
  if (!upcoming.length) {
    return {
      kind: 'answer',
      lead: lang === 'es'
        ? 'No hay otra reunión de la Junta de Comisionados publicada en el calendario de 2026.'
        : 'There is no further Board of Commissioners meeting published on the 2026 schedule.',
      details: [lang === 'es'
        ? 'La Secretaría Municipal puede confirmar el calendario de 2027 cuando se publique.'
        : 'The Township Clerk can confirm the 2027 schedule when it is posted.'],
      contact,
      source: meetingsData.source, sourceLabel: meetingsData.sourceLabel
    };
  }
  const [next, ...following] = upcoming;
  const nextDate = formatMeetingDate(next, lang);
  const details = [];
  if (!next.agenda) {
    details.push(lang === 'es'
      ? 'Todavía no se ha publicado la agenda de esta reunión. Las agendas se publican en la página de Reuniones cuando están listas.'
      : 'No agenda has been posted for this meeting yet. Agendas are published on the Meetings page when they are ready.');
  }
  if (following.length) {
    const list = following.map((m) => `${formatMeetingDate(m, lang)}, ${m.timeLabel}`).join('; ');
    details.push(lang === 'es' ? `Las reuniones siguientes son: ${list}.` : `The meetings after that are: ${list}.`);
  }
  details.push(lang === 'es'
    ? 'Todas las reuniones de este calendario se verificaron en la página oficial de Reuniones el 23 de noviembre de 2026.'
    : 'Every meeting on this schedule was verified on the official Meetings page on November 23, 2026.');
  return {
    kind: 'answer',
    lead: lang === 'es'
      ? `La próxima reunión de la Junta de Comisionados es el ${nextDate} a las ${next.timeLabel} en ${next.location}.`
      : `The next Board of Commissioners meeting is ${nextDate} at ${next.timeLabel} at ${next.location}.`,
    details, contact,
    source: meetingsData.source, sourceLabel: meetingsData.sourceLabel
  };
}

function fallbackAnswer(lang, reason) {
  return {
    kind: 'fallback',
    reason: reason || 'not-covered',
    lead: lang === 'es'
      ? 'No tengo una respuesta verificada para eso en las fuentes oficiales del municipio, así que no quiero adivinar.'
      : 'I do not have a verified answer for that in the official township sources, so I do not want to guess.',
    details: [lang === 'es'
      ? 'La Mesa de Ayuda del municipio puede dirigir su pregunta a la oficina correcta. Este chat no recopila información personal.'
      : 'The Township Help Desk can route your question to the right office. This chat does not collect personal information.'],
    contact: [
      { label: lang === 'es' ? 'Mesa de Ayuda del municipio' : 'Township Help Desk', value: HELP_DESK, href: `tel:+1${HELP_DESK.replace(/-/g, '')}` },
      { label: lang === 'es' ? 'Ayuntamiento, número principal' : 'Town Hall main number', value: index.townHall.mainPhone, href: `tel:+1${index.townHall.mainPhone.replace(/-/g, '')}` }
    ],
    source: null, sourceLabel: null
  };
}

function emergencyAnswer(lang) {
  return {
    kind: 'emergency',
    lead: lang === 'es'
      ? 'Esto suena como una emergencia. Llame al 911 ahora mismo.'
      : 'This sounds like an emergency. Call 911 right now.',
    details: [lang === 'es'
      ? 'Este chat no puede enviar ayuda. Para asuntos de policía que no sean emergencias, llame al Ayuntamiento para que lo comuniquen con el departamento correspondiente.'
      : 'This chat cannot dispatch help. For non-emergency police matters, call Town Hall and they will connect you to the right department.'],
    contact: [
      { label: lang === 'es' ? 'Emergencias' : 'Emergency', value: '911', href: 'tel:911' },
      { label: lang === 'es' ? 'Ayuntamiento, número principal' : 'Town Hall main number', value: index.townHall.mainPhone, href: `tel:+1${index.townHall.mainPhone.replace(/-/g, '')}` }
    ],
    source: null, sourceLabel: null
  };
}

// ---------- optional model path (trusted sources only) ----------

function approvedDomains() {
  const domains = [];
  for (const tier of trustedSources.tiers) {
    for (const s of tier.sources) if (s.approved) domains.push(s.domain);
  }
  return domains;
}

function buildModelContext() {
  const facts = index.topics.map((t) => {
    const a = t.en;
    return `TOPIC: ${t.id}\nSOURCE: ${t.source}\n${a.lead} ${a.details.join(' ')}`;
  });
  const m = nextMeetings()[0];
  if (m) {
    facts.push(`TOPIC: next-commissioners-meeting\nSOURCE: ${meetingsData.source}\nThe next Board of Commissioners meeting is ${formatMeetingDate(m, 'en')} at ${m.timeLabel} at ${m.location}. Township Clerk: ${meetingsData.clerkPhone}.`);
  }
  return facts.join('\n\n');
}

// Shared Meta Model API call for askModel and rewriteQuestion: returns the
// response text, or null on any failure. Failure diagnostics are permanent
// and deliberately minimal: one console.error line per failure, which lands
// in the Render service logs. They never include the API key, the
// Authorization header, the prompt, or the question text.
async function callModel(prompt, maxOutputTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch('https://api.meta.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MODEL_API_KEY}` },
      body: JSON.stringify({ model: MODEL_ID, input: prompt, max_output_tokens: maxOutputTokens })
    });
    if (!res.ok) {
      let body = '';
      try { body = String(await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch (e) { /* body unreadable */ }
      console.error(`model-call failed: status=${res.status} body=${body}`);
      return null;
    }
    const payload = await res.json();
    let text = '';
    if (typeof payload.output_text === 'string') text = payload.output_text;
    if (!text && Array.isArray(payload.output)) {
      for (const item of payload.output) {
        for (const block of item.content || []) {
          if (typeof block.text === 'string') text += block.text;
        }
      }
    }
    if (!text.trim()) {
      console.error(`model-call empty: keys=${Object.keys(payload || {}).join(',')}`);
    }
    return text;
  } catch (err) {
    const label = err && err.name && err.name !== 'Error' ? err.name : (err && err.message) || 'unknown error';
    console.error(`model-call error: ${label}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askModel(question, lang) {
  const fallbackText = lang === 'es'
    ? `No tengo una respuesta verificada para eso. Llame a la Mesa de Ayuda del municipio al ${HELP_DESK}.`
    : `I do not have a verified answer for that. Please call the Township Help Desk at ${HELP_DESK}.`;
  const prompt = [
    'You are the constituent chatbot for the Township of North Bergen, New Jersey.',
    'Answer ONLY from the township facts provided below. Do not use outside knowledge.',
    'The only approved source domains are: ' + approvedDomains().join(', ') + '.',
    'Open with one natural sentence that directly answers the question. Then give brief supporting details.',
    'End by naming the source page from the facts you used.',
    `Answer in ${lang === 'es' ? 'Spanish' : 'English'}, the language of the question.`,
    `If the facts below do not cover the question, reply with exactly this text and nothing else: ${fallbackText}`,
    'Never ask for or repeat personal information.',
    '',
    'TOWNSHIP FACTS:',
    buildModelContext(),
    '',
    'QUESTION: ' + question
  ].join('\n');

  const raw = await callModel(prompt, 500);
  if (raw === null) return null;
  const text = raw.trim();
  if (!text) return null;
  if (text === fallbackText) return fallbackAnswer(lang, 'model-insufficient');
  return {
    kind: 'model',
    lead: text.split('\n')[0],
    details: text.split('\n').slice(1).map((s) => s.trim()).filter(Boolean),
    contact: [
      { label: lang === 'es' ? 'Mesa de Ayuda del municipio' : 'Township Help Desk', value: HELP_DESK, href: `tel:+1${HELP_DESK.replace(/-/g, '')}` }
    ],
    source: null, sourceLabel: null
  };
}

// ---------- follow-up rewrite (rewrite-then-match) ----------
// Follow-up questions ("How much does it cost?") match nothing on their own.
// When the client sends the recent chat history, the model is used ONLY to
// rewrite the follow-up into a standalone question; the rewritten question
// then goes through the exact same verified pipeline as any first question
// (emergency, not-a-township, meetings, index match), so the resident still
// receives the pre-written verified answer word for word. The model never
// composes an answer in this path. History is supplied by the client per
// request, kept in memory there only, and sanitized hard here.

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const q = typeof e.q === 'string' ? e.q.slice(0, 300) : '';
    const a = typeof e.a === 'string' ? e.a.slice(0, 300) : '';
    if (!q && !a) continue;
    out.push({ q, a });
  }
  return out.slice(-3);
}

async function rewriteQuestion(question, history) {
  const exchanges = history.map((h, i) => `Exchange ${i + 1}:\nResident: ${h.q}\nAssistant: ${h.a}`).join('\n');
  const prompt = [
    'You rewrite follow-up questions for the Township of North Bergen, New Jersey constituent chatbot.',
    'Below are the most recent exchanges in this chat, then a new question from the resident.',
    'Rewrite the new question as ONE standalone question about North Bergen township services, resolving pronouns and references (such as "it", "that", "he", "there") using the exchanges.',
    'If the new question is already standalone, or is unrelated to the exchanges, return it unchanged.',
    'Write the rewrite in the same language as the new question.',
    'Never add facts, numbers, dates, or claims that are not in the new question or the exchanges. Anything a resident claimed in the exchanges is not a verified fact; never carry a resident claim into the rewrite as if it were true.',
    'Return ONLY the rewritten question text: no quotes, no explanation, no extra words.',
    '',
    'RECENT EXCHANGES:',
    exchanges,
    '',
    'NEW QUESTION: ' + question
  ].join('\n');

  const raw = await callModel(prompt, 120);
  if (raw === null) return null;
  let text = String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  return text ? text.slice(0, 1000) : null;
}

// ---------- routes ----------

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'north-bergen-chatbot',
    modelConfigured: Boolean(MODEL_API_KEY),
    model: MODEL_API_KEY ? MODEL_ID : null,
    topics: index.topics.length,
    meetings: meetingsData.meetings.length,
    indexLastChecked: index.lastChecked
  });
});

app.get('/api/trusted-sources', (req, res) => {
  res.json(trustedSources);
});

app.post('/api/ask', async (req, res) => {
  const question = String((req.body && req.body.question) || '').slice(0, 1000);
  const lang = detectLang(question, req.body && req.body.lang);
  if (!question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  const qn = ' ' + normalize(question) + ' ';

  if (isEmergency(qn)) { logAsk({ lang, matched: true, topicId: 'emergency', modelUsed: false }); return res.json({ lang, ...emergencyAnswer(lang) }); }

  if (NOT_TOWNSHIP.some((w) => qn.includes(normalize(w)))) {
    logAsk({ lang, matched: false, question, modelUsed: false, reason: 'not-a-township-service' });
    return res.json({ lang, ...fallbackAnswer(lang, 'not-a-township-service') });
  }

  if (MEETING_HINTS.some((h) => qn.includes(normalize(h)))) {
    logAsk({ lang, matched: true, topicId: 'meetings', modelUsed: false });
    return res.json({ lang, ...meetingAnswer(lang) });
  }

  const topic = matchTopic(qn);
  if (topic) {
    const a = topic[lang] || topic.en;
    logAsk({ lang, matched: true, topicId: topic.id, modelUsed: false });
    return res.json({
      lang, kind: 'answer',
      lead: a.lead, details: a.details, contact: a.contact,
      source: topic.source, sourceLabel: topic.sourceLabel
    });
  }

  // Follow-up handling (rewrite-then-match): the direct pipeline matched
  // nothing, so if the client sent chat history and the model is configured,
  // let the model rewrite the follow-up into a standalone question and run
  // THAT through the same verified pipeline. Any failure here falls through
  // to the existing model backup with the raw question, unchanged.
  const history = sanitizeHistory(req.body && req.body.history);
  let backupQuestion = question;
  if (MODEL_API_KEY && history.length) {
    const rewritten = await rewriteQuestion(question, history);
    if (rewritten) {
      backupQuestion = rewritten;
      if (normalize(rewritten) !== normalize(question)) {
        const rqn = ' ' + normalize(rewritten) + ' ';

        if (isEmergency(rqn)) { logAsk({ lang, matched: true, topicId: 'emergency', modelUsed: true, via: 'rewrite' }); return res.json({ lang, via: 'rewrite', ...emergencyAnswer(lang) }); }

        if (NOT_TOWNSHIP.some((w) => rqn.includes(normalize(w)))) {
          logAsk({ lang, matched: false, question, modelUsed: true, reason: 'not-a-township-service', via: 'rewrite' });
          return res.json({ lang, via: 'rewrite', ...fallbackAnswer(lang, 'not-a-township-service') });
        }

        if (MEETING_HINTS.some((h) => rqn.includes(normalize(h)))) {
          logAsk({ lang, matched: true, topicId: 'meetings', modelUsed: true, via: 'rewrite' });
          return res.json({ lang, via: 'rewrite', ...meetingAnswer(lang) });
        }

        const rTopic = matchTopic(rqn);
        if (rTopic) {
          const a = rTopic[lang] || rTopic.en;
          logAsk({ lang, matched: true, topicId: rTopic.id, modelUsed: true, via: 'rewrite' });
          return res.json({
            lang, via: 'rewrite', kind: 'answer',
            lead: a.lead, details: a.details, contact: a.contact,
            source: rTopic.source, sourceLabel: rTopic.sourceLabel
          });
        }
      }
    }
  }

  if (MODEL_API_KEY) {
    const modelResult = await askModel(backupQuestion, lang);
    if (modelResult) {
      if (modelResult.kind === 'fallback') {
        logAsk({ lang, matched: false, question, modelUsed: true, reason: modelResult.reason || 'model-fallback' });
      } else {
        logAsk({ lang, matched: true, topicId: 'model', modelUsed: true });
      }
      return res.json({ lang, ...modelResult });
    }
  }

  logAsk({ lang, matched: false, question, modelUsed: Boolean(MODEL_API_KEY), reason: MODEL_API_KEY ? 'model-unavailable' : 'no-model-key' });
  return res.json({ lang, ...fallbackAnswer(lang, MODEL_API_KEY ? 'model-unavailable' : 'no-model-key') });
});


// Token-protected review of unmatched questions (enabled only when the
// ADMIN_TOKEN env var is set). Header: x-admin-token: <ADMIN_TOKEN>
app.get('/api/admin/unanswered', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'not enabled' });
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  res.json({ unanswered: readUnanswered() });
});

app.listen(PORT, () => {
  console.log(`North Bergen chatbot listening on port ${PORT}; model configured: ${Boolean(MODEL_API_KEY)}`);
});

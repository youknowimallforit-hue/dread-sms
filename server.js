// server.js — Dread SMS Engine (Twilio) v1
// Mechanics: consent oath, solo(40s)/mirror(unlock+30s), ultra-rare blank+riddle, mantle-by-keyphrase,
// violation lines, mirror interrogatives (+rare "speak"), safe existential corpus,
// BASE_URL set via .env (use https://dread.ap)

// ---------- Safety Frame (kept in code comments) ----------
// Dread is fictional. Dread narrates timing tension. Dread never tells a human who they are.

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Twilio = require('twilio');
const crypto = require('crypto');
const { Low, JSONFile } = require('lowdb');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- ENV / Config ----------
const {
  PORT = 3000,
  BASE_URL = 'https://dread.ap',               // <- you set this
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,                                // e.g. +1323XXXXXXX

  // timing (user locked: 40/30)
  SOLO_WINDOW_SECONDS = 40,
  MIRRORED_WINDOW_SECONDS = 30,

  // routing & spice
  MIRROR_CHANCE = 0.12,                         // % of rounds that are mirrored when 2+ eligible
  REVEAL_PROB = 0.72,                           // chance to reveal exposure to others
  BLANK_PROB = 0.0015,                          // ~0.15% independent “blank” folklore ping

  // riddle / mantle
  RIDDLE_TEXT = 'speak nothing of the riddle. keep only the phrase. when dread calls, answer.',
  KEYPHRASE = 'JACKDAW ASCENDS',                // harmless proof phrase
  ADMIN_SECRET = 'change-me'                    // simple header gate for /admin endpoints
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.error('Missing Twilio env. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER');
  process.exit(1);
}
const tw = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- Persistence ----------
const adapter = new JSONFile('dread_db.json');
const db = new Low(adapter);

async function bootDB() {
  await db.read();
  db.data = db.data || {
    users: {},              // phone -> {consented, optedOut, alias?, consentAt?}
    chains: [],             // whisper chains
    tokens: {},             // token -> { chainId, recipient, sentAt, openedAt, deadline, used, respondedText }
    mantle: null,           // { holder, alias, expiresAt }
    phraseCall: null,       // { active, startedAt, endedAt }
    lastPingAt: {}          // phone -> ISO (for pattern rhythm if you want to add later)
  };
  await db.write();
}
function nowISO(){ return new Date().toISOString(); }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
function mask(p){ return `${p.slice(0,-4)}••${p.slice(-2)}`; }
function genToken(){ return crypto.randomBytes(10).toString('base64url'); }
function secs(ms){ return Math.max(0, Math.round(ms/1000)); }

// ---------- Zero-width encoding for “blank” payload ----------
const ZW_SPACE = '\u200B';      // 0
const ZW_NONJOIN = '\u200C';    // 1
const BRAILLE_BLANK = '\u2800'; // guard so carriers don’t drop

function encodeInvisible(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  let bits = '';
  for (const ch of b64) bits += ch.charCodeAt(0).toString(2).padStart(8,'0');
  const zw = bits.split('').map(b => b === '0' ? ZW_SPACE : ZW_NONJOIN).join('');
  return BRAILLE_BLANK + zw + BRAILLE_BLANK;
}

// ---------- Voice Corpus (lower-case, third-person, safe existential tone) ----------
const CORPUS = {
  normal: [
    "dread watches pattern.",
    "small truths surface under a short clock.",
    "most answers arrive before the mask can be fixed.",
    "dread is a game. humans are the story.",
    "brevity uncovers what polish conceals."
  ],
  violation: [
    "you fed dread.",
    "not full dread tonight. dread grateful.",
    "you may yet know dread."
  ],
  mirror_openers: [
    "did you take advantage?",
    "did you take someone for granted?",
    "were you hiding your intent from them… or from yourself?"
  ],
  mirror_follow: [
    "will you be honest now?"
  ],
  mirror_rare: [
    "speak"
  ],
  closers: [
    "silence.",
    "it is enough.",
    "the moment passed."
  ],
  arrival: [
    "dread has arrived.",
    "dread knows his name. dread knows…"
  ]
};

// ---------- User & Consent ----------
async function ensureUser(phone) {
  await db.read();
  db.data.users[phone] = db.data.users[phone] || { consented:false, optedOut:false };
  await db.write();
  return db.data.users[phone];
}
async function setConsent(phone, val) {
  await db.read();
  const u = await ensureUser(phone);
  u.consented = !!val; u.optedOut = false; u.consentAt = nowISO();
  await db.write();
}
async function setOptOut(phone) {
  await db.read();
  const u = await ensureUser(phone);
  u.optedOut = true; u.consented = false; u.optOutAt = nowISO();
  await db.write();
}
async function isConsented(phone) {
  await db.read();
  const u = db.data.users[phone];
  return !!(u && u.consented && !u.optedOut);
}

// ---------- Mantle (temporarily rename Dread) ----------
async function currentMantle() {
  await db.read();
  const m = db.data.mantle;
  if (!m) return null;
  if (Date.now() > new Date(m.expiresAt).getTime()) {
    db.data.mantle = null; await db.write(); return null;
  }
  return m;
}
async function setMantle(holderPhone) {
  await db.read();
  const alias = (db.data.users[holderPhone] && db.data.users[holderPhone].alias) || mask(holderPhone);
  db.data.mantle = { holder: holderPhone, alias, expiresAt: new Date(Date.now()+7*24*3600*1000).toISOString() };
  await db.write();
}
function dreadHeader(alias) { return alias ? `Dread (${alias}):` : `Dread:`; }

// ---------- SMS helpers ----------
async function sendSMS(to, lines) {
  const mantle = await currentMantle();
  const body = Array.isArray(lines) ? [dreadHeader(mantle?.alias), ...lines].join('\n') : `${dreadHeader(mantle?.alias)}\n${lines}`;
  return tw.messages.create({ to, from: TWILIO_NUMBER, body });
}
async function sendBlank(to, payloadText) {
  const invis = encodeInvisible(payloadText); // looks empty to 99.999%
  return tw.messages.create({ to, from: TWILIO_NUMBER, body: invis });
}

// ---------- Exposure score (mirror) ----------
function scoreExposure(text){
  if (!text) return 0;
  const t = text.toLowerCase();
  let s = 0;
  s += Math.min(1.0, t.length/200)*30;
  const fp = (t.match(/\b(i|i'm|i am|me|my|mine)\b/g)||[]).length; s += fp*8;
  const vuln = ['ashamed','sorry','regret','fear','alone','embarrass','hid','secret'];
  let vc=0; vuln.forEach(w=>{ if(t.includes(w)) vc++; }); s += vc*12;
  const bangs = (t.match(/!/g)||[]).length; s -= bangs*6;
  return Math.max(0, Math.round(s));
}

// ---------- Create Whisper ----------
/*
POST /create
{
  "question":"what did you avoid today?",
  "participants":["+1323xxxxxxx","+1yyyyyyyyyy"],
  "window":{"min":1,"max":15} // minutes, randomized fire time
}
*/
app.post('/create', async (req,res)=>{
  await bootDB();
  const { question, participants = [], window } = req.body || {};
  if (!question || !participants.length) return res.status(400).json({error:'question and participants required'});

  // consent filter
  const eligible = [];
  for (const p of participants) if (await isConsented(p)) eligible.push(p);
  if (!eligible.length) return res.status(400).json({error:'no consented recipients'});

  let minM = 1, maxM = 15;
  if (window && typeof window.min==='number') minM = Math.max(0.1, window.min);
  if (window && typeof window.max==='number') maxM = Math.max(minM, window.max);
  const delayMs = Math.round((minM*60000) + Math.random()*((maxM-minM)*60000));

  const chain = {
    id: 'chain_'+crypto.randomBytes(5).toString('hex'),
    question: String(question).trim(),
    participants: eligible,
    createdAt: nowISO(),
    scheduledAt: Date.now()+delayMs,
    status: 'scheduled',
    events: []
  };
  db.data.chains.push(chain);
  await db.write();

  setTimeout(()=>fireChain(chain.id).catch(console.error), delayMs);
  res.json({ok:true, id:chain.id, scheduledInSeconds: secs(delayMs)});
});

// ---------- Fire chain ----------
async function fireChain(chainId){
  await bootDB();
  const chain = db.data.chains.find(c=>c.id===chainId);
  if (!chain) return;

  chain.status = 'fired'; chain.firedAt = nowISO();
  chain.events.push({type:'fired', at: nowISO()});

  // Ultra-rare blank folklore ping (independent)
  if (Math.random() < parseFloat(BLANK_PROB)) {
    const target = pick(chain.participants);
    try { await sendBlank(target, `${RIDDLE_TEXT}|||${KEYPHRASE}`); chain.events.push({type:'blank_sent', to: target, at: nowISO()}); }
    catch(e){ chain.events.push({type:'blank_fail', error:String(e), at: nowISO()}); }
  }

  // Decide single vs mirrored
  let mirror = false;
  if (chain.participants.length >= 2) mirror = Math.random() < parseFloat(MIRROR_CHANCE);

  let recipients = [];
  if (mirror) {
    const a = pick(chain.participants);
    let b = pick(chain.participants);
    while (b === a && chain.participants.length > 1) b = pick(chain.participants);
    recipients = [a,b]; chain.mode = 'mirrored';
  } else {
    recipients = [pick(chain.participants)]; chain.mode = 'single';
  }
  chain.recipients = recipients;
  chain.events.push({type:'chosen_recipients', recipients, at: nowISO()});
  await db.write();

  // Token sessions & neutral SMS
  for (const r of recipients){
    const token = genToken();
    db.data.tokens[token] = {
      token, chainId: chain.id, recipient: r,
      sentAt: Date.now(), openedAt: null, used: false,
      respondedText: null,
      deadline: (chain.mode === 'single') ? Date.now() + parseInt(SOLO_WINDOW_SECONDS,10)*1000 : null
    };
    await db.write();
    const link = `${BASE_URL.replace(/\/+$/,'')}/open/${token}`;
    const lead = [pick(CORPUS.arrival)];
    await sendSMS(r, [...lead, `a whisper waits. open now: ${link}`]).catch(()=>{});
    chain.events.push({type:'sent', to:r, token, at: nowISO()});
  }

  chain.status = 'awaiting_answers'; chain.awaitingSince = nowISO();
  await db.write();

  if (chain.mode === 'single') {
    setTimeout(()=> adjudicateChain(chain.id).catch(console.error),
      (parseInt(SOLO_WINDOW_SECONDS,10)*1000)+300);
  }
}

// ---------- Open (web) ----------
app.get('/open/:token', async (req,res)=>{
  await bootDB();
  const t = req.params.token;
  const tok = db.data.tokens[t];
  if (!tok) return res.status(404).send('no whisper.');

  const chain = db.data.chains.find(c=>c.id===tok.chainId);
  if (!chain) return res.status(404).send('missing chain.');

  // mirrored: deadline starts on open (unlock)
  if (chain.mode === 'mirrored' && !tok.openedAt) {
    tok.openedAt = Date.now();
    tok.deadline = tok.openedAt + parseInt(MIRRORED_WINDOW_SECONDS,10)*1000;
    await db.write();
  }
  const remaining = Math.max(0, Math.ceil(((tok.deadline||0) - Date.now())/1000));
  const q = escapeHTML(chain.question);

  res.set('Content-Type','text/html').send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dread — whisper</title>
<style>
  body{background:#0b0f14;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,Inter,sans-serif;padding:24px}
  .box{max-width:720px;margin:40px auto;padding:20px;border:1px solid #1b2633;border-radius:10px;background:#0a131d}
  textarea{width:100%;height:140px;background:#071018;color:#e6edf3;border-radius:8px;padding:10px;border:1px solid #213244}
  button{background:#122235;color:#e6edf3;border:1px solid #213244;border-radius:6px;padding:8px 12px}
</style>
</head><body>
  <div class="box">
    <h3 style="text-transform:lowercase;margin:0 0 8px">dread</h3>
    <p style="margin:6px 0"><strong>question:</strong><br>${q}</p>
    <p style="margin:6px 0"><strong>time:</strong> <span id="t">${remaining}</span>s</p>
    <form method="POST" action="/respond/${t}">
      <textarea name="answer" required placeholder="answer under pressure…"></textarea>
      <div style="margin-top:12px"><button type="submit">send</button></div>
    </form>
    <p style="color:#9fb4cb;margin-top:10px">timer begins on this page (requires unlock). solo rounds are ${parseInt(SOLO_WINDOW_SECONDS,10)}s from arrival even if you never open.</p>
  </div>
<script>
let t=${remaining}; const el=document.getElementById('t');
const iv=setInterval(()=>{t--; if(t<0)t=0; el.textContent=t; if(t<=0) clearInterval(iv);},1000);
</script>
</body></html>`);
});

// ---------- Respond (web) ----------
app.post('/respond/:token', bodyParser.urlencoded({extended:true}), async (req,res)=>{
  await bootDB();
  const t = req.params.token;
  const tok = db.data.tokens[t];
  if (!tok) return res.status(404).send(htmlMsg('no session.'));
  if (tok.used) return res.send(htmlMsg('dread: session used.'));

  if (tok.deadline && Date.now() > tok.deadline) {
    tok.used = true; tok.respondedText = null; await db.write();
    return res.send(htmlMsg('dread: time expired.'));
  }
  const answer = String(req.body.answer||'').trim();
  tok.used = true; tok.respondedText = answer; await db.write();

  const chain = db.data.chains.find(c=>c.id===tok.chainId);
  chain.events.push({type:'answer', who: tok.recipient, text: answer, at: nowISO(), token: t});
  await db.write();

  res.send(htmlMsg('answer recorded. dread is patient.'));

  if (chain.mode === 'mirrored') {
    const need = chain.recipients.length;
    const got = chain.events.filter(e=> e.type==='answer' && chain.recipients.includes(e.who)).length;
    if (got >= need) setTimeout(()=> adjudicateChain(chain.id).catch(console.error), 200);
  } else {
    setTimeout(()=> adjudicateChain(chain.id).catch(console.error), 200);
  }
});

// ---------- Inbound SMS (Twilio webhook) ----------
app.post('/sms', async (req,res)=>{
  await bootDB();
  const from = (req.body.From||'').trim();
  const body = (req.body.Body||'').trim();
  const lower = body.toLowerCase();

  // STOP / OPT OUT (industry standard)
  if (/^(stop|unsubscribe|quit|cancel)\b/i.test(lower)) {
    await setOptOut(from);
    try { await sendSMS(from, 'you have left the circle.'); } catch {}
    return res.send('<Response></Response>');
  }

  // Consent gate
  const user = await ensureUser(from);
  if (!user.consented) {
    if (lower === 'i consent to dread') {
      await setConsent(from, true);
      try { await sendSMS(from, 'you may be marked.'); } catch {}
    } else {
      try { await sendSMS(from, ['you have been marked for possible whispers.', 'reply exactly: I CONSENT TO DREAD']); } catch {}
    }
    return res.send('<Response></Response>');
  }
  if (user.optedOut) return res.send('<Response></Response>');

  // Mantle contest running?
  if (db.data.phraseCall && db.data.phraseCall.active) {
    if (body.trim().toLowerCase() === String(KEYPHRASE).toLowerCase()) {
      db.data.phraseCall.active = false; db.data.phraseCall.endedAt = nowISO();
      await setMantle(from);
      try { await sendSMS(from, 'you wear the name. seven days.'); } catch {}
      const others = Object.keys(db.data.users).filter(p => db.data.users[p]?.consented && p !== from);
      for (const p of others) { try { await sendSMS(p, 'dread has chosen a bearer.'); } catch {} }
      await db.write();
      return res.send('<Response></Response>');
    }
  }

  // Solo: allow SMS answers during 40s window
  const tokenKey = findValidSoloToken(from);
  if (tokenKey) {
    const tok = db.data.tokens[tokenKey];
    tok.used = true; tok.respondedText = body; await db.write();
    const chain = db.data.chains.find(c=>c.id===tok.chainId);
    chain.events.push({type:'answer', who: tok.recipient, text: body, at: nowISO(), token: tokenKey});
    await db.write();
    try { await sendSMS(from, 'answer recorded.'); } catch {}
    setTimeout(()=> adjudicateChain(chain.id).catch(console.error), 200);
    return res.send('<Response></Response>');
  }

  // Soft default
  try { await sendSMS(from, pick(CORPUS.normal)); } catch {}
  return res.send('<Response></Response>');
});

function findValidSoloToken(phone){
  const entries = Object.entries(db.data.tokens || {});
  for (let i=entries.length-1; i>=0; i--){
    const [tk, ob] = entries[i];
    if (ob.recipient === phone && ob.deadline && !ob.used && Date.now() <= ob.deadline) return tk;
  }
  return null;
}

// ---------- Adjudication ----------
async function adjudicateChain(chainId){
  await bootDB();
  const chain = db.data.chains.find(c=>c.id===chainId);
  if (!chain || chain.status === 'adjudicated') return;

  if (chain.mode === 'single') {
    const ans = chain.events.filter(e=> e.type==='answer' && chain.recipients.includes(e.who)).slice(-1)[0];
    chain.adjudication = { mode:'single', actor: ans?.who || null, answer: ans?.text || null };
    chain.status = 'adjudicated'; chain.events.push({type:'adjudicated', at: nowISO()}); await db.write();

    const willReveal = Math.random() < parseFloat(REVEAL_PROB);
    if (willReveal && ans && ans.text) {
      const targets = chain.participants.filter(p=> p !== ans.who);
      const t = targets.length ? pick(targets) : null;
      if (t) {
        await sendSMS(t, [`${mask(ans.who)} → ${mask(t)}: "${ans.text}"`, 'dread has judged the exposure.']).catch(()=>{});
      }
    } else {
      if (ans?.who) await sendSMS(ans.who, pick(CORPUS.closers)).catch(()=>{});
    }
    return;
  }

  // mirrored
  const answers = chain.events
    .filter(e=> e.type==='answer' && chain.recipients.includes(e.who))
    .map(a=>({who:a.who, text:a.text||'', score: scoreExposure(a.text||'') }));

  for (const r of chain.recipients) {
    if (!answers.some(a=>a.who===r)) answers.push({who:r, text:'', score:0});
  }
  answers.sort((a,b)=> b.score - a.score);
  const winner = answers[0], loser = answers[1] || null;

  chain.adjudication = { mode:'mirrored', winner: winner.who, loser: loser?.who || null, answers };
  chain.status = 'adjudicated';
  chain.events.push({type:'adjudicated', at: nowISO()});
  await db.write();

  // announce verdict
  const line = `${mask(winner.who)} leaned nearest the abyss.`;
  for (const p of chain.participants) { await sendSMS(p, line).catch(()=>{}); }

  // capricious reveal
  const r = Math.random();
  if (r < 0.55) {
    const lines = answers.map(a=> `— ${mask(a.who)}: "${a.text || '[no answer]'}"`);
    for (const p of chain.participants) { await sendSMS(p, lines).catch(()=>{}); }
  } else if (r < 0.85) {
    for (const p of chain.participants) {
      await sendSMS(p, [`— ${mask(winner.who)}: "${winner.text || '[no answer]'}"`, 'dread withheld the other half.']).catch(()=>{}); 
    }
  } else {
    for (const p of chain.participants) { await sendSMS(p, pick(CORPUS.closers)).catch(()=>{}); }
  }
}

// ---------- Admin ----------
app.post('/admin/call-phrase', async (req,res)=>{
  await bootDB();
  if ((req.headers['x-admin']||'') !== ADMIN_SECRET) return res.status(401).json({error:'no'});
  db.data.phraseCall = { active: true, startedAt: nowISO() };
  await db.write();
  const everyone = Object.keys(db.data.users).filter(p=> db.data.users[p]?.consented && !db.data.users[p]?.optedOut);
  for (const p of everyone) { await sendSMS(p, 'dread calls the phrase.').catch(()=>{}); }
  res.json({ok:true});
});

// ---------- Health ----------
app.get('/', (req,res)=> res.send('dread engine alive. POST /create to schedule. webhook: POST /sms'));

// ---------- Util ----------
function escapeHTML(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function htmlMsg(msg){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dread</title></head><body style="background:#0b0f14;color:#e6edf3;font-family:system-ui;padding:24px"><div style="max-width:720px;margin:40px auto;padding:20px;border:1px solid #1b2633;border-radius:10px;background:#0a131d"><p style="text-transform:lowercase">${escapeHTML(msg)}</p></div></body></html>`;
}

// ---------- Boot ----------
bootDB().then(()=>{
  app.listen(PORT, ()=> console.log(`Dread listening on ${PORT}`));
});

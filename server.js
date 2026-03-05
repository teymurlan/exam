// server.js (CommonJS)
// Express server + WebApp HTML (inline) + Exam API.
// Uses bot.js exports for Telegram notifications, shared storage, fmtDate, questions.
// Start command: node server.js

const express = require('express');
const crypto = require('crypto');

const {
  bot,
  storage,
  fmtDate,
  sendToAdmins,
  QUESTIONS,
  TOPICS,
  PASS_SCORE,
  APP_URL,
  ADMIN_IDS,
  CORS_ORIGIN,
  TZ,
} = require('./bot.js');

const app = express();

// =========================
// Middleware
// =========================
app.use(express.json({ limit: '256kb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// =========================
// Utils
// =========================
function nowTs() {
  return Date.now();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildAdminStartMessage(user, chatId) {
  const when = fmtDate(nowTs());
  return (
    '🟦 <b>Старт экзамена</b>\n\n' +
    `👤 <b>${escapeHtml(user?.fullName || '—')}</b>\n` +
    `📞 <code>${escapeHtml(user?.phone || '—')}</code>\n` +
    `🆔 <code>${escapeHtml(String(chatId))}</code>\n` +
    `🕒 ${escapeHtml(when)}\n`
  );
}

function buildAdminFinishMessage(user, chatId, result) {
  const when = fmtDate(result.ts);
  const status = result.passed ? '✅ СДАЛ' : '❌ НЕ СДАЛ';
  return (
    '🟩 <b>Финал экзамена</b>\n\n' +
    `👤 <b>${escapeHtml(user?.fullName || '—')}</b>\n` +
    `📞 <code>${escapeHtml(user?.phone || '—')}</code>\n` +
    `🆔 <code>${escapeHtml(String(chatId))}</code>\n` +
    `🕒 ${escapeHtml(when)}\n` +
    `📊 Счет: <b>${result.score}/${result.total}</b>\n` +
    `🏁 Статус: <b>${status}</b>\n`
  );
}

// Create friendly recommendations for failed topics
function buildFailRecommendations(byTopic) {
  // byTopic: { [topicId]: { correct, wrong, total } }
  const stats = Object.entries(byTopic || {})
    .map(([k, v]) => ({ topicId: Number(k), ...v }))
    .filter(x => x.total > 0);

  stats.sort((a, b) => (b.wrong / b.total) - (a.wrong / a.total));

  const weak = stats.filter(s => s.wrong > 0).slice(0, 2);
  const recs = [];

  for (const w of weak) {
    if (w.topicId === 1) {
      recs.push('Повторите базовые правила безопасности: СИЗ, тест на незаметном участке, никогда не смешивать агрессивные средства.');
    } else if (w.topicId === 2) {
      recs.push('Освежите порядок действий: сверху вниз, от дальнего угла к выходу, соблюдение экспозиции и чистая последовательность зон.');
    } else if (w.topicId === 3) {
      recs.push('Потренируйте работу с инвентарём и поверхностями: микрофибра по зонам, аккуратно с абразивами, правильные насадки/техники.');
    } else {
      recs.push(`Подтяните тему: ${TOPICS[w.topicId] || '—'}.`);
    }
  }

  // Ensure 2–3 points
  if (recs.length < 2) recs.push('Пройдитесь по вопросам ещё раз и отметьте, где сомневались — это поможет быстро улучшить результат.');
  if (recs.length < 3) recs.push('Если хотите — пересдача будет доступна после разрешения администратора.');

  return recs.slice(0, 3);
}

function isValidChatId(chatId) {
  return typeof chatId === 'string' && /^\d{5,}$/.test(chatId);
}

// =========================
// Health
// =========================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ts: nowTs(),
    time: fmtDate(nowTs()),
    env: {
      BOT_TOKEN: Boolean(process.env.BOT_TOKEN),
      APP_URL: APP_URL,
      ADMIN_IDS: ADMIN_IDS,
      PASS_SCORE: PASS_SCORE,
      CORS_ORIGIN: CORS_ORIGIN,
      TZ: TZ,
    },
    storage: storage.meta,
  });
});

// =========================
// WebApp HTML
// =========================
function examHtml() {
  // чистый HTML/CSS/JS, без фреймворков
  // fetch timeout implemented
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Экзамен</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial; margin: 0; background: #0b1220; color: #e8eefc; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 18px; }
    .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 16px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    h2 { font-size: 16px; margin: 0 0 10px; opacity: .95; }
    p, li { line-height: 1.45; }
    .muted { opacity: .8; }
    .btn { display:inline-flex; align-items:center; justify-content:center; gap: 8px; border:0; border-radius: 12px; padding: 12px 14px; cursor:pointer; font-weight: 700; }
    .btn-primary { background: #3b82f6; color: #061022; }
    .btn-ghost { background: rgba(255,255,255,0.08); color: #e8eefc; border: 1px solid rgba(255,255,255,0.14); }
    .row { display:flex; gap: 10px; flex-wrap: wrap; }
    .spacer { height: 12px; }
    .danger { color: #ffb4b4; }
    .ok { color: #b8ffcf; }
    .qbox { margin-top: 10px; }
    .opt { display:flex; gap: 10px; padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); margin: 8px 0; }
    .opt input { margin-top: 3px; }
    .topline { display:flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
    .pill { padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); font-weight: 700; }
    .timer { font-variant-numeric: tabular-nums; }
    .footer { margin-top: 16px; opacity: .8; font-size: 12px; }
    .hidden { display:none !important; }
    .hr { height: 1px; background: rgba(255,255,255,0.12); margin: 14px 0; }
    .mono { font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div id="screenRules">
        <h1>Экзамен сотрудников</h1>
        <p class="muted">Перед началом обязательно ознакомьтесь с правилами.</p>
        <div class="hr"></div>
        <h2>Правила</h2>
        <ol>
          <li>Всего 15 вопросов.</li>
          <li>На каждый вопрос даётся <b>15 секунд</b>.</li>
          <li>Если время истекло — ответ считается неверным и вы переходите дальше.</li>
          <li>Не обновляйте страницу во время экзамена.</li>
          <li>Результат фиксируется после отправки.</li>
        </ol>
        <div class="spacer"></div>
        <div class="row">
          <button class="btn btn-primary" id="btnAgree">✅ Я согласен начать</button>
        </div>
        <div class="spacer"></div>
        <div class="muted">Если кнопка не работает — вернитесь в бота и откройте экзамен заново.</div>
      </div>

      <div id="screenExam" class="hidden">
        <div class="topline">
          <div class="pill" id="progressPill">Вопрос 1/15</div>
          <div class="pill timer" id="timerPill">⏳ 15</div>
        </div>
        <div class="spacer"></div>
        <div id="qText" style="font-size: 16px; font-weight: 800;"></div>
        <div class="qbox" id="optionsBox"></div>
        <div class="spacer"></div>
        <div class="row">
          <button class="btn btn-ghost" id="btnNext">Дальше</button>
          <button class="btn btn-primary hidden" id="btnSubmit">Отправить</button>
        </div>
        <div class="footer">Подсказка: если не успели — просто дождитесь окончания таймера.</div>
      </div>

      <div id="screenResult" class="hidden">
        <h1>Результат</h1>
        <div id="resultBox"></div>
        <div class="spacer"></div>
        <div class="muted">Можно закрыть страницу и вернуться в Telegram.</div>
      </div>
    </div>
  </div>

<script>
(function () {
  const qs = new URLSearchParams(location.search);
  const chatId = qs.get('chatId') || '';
  const $ = (id) => document.getElementById(id);

  const screenRules = $('screenRules');
  const screenExam = $('screenExam');
  const screenResult = $('screenResult');

  const btnAgree = $('btnAgree');
  const btnNext = $('btnNext');
  const btnSubmit = $('btnSubmit');

  const progressPill = $('progressPill');
  const timerPill = $('timerPill');
  const qText = $('qText');
  const optionsBox = $('optionsBox');
  const resultBox = $('resultBox');

  let token = null;
  let questions = [];
  let idx = 0;
  let answers = []; // {qid, optionIndex|null}
  let timer = null;
  let secondsLeft = 15;

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function fetchWithTimeout(url, opts, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    return fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }))
      .finally(() => clearTimeout(t));
  }

  function renderQuestion() {
    const q = questions[idx];
    progressPill.textContent = 'Вопрос ' + (idx + 1) + '/' + questions.length;
    qText.textContent = q.text;

    optionsBox.innerHTML = '';
    const name = 'opt';

    q.options.forEach((opt, i) => {
      const row = document.createElement('label');
      row.className = 'opt';
      row.innerHTML = '<input type="radio" name="' + name + '" value="' + i + '" />' +
                      '<div>' + escapeHtml(opt) + '</div>';
      optionsBox.appendChild(row);
    });

    // buttons
    btnSubmit.classList.add('hidden');
    btnNext.classList.remove('hidden');
    if (idx === questions.length - 1) {
      btnNext.classList.add('hidden');
      btnSubmit.classList.remove('hidden');
    }

    // reset timer
    stopTimer();
    secondsLeft = 15;
    timerPill.textContent = '⏳ ' + secondsLeft;
    timer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        timerPill.textContent = '⏳ 0';
        stopTimer();
        // auto mark null answer and move next (or submit)
        saveAnswer(null);
        if (idx < questions.length - 1) {
          idx += 1;
          renderQuestion();
        } else {
          submit();
        }
        return;
      }
      timerPill.textContent = '⏳ ' + secondsLeft;
    }, 1000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getSelectedOptionIndex() {
    const checked = optionsBox.querySelector('input[type="radio"]:checked');
    if (!checked) return null;
    const v = Number(checked.value);
    if (!Number.isFinite(v)) return null;
    return v;
  }

  function saveAnswer(optionIndex) {
    const q = questions[idx];
    answers[idx] = { qid: q.id, optionIndex: optionIndex };
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function loadQuestions() {
    if (!chatId) throw new Error('Нет chatId');
    const resp = await fetchWithTimeout('/api/questions?chatId=' + encodeURIComponent(chatId), { method: 'GET' }, 12000);
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('Ошибка загрузки вопросов: ' + resp.status + ' ' + t);
    }
    const data = await resp.json();
    token = data.token;
    questions = data.questions || [];
    if (!token || !questions.length) throw new Error('Пустой набор вопросов');
  }

  async function submit() {
    stopTimer();
    // ensure current question stored (if user clicked submit)
    if (!answers[idx]) saveAnswer(getSelectedOptionIndex());

    // normalize: fill missing as null
    for (let i = 0; i < questions.length; i++) {
      if (!answers[i]) answers[i] = { qid: questions[i].id, optionIndex: null };
      if (answers[i].optionIndex === undefined) answers[i].optionIndex = null;
    }

    btnNext.disabled = true;
    btnSubmit.disabled = true;

    try {
      const resp = await fetchWithTimeout('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chatId, token: token, answers: answers })
      }, 12000);

      const data = await resp.json().catch(() => ({}));
      hide(screenExam);
      show(screenResult);

      if (!resp.ok || !data.ok) {
        const msg = data && data.error ? data.error : 'Не удалось отправить ответы';
        resultBox.innerHTML = '<div class="danger"><b>Ошибка:</b> ' + escapeHtml(msg) + '</div>';
        return;
      }

      const status = data.passed ? '<span class="ok"><b>СДАЛ</b></span>' : '<span class="danger"><b>НЕ СДАЛ</b></span>';
      resultBox.innerHTML =
        '<div>Статус: ' + status + '</div>' +
        '<div>Счет: <b>' + data.score + '/' + data.total + '</b></div>' +
        '<div class="muted">Дата: <span class="mono">' + escapeHtml(data.time || '') + '</span></div>';
    } catch (e) {
      hide(screenExam);
      show(screenResult);
      resultBox.innerHTML = '<div class="danger"><b>Ошибка:</b> ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  btnAgree.addEventListener('click', async () => {
    btnAgree.disabled = true;
    try {
      // Quick status check (optional)
      const st = await fetchWithTimeout('/api/status?chatId=' + encodeURIComponent(chatId), { method: 'GET' }, 8000);
      if (!st.ok) throw new Error('Не удалось проверить статус');

      await loadQuestions();
      answers = [];
      idx = 0;

      hide(screenRules);
      show(screenExam);
      renderQuestion();
    } catch (e) {
      btnAgree.disabled = false;
      alert('Ошибка: ' + (e.message || e));
    }
  });

  btnNext.addEventListener('click', () => {
    // save current selected
    saveAnswer(getSelectedOptionIndex());
    stopTimer();
    if (idx < questions.length - 1) {
      idx += 1;
      renderQuestion();
    }
  });

  btnSubmit.addEventListener('click', () => {
    saveAnswer(getSelectedOptionIndex());
    submit();
  });
})();
</script>
</body>
</html>`;
}

// =========================
// Routes
// =========================
app.get('/exam', async (req, res) => {
  // Just returns HTML. Rules screen is inside HTML.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(examHtml());
});

app.get('/api/status', async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '');
    if (!isValidChatId(chatId)) return res.status(400).json({ ok: false, error: 'Invalid chatId' });

    const user = await storage.getUser(chatId);
    const flags = await storage.getFlags(chatId);
    const last = await storage.getLastResult(chatId);

    res.json({
      ok: true,
      registered: !!user,
      canTakeExam: !!flags.canTakeExam,
      hasResult: !!last,
      lastResult: last
        ? {
            ts: last.ts,
            time: fmtDate(last.ts),
            score: last.score,
            total: last.total,
            passed: last.passed,
            attemptId: last.attemptId,
          }
        : null,
    });
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] /api/status error`, e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/questions', async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '');
    if (!isValidChatId(chatId)) return res.status(400).json({ ok: false, error: 'Invalid chatId' });

    const user = await storage.getUser(chatId);
    if (!user) return res.status(403).json({ ok: false, error: 'Not registered' });

    const flags = await storage.getFlags(chatId);
    if (!flags.canTakeExam) {
      return res.status(403).json({ ok: false, error: 'Exam is not allowed. Open exam from bot and accept rules.' });
    }

    // Prepare questions:
    // - shuffle questions
    // - shuffle options
    // - do NOT expose correctOptionIndex
    const qOrder = shuffle(QUESTIONS).slice(0, 15);
    const prepared = [];
    const sessionQuestions = [];

    for (const q of qOrder) {
      const optWithIndex = q.options.map((txt, i) => ({ txt, originalIndex: i }));
      const shuffledOpts = shuffle(optWithIndex);
      const options = shuffledOpts.map(x => x.txt);
      const correctIndexShuffled = shuffledOpts.findIndex(x => x.originalIndex === q.correctIndex);

      prepared.push({ id: q.id, text: q.text, options });
      sessionQuestions.push({ qid: q.id, correctIndexShuffled, topic: q.topic });
    }

    const token = storage.createSession(chatId, { questions: sessionQuestions });

    // Notify admins about start
    try {
      await sendToAdmins(buildAdminStartMessage(user, chatId));
    } catch (_) {}

    res.json({ ok: true, token, questions: prepared });
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] /api/questions error`, e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const { chatId, token, answers } = req.body || {};
    const chatIdStr = String(chatId || '');
    const tokenStr = String(token || '');

    if (!isValidChatId(chatIdStr)) return res.status(400).json({ ok: false, error: 'Invalid chatId' });
    if (!tokenStr || tokenStr.length < 20) return res.status(400).json({ ok: false, error: 'Invalid token' });
    if (!Array.isArray(answers)) return res.status(400).json({ ok: false, error: 'Invalid answers' });

    const session = storage.getSession(tokenStr);
    if (!session) return res.status(403).json({ ok: false, error: 'Session expired or invalid' });
    if (session.submitted) return res.status(409).json({ ok: false, error: 'Already submitted' });
    if (String(session.chatId) !== chatIdStr) return res.status(403).json({ ok: false, error: 'Token mismatch' });

    // Build answer map
    const ansMap = new Map();
    for (const a of answers) {
      if (!a || typeof a.qid !== 'string') continue;
      const opt = (a.optionIndex === null || a.optionIndex === undefined) ? null : Number(a.optionIndex);
      ansMap.set(a.qid, Number.isFinite(opt) ? opt : null);
    }

    let score = 0;
    const total = session.questions.length;

    const byTopic = {};
    for (const sq of session.questions) {
      const chosen = ansMap.has(sq.qid) ? ansMap.get(sq.qid) : null;
      const isCorrect = (chosen !== null && chosen === sq.correctIndexShuffled);

      if (!byTopic[sq.topic]) byTopic[sq.topic] = { correct: 0, wrong: 0, total: 0 };
      byTopic[sq.topic].total += 1;

      if (isCorrect) {
        score += 1;
        byTopic[sq.topic].correct += 1;
      } else {
        byTopic[sq.topic].wrong += 1;
      }
    }

    const passed = score >= PASS_SCORE;
    const attemptId = crypto.randomBytes(8).toString('hex');
    const ts = nowTs();

    // determine weak topics list
    const weakTopics = Object.entries(byTopic)
      .map(([k, v]) => ({ topicId: Number(k), ...v }))
      .filter(x => x.total > 0)
      .sort((a, b) => (b.wrong / b.total) - (a.wrong / a.total))
      .filter(x => x.wrong > 0)
      .map(x => ({ topicId: x.topicId, name: TOPICS[x.topicId] || String(x.topicId) }))
      .slice(0, 3);

    const result = {
      chatId: chatIdStr,
      ts,
      score,
      total,
      passed,
      byTopic,
      weakTopics,
      attemptId,
    };

    // Persist last result
    await storage.setLastResult(chatIdStr, result);

    // After submit: lock exam; retry only by admin
    await storage.setCanTakeExam(chatIdStr, false);
    await storage.setCanRetry(chatIdStr, false);

    // Mark session submitted
    storage.markSessionSubmitted(tokenStr);

    // Candidate notifications
    const user = await storage.getUser(chatIdStr);

    if (passed) {
      const msg =
        '🍬🍬🍬\n' +
        'Поздравляем! Вы успешно сдали экзамен. Скоро с вами свяжется наш менеджер.';
      try {
        await bot.sendMessage(chatIdStr, msg, { parse_mode: 'HTML' });
      } catch (_) {}
    } else {
      const recs = buildFailRecommendations(byTopic);
      const recText =
        '❌ <b>Экзамен не сдан</b>\n\n' +
        'Ничего страшного — это нормальная ситуация. Вот что лучше подтянуть:\n' +
        recs.map((r, i) => `${i + 1}) ${escapeHtml(r)}`).join('\n') +
        '\n\n' +
        'Пересдача будет доступна после разрешения администратора.';
      try {
        await bot.sendMessage(chatIdStr, recText, { parse_mode: 'HTML' });
      } catch (_) {}
    }

    // Admin finish notify
    try {
      await sendToAdmins(buildAdminFinishMessage(user, chatIdStr, result));
    } catch (_) {}

    // response to WebApp
    res.json({ ok: true, passed, score, total, time: fmtDate(ts) });
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] /api/submit error`, e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// =========================
// Start server
// =========================
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[${fmtDate(nowTs())}] server listening on ${PORT} | APP_URL=${APP_URL}`);
});
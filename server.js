/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { bot, db, fmtDate, isAdmin, ADMIN_IDS } = require('./bot.js');

const app = express();
const PORT = process.env.PORT || 3000;
const PASS_SCORE = parseInt(process.env.PASS_SCORE || '13');

app.use(express.json());

// Questions Data
const QUESTIONS = [
  { id: 1, cat: 1, q: 'Что делать при попадании химии в глаза?', options: ['Промыть водой 15 мин и вызвать врача', 'Протереть сухой салфеткой', 'Ничего не делать', 'Закапать любые капли'], correct: 0 },
  { id: 2, cat: 1, q: 'Можно ли смешивать хлорсодержащие средства с аммиаком?', options: ['Да, это усилит эффект', 'Нет, выделяется ядовитый газ', 'Только в холодной воде', 'Да, если помещение проветривается'], correct: 1 },
  { id: 3, cat: 1, q: 'Какой pH у кислотных средств?', options: ['Больше 7', 'Ровно 7', 'Меньше 7', '14'], correct: 2 },
  { id: 4, cat: 1, q: 'Какое средство лучше всего удаляет известковый налет?', options: ['Щелочное', 'Кислотное', 'Нейтральное', 'Спиртовое'], correct: 1 },
  { id: 5, cat: 2, q: 'В каком порядке убирается комната?', options: ['Снизу вверх', 'Сверху вниз, от окна к двери', 'От двери к окну', 'Как удобно'], correct: 1 },
  { id: 6, cat: 3, q: 'Как очистить зеркало без разводов?', options: ['Газетой', 'Микрофибра для стекла + спиртовой очиститель', 'Влажной тряпкой', 'Мыльным раствором'], correct: 1 },
  { id: 7, cat: 2, q: 'С чего начинается уборка пола?', options: ['С влажной уборки', 'С сухой уборки (пылесос/веник)', 'С полировки', 'С нанесения воска'], correct: 1 },
  { id: 8, cat: 2, q: 'Что такое перекрестное загрязнение?', options: ['Перенос бактерий с грязной зоны в чистую', 'Смешивание двух видов химии', 'Уборка двух комнат одновременно', 'Использование одной тряпки для пыли'], correct: 0 },
  { id: 9, cat: 3, q: 'Какого цвета микрофибра обычно используется для унитазов?', options: ['Синяя', 'Зеленая', 'Желтая', 'Красная'], correct: 3 },
  { id: 10, cat: 3, q: 'Можно ли использовать меламиновую губку на глянцевых фасадах?', options: ['Да, она отлично чистит', 'Нет, она поцарапает поверхность', 'Только с водой', 'Только с химией'], correct: 1 },
  { id: 11, cat: 3, q: 'Лучший инструмент для удаления шерсти с ковра?', options: ['Обычный веник', 'Турбощетка или резиновая щетка', 'Влажная тряпка', 'Пылесос без насадок'], correct: 1 },
  { id: 12, cat: 3, q: 'Как удалить остатки скотча?', options: ['Водой', 'Маслом или специальным антискотчем', 'Металлической губкой', 'Ножом'], correct: 1 },
  { id: 13, cat: 1, q: 'Нужны ли перчатки при работе с профессиональной химией?', options: ['Нет, если кожа не чувствительная', 'Да, всегда', 'Только при работе с кислотой', 'Только при работе с хлором'], correct: 1 },
  { id: 14, cat: 2, q: 'Как правильно мыть пол шваброй?', options: ['Движениями вперед-назад', 'Движениями "восьмеркой"', 'Круговыми движениями', 'Только в одну сторону'], correct: 1 },
  { id: 15, cat: 1, q: 'Что означает "нейтральный pH"?', options: ['pH около 0', 'pH около 7', 'pH около 14', 'pH не существует'], correct: 1 }
];

const CATEGORIES = {
  1: 'Безопасность и химия',
  2: 'Технология уборки и порядок действий',
  3: 'Инвентарь, поверхности и лайфхаки'
};

// --- API ENDPOINTS ---

app.get('/', (req, res) => {
  res.send('<h1>Cleaning Exam Server 2.0 is Running</h1><p>WebApp is available in Telegram Bot.</p>');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, env: { bot: !!process.env.BOT_TOKEN, url: !!process.env.APP_URL } });
});

app.get('/api/status', (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: 'ID чата обязателен' });

  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
  if (!user) return res.json({ registered: false });

  const lastResult = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
  
  res.json({
    registered: true,
    fio: user.fio,
    canTakeExam: user.canRetry || !lastResult,
    hasResult: !!lastResult,
    lastResult: lastResult ? { score: lastResult.score, total: lastResult.total, status: lastResult.status, date: fmtDate(lastResult.finishedAt) } : null
  });
});

app.get('/api/questions', (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: 'ID чата обязателен' });

  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
  if (!user) return res.status(403).json({ error: 'Вы не зарегистрированы' });

  // Check for existing active session
  const existingSession = db.prepare('SELECT * FROM sessions WHERE chatId = ? AND submitted = 0').get(chatId);
  if (existingSession) {
    const orderMap = JSON.parse(existingSession.orderMap);
    return res.json({
      token: existingSession.token,
      currentIdx: existingSession.currentIdx,
      answers: JSON.parse(existingSession.answers),
      questions: orderMap.map((q, idx) => ({
        id: q.id,
        q: QUESTIONS.find(orig => orig.id === q.id).q,
        options: q.options.map(o => o.text),
        index: idx + 1,
        total: QUESTIONS.length
      }))
    });
  }

  const lastResult = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
  if (lastResult && !user.canRetry) return res.status(403).json({ error: 'Экзамен уже пройден' });

  // Create new session
  const token = crypto.randomBytes(16).toString('hex');
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  
  const orderMap = shuffled.map(q => ({
    id: q.id,
    options: q.options.map((opt, idx) => ({ text: opt, originalIdx: idx })).sort(() => Math.random() - 0.5)
  }));

  db.prepare('INSERT INTO sessions (token, chatId, createdAt, orderMap) VALUES (?, ?, ?, ?)').run(token, chatId, Date.now(), JSON.stringify(orderMap));

  // Notify Admins
  ADMIN_IDS.forEach(adminId => {
    bot.sendMessage(adminId, `🚀 **Экзамен начат!**\n\n👤 ${user.fio}\n📞 <code>${user.phone}</code>\n🆔 <code>${user.chatId}</code>\n🕒 ${fmtDate(Date.now())}`, { parse_mode: 'HTML' });
  });

  res.json({
    token,
    currentIdx: 0,
    answers: [],
    questions: orderMap.map((q, idx) => ({
      id: q.id,
      q: QUESTIONS.find(orig => orig.id === q.id).q,
      options: q.options.map(o => o.text),
      index: idx + 1,
      total: QUESTIONS.length
    }))
  });
});

app.post('/api/progress', (req, res) => {
  const { token, chatId, currentIdx, answers } = req.body;
  if (!token || !chatId) return res.status(400).json({ error: 'Отсутствуют данные' });

  db.prepare('UPDATE sessions SET currentIdx = ?, answers = ? WHERE token = ? AND chatId = ?').run(
    currentIdx,
    JSON.stringify(answers),
    token,
    chatId
  );
  res.json({ ok: true });
});

app.post('/api/submit', async (req, res) => {
  const { token, chatId, answers } = req.body;
  if (!token || !chatId || !answers) return res.status(400).json({ error: 'Отсутствуют данные' });

  const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND chatId = ?').get(token, chatId);
  if (!session || session.submitted) return res.status(403).json({ error: 'Недействительная или уже использованная сессия' });

  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
  const orderMap = JSON.parse(session.orderMap);
  
  let score = 0;
  const errorsByCat = { 1: 0, 2: 0, 3: 0 };
  const details = [];

  orderMap.forEach((qMap, idx) => {
    const origQ = QUESTIONS.find(q => q.id === qMap.id);
    const userAnswer = answers.find(a => a.id === qMap.id);
    
    let isCorrect = false;
    if (userAnswer && userAnswer.optionIndex !== null) {
      const selectedOption = qMap.options[userAnswer.optionIndex];
      if (selectedOption && selectedOption.originalIdx === origQ.correct) {
        isCorrect = true;
      }
    }

    if (isCorrect) {
      score++;
    } else {
      errorsByCat[origQ.cat]++;
    }
    details.push({ id: qMap.id, correct: isCorrect });
  });

  const status = score >= PASS_SCORE ? 'PASS' : 'FAIL';
  const finishedAt = Date.now();

  db.prepare('INSERT INTO results (chatId, score, total, status, finishedAt, details) VALUES (?, ?, ?, ?, ?, ?)').run(chatId, score, QUESTIONS.length, status, finishedAt, JSON.stringify(details));
  db.prepare('UPDATE sessions SET submitted = 1 WHERE token = ?').run(token);
  db.prepare('UPDATE users SET canRetry = 0 WHERE chatId = ?').run(chatId);

  // Recommendations
  let recommendations = [];
  if (status === 'FAIL') {
    const sortedCats = Object.entries(errorsByCat).sort((a, b) => b[1] - a[1]);
    sortedCats.forEach(([catId, count]) => {
      if (count > 0) recommendations.push(CATEGORIES[catId]);
    });
  }

  // Notify Candidate
  if (status === 'PASS') {
    bot.sendMessage(chatId, '🍬🍬🍬\n\n**Поздравляем!** Вы успешно сдали экзамен. Скоро с вами свяжется наш менеджер.', { parse_mode: 'Markdown' });
  } else {
    let recText = '😔 К сожалению, вы не набрали проходной балл.\n\n**Рекомендации:**\nВам стоит подтянуть следующие темы:\n';
    recommendations.slice(0, 2).forEach(r => recText += `• ${r}\n`);
    recText += '\nНе расстраивайтесь! Повторите материал и попросите администратора разрешить пересдачу.';
    bot.sendMessage(chatId, recText, { parse_mode: 'Markdown' });
  }

  // Notify Admins
  ADMIN_IDS.forEach(adminId => {
    bot.sendMessage(adminId, `🏁 **Экзамен завершен!**\n\n👤 ${user.fio}\n📞 <code>${user.phone}</code>\n🆔 <code>${user.chatId}</code>\n📊 Результат: **${score}/${QUESTIONS.length}**\nСтатус: ${status === 'PASS' ? '✅ СДАЛ' : '❌ НЕ СДАЛ'}\n🕒 ${fmtDate(finishedAt)}`, { parse_mode: 'HTML' });
  });

  res.json({ score, total: QUESTIONS.length, status, recommendations });
});

// --- WEBAPP HTML ---

app.get('/exam', (req, res) => {
  const { chatId } = req.query;
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Экзамен Клининг 2.0</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --bg-color: #020617;
            --card-bg: #0f172a;
            --card-border: rgba(255, 255, 255, 0.08);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-color: #38bdf8;
            --accent-glow: rgba(56, 189, 248, 0.4);
            --danger-color: #f43f5e;
            --success-color: #10b981;
            --font-main: 'Inter', -apple-system, sans-serif;
        }
        body {
            font-family: var(--font-main);
            background-color: var(--bg-color);
            color: var(--text-primary);
            margin: 0; padding: 0;
            display: flex; flex-direction: column; min-height: 100vh;
            box-sizing: border-box;
            overflow-x: hidden;
            -webkit-tap-highlight-color: transparent;
        }
        .container {
            max-width: 500px; margin: 0 auto; width: 100%;
            padding: 24px 20px; box-sizing: border-box;
            display: flex; flex-direction: column; flex: 1;
        }
        .screen { display: none; flex-direction: column; gap: 28px; animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
        .screen.active { display: flex; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        
        .header { text-align: center; margin-bottom: 8px; }
        h1 { font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -0.04em; background: linear-gradient(to bottom right, #fff, #94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        h2 { font-size: 20px; font-weight: 700; margin: 0; line-height: 1.4; color: #fff; }
        
        .card { 
            background: var(--card-bg); 
            padding: 28px; 
            border-radius: 24px; 
            border: 1px solid var(--card-border);
            box-shadow: 0 20px 40px -12px rgba(0,0,0,0.5);
            position: relative;
            overflow: hidden;
        }
        .card::before {
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
        }
        
        .rules-list { padding: 0; list-style: none; margin: 0; display: flex; flex-direction: column; gap: 16px; }
        .rules-list li { display: flex; align-items: flex-start; gap: 14px; font-size: 15px; color: var(--text-secondary); line-height: 1.5; }
        .rules-list li b { color: var(--text-primary); }
        .rules-list li .icon { flex-shrink: 0; width: 24px; height: 24px; background: rgba(56, 189, 248, 0.1); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--accent-color); font-size: 12px; }
        
        .btn {
            background: var(--accent-color);
            color: #020617;
            border: none; border-radius: 18px; padding: 20px;
            font-size: 17px; font-weight: 800; cursor: pointer;
            text-align: center; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 8px 20px -4px var(--accent-glow);
            text-transform: uppercase; letter-spacing: 0.02em;
        }
        .btn:active { transform: scale(0.96); filter: brightness(0.9); }
        .btn:disabled { background: #1e293b; color: #475569; box-shadow: none; cursor: not-allowed; }
        
        .timer-container { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 12px; }
        .timer-text { font-family: 'JetBrains Mono', monospace; font-size: 24px; font-weight: 800; color: var(--accent-color); line-height: 1; }
        .progress-text { font-size: 13px; color: var(--text-secondary); font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; }
        
        .timer-bar { height: 6px; background: #0f172a; border-radius: 10px; overflow: hidden; margin-bottom: 28px; border: 1px solid rgba(255,255,255,0.05); }
        .timer-fill { height: 100%; background: var(--accent-color); transition: width 1s linear; box-shadow: 0 0 15px var(--accent-glow); }
        
        .options { display: flex; flex-direction: column; gap: 14px; }
        .option {
            background: rgba(255,255,255,0.02); border: 1px solid var(--card-border);
            padding: 20px; border-radius: 20px; cursor: pointer;
            display: flex; align-items: center; gap: 16px;
            transition: all 0.2s ease;
        }
        .option:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.15); }
        .option.selected { border-color: var(--accent-color); background: rgba(56, 189, 248, 0.08); box-shadow: inset 0 0 0 1px var(--accent-color); }
        .option-circle { width: 22px; height: 22px; border: 2px solid #334155; border-radius: 50%; flex-shrink: 0; transition: all 0.2s ease; position: relative; }
        .option.selected .option-circle { border-color: var(--accent-color); }
        .option.selected .option-circle::after { content: ''; position: absolute; top: 4px; left: 4px; right: 4px; bottom: 4px; background: var(--accent-color); border-radius: 50%; box-shadow: 0 0 8px var(--accent-glow); }
        .option span { font-size: 16px; font-weight: 500; line-height: 1.4; }
        
        .result-icon { font-size: 96px; text-align: center; margin-bottom: 16px; filter: drop-shadow(0 0 20px rgba(255,255,255,0.1)); }
        .status-badge { display: inline-block; padding: 8px 20px; border-radius: 100px; font-size: 13px; font-weight: 800; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 0.05em; }
        .status-pass { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); }
        .status-fail { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.2); }
        
        .loading-overlay { position: fixed; inset: 0; background: var(--bg-color); z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; transition: opacity 0.5s ease; }
        .spinner { width: 40px; height: 40px; border: 3px solid rgba(56, 189, 248, 0.1); border-top-color: var(--accent-color); border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div id="loading" class="loading-overlay">
        <div class="spinner"></div>
        <div style="color: var(--text-secondary); font-size: 14px; font-weight: 500;">Загрузка системы...</div>
    </div>

    <div class="container">
        <div id="screen-rules" class="screen active">
            <div class="header">
                <h1>АТТЕСТАЦИЯ</h1>
                <div style="color: var(--text-secondary); font-size: 14px; font-weight: 600; letter-spacing: 0.2em; margin-top: 4px;">КЛИНИНГ 2.0</div>
            </div>
            <div class="card">
                <h2 style="margin-bottom: 20px;">⚡️ Регламент экзамена</h2>
                <ul class="rules-list">
                    <li><div class="icon">01</div><span><b>15 вопросов</b> охватывают химию, безопасность и технику уборки.</span></li>
                    <li><div class="icon">02</div><span><b>15 секунд</b> на каждый вопрос. Если не успели — ответ считается неверным.</span></li>
                    <li><div class="icon">03</div><span><b>${PASS_SCORE} баллов</b> — минимальный порог для успешного прохождения.</span></li>
                    <li><div class="icon">04</div><span><b>Автосохранение:</b> если приложение закроется, вы продолжите с того же места.</span></li>
                    <li><div class="icon">05</div><span><b>Одна попытка:</b> пересдача возможна только с разрешения администратора.</span></li>
                </ul>
            </div>
            <button class="btn" onclick="startExam()">Начать аттестацию</button>
        </div>

        <div id="screen-exam" class="screen">
            <div class="timer-container">
                <span class="timer-text" id="timer-text">00:15</span>
                <span class="progress-text" id="progress-text">ВОПРОС 01/15</span>
            </div>
            <div class="timer-bar"><div id="timer-fill" class="timer-fill" style="width: 100%"></div></div>
            <div class="card">
                <h2 id="question-text" style="min-height: 60px;">Загрузка вопроса...</h2>
                <div class="options" id="options-container" style="margin-top: 24px;"></div>
            </div>
            <button class="btn" id="next-btn" onclick="nextQuestion()" disabled>Подтвердить выбор</button>
        </div>

        <div id="screen-result" class="screen" style="text-align: center;">
            <div class="result-icon" id="result-icon"></div>
            <div id="status-badge-container"></div>
            <h1 id="result-title" style="color: #fff; margin-bottom: 12px; -webkit-text-fill-color: initial; background: none;"></h1>
            <div class="card" id="result-details" style="margin-bottom: 32px; color: var(--text-secondary); line-height: 1.6;"></div>
            <button class="btn" onclick="tg.close()">Вернуться в Telegram</button>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        tg.backgroundColor = "#020617";
        tg.headerColor = "#020617";
        
        // Hide loading screen after 1s
        setTimeout(() => {
            document.getElementById('loading').style.opacity = '0';
            setTimeout(() => document.getElementById('loading').style.display = 'none', 500);
        }, 1000);

        const chatId = "${chatId}" || (tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : null);
        let token = "";
        let questions = [];
        let currentIdx = 0;
        let answers = [];
        let timer = 15;
        let timerInterval;
        let selectedOption = null;

        async function startExam() {
            if (!chatId) {
                alert("Ошибка: не удалось определить ваш ID.");
                tg.close();
                return;
            }
            document.getElementById('screen-rules').classList.remove('active');
            document.getElementById('screen-exam').classList.add('active');
            
            try {
                const res = await fetch(\`/api/questions?chatId=\${chatId}\`);
                const data = await res.json();
                if (data.error) throw new Error(data.error);
                
                token = data.token;
                questions = data.questions;
                currentIdx = data.currentIdx || 0;
                answers = data.answers || [];
                
                showQuestion();
            } catch (e) {
                alert("Ошибка: " + e.message);
                tg.close();
            }
        }

        async function saveProgress() {
            try {
                await fetch('/api/progress', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, chatId, currentIdx, answers })
                });
            } catch (e) { console.error("Progress save failed", e); }
        }

        function showQuestion() {
            clearInterval(timerInterval);
            const q = questions[currentIdx];
            if (!q) return finishExam();

            document.getElementById('question-text').innerText = q.q;
            document.getElementById('progress-text').innerText = \`QUESTION \${String(currentIdx + 1).padStart(2, '0')}/\${questions.length}\`;
            
            const container = document.getElementById('options-container');
            container.innerHTML = "";
            selectedOption = null;
            document.getElementById('next-btn').disabled = true;

            q.options.forEach((opt, idx) => {
                const div = document.createElement('div');
                div.className = 'option';
                div.innerHTML = \`<div class="option-circle"></div><span>\${opt}</span>\`;
                div.onclick = () => selectOption(idx, div);
                container.appendChild(div);
            });

            startTimer();
        }

        function selectOption(idx, el) {
            selectedOption = idx;
            document.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
            el.classList.add('selected');
            document.getElementById('next-btn').disabled = false;
        }

        function startTimer() {
            timer = 15;
            updateTimerUI();
            timerInterval = setInterval(() => {
                timer--;
                updateTimerUI();
                if (timer <= 0) {
                    clearInterval(timerInterval);
                    nextQuestion(); // Auto-skip if time out
                }
            }, 1000);
        }

        function updateTimerUI() {
            document.getElementById('timer-text').innerText = \`00:\${String(timer).padStart(2, '0')}\`;
            document.getElementById('timer-fill').style.width = \`\${(timer / 15) * 100}%\`;
            if (timer <= 5) {
                document.getElementById('timer-text').style.color = 'var(--danger-color)';
                document.getElementById('timer-fill').style.background = 'var(--danger-color)';
            } else {
                document.getElementById('timer-text').style.color = 'var(--accent-color)';
                document.getElementById('timer-fill').style.background = 'var(--accent-color)';
            }
        }

        async function nextQuestion() {
            clearInterval(timerInterval);
            answers.push({ id: questions[currentIdx].id, optionIndex: selectedOption });
            currentIdx++;
            
            await saveProgress();

            if (currentIdx < questions.length) {
                showQuestion();
            } else {
                finishExam();
            }
        }

        async function finishExam() {
            document.getElementById('screen-exam').classList.remove('active');
            document.getElementById('screen-result').classList.add('active');
            document.getElementById('result-title').innerText = "ОБРАБОТКА...";
            
            try {
                const res = await fetch('/api/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, chatId, answers })
                });
                const data = await res.json();
                
                const isPass = data.status === 'PASS';
                document.getElementById('result-icon').innerText = isPass ? "🏆" : "🥀";
                document.getElementById('status-badge-container').innerHTML = \`<span class="status-badge \${isPass ? 'status-pass' : 'status-fail'}">\${isPass ? 'АТТЕСТАЦИЯ ПРОЙДЕНА' : 'АТТЕСТАЦИЯ НЕ ПРОЙДЕНА'}</span>\`;
                document.getElementById('result-title').innerText = isPass ? "ОТЛИЧНАЯ РАБОТА!" : "НУЖНО ПОВТОРИТЬ";
                document.getElementById('result-details').innerHTML = \`🎯 Ваш результат: <b>\${data.score} из \${data.total}</b><br><br>\${isPass ? 'Вы подтвердили свою квалификацию.' : 'К сожалению, баллов недостаточно для допуска.'}\`;
                
            } catch (e) {
                alert("Ошибка отправки: " + e.message);
            }
        }
    </script>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

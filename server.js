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
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

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
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
  if (!user) return res.status(403).json({ error: 'Not registered' });

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
  if (lastResult && !user.canRetry) return res.status(403).json({ error: 'Exam already taken' });

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
  if (!token || !chatId) return res.status(400).json({ error: 'Missing data' });

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
  if (!token || !chatId || !answers) return res.status(400).json({ error: 'Missing data' });

  const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND chatId = ?').get(token, chatId);
  if (!session || session.submitted) return res.status(403).json({ error: 'Invalid or used session' });

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
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-color: #38bdf8;
            --accent-glow: rgba(56, 189, 248, 0.3);
            --danger-color: #ef4444;
            --success-color: #22c55e;
        }
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-primary);
            margin: 0; padding: 0;
            display: flex; flex-direction: column; min-height: 100vh;
            box-sizing: border-box;
            overflow-x: hidden;
        }
        .container {
            max-width: 500px; margin: 0 auto; width: 100%;
            padding: 20px; box-sizing: border-box;
            display: flex; flex-direction: column; flex: 1;
        }
        .screen { display: none; flex-direction: column; gap: 24px; animation: fadeIn 0.3s ease; }
        .screen.active { display: flex; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        h1 { font-size: 28px; font-weight: 800; margin: 0; letter-spacing: -0.02em; color: var(--accent-color); }
        h2 { font-size: 20px; font-weight: 600; margin: 0; line-height: 1.4; }
        
        .card { 
            background: var(--card-bg); 
            padding: 24px; 
            border-radius: 20px; 
            border: 1px solid rgba(255,255,255,0.05);
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
        }
        
        .rules-list { padding: 0; list-style: none; margin: 0; display: flex; flex-direction: column; gap: 12px; }
        .rules-list li { display: flex; align-items: center; gap: 12px; font-size: 16px; color: var(--text-secondary); }
        .rules-list li::before { content: "⚡"; color: var(--accent-color); font-size: 14px; }
        
        .btn {
            background: var(--accent-color);
            color: #000;
            border: none; border-radius: 16px; padding: 18px;
            font-size: 17px; font-weight: 700; cursor: pointer;
            text-align: center; transition: all 0.2s ease;
            box-shadow: 0 4px 15px var(--accent-glow);
        }
        .btn:active { transform: scale(0.98); opacity: 0.9; }
        .btn:disabled { background: #334155; color: #64748b; box-shadow: none; cursor: not-allowed; }
        
        .timer-container { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .timer-text { font-family: monospace; font-size: 18px; font-weight: bold; color: var(--accent-color); }
        .progress-text { font-size: 14px; color: var(--text-secondary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
        
        .timer-bar { height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden; margin-bottom: 24px; border: 1px solid rgba(255,255,255,0.05); }
        .timer-fill { height: 100%; background: var(--accent-color); transition: width 1s linear; box-shadow: 0 0 10px var(--accent-glow); }
        
        .options { display: flex; flex-direction: column; gap: 12px; }
        .option {
            background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);
            padding: 18px; border-radius: 16px; cursor: pointer;
            display: flex; align-items: center; gap: 14px;
            transition: all 0.2s ease;
        }
        .option:hover { background: rgba(255,255,255,0.05); }
        .option.selected { border-color: var(--accent-color); background: rgba(56, 189, 248, 0.1); }
        .option-circle { width: 20px; height: 20px; border: 2px solid var(--text-secondary); border-radius: 50%; flex-shrink: 0; transition: all 0.2s ease; }
        .option.selected .option-circle { border-color: var(--accent-color); background: var(--accent-color); box-shadow: 0 0 8px var(--accent-glow); }
        
        .result-icon { font-size: 80px; text-align: center; margin-bottom: 10px; }
        .status-badge { display: inline-block; padding: 6px 16px; border-radius: 100px; font-size: 14px; font-weight: 700; margin-bottom: 16px; }
        .status-pass { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .status-fail { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    </style>
</head>
<body>
    <div class="container">
        <div id="screen-rules" class="screen active">
            <h1>CLEANING EXAM</h1>
            <div class="card">
                <h2 style="margin-bottom: 16px;">⚡️ Правила аттестации</h2>
                <ul class="rules-list">
                    <li><b>15 вопросов</b> по химии и технологиям</li>
                    <li><b>15 секунд</b> на каждый ответ</li>
                    <li><b>${PASS_SCORE} баллов</b> для успешной сдачи</li>
                    <li>Прогресс сохраняется автоматически</li>
                </ul>
            </div>
            <button class="btn" onclick="startExam()">ПРИСТУПИТЬ К ТЕСТУ</button>
        </div>

        <div id="screen-exam" class="screen">
            <div class="timer-container">
                <span class="timer-text" id="timer-text">00:15</span>
                <span class="progress-text" id="progress-text">QUESTION 01/15</span>
            </div>
            <div class="timer-bar"><div id="timer-fill" class="timer-fill" style="width: 100%"></div></div>
            <div class="card">
                <h2 id="question-text">Загрузка данных...</h2>
                <div class="options" id="options-container"></div>
            </div>
            <button class="btn" id="next-btn" onclick="nextQuestion()" disabled>ПОДТВЕРДИТЬ ОТВЕТ</button>
        </div>

        <div id="screen-result" class="screen" style="text-align: center;">
            <div class="result-icon" id="result-icon"></div>
            <div id="status-badge-container"></div>
            <h1 id="result-title" style="color: #fff; margin-bottom: 8px;"></h1>
            <div class="card" id="result-details" style="margin-bottom: 24px; color: var(--text-secondary);"></div>
            <button class="btn" onclick="tg.close()">ВЕРНУТЬСЯ В БОТ</button>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        tg.backgroundColor = "#0f172a";
        tg.headerColor = "#0f172a";
        
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

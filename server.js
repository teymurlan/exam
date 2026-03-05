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

  const lastResult = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
  if (lastResult && !user.canRetry) return res.status(403).json({ error: 'Exam already taken' });

  // Create session
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
    questions: orderMap.map((q, idx) => ({
      id: q.id,
      q: QUESTIONS.find(orig => orig.id === q.id).q,
      options: q.options.map(o => o.text),
      index: idx + 1,
      total: QUESTIONS.length
    }))
  });
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
            --tg-theme-bg-color: #fff;
            --tg-theme-text-color: #000;
            --tg-theme-button-color: #3390ec;
            --tg-theme-button-text-color: #fff;
            --tg-theme-secondary-bg-color: #f4f4f5;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--tg-theme-bg-color);
            color: var(--tg-theme-text-color);
            margin: 0; padding: 20px;
            display: flex; flex-direction: column; min-height: 100vh;
            box-sizing: border-box;
        }
        .screen { display: none; flex-direction: column; gap: 20px; }
        .screen.active { display: flex; }
        h1 { font-size: 22px; margin: 0; }
        .card { background: var(--tg-theme-secondary-bg-color); padding: 20px; border-radius: 12px; }
        .rules-list { padding-left: 20px; line-height: 1.6; }
        .btn {
            background-color: var(--tg-theme-button-color);
            color: var(--tg-theme-button-text-color);
            border: none; border-radius: 10px; padding: 15px;
            font-size: 16px; font-weight: 600; cursor: pointer;
            text-align: center;
        }
        .btn:disabled { opacity: 0.5; }
        .timer-container { display: flex; align-items: center; justify-content: space-between; font-weight: bold; }
        .timer-bar { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin-top: 5px; }
        .timer-fill { height: 100%; background: var(--tg-theme-button-color); transition: width 1s linear; }
        .options { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
        .option {
            background: var(--tg-theme-bg-color); border: 1px solid #ddd;
            padding: 15px; border-radius: 10px; cursor: pointer;
            display: flex; align-items: center; gap: 10px;
        }
        .option.selected { border-color: var(--tg-theme-button-color); background: #eef6ff; }
        .progress { font-size: 14px; opacity: 0.6; }
        .result-icon { font-size: 64px; text-align: center; }
    </style>
</head>
<body>
    <div id="screen-rules" class="screen active">
        <h1>📜 Правила экзамена</h1>
        <div class="card">
            <ul class="rules-list">
                <li>Всего <b>15 вопросов</b>.</li>
                <li>На каждый вопрос — <b>15 секунд</b>.</li>
                <li>Не успели — ответ не засчитан.</li>
                <li>Проходной балл — <b>${PASS_SCORE}</b>.</li>
            </ul>
        </div>
        <button class="btn" onclick="startExam()">✅ Я согласен начать</button>
    </div>

    <div id="screen-exam" class="screen">
        <div class="timer-container">
            <span id="timer-text">Осталось: 15с</span>
            <span class="progress" id="progress-text">Вопрос 1/15</span>
        </div>
        <div class="timer-bar"><div id="timer-fill" class="timer-fill" style="width: 100%"></div></div>
        <div class="card">
            <h2 id="question-text" style="margin: 0; font-size: 18px;">Загрузка...</h2>
            <div class="options" id="options-container"></div>
        </div>
        <button class="btn" id="next-btn" onclick="nextQuestion()" disabled>Далее</button>
    </div>

    <div id="screen-result" class="screen">
        <div class="result-icon" id="result-icon"></div>
        <h1 id="result-title" style="text-align: center;"></h1>
        <div class="card" id="result-details" style="text-align: center;"></div>
        <button class="btn" onclick="tg.close()">Закрыть</button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        const chatId = "${chatId}";
        let token = "";
        let questions = [];
        let currentIdx = 0;
        let answers = [];
        let timer = 15;
        let timerInterval;
        let selectedOption = null;

        async function startExam() {
            document.getElementById('screen-rules').classList.remove('active');
            document.getElementById('screen-exam').classList.add('active');
            
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                const res = await fetch(\`/api/questions?chatId=\${chatId}\`, { signal: controller.signal });
                clearTimeout(timeoutId);
                const data = await res.json();
                if (data.error) throw new Error(data.error);
                token = data.token;
                questions = data.questions;
                showQuestion();
            } catch (e) {
                alert("Ошибка загрузки: " + (e.name === 'AbortError' ? 'Таймаут' : e.message));
                tg.close();
            }
        }

        function showQuestion() {
            const q = questions[currentIdx];
            document.getElementById('question-text').innerText = q.q;
            document.getElementById('progress-text').innerText = \`Вопрос \${currentIdx + 1}/\${questions.length}\`;
            
            const container = document.getElementById('options-container');
            container.innerHTML = "";
            selectedOption = null;
            document.getElementById('next-btn').disabled = true;
            document.getElementById('next-btn').innerText = currentIdx === questions.length - 1 ? "Завершить" : "Далее";

            q.options.forEach((opt, idx) => {
                const div = document.createElement('div');
                div.className = "option";
                div.innerText = opt;
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
            clearInterval(timerInterval);
            timer = 15;
            updateTimerUI();
            timerInterval = setInterval(() => {
                timer--;
                updateTimerUI();
                if (timer <= 0) {
                    clearInterval(timerInterval);
                    autoNext();
                }
            }, 1000);
        }

        function updateTimerUI() {
            document.getElementById('timer-text').innerText = \`Осталось: \${timer}с\`;
            document.getElementById('timer-fill').style.width = \`\${(timer / 15) * 100}%\`;
        }

        function autoNext() {
            answers.push({ id: questions[currentIdx].id, optionIndex: selectedOption });
            currentIdx++;
            if (currentIdx < questions.length) {
                showQuestion();
            } else {
                submitExam();
            }
        }

        function nextQuestion() {
            clearInterval(timerInterval);
            autoNext();
        }

        async function submitExam() {
            document.getElementById('screen-exam').classList.remove('active');
            tg.MainButton.showProgress();
            
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                const res = await fetch('/api/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, chatId, answers }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                const data = await res.json();
                showResult(data);
            } catch (e) {
                alert("Ошибка при отправке: " + (e.name === 'AbortError' ? 'Таймаут' : e.message));
            } finally {
                tg.MainButton.hideProgress();
            }
        }

        function showResult(data) {
            document.getElementById('screen-result').classList.add('active');
            const isPass = data.status === 'PASS';
            document.getElementById('result-icon').innerText = isPass ? "✅" : "❌";
            document.getElementById('result-title').innerText = isPass ? "Экзамен сдан!" : "Экзамен не сдан";
            document.getElementById('result-details').innerHTML = \`
                <p style="font-size: 24px; font-weight: bold;">\${data.score} / \${data.total}</p>
                <p>\${isPass ? "Поздравляем! Вы отлично справились." : "К сожалению, этого недостаточно."}</p>
            \`;
        }
    </script>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// bot.js (CommonJS)
// Telegram Exam Bot 2.0 (polling) + shared in-process storage for server.js
// Tech: node-telegram-bot-api, crypto
//
// IMPORTANT:
// - Railway Free without Volume: persistence is NOT guaranteed across restarts.
// - We keep runtime data in memory + (optional) try sqlite3 if available.
// - Admin notifications are the primary "audit log" (as per requirement).

const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

// =========================
// ENV
// =========================
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isFinite(n));
const PASS_SCORE = Number(process.env.PASS_SCORE || 13);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TZ = process.env.TZ || 'Europe/Moscow';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}
if (!APP_URL) {
  throw new Error('APP_URL is required (e.g. https://<railway-domain>.up.railway.app)');
}

// =========================
// Helpers
// =========================
function isAdmin(chatId) {
  return ADMIN_IDS.includes(Number(chatId));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Strict format: DD.MM.YYYY HH:mm in Europe/Moscow
function fmtDate(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

function nowTs() {
  return Date.now();
}

function normPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // allow +, digits, spaces, dashes, parentheses
  const cleaned = s.replace(/[^\d+]/g, '');
  // must contain at least 10 digits
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // if multiple pluses or plus not at start -> normalize
  const plus = cleaned.startsWith('+') ? '+' : '';
  return plus + digits;
}

function shortId() {
  return crypto.randomBytes(6).toString('hex');
}

// =========================
// Questions (15) with topics
// Topics:
// 1) Safety & chemistry
// 2) Cleaning tech & order
// 3) Inventory/surfaces/lifehacks
// =========================
const TOPICS = {
  1: 'Безопасность и химия',
  2: 'Технология уборки и порядок действий',
  3: 'Инвентарь/поверхности/лайфхаки',
};

const QUESTIONS = [
  {
    id: 'q1',
    topic: 1,
    text: 'Что нужно сделать в первую очередь перед использованием нового чистящего средства?',
    options: [
      'Смешать с другим средством для усиления эффекта',
      'Проверить инструкцию и протестировать на незаметном участке',
      'Нанести сразу на всю поверхность',
      'Разогреть средство в микроволновке',
    ],
    correctIndex: 1,
  },
  {
    id: 'q2',
    topic: 1,
    text: 'Почему нельзя смешивать хлорсодержащие средства с кислотными?',
    options: [
      'Появляется неприятный запах, но безопасно',
      'Ускоряется уборка',
      'Может выделяться токсичный газ (хлор/хлорамин) и это опасно',
      'Смесь становится слишком жидкой',
    ],
    correctIndex: 2,
  },
  {
    id: 'q3',
    topic: 1,
    text: 'Какие средства защиты чаще всего обязательны при работе с сильной химией?',
    options: [
      'Только кепка',
      'Перчатки и при необходимости маска/очки',
      'Никакие, если быстро',
      'Только бахилы',
    ],
    correctIndex: 1,
  },
  {
    id: 'q4',
    topic: 1,
    text: 'Как правильно хранить химию на объекте клиента во время уборки?',
    options: [
      'В открытом виде на столе рядом с едой',
      'В недоступном месте для детей/животных, закрытой и подписанной',
      'В ванной на полу, чтобы было удобнее',
      'Перелить в бутылку без маркировки',
    ],
    correctIndex: 1,
  },
  {
    id: 'q5',
    topic: 2,
    text: 'Правильная логика движения по комнате при уборке (общий принцип):',
    options: [
      'Снизу вверх, чтобы пыль поднималась',
      'Сверху вниз и от дальнего угла к выходу',
      'Сначала пол, потом пыль',
      'Не имеет значения',
    ],
    correctIndex: 1,
  },
  {
    id: 'q6',
    topic: 2,
    text: 'Что лучше сделать перед влажной уборкой пола?',
    options: [
      'Сразу мыть мокрой тряпкой по пыли',
      'Сначала сухая уборка (пылесос/подметание), затем влажная',
      'Налить больше воды, чтобы “само отмокло”',
      'Только ароматизатор распылить',
    ],
    correctIndex: 1,
  },
  {
    id: 'q7',
    topic: 2,
    text: 'Какой порядок уборки санузла наиболее корректный?',
    options: [
      'Унитаз в конце, чтобы не разносить загрязнения',
      'Сначала пол, потом сантехника',
      'Сначала зеркала, потом грязные зоны',
      'Сначала все протереть одной тряпкой',
    ],
    correctIndex: 0,
  },
  {
    id: 'q8',
    topic: 2,
    text: 'Если на поверхности пятно неизвестного происхождения, лучше:',
    options: [
      'Сразу тереть абразивом',
      'Использовать самый сильный растворитель',
      'Начать с щадящего метода и теста на незаметном участке',
      'Соскоблить ножом',
    ],
    correctIndex: 2,
  },
  {
    id: 'q9',
    topic: 2,
    text: 'Почему важно соблюдать время экспозиции (выдержки) средства?',
    options: [
      'Это просто маркетинг',
      'Чтобы средство успело подействовать и снизить усилия/риски повреждения',
      'Чтобы быстрее высохло',
      'Чтобы пахло сильнее',
    ],
    correctIndex: 1,
  },
  {
    id: 'q10',
    topic: 3,
    text: 'Как правильно использовать микрофибру для разных зон?',
    options: [
      'Одной микрофиброй весь объект',
      'Разделять по зонам/цветам (кухня/санузел/комната) и менять по мере загрязнения',
      'Стирать раз в месяц',
      'Использовать только бумажные полотенца',
    ],
    correctIndex: 1,
  },
  {
    id: 'q11',
    topic: 3,
    text: 'Какая насадка пылесоса/щётка чаще подходит для мягкой мебели?',
    options: [
      'Жёсткая металлическая щётка',
      'Турбо-щётка/насадка для мебели (при наличии) или мягкая щётка',
      'Насадка для плитки',
      'Без насадок, просто трубой',
    ],
    correctIndex: 1,
  },
  {
    id: 'q12',
    topic: 3,
    text: 'На каких поверхностях абразивные губки особенно рискованны?',
    options: [
      'На деликатных: глянец, акрил, нержавейка, стеклокерамика',
      'Только на бетоне',
      'Только на кафеле',
      'На любых — они безопасны',
    ],
    correctIndex: 0,
  },
  {
    id: 'q13',
    topic: 1,
    text: 'Что делать при попадании химии на кожу?',
    options: [
      'Стереть сухой салфеткой и продолжать',
      'Смыть большим количеством воды, при необходимости обратиться за помощью',
      'Налить сверху другое средство',
      'Потереть спиртом',
    ],
    correctIndex: 1,
  },
  {
    id: 'q14',
    topic: 2,
    text: 'Как корректно убирать кухонные поверхности после использования обезжиривателя?',
    options: [
      'Оставить как есть, чтобы “дольше работало”',
      'Тщательно удалить остатки средства и при необходимости промыть/протереть чистой водой',
      'Смешать с хлоркой для блеска',
      'Посыпать содой поверх',
    ],
    correctIndex: 1,
  },
  {
    id: 'q15',
    topic: 3,
    text: 'Какой лайфхак помогает снизить разводы на стекле/зеркалах?',
    options: [
      'Мыть горячей водой и не вытирать',
      'Использовать чистую сухую микрофибру/склиз и не переливать средство',
      'Тереть абразивом до скрипа',
      'Добавить масло в воду',
    ],
    correctIndex: 1,
  },
];

// =========================
// Storage Layer (in-process)
// Try sqlite3 if available, otherwise in-memory JSON.
// NOTE: Without Railway Volume, file persistence may reset.
// =========================
function createStorage() {
  // In-memory baseline
  const mem = {
    users: new Map(),        // chatId -> { chatId, fullName, phone, createdAt }
    results: new Map(),      // chatId -> { chatId, ts, score, total, passed, byTopic: {topicId:{correct,wrong,total}}, weakTopics:[...], attemptId }
    retryFlags: new Map(),   // chatId -> boolean (canRetry)
    canTakeExam: new Map(),  // chatId -> boolean (allowed to take now)
    sessions: new Map(),     // token -> { chatId, createdAt, expiresAt, submitted, questions:[{qid, correctIndexShuffled, topic}], used }
  };

  let sqlite = null;
  let sqliteMode = 'memory';

  // Attempt sqlite3 (optional)
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const sqlite3 = require('sqlite3').verbose();
    // We can use a file DB; without volume it may reset, but it will work during runtime.
    const dbFile = process.env.SQLITE_FILE || 'data.sqlite';
    sqlite = new sqlite3.Database(dbFile);
    sqliteMode = dbFile;

    sqlite.serialize(() => {
      sqlite.run(`
        CREATE TABLE IF NOT EXISTS users (
          chatId TEXT PRIMARY KEY,
          fullName TEXT NOT NULL,
          phone TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        )
      `);
      sqlite.run(`
        CREATE TABLE IF NOT EXISTS results (
          chatId TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          score INTEGER NOT NULL,
          total INTEGER NOT NULL,
          passed INTEGER NOT NULL,
          byTopicJson TEXT NOT NULL,
          weakTopicsJson TEXT NOT NULL,
          attemptId TEXT NOT NULL
        )
      `);
      sqlite.run(`
        CREATE TABLE IF NOT EXISTS flags (
          chatId TEXT PRIMARY KEY,
          canRetry INTEGER NOT NULL,
          canTakeExam INTEGER NOT NULL
        )
      `);
    });
    console.log(`[storage] sqlite3 enabled: ${sqliteMode}`);
  } catch (e) {
    console.log('[storage] sqlite3 not available, using in-memory JSON only');
  }

  function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      sqlite.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }
  function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      sqlite.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }
  function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      sqlite.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  const storage = {
    meta: {
      sqliteEnabled: Boolean(sqlite),
      sqliteMode,
    },

    // Users
    async getUser(chatId) {
      const key = String(chatId);
      if (sqlite) {
        const row = await dbGet('SELECT chatId, fullName, phone, createdAt FROM users WHERE chatId=?', [key]);
        if (!row) return null;
        return { chatId: row.chatId, fullName: row.fullName, phone: row.phone, createdAt: row.createdAt };
      }
      return mem.users.get(key) || null;
    },

    async upsertUser(user) {
      const key = String(user.chatId);
      const val = { ...user, chatId: key };
      if (sqlite) {
        await dbRun(
          `INSERT INTO users (chatId, fullName, phone, createdAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chatId) DO UPDATE SET fullName=excluded.fullName, phone=excluded.phone`,
          [val.chatId, val.fullName, val.phone, val.createdAt]
        );
        // also ensure flags row exists
        const existing = await dbGet('SELECT chatId FROM flags WHERE chatId=?', [key]);
        if (!existing) {
          await dbRun('INSERT INTO flags (chatId, canRetry, canTakeExam) VALUES (?, ?, ?)', [key, 0, 0]);
        }
      } else {
        mem.users.set(key, val);
        if (!mem.retryFlags.has(key)) mem.retryFlags.set(key, false);
        if (!mem.canTakeExam.has(key)) mem.canTakeExam.set(key, false);
      }
      return val;
    },

    // Flags
    async getFlags(chatId) {
      const key = String(chatId);
      if (sqlite) {
        const row = await dbGet('SELECT chatId, canRetry, canTakeExam FROM flags WHERE chatId=?', [key]);
        if (!row) return { canRetry: false, canTakeExam: false };
        return { canRetry: !!row.canRetry, canTakeExam: !!row.canTakeExam };
      }
      return {
        canRetry: !!mem.retryFlags.get(key),
        canTakeExam: !!mem.canTakeExam.get(key),
      };
    },

    async setCanRetry(chatId, val) {
      const key = String(chatId);
      if (sqlite) {
        const exists = await dbGet('SELECT chatId FROM flags WHERE chatId=?', [key]);
        if (exists) {
          await dbRun('UPDATE flags SET canRetry=? WHERE chatId=?', [val ? 1 : 0, key]);
        } else {
          await dbRun('INSERT INTO flags (chatId, canRetry, canTakeExam) VALUES (?, ?, ?)', [key, val ? 1 : 0, 0]);
        }
      } else {
        mem.retryFlags.set(key, !!val);
      }
    },

    async setCanTakeExam(chatId, val) {
      const key = String(chatId);
      if (sqlite) {
        const exists = await dbGet('SELECT chatId FROM flags WHERE chatId=?', [key]);
        if (exists) {
          await dbRun('UPDATE flags SET canTakeExam=? WHERE chatId=?', [val ? 1 : 0, key]);
        } else {
          await dbRun('INSERT INTO flags (chatId, canRetry, canTakeExam) VALUES (?, ?, ?)', [key, 0, val ? 1 : 0]);
        }
      } else {
        mem.canTakeExam.set(key, !!val);
      }
    },

    // Results
    async getLastResult(chatId) {
      const key = String(chatId);
      if (sqlite) {
        const row = await dbGet(
          'SELECT chatId, ts, score, total, passed, byTopicJson, weakTopicsJson, attemptId FROM results WHERE chatId=?',
          [key]
        );
        if (!row) return null;
        return {
          chatId: row.chatId,
          ts: row.ts,
          score: row.score,
          total: row.total,
          passed: !!row.passed,
          byTopic: JSON.parse(row.byTopicJson),
          weakTopics: JSON.parse(row.weakTopicsJson),
          attemptId: row.attemptId,
        };
      }
      return mem.results.get(key) || null;
    },

    async setLastResult(chatId, result) {
      const key = String(chatId);
      const val = { ...result, chatId: key };
      if (sqlite) {
        await dbRun(
          `INSERT INTO results (chatId, ts, score, total, passed, byTopicJson, weakTopicsJson, attemptId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chatId) DO UPDATE SET
             ts=excluded.ts,
             score=excluded.score,
             total=excluded.total,
             passed=excluded.passed,
             byTopicJson=excluded.byTopicJson,
             weakTopicsJson=excluded.weakTopicsJson,
             attemptId=excluded.attemptId
          `,
          [
            key,
            val.ts,
            val.score,
            val.total,
            val.passed ? 1 : 0,
            JSON.stringify(val.byTopic || {}),
            JSON.stringify(val.weakTopics || []),
            val.attemptId || '',
          ]
        );
      } else {
        mem.results.set(key, val);
      }
      return val;
    },

    async getLastResults(limit = 10) {
      if (sqlite) {
        const rows = await dbAll(
          'SELECT chatId, ts, score, total, passed, byTopicJson, weakTopicsJson, attemptId FROM results ORDER BY ts DESC LIMIT ?',
          [limit]
        );
        return rows.map(r => ({
          chatId: r.chatId,
          ts: r.ts,
          score: r.score,
          total: r.total,
          passed: !!r.passed,
          byTopic: JSON.parse(r.byTopicJson),
          weakTopics: JSON.parse(r.weakTopicsJson),
          attemptId: r.attemptId,
        }));
      }
      // in-memory: sort by ts desc
      const all = Array.from(mem.results.values());
      all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return all.slice(0, limit);
    },

    // Sessions (always in-memory; TTL)
    createSession(chatId, payload) {
      const token = crypto.randomBytes(24).toString('hex');
      const createdAt = nowTs();
      const expiresAt = createdAt + 60 * 60 * 1000; // 1h
      mem.sessions.set(token, {
        token,
        chatId: String(chatId),
        createdAt,
        expiresAt,
        submitted: false,
        ...payload,
      });
      return token;
    },

    getSession(token) {
      if (!token) return null;
      const s = mem.sessions.get(String(token)) || null;
      if (!s) return null;
      if (nowTs() > s.expiresAt) {
        mem.sessions.delete(String(token));
        return null;
      }
      return s;
    },

    markSessionSubmitted(token) {
      const s = mem.sessions.get(String(token));
      if (s) s.submitted = true;
    },

    // Delete candidate (profile + result + flags)
    async resetCandidate(chatId) {
      const key = String(chatId);
      if (sqlite) {
        await dbRun('DELETE FROM users WHERE chatId=?', [key]);
        await dbRun('DELETE FROM results WHERE chatId=?', [key]);
        await dbRun('DELETE FROM flags WHERE chatId=?', [key]);
      }
      mem.users.delete(key);
      mem.results.delete(key);
      mem.retryFlags.delete(key);
      mem.canTakeExam.delete(key);

      // also invalidate sessions for that chatId
      for (const [t, s] of mem.sessions.entries()) {
        if (String(s.chatId) === key) mem.sessions.delete(t);
      }
    },
  };

  return storage;
}

const storage = createStorage();

// =========================
// Telegram bot
// =========================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
  // Small tweak: reduce chances of long polling issues
  request: { timeout: 30000 },
});

bot.setMyCommands([
  { command: 'start', description: 'Запуск / меню' },
  { command: 'admin', description: 'Админ панель (только для админов)' },
]);

async function sendToAdmins(text) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      console.error(`[${fmtDate(nowTs())}] admin notify failed -> ${adminId}`, e?.message || e);
    }
  }
}

function mainMenuInline(chatId) {
  const rows = [
    [{ text: '📝 Начать экзамен', callback_data: 'menu_start_exam' }],
    [{ text: '📊 Мой результат', callback_data: 'menu_my_result' }],
    [{ text: 'ℹ️ Правила', callback_data: 'menu_rules' }],
  ];
  if (isAdmin(chatId)) {
    rows.push([{ text: '⚙️ Админ панель', callback_data: 'menu_admin' }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function adminMenuInline() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Последние результаты (10)', callback_data: 'admin_last10' }],
        [{ text: '👤 Найти кандидата', callback_data: 'admin_find' }],
        [{ text: '🔄 Разрешить пересдачу', callback_data: 'admin_allow_retry' }],
        [{ text: '🧹 Сбросить кандидата', callback_data: 'admin_reset' }],
        [{ text: '⬅️ Меню', callback_data: 'admin_back' }],
      ],
    },
  };
}

function rulesText() {
  return (
    '📌 <b>Правила экзамена</b>\n' +
    '1) Экзамен состоит из 15 вопросов.\n' +
    '2) На каждый вопрос даётся <b>15 секунд</b>.\n' +
    '3) Если время истекло — ответ считается неверным и вы переходите дальше.\n' +
    '4) Не обновляйте страницу во время экзамена.\n' +
    '5) Результат фиксируется после отправки.\n'
  );
}

function buildCandidateCard(user, whenTs) {
  const fullName = escapeHtml(user?.fullName || '—');
  const phone = escapeHtml(user?.phone || '—');
  const chatId = escapeHtml(String(user?.chatId || '—'));
  const dt = escapeHtml(fmtDate(whenTs));
  return (
    `👤 <b>${fullName}</b>\n` +
    `📞 <code>${phone}</code>\n` +
    `🆔 <code>${chatId}</code>\n` +
    `🕒 ${dt}\n`
  );
}

// =========================
// Simple state machine for input modes (no spam, no reacting to random text)
// =========================
const userState = new Map(); // chatId -> { mode, tmp, createdAt }

function setState(chatId, mode, tmp = {}) {
  userState.set(String(chatId), { mode, tmp, createdAt: nowTs() });
}
function getState(chatId) {
  return userState.get(String(chatId)) || null;
}
function clearState(chatId) {
  userState.delete(String(chatId));
}

// =========================
// Bot flows
// =========================
async function showMenu(chatId, text = 'Выберите действие:') {
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...mainMenuInline(chatId) });
}

async function startRegistration(chatId) {
  setState(chatId, 'reg_fullname', {});
  await bot.sendMessage(
    chatId,
    '👋 Добро пожаловать!\n\nЧтобы начать, нужно пройти регистрацию (1 раз).\n\nВведите <b>ФИО</b>:',
    { parse_mode: 'HTML' }
  );
}

async function showRulesAndAskConsent(chatId) {
  // allow take exam only after explicit consent (button)
  await storage.setCanTakeExam(chatId, false);

  await bot.sendMessage(chatId, rulesText(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Я согласен начать', callback_data: 'exam_consent_yes' }],
        [{ text: '⬅️ Меню', callback_data: 'exam_consent_back' }],
      ],
    },
  });
}

async function sendWebAppStart(chatId) {
  const url = `${APP_URL}/exam?chatId=${encodeURIComponent(String(chatId))}`;
  await bot.sendMessage(
    chatId,
    '✅ Отлично. Нажмите кнопку ниже, чтобы открыть экзамен:',
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Открыть экзамен', web_app: { url } }],
          [{ text: '⬅️ Меню', callback_data: 'exam_open_back' }],
        ],
      },
    }
  );
}

// =========================
// Handlers
// =========================
bot.onText(/^\/start$/i, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await storage.getUser(chatId);
    if (!user) return await startRegistration(chatId);
    return await showMenu(chatId, '🏠 Меню:');
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] /start error`, e);
    await bot.sendMessage(chatId, 'Ошибка. Попробуйте позже.');
  }
});

bot.onText(/^\/admin$/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  try {
    await bot.sendMessage(chatId, '⚙️ <b>Админ панель</b>', { parse_mode: 'HTML', ...adminMenuInline() });
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] /admin error`, e);
  }
});

bot.on('callback_query', async (cq) => {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || '';
  if (!chatId) return;

  // Always answer callback to avoid "loading"
  try { await bot.answerCallbackQuery(cq.id); } catch (_) {}

  try {
    const user = await storage.getUser(chatId);
    const flags = await storage.getFlags(chatId);

    // MENU
    if (data === 'menu_start_exam') {
      if (!user) return await startRegistration(chatId);
      // If failed and has no retry flag, block start
      const last = await storage.getLastResult(chatId);
      if (last && !last.passed) {
        if (!flags.canRetry) {
          return await bot.sendMessage(
            chatId,
            '⛔️ Сейчас пересдача недоступна.\n\nЕсли нужно — дождитесь разрешения администратора.',
            { parse_mode: 'HTML', ...mainMenuInline(chatId) }
          );
        }
      }
      return await showRulesAndAskConsent(chatId);
    }

    if (data === 'menu_my_result') {
      if (!user) return await startRegistration(chatId);
      const last = await storage.getLastResult(chatId);
      if (!last) {
        return await bot.sendMessage(chatId, 'Пока нет результатов. Нажмите «📝 Начать экзамен».', {
          parse_mode: 'HTML',
          ...mainMenuInline(chatId),
        });
      }
      const status = last.passed ? '✅ СДАЛ' : '❌ НЕ СДАЛ';
      let text =
        `📊 <b>Ваш результат</b>\n` +
        `Статус: <b>${status}</b>\n` +
        `Счет: <b>${last.score}/${last.total}</b>\n` +
        `Дата: <b>${escapeHtml(fmtDate(last.ts))}</b>\n`;

      if (!last.passed) {
        const f = await storage.getFlags(chatId);
        text += '\n';
        if (f.canRetry) {
          text += '✅ Пересдача разрешена администратором — можете начать снова.\n';
        } else {
          text += '⏳ Пересдача возможна после разрешения администратора.\n';
        }
      }

      return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...mainMenuInline(chatId) });
    }

    if (data === 'menu_rules') {
      return await bot.sendMessage(chatId, rulesText(), { parse_mode: 'HTML', ...mainMenuInline(chatId) });
    }

    if (data === 'menu_admin') {
      if (!isAdmin(chatId)) return;
      clearState(chatId);
      return await bot.sendMessage(chatId, '⚙️ <b>Админ панель</b>', { parse_mode: 'HTML', ...adminMenuInline() });
    }

    // Exam consent flow
    if (data === 'exam_consent_yes') {
      if (!user) return await startRegistration(chatId);

      // Determine if can take now
      const last = await storage.getLastResult(chatId);
      if (last && !last.passed) {
        if (!flags.canRetry) {
          return await bot.sendMessage(
            chatId,
            '⛔️ Пересдача недоступна. Дождитесь разрешения администратора.',
            { parse_mode: 'HTML', ...mainMenuInline(chatId) }
          );
        }
      }

      await storage.setCanTakeExam(chatId, true);
      // If this is a retry, consume canRetry immediately (so link can't be abused repeatedly)
      if (flags.canRetry) await storage.setCanRetry(chatId, false);

      return await sendWebAppStart(chatId);
    }
    if (data === 'exam_consent_back' || data === 'exam_open_back') {
      return await showMenu(chatId, '🏠 Меню:');
    }

    // Admin panel actions
    if (data === 'admin_back') {
      clearState(chatId);
      return await showMenu(chatId, '🏠 Меню:');
    }

    if (data === 'admin_last10') {
      if (!isAdmin(chatId)) return;
      const rows = await storage.getLastResults(10);
      if (!rows.length) {
        return await bot.sendMessage(chatId, 'Пока нет результатов.', { parse_mode: 'HTML', ...adminMenuInline() });
      }
      let out = '📊 <b>Последние результаты</b>\n\n';
      for (const r of rows) {
        const u = await storage.getUser(r.chatId);
        const status = r.passed ? '✅ СДАЛ' : '❌ НЕ СДАЛ';
        out +=
          `${status} | <b>${escapeHtml(u?.fullName || '—')}</b>\n` +
          `📞 <code>${escapeHtml(u?.phone || '—')}</code>\n` +
          `🆔 <code>${escapeHtml(String(r.chatId))}</code>\n` +
          `🕒 ${escapeHtml(fmtDate(r.ts))}\n` +
          `Счет: <b>${r.score}/${r.total}</b>\n\n`;
      }
      return await bot.sendMessage(chatId, out, { parse_mode: 'HTML', ...adminMenuInline() });
    }

    if (data === 'admin_find') {
      if (!isAdmin(chatId)) return;
      setState(chatId, 'admin_find_query', {});
      return await bot.sendMessage(
        chatId,
        '👤 Введите <b>chatId</b> или <b>телефон</b> (можно с +):',
        { parse_mode: 'HTML', ...adminMenuInline() }
      );
    }

    if (data === 'admin_allow_retry') {
      if (!isAdmin(chatId)) return;
      setState(chatId, 'admin_allow_retry_chatid', {});
      return await bot.sendMessage(chatId, '🔄 Введите <b>chatId</b>, кому разрешить пересдачу:', {
        parse_mode: 'HTML',
        ...adminMenuInline(),
      });
    }

    if (data === 'admin_reset') {
      if (!isAdmin(chatId)) return;
      setState(chatId, 'admin_reset_chatid', {});
      return await bot.sendMessage(chatId, '🧹 Введите <b>chatId</b>, кого сбросить (удалить профиль/результаты):', {
        parse_mode: 'HTML',
        ...adminMenuInline(),
      });
    }

    // Reset confirm
    if (data.startsWith('admin_reset_confirm:')) {
      if (!isAdmin(chatId)) return;
      const [, targetChatId, confirmId] = data.split(':');
      if (!targetChatId || !confirmId) return;

      // minimal anti-misclick: confirmId must match last stored state
      const st = getState(chatId);
      if (!st || st.mode !== 'admin_reset_confirm' || st.tmp.confirmId !== confirmId) {
        return await bot.sendMessage(chatId, 'Подтверждение устарело. Откройте сброс заново.', {
          parse_mode: 'HTML',
          ...adminMenuInline(),
        });
      }

      await storage.resetCandidate(targetChatId);
      clearState(chatId);

      return await bot.sendMessage(chatId, `✅ Сброс выполнен для 🆔 <code>${escapeHtml(String(targetChatId))}</code>`, {
        parse_mode: 'HTML',
        ...adminMenuInline(),
      });
    }

    if (data.startsWith('admin_reset_cancel:')) {
      if (!isAdmin(chatId)) return;
      clearState(chatId);
      return await bot.sendMessage(chatId, 'Отменено.', { parse_mode: 'HTML', ...adminMenuInline() });
    }
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] callback error`, e);
    try {
      await bot.sendMessage(chatId, 'Ошибка. Попробуйте позже.', { ...mainMenuInline(chatId) });
    } catch (_) {}
  }
});

// Text/contact handler (registration/admin input modes only)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // ignore service messages
  if (msg.new_chat_members || msg.left_chat_member) return;

  // Commands handled elsewhere
  if (msg.text && msg.text.startsWith('/')) return;

  const st = getState(chatId);
  if (!st) {
    // Do not treat any random text as commands (stability requirement)
    return;
  }

  try {
    // REGISTRATION: full name
    if (st.mode === 'reg_fullname') {
      const fullName = String(msg.text || '').trim();
      if (fullName.length < 3) {
        return await bot.sendMessage(chatId, 'Введите корректное ФИО (минимум 3 символа).');
      }
      st.tmp.fullName = fullName;
      setState(chatId, 'reg_phone', st.tmp);

      // request_contact reply keyboard (one-time)
      return await bot.sendMessage(
        chatId,
        '📞 Отправьте <b>номер телефона</b>:\n— нажмите кнопку “📲 Отправить контакт”\n— или введите номер текстом',
        {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [[{ text: '📲 Отправить контакт', request_contact: true }], [{ text: 'Отмена' }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    }

    // REGISTRATION: phone
    if (st.mode === 'reg_phone') {
      if (msg.text && String(msg.text).trim().toLowerCase() === 'отмена') {
        clearState(chatId);
        return await showMenu(chatId, 'Ок, вернулись в меню.');
      }

      let phone = null;
      if (msg.contact && msg.contact.phone_number) phone = normPhone(msg.contact.phone_number);
      if (!phone && msg.text) phone = normPhone(msg.text);

      if (!phone) {
        return await bot.sendMessage(chatId, 'Не похоже на телефон. Пример: +79991234567');
      }

      const user = {
        chatId: String(chatId),
        fullName: st.tmp.fullName,
        phone,
        createdAt: nowTs(),
      };
      await storage.upsertUser(user);
      await storage.setCanRetry(chatId, false);
      await storage.setCanTakeExam(chatId, false);

      clearState(chatId);

      // remove reply keyboard
      await bot.sendMessage(chatId, '✅ Вы зарегистрированы.', {
        reply_markup: { remove_keyboard: true },
      });
      return await showMenu(chatId, '🏠 Меню:');
    }

    // ADMIN: find query
    if (st.mode === 'admin_find_query') {
      if (!isAdmin(chatId)) return clearState(chatId);
      const q = String(msg.text || '').trim();
      if (!q) return;

      let targetUser = null;
      let targetChatId = null;

      // if numeric -> chatId
      if (/^\d{5,}$/.test(q)) {
        targetChatId = q;
        targetUser = await storage.getUser(targetChatId);
      } else {
        // by phone: scan users (sqlite or mem)
        // We only have direct access to getUser, so do a simple approach:
        // - If sqlite enabled: query by phone
        // - If mem: iterate
        const phoneQ = normPhone(q) || q.replace(/[^\d+]/g, '');
        if (storage.meta.sqliteEnabled) {
          // direct sqlite query not exposed; do minimal: fallback scan results list + users
          // We'll scan last results + if not found we inform.
        }

        // Try: scan last 50 results users (practical)
        const recent = await storage.getLastResults(50);
        for (const r of recent) {
          const u = await storage.getUser(r.chatId);
          if (u && u.phone && (u.phone === phoneQ || u.phone.endsWith(phoneQ.replace(/\D/g, '')))) {
            targetUser = u;
            targetChatId = u.chatId;
            break;
          }
        }
      }

      if (!targetUser) {
        return await bot.sendMessage(chatId, 'Не найдено. Проверьте chatId/телефон.\n\nПодсказка: по телефону ищем среди недавних результатов.', {
          parse_mode: 'HTML',
          ...adminMenuInline(),
        });
      }

      const last = await storage.getLastResult(targetUser.chatId);
      const flags = await storage.getFlags(targetUser.chatId);

      let out = '👤 <b>Кандидат</b>\n\n';
      out += buildCandidateCard(targetUser, nowTs());
      out += `🔄 canRetry: <b>${flags.canRetry ? 'true' : 'false'}</b>\n`;
      out += `📝 canTakeExam: <b>${flags.canTakeExam ? 'true' : 'false'}</b>\n`;
      out += '\n';

      if (last) {
        out += `📊 Последний результат: <b>${last.score}/${last.total}</b> — <b>${last.passed ? 'СДАЛ' : 'НЕ СДАЛ'}</b>\n`;
        out += `🕒 ${escapeHtml(fmtDate(last.ts))}\n`;
        out += `attemptId: <code>${escapeHtml(last.attemptId || '—')}</code>\n`;
      } else {
        out += '📊 Результатов пока нет.\n';
      }

      clearState(chatId);
      return await bot.sendMessage(chatId, out, { parse_mode: 'HTML', ...adminMenuInline() });
    }

    // ADMIN: allow retry
    if (st.mode === 'admin_allow_retry_chatid') {
      if (!isAdmin(chatId)) return clearState(chatId);
      const targetChatId = String(msg.text || '').trim();
      if (!/^\d{5,}$/.test(targetChatId)) {
        return await bot.sendMessage(chatId, 'Введите корректный chatId (только цифры).', { ...adminMenuInline() });
      }
      const u = await storage.getUser(targetChatId);
      if (!u) {
        return await bot.sendMessage(chatId, 'Профиль не найден. Сначала кандидат должен зарегистрироваться.', {
          parse_mode: 'HTML',
          ...adminMenuInline(),
        });
      }
      await storage.setCanRetry(targetChatId, true);
      await storage.setCanTakeExam(targetChatId, false);

      clearState(chatId);

      await bot.sendMessage(chatId, `✅ Разрешена пересдача для 🆔 <code>${escapeHtml(targetChatId)}</code>`, {
        parse_mode: 'HTML',
        ...adminMenuInline(),
      });

      // notify candidate
      try {
        await bot.sendMessage(
          targetChatId,
          '✅ Администратор разрешил пересдачу.\n\nТеперь вы можете нажать «📝 Начать экзамен».',
          { parse_mode: 'HTML', ...mainMenuInline(targetChatId) }
        );
      } catch (_) {}
      return;
    }

    // ADMIN: reset candidate
    if (st.mode === 'admin_reset_chatid') {
      if (!isAdmin(chatId)) return clearState(chatId);
      const targetChatId = String(msg.text || '').trim();
      if (!/^\d{5,}$/.test(targetChatId)) {
        return await bot.sendMessage(chatId, 'Введите корректный chatId (только цифры).', { ...adminMenuInline() });
      }
      const u = await storage.getUser(targetChatId);
      if (!u) {
        return await bot.sendMessage(chatId, 'Профиль не найден.', { parse_mode: 'HTML', ...adminMenuInline() });
      }

      const confirmId = shortId();
      setState(chatId, 'admin_reset_confirm', { targetChatId, confirmId });

      const text =
        '⚠️ <b>Подтвердите сброс кандидата</b>\n\n' +
        buildCandidateCard(u, nowTs()) +
        '\n<b>Это удалит профиль, результаты и флаги.</b>';

      return await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да, сбросить', callback_data: `admin_reset_confirm:${targetChatId}:${confirmId}` }],
            [{ text: '❌ Отмена', callback_data: `admin_reset_cancel:${confirmId}` }],
          ],
        },
      });
    }
  } catch (e) {
    console.error(`[${fmtDate(nowTs())}] message handler error`, e);
    try {
      await bot.sendMessage(chatId, 'Ошибка. Попробуйте позже.');
    } catch (_) {}
  }
});

// Log polling errors
bot.on('polling_error', (err) => {
  console.error(`[${fmtDate(nowTs())}] polling_error`, err?.message || err);
});

// =========================
// Exports for server.js
// =========================
module.exports = {
  bot,
  storage,
  fmtDate,
  isAdmin,
  sendToAdmins,
  QUESTIONS,
  TOPICS,
  PASS_SCORE,
  APP_URL,
  ADMIN_IDS,
  CORS_ORIGIN,
  TZ,
};
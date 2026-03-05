/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const crypto = require('crypto');

dayjs.extend(utc);
dayjs.extend(timezone);

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
let APP_URL = (process.env.APP_URL || '').trim();
if (APP_URL.endsWith('/')) APP_URL = APP_URL.slice(0, -1);

const TZ = process.env.TZ || 'Europe/Moscow';

if (!TOKEN) {
  console.error('BOT_TOKEN is missing in ENV');
  process.exit(1);
}

if (!APP_URL) {
  console.warn('⚠️ APP_URL is missing in ENV. WebApp features may not work correctly.');
}

// Database setup
const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chatId TEXT PRIMARY KEY,
    fio TEXT,
    phone TEXT,
    registeredAt INTEGER,
    canRetry INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId TEXT,
    score INTEGER,
    total INTEGER,
    status TEXT,
    finishedAt INTEGER,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    chatId TEXT,
    createdAt INTEGER,
    submitted INTEGER DEFAULT 0,
    orderMap TEXT,
    currentIdx INTEGER DEFAULT 0,
    answers TEXT DEFAULT '[]'
  );
`);

// Disable polling in AI Studio environment to avoid 409 Conflict with Railway
const isAIStudio = process.env.APP_URL && (process.env.APP_URL.includes('ais-dev') || process.env.APP_URL.includes('ais-pre'));
const shouldPoll = isAIStudio ? false : (process.env.DISABLE_POLLING !== 'true');

const bot = new TelegramBot(TOKEN, { polling: shouldPoll });

if (isAIStudio) {
  console.log('ℹ️ AI Studio detected: Polling DISABLED to prevent conflict with your Railway bot.');
} else if (!shouldPoll) {
  console.log('⚠️ Polling DISABLED via environment variable.');
}

// Helper: Format Date
function fmtDate(ts) {
  if (!ts) return '—';
  return dayjs(ts).tz(TZ).format('DD.MM.YYYY HH:mm');
}

// Helper: Check if Admin
function isAdmin(chatId) {
  return ADMIN_IDS.includes(String(chatId));
}

// States for registration
const userStates = new Map();

// Bot Commands
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  console.log(`[DEBUG] /start received from ${chatId}`);
  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);

  if (!user) {
    bot.sendMessage(chatId, '👋 **Добро пожаловать!**\n\nДля начала работы необходимо зарегистрироваться.\n\nВведите ваше **ФИО**:');
    userStates.set(chatId, { step: 'fio' });
  } else {
    showMainMenu(chatId);
  }
});

bot.onText(/\/menu/, (msg) => showMainMenu(String(msg.chat.id)));

bot.onText(/\/profile/, async (msg) => {
  const chatId = String(msg.chat.id);
  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
  if (!user) return bot.sendMessage(chatId, '❌ Сначала зарегистрируйтесь: /start');
  
  const bestResult = db.prepare('SELECT MAX(score) as maxScore FROM results WHERE chatId = ?').get(chatId);
  const totalAttempts = db.prepare('SELECT COUNT(*) as count FROM results WHERE chatId = ?').get(chatId);
  
  const profileText = `👤 **ВАШ ПРОФИЛЬ**\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📝 ФИО: **${user.fio}**\n` +
    `📞 Тел: \`${user.phone}\`\n` +
    `🏆 Лучший результат: **${bestResult.maxScore || 0} / 15**\n` +
    `🔄 Попыток сделано: **${totalAttempts.count}**\n` +
    `📅 Регистрация: ${fmtDate(user.createdAt)}\n` +
    `━━━━━━━━━━━━━━━━━━`;
  
  await bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown' });
});

bot.onText(/\/top/, async (msg) => {
  const chatId = String(msg.chat.id);
  const top = db.prepare(`
    SELECT u.fio, MAX(r.score) as bestScore 
    FROM results r 
    JOIN users u ON r.chatId = u.chatId 
    WHERE r.status = 'PASS'
    GROUP BY r.chatId 
    ORDER BY bestScore DESC 
    LIMIT 10
  `).all();
  
  if (top.length === 0) {
    await bot.sendMessage(chatId, '🏆 **ТАБЛИЦА ЛИДЕРОВ**\n\nПока никто не сдал экзамен.');
  } else {
    let text = `🏆 **ТОП-10 ЛУЧШИХ**\n` +
      `━━━━━━━━━━━━━━━━━━\n`;
    top.forEach((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '👤';
      text += `${medal} **${r.fio}** — ${r.bestScore}/15\n`;
    });
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `📖 **СПРАВКА ПО БОТУ**\n\n` +
    `🔹 **/start** — Главное меню\n` +
    `🔹 **/menu** — Быстрый вызов меню\n` +
    `🔹 **/profile** — Личный профиль\n` +
    `🔹 **/top** — Таблица лидеров\n` +
    `🔹 **/debug** — Тех. информация\n\n` +
    `**Как пройти экзамен?**\n` +
    `Нажмите "📝 Начать экзамен" и следуйте инструкциям. Если вы закроете приложение, ваш прогресс сохранится!`;
  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/debug/, async (msg) => {
  const chatId = String(msg.chat.id);
  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
  const resultsCount = db.prepare('SELECT COUNT(*) as count FROM results WHERE chatId = ?').get(chatId);
  
  let debugInfo = `🛠 **Техническая информация:**\n\n`;
  debugInfo += `🆔 ID чата: <code>${chatId}</code>\n`;
  debugInfo += `👤 Пользователь: ${user ? user.fio : 'Не найден'}\n`;
  debugInfo += `📞 Телефон: ${user ? user.phone : 'Н/A'}\n`;
  debugInfo += `📊 Кол-во результатов: ${resultsCount.count}\n`;
  debugInfo += `🔄 Можно пересдать: ${user ? (user.canRetry ? 'Да' : 'Нет') : 'Н/A'}\n`;
  debugInfo += `🌐 URL приложения: <code>${APP_URL}</code>\n`;
  
  await bot.sendMessage(chatId, debugInfo, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `📖 **Справка по боту Cleaning Exam 2.0**\n\n` +
    `🔹 **/start** — Регистрация и главное меню\n` +
    `🔹 **/debug** — Техническая информация о профиле\n` +
    `🔹 **/admin** — Панель управления (только для админов)\n\n` +
    `**Как пройти экзамен?**\n` +
    `1. Нажмите "📝 Начать экзамен".\n` +
    `2. Прочитайте правила и подтвердите участие.\n` +
    `3. Ответьте на 15 вопросов (по 15 сек на каждый).\n` +
    `4. Получите результат мгновенно!`;
  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/admin/, (msg) => {
  if (isAdmin(msg.chat.id)) {
    showAdminPanel(msg.chat.id);
  } else {
    bot.sendMessage(msg.chat.id, '⛔️ У вас нет прав доступа к админ-панели.');
  }
});

// Handling messages (Registration & Admin Input)
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = msg.text;

  if (text && text.startsWith('/')) return;

  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 'fio') {
    state.fio = text;
    state.step = 'phone';
    bot.sendMessage(chatId, `Приятно познакомиться, ${text}!\n\nТеперь отправьте ваш номер телефона (нажмите кнопку ниже или введите вручную):`, {
      reply_markup: {
        keyboard: [[{ text: '📱 Отправить контакт', request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  } else if (state.step === 'phone') {
    let phone = '';
    if (msg.contact) {
      phone = msg.contact.phone_number;
    } else if (text) {
      phone = text;
    }

    if (phone) {
      db.prepare('INSERT INTO users (chatId, fio, phone, registeredAt) VALUES (?, ?, ?, ?)').run(chatId, state.fio, phone, Date.now());
      userStates.delete(chatId);
      bot.sendMessage(chatId, '✅ Регистрация успешно завершена!', { reply_markup: { remove_keyboard: true } });
      showMainMenu(chatId);
    }
  } else if (state.step === 'admin_retry') {
    const targetChatId = text.trim();
    const target = db.prepare('SELECT * FROM users WHERE chatId = ?').get(targetChatId);
    if (target) {
      db.prepare('UPDATE users SET canRetry = 1 WHERE chatId = ?').run(targetChatId);
      bot.sendMessage(chatId, `✅ Пересдача разрешена для <code>${targetChatId}</code> (${target.fio})`, { parse_mode: 'HTML' });
      bot.sendMessage(targetChatId, '🔄 Администратор разрешил вам пройти экзамен повторно. Теперь вы можете нажать "Начать экзамен" в меню.');
    } else {
      bot.sendMessage(chatId, '❌ Кандидат с таким ID не найден.');
    }
    userStates.delete(chatId);
    showAdminPanel(chatId);
  } else if (state.step === 'admin_find') {
    const query = text.trim();
    const results = db.prepare('SELECT * FROM users WHERE chatId = ? OR phone LIKE ?').all(query, `%${query}%`);
    if (results.length > 0) {
      let msgText = '🔍 **Результаты поиска:**\n\n';
      results.forEach(u => {
        msgText += `👤 ${u.fio}\n📞 <code>${u.phone}</code>\n🆔 <code>${u.chatId}</code>\n\n`;
      });
      bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, '❌ Ничего не найдено.');
    }
    userStates.delete(chatId);
    showAdminPanel(chatId);
  }
});

// Error handling for polling
bot.on('polling_error', (error) => {
  console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
});

// Inline Buttons Handling
bot.on('callback_query', async (query) => {
  const chatId = String(query.from.id);
  const data = query.data;
  
  console.log(`[DEBUG] Callback: ${data} from ${chatId} (${query.from.first_name})`);

  try {
    // 1. Start Exam Flow
    if (data === 'start_exam_rules') {
      const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
      if (!user) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Профиль не найден', show_alert: true });
        await bot.sendMessage(chatId, '❌ Ошибка: профиль не найден. Попробуйте /start');
        return;
      }

      const lastResult = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
      
      if (lastResult && lastResult.status === 'PASS' && !user.canRetry) {
        await bot.answerCallbackQuery(query.id, { text: '✅ Экзамен уже сдан!', show_alert: true });
        return;
      }
      
      if (lastResult && lastResult.status === 'FAIL' && !user.canRetry) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Пересдача пока недоступна', show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: '⏳ Подготовка вопросов...' });

      const rules = `📝 **ПОДГОТОВКА К ЭКЗАМЕНУ**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `• Вопросов: **15**\n` +
        `• Время: **15 сек/вопрос**\n` +
        `• Проходной балл: **${process.env.PASS_SCORE || 13}**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Нажимая кнопку ниже, вы подтверждаете готовность.`;

      const webAppUrl = `${APP_URL}/exam?chatId=${chatId}`;
      await bot.sendMessage(chatId, rules, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 НАЧАТЬ ЭКЗАМЕН', web_app: { url: webAppUrl } }]]
        }
      });
    } 
    
    // 2. User Info & Leaderboard
    else if (data === 'my_profile') {
      await bot.answerCallbackQuery(query.id);
      const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
      const bestResult = db.prepare('SELECT MAX(score) as maxScore FROM results WHERE chatId = ?').get(chatId);
      const totalAttempts = db.prepare('SELECT COUNT(*) as count FROM results WHERE chatId = ?').get(chatId);
      
      const profileText = `👤 **ВАШ ПРОФИЛЬ**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📝 ФИО: **${user.fio}**\n` +
        `📞 Тел: \`${user.phone}\`\n` +
        `🏆 Лучший результат: **${bestResult.maxScore || 0} / 15**\n` +
        `🔄 Попыток сделано: **${totalAttempts.count}**\n` +
        `📅 Регистрация: ${fmtDate(user.createdAt)}\n` +
        `━━━━━━━━━━━━━━━━━━`;
      
      await bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown' });
    }
    
    else if (data === 'leaderboard') {
      await bot.answerCallbackQuery(query.id, { text: '📊 Загрузка рейтинга...' });
      const top = db.prepare(`
        SELECT u.fio, MAX(r.score) as bestScore, r.finishedAt 
        FROM results r 
        JOIN users u ON r.chatId = u.chatId 
        WHERE r.status = 'PASS'
        GROUP BY r.chatId 
        ORDER BY bestScore DESC, r.finishedAt ASC 
        LIMIT 10
      `).all();
      
      if (top.length === 0) {
        await bot.sendMessage(chatId, '🏆 **ТАБЛИЦА ЛИДЕРОВ**\n\nПока никто не сдал экзамен. Будьте первым!');
      } else {
        let text = `🏆 **ТОП-10 ЛУЧШИХ РЕЗУЛЬТАТОВ**\n` +
          `━━━━━━━━━━━━━━━━━━\n`;
        top.forEach((r, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '👤';
          text += `${medal} **${r.fio}** — ${r.bestScore}/15\n`;
        });
        text += `━━━━━━━━━━━━━━━━━━\n_Показаны только те, кто сдал экзамен_`;
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      }
    }
    
    else if (data === 'my_result') {
      await bot.answerCallbackQuery(query.id);
      const result = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
      if (result) {
        const text = `📊 **ПОСЛЕДНИЙ РЕЗУЛЬТАТ**\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🎯 Баллы: **${result.score} / ${result.total}**\n` +
          `📢 Статус: ${result.status === 'PASS' ? '✅ СДАНО' : '❌ НЕ СДАНО'}\n` +
          `📅 Дата: ${fmtDate(result.finishedAt)}\n` +
          `━━━━━━━━━━━━━━━━━━`;
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, 'ℹ️ У вас еще нет завершенных экзаменов.');
      }
    }
    
    else if (data === 'show_rules') {
      await bot.answerCallbackQuery(query.id);
      const rulesText = `📜 **ПРАВИЛА И УСЛОВИЯ**\n\n` +
        `• Экзамен проверяет знания химии, технологий и инвентаря.\n` +
        `• Система автоматически завершит вопрос через 15 секунд.\n` +
        `• Результаты сохраняются в базе и доступны администратору.\n` +
        `• Повторная попытка возможна только после сброса админом.`;
      await bot.sendMessage(chatId, rulesText, { parse_mode: 'Markdown' });
    }

    // 3. Admin Actions (with security check)
    else if (data.startsWith('admin_')) {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: '⛔️ Доступ запрещен', show_alert: true });
        return;
      }
      await bot.answerCallbackQuery(query.id);

      if (data === 'admin_panel') {
        showAdminPanel(chatId);
      } else if (data === 'admin_last_10') {
        const last = db.prepare(`
          SELECT r.*, u.fio, u.phone 
          FROM results r 
          JOIN users u ON r.chatId = u.chatId 
          ORDER BY r.finishedAt DESC LIMIT 10
        `).all();
        
        if (last.length === 0) {
          await bot.sendMessage(chatId, '📭 Список результатов пуст.');
        } else {
          let text = `📋 **ПОСЛЕДНИЕ 10 РЕЗУЛЬТАТОВ**\n\n`;
          last.forEach((r, i) => {
            text += `${i+1}. ${r.status === 'PASS' ? '✅' : '❌'} **${r.fio}**\n` +
                    `   Баллы: ${r.score}/${r.total} | 🕒 ${fmtDate(r.finishedAt)}\n` +
                    `   ID: <code>${r.chatId}</code>\n\n`;
          });
          await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        }
      } else if (data === 'admin_retry_req') {
        await bot.sendMessage(chatId, '⌨️ Введите 🆔 **chatId** кандидата для разрешения пересдачи:');
        userStates.set(chatId, { step: 'admin_retry' });
      } else if (data === 'admin_find_req') {
        await bot.sendMessage(chatId, '🔍 Введите **chatId** или **номер телефона** для поиска:');
        userStates.set(chatId, { step: 'admin_find' });
      } else if (data === 'admin_reset_req') {
        await bot.sendMessage(chatId, '⚠️ **ПОДТВЕРЖДЕНИЕ СБРОСА**\n\nВы действительно хотите полностью очистить базу данных? Это действие необратимо.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 ДА, УДАЛИТЬ ВСЁ', callback_data: 'admin_reset_confirm' }],
              [{ text: '❌ ОТМЕНА', callback_data: 'admin_panel' }]
            ]
          }
        });
      } else if (data === 'admin_reset_confirm') {
        db.prepare('DELETE FROM users').run();
        db.prepare('DELETE FROM results').run();
        db.prepare('DELETE FROM sessions').run();
        await bot.sendMessage(chatId, '🧹 **БАЗА ДАННЫХ ОЧИЩЕНА**\nВсе пользователи и результаты удалены.');
        showAdminPanel(chatId);
      }
    } else if (data === 'show_main_menu') {
      await bot.answerCallbackQuery(query.id);
      showMainMenu(chatId);
    }
  } catch (err) {
    console.error(`[CRITICAL ERROR] Callback: ${err.message}`);
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Произошла ошибка', show_alert: true }).catch(() => {});
  }
});

// Helper: Show Main Menu
function showMainMenu(chatId) {
  const text = `🏠 **ГЛАВНОЕ МЕНЮ**\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Добро пожаловать в систему аттестации! Выберите нужный раздел:`;
  
  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Начать экзамен', callback_data: 'start_exam_rules' }],
        [{ text: '👤 Мой профиль', callback_data: 'my_profile' }, { text: '🏆 Топ лидеров', callback_data: 'leaderboard' }],
        [{ text: '📊 Последний результат', callback_data: 'my_result' }, { text: 'ℹ️ Справка и правила', callback_data: 'show_rules' }],
        isAdmin(chatId) ? [{ text: '⚙️ Админ панель', callback_data: 'admin_panel' }] : []
      ].filter(r => r.length > 0)
    }
  });
}

// Set Menu Button (WebApp)
async function setBotMenuButton() {
  try {
    await bot.setChatMenuButton({
      menu_button: JSON.stringify({
        type: 'web_app',
        text: '✍️ Экзамен',
        web_app: { url: `${APP_URL}/exam` }
      })
    });
    console.log('✅ Кнопка меню WebApp успешно установлена');
  } catch (e) {
    console.error('❌ Ошибка установки кнопки меню:', e.message);
  }
}
setBotMenuButton();

function showAdminPanel(chatId) {
  const text = `🛠 **ПАНЕЛЬ АДМИНИСТРАТОРА**\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Выберите действие для управления кандидатами и базой данных:`;
  
  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Последние 10 результатов', callback_data: 'admin_last_10' }],
        [{ text: '🔍 Найти кандидата', callback_data: 'admin_find_req' }],
        [{ text: '🔄 Разрешить пересдачу', callback_data: 'admin_retry_req' }],
        [{ text: '🧹 Очистить всю базу', callback_data: 'admin_reset_req' }],
        [{ text: '🏠 Вернуться в меню', callback_data: 'show_main_menu' }]
      ]
    }
  });
}

// Export for server.js
module.exports = { bot, db, fmtDate, isAdmin, ADMIN_IDS };

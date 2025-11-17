import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));

const API_KEY = process.env.API_KEY;

// Автоматическая генерация JWT секрета
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(64).toString('hex');
  console.log('🔐 Автоматически сгенерирован JWT секрет');
  
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.includes('JWT_SECRET=')) {
        envContent = envContent.replace(/JWT_SECRET=.*/, `JWT_SECRET=${JWT_SECRET}`);
      } else {
        envContent += `\nJWT_SECRET=${JWT_SECRET}\n`;
      }
    } else {
      envContent = `JWT_SECRET=${JWT_SECRET}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log('✅ JWT секрет сохранен в .env файл');
  } catch (error) {
    console.log('⚠️ Не удалось сохранить JWT секрет:', error.message);
  }
}

const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

if (!API_KEY) {
  console.error("❌ API_KEY не найден в .env");
  process.exit(1);
}

console.log('✅ Сервер запускается...');
console.log('✅ JWT секрет настроен');
console.log('✅ Gemini API ключ найден');

// Система хранения данных
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Создаем папку data если не существует
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
  console.log('✅ Создана папка data для хранения данных');
}

// Функции для работы с файлами
function readJSONFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
  }
  return {};
}

function writeJSONFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    return false;
  }
}

const readUsers = () => readJSONFile(USERS_FILE);
const writeUsers = (users) => writeJSONFile(USERS_FILE, users);
const readStats = () => readJSONFile(STATS_FILE);
const writeStats = (stats) => writeJSONFile(STATS_FILE, stats);
const readHistory = () => readJSONFile(HISTORY_FILE);
const writeHistory = (history) => writeJSONFile(HISTORY_FILE, history);

// Middleware для проверки JWT токена
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Токен доступа отсутствует" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Недействительный токен" });
    }
    req.user = user;
    next();
  });
}

// Функции для работы со статистикой
function getUserStats(email) {
  const stats = readStats();
  if (!stats[email]) {
    stats[email] = {
      completedLessons: 0,
      totalScore: 0,
      testsTaken: 0,
      aiRequests: 0,
      currentStreak: 0,
      lastActivity: null,
      dailyRequests: {},
      progress: {
        programming: 0,
        algorithms: 0,
        web: 0,
        databases: 0
      },
      testHistory: []
    };
    writeStats(stats);
  }
  return stats[email];
}

// Функция для расчета уровней и опыта
function calculateLevel(experience) {
  const level = Math.floor(experience / 100) + 1;
  const currentLevelExp = experience % 100;
  const expToNextLevel = 100 - currentLevelExp;
  
  return {
    level: level,
    experience: experience,
    currentLevelExp: currentLevelExp,
    expToNextLevel: expToNextLevel
  };
}

// Функция для обновления статистики пользователя
function updateUserStats(email, updates) {
  const stats = readStats();
  const userStats = getUserStats(email);
  
  Object.keys(updates).forEach(key => {
    if (userStats[key] !== undefined) {
      if (key === 'progress') {
        Object.keys(updates[key]).forEach(progressKey => {
          userStats.progress[progressKey] = Math.min(100, Math.max(
            userStats.progress[progressKey] || 0, 
            updates[key][progressKey]
          ));
        });
      } else if (key === 'testHistory' && updates[key]) {
        userStats.testHistory.push(updates[key]);
      } else {
        userStats[key] += updates[key];
      }
    }
  });
  
  const today = new Date().toDateString();
  
  if (!userStats.dailyRequests[today]) {
    userStats.dailyRequests[today] = 0;
  }
  if (updates.aiRequests) {
    userStats.dailyRequests[today] += updates.aiRequests;
  }
  
  if (updates.aiRequests > 0 || updates.testsTaken > 0) {
    if (userStats.lastActivity !== today) {
      const lastActivity = userStats.lastActivity ? new Date(userStats.lastActivity) : null;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (!lastActivity || lastActivity.toDateString() === yesterday.toDateString()) {
        userStats.currentStreak++;
      } else if (lastActivity.toDateString() !== today) {
        userStats.currentStreak = 1;
      }
      userStats.lastActivity = today;
    }
  }
  
  stats[email] = userStats;
  writeStats(stats);
  return userStats;
}

// Функция для определения категории теста
function getTestCategory(topic) {
  const topicLower = topic.toLowerCase();
  
  if (topicLower.includes('python') || topicLower.includes('java') || 
      topicLower.includes('javascript') || topicLower.includes('programming') ||
      topicLower.includes('code') || topicLower.includes('variable') ||
      topicLower.includes('function') || topicLower.includes('loop')) {
    return 'programming';
  } else if (topicLower.includes('algorithm') || topicLower.includes('data structure') ||
             topicLower.includes('sort') || topicLower.includes('search') ||
             topicLower.includes('complexity') || topicLower.includes('recursion')) {
    return 'algorithms';
  } else if (topicLower.includes('html') || topicLower.includes('css') || 
             topicLower.includes('web') || topicLower.includes('frontend') ||
             topicLower.includes('backend') || topicLower.includes('website')) {
    return 'web';
  } else if (topicLower.includes('database') || topicLower.includes('sql') ||
             topicLower.includes('mysql') || topicLower.includes('mongodb') ||
             topicLower.includes('query') || topicLower.includes('table')) {
    return 'databases';
  }
  
  return null;
}

// Функция для расчета прогресса на основе тестов
function calculateProgress(testHistory) {
  const progress = { programming: 0, algorithms: 0, web: 0, databases: 0 };
  const categoryTests = { programming: 0, algorithms: 0, web: 0, databases: 0 };
  
  testHistory.forEach(test => {
    const category = getTestCategory(test.topic);
    if (category) {
      categoryTests[category]++;
      progress[category] = Math.min(100, categoryTests[category] * 5);
    }
  });
  
  return progress;
}

// База реальных образовательных ресурсов
const REAL_CONTENT_SOURCES = {
  'programming': {
    image: [
      {
        title: "Programming Concepts Diagram",
        url: "https://code.org/",
        description: "Visual explanation of programming concepts",
        suitability: "Clear diagrams perfect for beginners",
        imageUrl: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=500&q=80"
      },
      {
        title: "Coding for Kids",
        url: "https://scratch.mit.edu/",
        description: "Visual programming interface for learning",
        suitability: "Designed specifically for young learners",
        imageUrl: "https://images.unsplash.com/photo-1542831371-29b0f74f9713?w=500&q=80"
      }
    ],
    video: [
      {
        title: "What is Coding?",
        url: "https://www.youtube.com/watch?v=N7ZmPYaXoic",
        description: "Introduction to programming for beginners",
        suitability: "Perfect for complete beginners",
        videoUrl: "https://www.youtube.com/embed/N7ZmPYaXoic"
      },
      {
        title: "How Computer Programs Work",
        url: "https://www.youtube.com/watch?v=OAx_6-wdslM",
        description: "Understanding how code makes computers work",
        suitability: "Great visual explanations",
        videoUrl: "https://www.youtube.com/embed/OAx_6-wdslM"
      }
    ]
  },
  'computer-parts': {
    image: [
      {
        title: "Computer Components",
        url: "https://www.computerscience.org/",
        description: "Diagram showing main computer parts",
        suitability: "Clear labeling for easy learning",
        imageUrl: "https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?w=500&q=80"
      }
    ],
    video: [
      {
        title: "Computer Basics",
        url: "https://www.youtube.com/watch?v=7cXEOWAStq4",
        description: "Learn about computer hardware components",
        suitability: "Simple explanations for beginners",
        videoUrl: "https://www.youtube.com/embed/7cXEOWAStq4"
      }
    ]
  },
  'algorithms': {
    image: [
      {
        title: "Algorithm Flowchart",
        url: "https://www.khanacademy.org/",
        description: "Visual representation of algorithms",
        suitability: "Step-by-step visual learning",
        imageUrl: "https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=500&q=80"
      }
    ],
    video: [
      {
        title: "What's an Algorithm?",
        url: "https://www.youtube.com/watch?v=Da5S1cuqQk4",
        description: "Simple explanation of algorithms",
        suitability: "Fun and engaging for students",
        videoUrl: "https://www.youtube.com/embed/Da5S1cuqQk4"
      }
    ]
  },
  'html': {
    image: [
      {
        title: "HTML Structure",
        url: "https://www.w3schools.com/",
        description: "Visual guide to HTML document structure",
        suitability: "Perfect for web development beginners",
        imageUrl: "https://images.unsplash.com/photo-1621839673705-6617adf9e890?w=500&q=80"
      }
    ],
    video: [
      {
        title: "HTML Tutorial for Beginners",
        url: "https://www.youtube.com/watch?v=qz0aGYrrlhU",
        description: "Learn HTML basics in 1 hour",
        suitability: "Comprehensive beginner tutorial",
        videoUrl: "https://www.youtube.com/embed/qz0aGYrrlhU"
      }
    ]
  },
  'python': {
    image: [
      {
        title: "Python Code Example",
        url: "https://www.python.org/",
        description: "Clean Python code with explanations",
        suitability: "Real code examples for learning",
        imageUrl: "https://images.unsplash.com/photo-1526379879527-8559ecfcaec0?w=500&q=80"
      }
    ],
    video: [
      {
        title: "Python for Beginners",
        url: "https://www.youtube.com/watch?v=kqtD5dpn9C8",
        description: "Complete Python programming course",
        suitability: "Structured learning path",
        videoUrl: "https://www.youtube.com/embed/kqtD5dpn9C8"
      }
    ]
  }
};

// Функции для работы с контентом
function getRealContentSources(topic, contentType, language) {
  const topicLower = topic.toLowerCase();
  
  let category = 'programming';
  
  if (topicLower.includes('html') || topicLower.includes('css') || topicLower.includes('web')) {
    category = 'html';
  } else if (topicLower.includes('computer') || topicLower.includes('hardware') || topicLower.includes('parts')) {
    category = 'computer-parts';
  } else if (topicLower.includes('algorithm') || topicLower.includes('sort') || topicLower.includes('search')) {
    category = 'algorithms';
  } else if (topicLower.includes('python') || topicLower.includes('programming') || topicLower.includes('code')) {
    category = 'programming';
  }

  const sources = REAL_CONTENT_SOURCES[category];
  
  if (sources && sources[contentType]) {
    return {
      resources: sources[contentType],
      ai_recommendation: `I've selected verified educational resources from trusted platforms. These are real working links that will help you learn ${topic}.`,
      search_strategy: `Curated from verified educational platforms and real online resources`
    };
  }
  
  return createFallbackResponse(topic, contentType, language);
}

function createFallbackResponse(topic, contentType, language) {
  const resources = [
    {
      title: `${topic} - Educational ${contentType}`,
      url: "https://www.khanacademy.org/computing",
      description: `Learn about ${topic} through interactive content`,
      suitability: "Age-appropriate content from verified educational platforms",
      imageUrl: contentType === 'image' ? "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=500&q=80" : undefined,
      videoUrl: contentType === 'video' ? "https://www.youtube.com/embed/N7ZmPYaXoic" : undefined,
    }
  ];

  return {
    resources,
    ai_recommendation: `I recommend starting with Khan Academy for reliable educational content about ${topic}. This platform is specifically designed for student learning.`,
    search_strategy: `Verified educational platforms with real, working content`
  };
}

// API для системы аккаунтов
app.post("/api/register", async (req, res) => {
  const { username, email, password, grade } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ error: "Все поля обязательны" });
  }
  
  const users = readUsers();
  
  if (users[email]) {
    return res.status(400).json({ error: "Пользователь с таким email уже существует" });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    users[email] = {
      username,
      email,
      password: hashedPassword,
      grade: grade || '5',
      level: 1,
      experience: 0,
      joined: new Date().toISOString()
    };
    
    if (writeUsers(users)) {
      getUserStats(email);
      
      const token = jwt.sign({ email: email }, JWT_SECRET, { expiresIn: '24h' });
      
      res.json({ 
        success: true, 
        message: "Аккаунт создан успешно",
        token,
        user: {
          username,
          email,
          level: 1,
          experience: 0,
          grade: grade || '5'
        }
      });
    } else {
      res.status(500).json({ error: "Ошибка при создании аккаунта" });
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: "Email и пароль обязательны" });
  }
  
  const users = readUsers();
  const user = users[email];
  
  if (!user) {
    return res.status(401).json({ error: "Неверный email или пароль" });
  }
  
  try {
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }
    
    const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    const stats = getUserStats(email);
    
    res.json({
      success: true,
      token,
      user: {
        username: user.username,
        email: user.email,
        level: user.level,
        experience: user.experience,
        grade: user.grade,
        joined: user.joined,
        stats: stats
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Получение данных пользователя
app.get("/api/user", authenticateToken, (req, res) => {
  const users = readUsers();
  const user = users[req.user.email];
  
  if (!user) {
    return res.status(404).json({ error: "Пользователь не найден" });
  }
  
  const stats = getUserStats(req.user.email);
  
  if (stats.testHistory && stats.testHistory.length > 0) {
    stats.progress = calculateProgress(stats.testHistory);
  }
  
  res.json({
    username: user.username,
    email: user.email,
    level: user.level,
    experience: user.experience,
    grade: user.grade,
    joined: user.joined,
    stats: stats
  });
});

// Получение информации об уровне
app.get("/api/level-info", authenticateToken, (req, res) => {
  const users = readUsers();
  const user = users[req.user.email];
  
  if (!user) {
    return res.status(404).json({ error: "Пользователь не найден" });
  }
  
  const levelInfo = calculateLevel(user.experience);
  
  res.json({
    level: user.level,
    experience: user.experience,
    currentLevelExp: levelInfo.currentLevelExp,
    expToNextLevel: levelInfo.expToNextLevel,
    levelInfo: levelInfo
  });
});

// Получение статистики
app.get("/api/stats", authenticateToken, (req, res) => {
  const stats = getUserStats(req.user.email);
  
  if (stats.testHistory && stats.testHistory.length > 0) {
    stats.progress = calculateProgress(stats.testHistory);
  }
  
  res.json(stats);
});

// API для обновления прогресса
app.post("/api/update-progress", authenticateToken, (req, res) => {
  const { progress, experience, testScore, aiRequests } = req.body;
  
  const updates = {};
  if (progress) updates.progress = progress;
  if (experience) updates.experience = experience;
  if (testScore !== undefined) {
    updates.totalScore = testScore;
    updates.testsTaken = 1;
  }
  if (aiRequests) updates.aiRequests = aiRequests;
  
  const userStats = updateUserStats(req.user.email, updates);
  
  if (experience) {
    const users = readUsers();
    const user = users[req.user.email];
    if (user) {
      user.experience += experience;
      const levelInfo = calculateLevel(user.experience);
      user.level = levelInfo.level;
      writeUsers(users);
      
      res.json({ 
        success: true, 
        stats: userStats,
        level: user.level,
        experience: user.experience,
        levelInfo: levelInfo
      });
      return;
    }
  }
  
  const users = readUsers();
  const user = users[req.user.email];
  if (user) {
    const levelInfo = calculateLevel(user.experience);
    res.json({ 
      success: true, 
      stats: userStats,
      level: user.level,
      experience: user.experience,
      levelInfo: levelInfo
    });
  } else {
    res.json({ 
      success: true, 
      stats: userStats
    });
  }
});

// API для истории действий
app.post("/api/add-to-history", authenticateToken, (req, res) => {
  const { type, topic, details, score } = req.body;
  
  const history = readHistory();
  const email = req.user.email;
  
  if (!history[email]) {
    history[email] = [];
  }
  
  const historyItem = {
    id: Date.now(),
    type,
    topic,
    details,
    score,
    timestamp: new Date().toISOString()
  };
  
  history[email].unshift(historyItem);
  
  if (history[email].length > 100) {
    history[email] = history[email].slice(0, 100);
  }
  
  if (writeHistory(history)) {
    res.json({ success: true, historyItem });
  } else {
    res.status(500).json({ error: "Ошибка при сохранении истории" });
  }
});

app.get("/api/history", authenticateToken, (req, res) => {
  const history = readHistory();
  const userHistory = history[req.user.email] || [];
  
  res.json(userHistory);
});

// Эндпоинт чата
app.post("/api/chat", async (req, res) => {
  console.log("→ Запрос /api/chat");
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages должен быть массивом" });
  }

  try {
    const response = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: messages })
    });

    const data = await response.json();

    if (data.candidates && data.candidates.length > 0) {
      const reply = data.candidates[0].content.parts.map(p => p.text).join(" ");
      
      res.json({
        choices: [
          {
            message: { content: reply }
          }
        ]
      });
    } else {
      res.json({
        choices: [
          {
            message: { content: "Извините, я не смог обработать ваш запрос. Пожалуйста, попробуйте еще раз." }
          }
        ]
      });
    }
  } catch (error) {
    console.error("❌ Ошибка:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Генератор тестов
app.post("/api/generate-test", authenticateToken, async (req, res) => {
  console.log("→ Запрос /api/generate-test от пользователя:", req.user.email);
  const { topic } = req.body;

  if (!topic) {
    return res.status(400).json({ error: "Topic is required" });
  }

  try {
    const response = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Generate a test with 5 multiple choice questions about "${topic}" in computer science. 
            Return the questions in JSON format like this:
            {
              "topic": "${topic}",
              "questions": [
                {
                  "question": "Question text here",
                  "options": ["Option A", "Option B", "Option C", "Option D"],
                  "correct": 0
                }
              ]
            }
            Make sure each question has exactly 4 options and the correct answer index is between 0-3.NEVER, NEVER, NEVER, NEVER LEAVE EMPTY QUESTIONS OR EMPTY ANSWER OPTIONS.`
          }]
        }]
      })
    });

    const data = await response.json();

    if (data.candidates && data.candidates.length > 0) {
      const reply = data.candidates[0].content.parts.map(p => p.text).join(" ");
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const testData = JSON.parse(jsonMatch[0]);
        
        // Сохраняем в историю
        const history = readHistory();
        const email = req.user.email;
        
        if (!history[email]) {
          history[email] = [];
        }
        
        const historyItem = {
          id: Date.now(),
          type: 'test-generated',
          topic: topic,
          details: {
            questions: testData.questions.length,
            topic: topic
          },
          timestamp: new Date().toISOString()
        };
        
        history[email].unshift(historyItem);
        if (history[email].length > 100) {
          history[email] = history[email].slice(0, 100);
        }
        writeHistory(history);
        
        res.json(testData);
      } else {
        res.status(500).json({ error: "Could not parse test data" });
      }
    } else {
      res.status(500).json({ error: "No response from AI" });
    }
  } catch (error) {
    console.error("❌ Ошибка при генерации теста:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// API для сохранения результатов теста
app.post("/api/save-test-result", authenticateToken, async (req, res) => {
  const { topic, score, totalQuestions } = req.body;
  
  try {
    const percentage = Math.round((score / totalQuestions) * 100);
    const isPerfectScore = percentage === 100;
    const category = getTestCategory(topic);
    
    console.log(`💾 Сохранение результатов теста: ${topic}, score: ${score}/${totalQuestions} (${percentage}%)`);
    
    // Сохраняем в историю
    const history = readHistory();
    const email = req.user.email;
    
    if (!history[email]) {
      history[email] = [];
    }
    
    const historyItem = {
      id: Date.now(),
      type: 'test-completed',
      topic: topic,
      details: {
        score: score,
        totalQuestions: totalQuestions,
        percentage: percentage,
        category: category
      },
      score: percentage,
      timestamp: new Date().toISOString()
    };
    
    history[email].unshift(historyItem);
    if (history[email].length > 100) {
      history[email] = history[email].slice(0, 100);
    }
    writeHistory(history);
    
    // Обновляем статистику
    const updates = {
      totalScore: percentage,
      testsTaken: 1,
      aiRequests: 1
    };
    
    if (isPerfectScore) {
      updates.completedLessons = 1;
    }
    
    if (category) {
      updates.testHistory = {
        topic: topic,
        category: category,
        score: percentage,
        date: new Date().toISOString()
      };
    }
    
    const userStats = updateUserStats(req.user.email, updates);
    
    if (userStats.testHistory && userStats.testHistory.length > 0) {
      userStats.progress = calculateProgress(userStats.testHistory);
      writeStats(readStats());
    }
    
    // Обновляем опыт пользователя
    let experienceGained = 15 + Math.round(percentage * 0.3);
    if (isPerfectScore) {
      experienceGained += 30;
    }
    
    console.log(`🎯 Начисление опыта: ${experienceGained} XP`);
    
    const users = readUsers();
    const user = users[req.user.email];
    let levelUp = false;
    
    if (user) {
      const oldLevel = user.level;
      user.experience += experienceGained;
      const levelInfo = calculateLevel(user.experience);
      user.level = levelInfo.level;
      
      levelUp = user.level > oldLevel;
      
      writeUsers(users);
      
      console.log(`📊 Обновление пользователя: ${user.email}, опыт: ${user.experience}, уровень: ${user.level}`);
      
      res.json({ 
        success: true, 
        stats: userStats,
        experience: experienceGained,
        level: user.level,
        levelUp: levelUp,
        levelInfo: levelInfo,
        category: category,
        isPerfectScore: isPerfectScore
      });
      
    } else {
      res.status(404).json({ error: "Пользователь не найден" });
    }
    
  } catch (error) {
    console.error("❌ Ошибка при сохранении результатов теста:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Улучшенный поиск контента с реальными источниками
app.post('/api/search-content', authenticateToken, async (req, res) => {
  console.log("→ Запрос /api/search-content от пользователя:", req.user.email);
  const { topic, contentType, language } = req.body;

  if (!topic || !contentType) {
    return res.status(400).json({ error: "Topic and contentType are required" });
  }

  try {
    // Используем предопределенные реальные источники
    const realSources = getRealContentSources(topic, contentType, language);
    
    // Обновляем статистику
    updateUserStats(req.user.email, { aiRequests: 1 });
    
    // Сохраняем в историю
    const history = readHistory();
    const email = req.user.email;
    
    if (!history[email]) {
      history[email] = [];
    }
    
    const historyItem = {
      id: Date.now(),
      type: 'content-search',
      topic: topic,
      details: {
        contentType: contentType,
        resources: realSources.resources.length,
        language: language
      },
      timestamp: new Date().toISOString()
    };
    
    history[email].unshift(historyItem);
    if (history[email].length > 100) {
      history[email] = history[email].slice(0, 100);
    }
    writeHistory(history);
    
    res.json(realSources);
    
  } catch (error) {
    console.error("❌ Ошибка при поиске контента:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Endpoint для получения статуса API
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'ok',
    apiKey: API_KEY ? 'configured' : 'missing',
    jwt: JWT_SECRET ? 'configured' : 'missing',
    server: 'running'
  });
});

// Основной маршрут
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/favicon.ico", (req, res) => res.status(204).end());

// Обработка 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`📁 Данные хранятся в: ${DATA_DIR}`);
});
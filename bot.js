// bot.js
// Simple Python host demo bot (no database, in-memory only)

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const axios = require("axios");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");

dotenv.config();

// ====== Env variables ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const MAX_FILE_MB = process.env.MAX_FILE_MB
  ? Number(process.env.MAX_FILE_MB)
  : 2; // per upload, default 2MB
const PYTHON_COMMAND = process.env.PYTHON_COMMAND || "python3";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing. Set it in environment variables.");
  process.exit(1);
}

// ====== Simple in-memory state (no database) ======
const userState = new Map(); // userId -> { currentFile, usageMB, waitingForFile }
const userPackages = new Map(); // userId -> { name, limitMB, usedMB }
const runningProcesses = new Map(); // userId -> { proc, filePath }

// ====== Helper functions ======
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function formatBytesToMB(bytes) {
  return +(bytes / (1024 * 1024)).toFixed(2);
}

function getUserData(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, {
      currentFile: null,
      usageMB: 0,
      waitingForFile: false
    });
  }
  return userState.get(userId);
}

function getUserPackage(userId) {
  // Default free package
  if (!userPackages.has(userId)) {
    userPackages.set(userId, {
      name: "Free",
      limitMB: 50,
      usedMB: 0
    });
  }
  return userPackages.get(userId);
}

function updateUserUsage(userId, addedMB) {
  const u = getUserData(userId);
  const pkg = getUserPackage(userId);
  u.usageMB += addedMB;
  pkg.usedMB += addedMB;
}

function mainKeyboard() {
  return {
    keyboard: [
      ["📂 Upload File", "▶ Run"],
      ["⏹ Stop", "📊 Status"],
      ["💾 Usage", "💰 Buy Package"],
      ["⚙ Account", "🆘 Help"]
    ],
    resize_keyboard: true
  };
}

function adminKeyboard() {
  return {
    keyboard: [
      ["👥 Users", "📦 Packages"],
      ["📊 Global Stats"],
      ["🔙 Back to User Mode"]
    ],
    resize_keyboard: true
  };
}

function isAdmin(chatId) {
  if (!ADMIN_ID) return false;
  return Number(chatId) === ADMIN_ID;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ====== Init bot ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log("🤖 Bot started with long polling...");

// ====== /start & /help commands ======

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || "User";

  console.log(`User started: ${chatId} (${firstName})`);

  const text =
    `👋 হাই ${firstName}!\n\n` +
    `আমি একটি Python Host Demo Bot (ডাটাবেস ছাড়া, ইন-মেমোরি)।\n` +
    `তুমি Python ফাইল আপলোড করে রান করতে পারো, usage আর status দেখতে পারো।\n\n` +
    `নিচের কিবোর্ড বাটন থেকে অপশন বেছে নাও 👇`;

  bot.sendMessage(chatId, text, { reply_markup: mainKeyboard() });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const text =
    "🆘 Help\n\n" +
    "📂 Upload File – Python ফাইল ( .py ) পাঠাতে\n" +
    "▶ Run – সর্বশেষ আপলোড করা ফাইল রান করতে\n" +
    "⏹ Stop – চলমান রান বন্ধ করতে\n" +
    "📊 Status – স্ট্যাটাস দেখতে\n" +
    "💾 Usage – কত MB ব্যবহার হয়েছে দেখতে\n" +
    "💰 Buy Package – ডেমো প্যাকেজ ইনফো\n" +
    "⚙ Account – তোমার account ইনফো\n\n" +
    "⚠️ এটা ডেমো প্রজেক্ট। Public hosting করতে চাইলে পরে নিরাপত্তা ঠিক করে নেবে।";

  bot.sendMessage(chatId, text, { reply_markup: mainKeyboard() });
});

// ====== /admin command ======

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, "⛔ তুমি admin নও।");
    return;
  }
  bot.sendMessage(chatId, "👑 Admin Panel এ ঢুকেছো।", {
    reply_markup: adminKeyboard()
  });
});

// ====== Main message handler (keyboard options) ======
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  // document/ফাইল হলে নিচে আলাদা handler আছে
  if (msg.document) return;

  const text = msg.text;
  if (!text) return;

  // Admin keyboard options
  if (isAdmin(chatId)) {
    if (text === "🔙 Back to User Mode") {
      bot.sendMessage(chatId, "👤 User mode এ ফিরে গেলে।", {
        reply_markup: mainKeyboard()
      });
      return;
    }
    if (text === "👥 Users") {
      const totalUsers = userState.size;
      bot.sendMessage(
        chatId,
        `👥 এই সেশন পর্যন্ত মোট ইউজার: ${totalUsers}`
      );
      return;
    }
    if (text === "📦 Packages") {
      bot.sendMessage(
        chatId,
        "📦 Package management (ডেমো)। ভবিষ্যতে এখানে আসল প্যাকেজ/পেমেন্ট সিস্টেম থাকবে।"
      );
      return;
    }
    if (text === "📊 Global Stats") {
      let totalUsage = 0;
      for (const [, pkg] of userPackages) {
        totalUsage += pkg.usedMB;
      }
      bot.sendMessage(
        chatId,
        `📊 Global usage (ডেমো, ইন-মেমোরি): ${totalUsage.toFixed(2)} MB`
      );
      return;
    }
  }

  // User keyboard options
  if (text === "📂 Upload File") {
    const u = getUserData(chatId);
    u.waitingForFile = true;
    bot.sendMessage(
      chatId,
      `📂 এখন একটি Python ফাইল পাঠাও ( .py )\nসর্বোচ্চ সাইজ: ${MAX_FILE_MB} MB।`
    );
    return;
  }

  if (text === "▶ Run") {
    handleRunCommand(chatId);
    return;
  }

  if (text === "⏹ Stop") {
    handleStopCommand(chatId);
    return;
  }

  if (text === "📊 Status") {
    handleStatusCommand(chatId);
    return;
  }

  if (text === "💾 Usage") {
    handleUsageCommand(chatId);
    return;
  }

  if (text === "💰 Buy Package") {
    handleBuyPackage(chatId);
    return;
  }

  if (text === "⚙ Account") {
    handleAccount(chatId);
    return;
  }

  if (text === "🆘 Help") {
    bot.sendMessage(chatId, "ℹ️ বিস্তারিত জানতে /help কমান্ড ব্যবহার করো।", {
      reply_markup: mainKeyboard()
    });
    return;
  }

  // অন্য যেকোনো লেখা
  // চাইলে এখানে custom reply/echo দিতে পারো
});

// ====== File upload handler (.py documents) ======
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;
  const u = getUserData(chatId);

  if (!u.waitingForFile) {
    bot.sendMessage(
      chatId,
      "ℹ️ আগে '📂 Upload File' বাটনে চাপো, তারপর ফাইল পাঠাও।",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (!doc.file_name.endsWith(".py")) {
    bot.sendMessage(
      chatId,
      "❌ শুধুমাত্র .py ফাইল অনুমোদিত (ডেমো)। আবার চেষ্টা করো।"
    );
    return;
  }

  const sizeBytes = doc.file_size || 0;
  const fileSizeMB = formatBytesToMB(sizeBytes);
  if (fileSizeMB > MAX_FILE_MB) {
    bot.sendMessage(
      chatId,
      `❌ ফাইল অনেক বড় (${fileSizeMB} MB)। সর্বোচ্চ ${MAX_FILE_MB} MB অনুমোদিত।`
    );
    return;
  }

  // Storage path
  const uploadsDir = path.join(__dirname, "storage", "uploads");
  ensureDir(uploadsDir);

  const safeName = doc.file_name.replace(/[^\w.\-]/g, "_");
  const localPath = path.join(uploadsDir, `${chatId}_${safeName}`);

  try {
    const fileUrl = await bot.getFileLink(doc.file_id);

    await downloadFile(fileUrl, localPath);

    u.currentFile = localPath;
    u.waitingForFile = false;

    updateUserUsage(chatId, fileSizeMB);

    bot.sendMessage(
      chatId,
      `✅ ফাইল সংরক্ষণ করা হয়েছে!\nফাইল: ${doc.file_name}\nসাইজ: ${fileSizeMB} MB\n\nএখন '▶ Run' বাটনে ক্লিক করে রান করতে পারো।`,
      { reply_markup: mainKeyboard() }
    );
  } catch (err) {
    console.error("File download error:", err);
    bot.sendMessage(
      chatId,
      "❌ ফাইল ডাউনলোড করতে সমস্যা হয়েছে। পরে আবার চেষ্টা করো।"
    );
  }
});

// ====== Download helper (axios stream) ======
async function downloadFile(url, destPath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream"
  });

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    response.data.pipe(writeStream);
    response.data.on("error", reject);
    writeStream.on("finish", resolve);
  });
}

// ====== Command handlers ======

function handleRunCommand(chatId) {
  const u = getUserData(chatId);
  const pkg = getUserPackage(chatId);

  if (!u.currentFile) {
    bot.sendMessage(
      chatId,
      "❌ আগে '📂 Upload File' দিয়ে একটি Python ফাইল পাঠাও।",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (pkg.usedMB >= pkg.limitMB) {
    bot.sendMessage(
      chatId,
      `🚫 তোমার প্যাকেজ লিমিট শেষ (${pkg.usedMB.toFixed(
        2
      )} MB / ${pkg.limitMB} MB).\n'💰 Buy Package' থেকে প্যাকেজ ইনফো দেখো।`
    );
    return;
  }

  if (runningProcesses.has(chatId)) {
    bot.sendMessage(
      chatId,
      "⚠️ ইতিমধ্যেই একটি রান চলছে। আগে '⏹ Stop' দিয়ে বন্ধ করো।"
    );
    return;
  }

  bot.sendMessage(chatId, "🚀 তোমার Python ফাইল রান করা হচ্ছে…");

  const command = `${PYTHON_COMMAND} "${u.currentFile}"`;
  console.log(`Running for user ${chatId}: ${command}`);

  const proc = exec(
    command,
    {
      timeout: 1000 * 15 // 15 seconds timeout (ডেমো)
    },
    (error, stdout, stderr) => {
      runningProcesses.delete(chatId);

      let msgText = "";

      if (error) {
        if (error.killed) {
          msgText += "⏱ রান টাইমআউট হয়েছে (১৫ সেকেন্ড)।\n\n";
        } else {
          msgText += `⚠️ রান করার সময় সমস্যা: ${escapeHTML(
            error.message
          )}\n\n`;
        }
      }

      if (stdout) {
        const out = String(stdout).slice(0, 3000);
        msgText += `📤 Output (stdout):\n<pre>${escapeHTML(out)}</pre>\n\n`;
      }

      if (stderr) {
        const errOut = String(stderr).slice(0, 2000);
        msgText += `⚠️ Errors (stderr):\n<pre>${escapeHTML(
          errOut
        )}</pre>\n`;
      }

      if (!msgText) {
        msgText = "ℹ️ কোন output পাওয়া যায়নি।";
      }

      // usage আনুমানিক বৃদ্ধি (ডেমো)
      const addedMB = 0.2;
      updateUserUsage(chatId, addedMB);

      bot.sendMessage(chatId, msgText, {
        parse_mode: "HTML",
        reply_markup: mainKeyboard()
      });
    }
  );

  runningProcesses.set(chatId, { proc, filePath: u.currentFile });
}

function handleStopCommand(chatId) {
  const running = runningProcesses.get(chatId);
  if (!running) {
    bot.sendMessage(chatId, "ℹ️ বর্তমানে কোনো রান চলছে না।");
    return;
  }

  running.proc.kill("SIGKILL");
  runningProcesses.delete(chatId);

  bot.sendMessage(chatId, "⏹ রান বন্ধ করা হয়েছে।");
}

function handleStatusCommand(chatId) {
  const u = getUserData(chatId);
  const pkg = getUserPackage(chatId);
  const running = runningProcesses.get(chatId);

  let statusText = "📊 Status\n\n";

  statusText += `Package: ${pkg.name}\n`;
  statusText += `Usage: ${pkg.usedMB.toFixed(2)} MB / ${
    pkg.limitMB
  } MB\n\n`;

  statusText += `Current file: ${
    u.currentFile ? path.basename(u.currentFile) : "❌ নাই"
  }\n`;
  statusText += `Running: ${running ? "🟢 হ্যাঁ" : "🔴 না"}\n`;

  bot.sendMessage(chatId, statusText, {
    reply_markup: mainKeyboard()
  });
}

function handleUsageCommand(chatId) {
  const u = getUserData(chatId);
  const pkg = getUserPackage(chatId);

  const text =
    "💾 Usage\n\n" +
    `Session usage: ${u.usageMB.toFixed(2)} MB\n` +
    `Package: ${pkg.name}\n` +
    `Package usage: ${pkg.usedMB.toFixed(2)} MB / ${
      pkg.limitMB
    } MB\n`;

  bot.sendMessage(chatId, text, { reply_markup: mainKeyboard() });
}

function handleBuyPackage(chatId) {
  const text =
    "💰 Buy Package (ডেমো)\n\n" +
    "1️⃣ Free – ৫০ MB – ডিফল্ট\n" +
    "2️⃣ ভবিষ্যতে Pro/Premium প্যাকেজ add করবে (bKash/payment সহ)।\n\n" +
    "এই ভার্সনে সবকিছু ইন-মেমোরি, ডাটাবেস ছাড়া।";

  bot.sendMessage(chatId, text, { reply_markup: mainKeyboard() });
}

function handleAccount(chatId) {
  const pkg = getUserPackage(chatId);
  const text =
    "⚙ Account Info\n\n" +
    `ID: <code>${chatId}</code>\n` +
    `Package: ${pkg.name}\n` +
    `Limit: ${pkg.limitMB} MB\n` +
    `Used: ${pkg.usedMB.toFixed(2)} MB\n\n` +
    "Admin চাইলে ভবিষ্যতে প্যাকেজ upgrade/set করতে পারবে (ডাটাবেস + পেমেন্ট সিস্টেম যোগ করলে)।";

  bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: mainKeyboard()
  });
}

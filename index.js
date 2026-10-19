import "dotenv/config";
import express from "express";
import { Bot, InlineKeyboard } from "grammy";
import OpenAI from "openai";
import pg from "pg";

const { Pool } = pg;

const required = [
  "BOT_TOKEN",
  "OPENAI_API_KEY",
  "DATABASE_URL",
  "ADMIN_IDS",
  "CHANNEL_ID",
  "CHANNEL_LINK"
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const admins = new Set(
  process.env.ADMIN_IDS.split(",").map(x => x.trim()).filter(Boolean)
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false },
  max: 5
});

const bot = new Bot(process.env.BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

const CHANNEL = process.env.CHANNEL_ID;
const CHANNEL_LINK = process.env.CHANNEL_LINK;
const PORTFOLIO = process.env.PORTFOLIO_URL || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const BRAND_RULES = `
You are the AI customer assistant for WebWave Studio, a website
development and business advertising service.

Be friendly, clear, professional and concise. You may help customers
understand website design, landing pages, business websites, online
stores, website maintenance and advertising services.

Never invent prices, client testimonials, completed projects, delivery
dates, guarantees or payment details. If a price or commitment has not
been configured, say that the owner will provide a quote.

Do not claim to be a human. Do not claim an order is confirmed or paid.
For quotes, tell customers to use the bot's quote menu. For complaints,
complex requests or uncertain answers, offer to pass the enquiry to the
owner. Never ask for passwords, card PINs or banking login details.

The bot can answer questions, but it cannot approve advertising,
confirm payments or promise business results.
`;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      referred_by BIGINT,
      state TEXT,
      state_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_ai_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      username TEXT,
      details JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ads (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      username TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id BIGSERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      publish_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS chat_history_idx
      ON chat_messages (telegram_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS scheduled_due_idx
      ON scheduled_posts (status, publish_at);
  `);
}

function isAdmin(ctx) {
  return Boolean(
    ctx.from &&
    ctx.chat?.type === "private" &&
    admins.has(String(ctx.from.id))
  );
}

async function ensureUser(ctx, referral = null) {
  const from = ctx.from;
  if (!from) return;

  const validRef = referral &&
    /^\d+$/.test(referral) &&
    referral !== String(from.id)
      ? referral
      : null;

  await pool.query(
    `INSERT INTO users
      (telegram_id, username, first_name, referred_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name`,
    [from.id, from.username || null, from.first_name || "", validRef]
  );
}

async function setState(id, state, data = {}) {
  await pool.query(
    `UPDATE users SET state=$2, state_data=$3::jsonb
     WHERE telegram_id=$1`,
    [id, state, JSON.stringify(data)]
  );
}

async function clearState(id) {
  await setState(id, null, {});
}

async function tellAdmins(message) {
  for (const id of admins) {
    try {
      await bot.api.sendMessage(id, message);
    } catch (err) {
      console.error("Admin notification failed:", id, err.message);
    }
  }
}

function mainKeyboard() {
  return new InlineKeyboard()
    .text("💻 Our services", "services")
    .text("🖼 Portfolio", "portfolio")
    .row()
    .text("📝 Request a quote", "quote")
    .text("📢 Submit an advert", "advertise")
    .row()
    .text("📣 Join our channel", "join")
    .text("🤝 Refer a friend", "referral");
}

async function showMenu(ctx) {
  await ctx.reply(
    "Welcome to WebWave Studio Assistant! 👋\n\n" +
    "I can answer questions about our services, help collect your " +
    "project requirements and submit enquiries to our team.\n\n" +
    "I'm an AI assistant, so important details and quotes are " +
    "confirmed by the owner.\n\nChoose an option below:",
    { reply_markup: mainKeyboard() }
  );
}

bot.command("start", async ctx => {
  const payload = ctx.message.text.split(/\s+/)[1] || "";
  const referral = payload.startsWith("ref_")
    ? payload.slice(4)
    : null;

  await ensureUser(ctx, referral);
  await showMenu(ctx);
});

bot.command("menu", async ctx => {
  await ensureUser(ctx);
  await showMenu(ctx);
});

bot.command("cancel", async ctx => {
  await ensureUser(ctx);
  await clearState(ctx.from.id);
  await ctx.reply("Cancelled. Use /menu whenever you're ready.");
});

bot.command("services", async ctx => {
  await ctx.reply(
    "💻 WEBWAVE STUDIO SERVICES\n\n" +
    "• Business websites\n" +
    "• Landing pages\n" +
    "• Online stores and product catalogues\n" +
    "• Website redesigns\n" +
    "• Website maintenance\n" +
    "• Business advertising and promotional posts\n\n" +
    "Prices depend on the project scope. Use /menu to request a quote."
  );
});

bot.command("quote", async ctx => {
  await ensureUser(ctx);
  await setState(ctx.from.id, "lead_name", {});
  await ctx.reply(
    "Let's prepare your project enquiry. What name should we use?\n\n" +
    "Send /cancel to stop."
  );
});

bot.command("advertise", async ctx => {
  await ensureUser(ctx);
  await setState(ctx.from.id, "ad_submission", {});
  await ctx.reply(
    "Send your complete advert text, including the business name, " +
    "what you're promoting and any relevant links.\n\n" +
    "Your advert will remain pending until the owner reviews it. " +
    "Submitting an advert does not guarantee publication.\n\n" +
    "Send /cancel to stop."
  );
});

bot.command("referral", async ctx => {
  await ensureUser(ctx);
  const me = await bot.api.getMe();
  const link = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;

  await ctx.reply(
    "🤝 Your personal invitation link:\n\n" + link +
    "\n\nShare it with people who may genuinely find our services useful. " +
    "The bot counts new users who start it through this link."
  );
});

bot.command("admin", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorised to use admin commands.");

  await ctx.reply(
    "🔐 WEBWAVE ADMIN COMMANDS\n\n" +
    "/post Your message — publish to the channel\n" +
    "/schedule 2026-12-01T15:00:00Z | Message — schedule UTC time\n" +
    "/pending_ads — list submitted adverts\n" +
    "/approve_ad ID — publish a pending advert\n" +
    "/reject_ad ID — reject an advert\n" +
    "/leads — view recent enquiries\n" +
    "/stats — overview\n" +
    "/referrals — referral totals\n\n" +
    "Only use these commands from your authorised Telegram account."
  );
});

bot.command("post", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const body = ctx.message.text.replace(/^\/post(?:@\w+)?\s*/i, "").trim();
  if (!body) return ctx.reply("Usage: /post Your channel message");

  try {
    const sent = await bot.api.sendMessage(CHANNEL, body);
    await ctx.reply(`Published successfully. Message ID: ${sent.message_id}`);
  } catch (err) {
    console.error(err);
    await ctx.reply("Publication failed. Check the bot's channel permissions and CHANNEL_ID.");
  }
});

bot.command("schedule", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const value = ctx.message.text.replace(/^\/schedule(?:@\w+)?\s*/i, "");
  const separator = value.indexOf("|");

  if (separator < 0) {
    return ctx.reply(
      "Usage:\n/schedule 2026-12-01T15:00:00Z | Your post\n\n" +
      "Use a future ISO date/time in UTC, ending in Z."
    );
  }

  const dateText = value.slice(0, separator).trim();
  const body = value.slice(separator + 1).trim();
  const date = new Date(dateText);

  if (!body || !Number.isFinite(date.getTime()) || date <= new Date()) {
    return ctx.reply("Provide a valid future UTC date/time and non-empty post.");
  }

  const result = await pool.query(
    `INSERT INTO scheduled_posts (body, publish_at)
     VALUES ($1, $2) RETURNING id, publish_at`,
    [body, date.toISOString()]
  );

  await ctx.reply(
    `Scheduled post #${result.rows[0].id} for ` +
    `${result.rows[0].publish_at.toISOString()} UTC.`
  );
});

bot.command("pending_ads", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const result = await pool.query(
    `SELECT id, telegram_id, username, body, created_at
     FROM ads WHERE status='pending'
     ORDER BY created_at ASC LIMIT 10`
  );

  if (!result.rows.length) return ctx.reply("No pending adverts.");

  for (const ad of result.rows) {
    await ctx.reply(
      `AD #${ad.id}\nFrom: ${ad.username ? "@" + ad.username : ad.telegram_id}\n\n` +
      `${ad.body.slice(0, 3000)}\n\n` +
      `Approve: /approve_ad ${ad.id}\nReject: /reject_ad ${ad.id}`
    );
  }
});

bot.command("approve_ad", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(id) || id < 1) {
    return ctx.reply("Usage: /approve_ad ID");
  }

  const result = await pool.query(
    `SELECT * FROM ads WHERE id=$1 AND status='pending'`,
    [id]
  );

  if (!result.rows.length) return ctx.reply("Pending advert not found.");

  const ad = result.rows[0];

  try {
    await bot.api.sendMessage(
      CHANNEL,
      `📢 SPONSORED ADVERTISEMENT\n\n${ad.body}`
    );

    await pool.query(
      `UPDATE ads SET status='published' WHERE id=$1`,
      [id]
    );

    await ctx.reply(`Advert #${id} published.`);
    try {
      await bot.api.sendMessage(ad.telegram_id, "Your advert has been approved and published.");
    } catch {}
  } catch (err) {
    console.error(err);
    await ctx.reply("Publishing failed. The advert remains pending.");
  }
});

bot.command("reject_ad", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(id) || id < 1) {
    return ctx.reply("Usage: /reject_ad ID");
  }

  const result = await pool.query(
    `UPDATE ads SET status='rejected'
     WHERE id=$1 AND status='pending'
     RETURNING telegram_id`,
    [id]
  );

  if (!result.rows.length) return ctx.reply("Pending advert not found.");

  await ctx.reply(`Advert #${id} rejected.`);
  try {
    await bot.api.sendMessage(result.rows[0].telegram_id, "Your advert was not approved for publication.");
  } catch {}
});

bot.command("leads", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const result = await pool.query(
    `SELECT id, telegram_id, username, details, created_at
     FROM leads ORDER BY created_at DESC LIMIT 10`
  );

  if (!result.rows.length) return ctx.reply("No customer enquiries yet.");

  for (const lead of result.rows) {
    await ctx.reply(
      `LEAD #${lead.id}\n` +
      `Telegram: ${lead.username ? "@" + lead.username : lead.telegram_id}\n` +
      `Details: ${JSON.stringify(lead.details, null, 2)}`
    );
  }
});

bot.command("stats", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const [users, leads, ads, refs, scheduled] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM users"),
    pool.query("SELECT COUNT(*)::int AS n FROM leads"),
    pool.query("SELECT COUNT(*)::int AS n FROM ads WHERE status='pending'"),
    pool.query("SELECT COUNT(*)::int AS n FROM users WHERE referred_by IS NOT NULL"),
    pool.query("SELECT COUNT(*)::int AS n FROM scheduled_posts WHERE status='scheduled'")
  ]);

  await ctx.reply(
    `📊 WEBWAVE BOT STATS\n\n` +
    `Bot users: ${users.rows[0].n}\n` +
    `Customer leads: ${leads.rows[0].n}\n` +
    `Pending adverts: ${ads.rows[0].n}\n` +
    `Referred users: ${refs.rows[0].n}\n` +
    `Scheduled posts: ${scheduled.rows[0].n}`
  );
});

bot.command("referrals", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

  const result = await pool.query(`
    SELECT referred_by, COUNT(*)::int AS total
    FROM users WHERE referred_by IS NOT NULL
    GROUP BY referred_by ORDER BY total DESC LIMIT 10
  `);

  if (!result.rows.length) return ctx.reply("No referrals tracked yet.");

  await ctx.reply(
    "TOP REFERRERS\n\n" +
    result.rows.map((r, i) => `${i + 1}. Telegram ID ${r.referred_by}: ${r.total}`).join("\n")
  );
});

bot.on("callback_query:data", async ctx => {
  await ensureUser(ctx);
  const action = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  if (action === "services") {
    return ctx.reply(
      "💻 We offer business websites, landing pages, online stores, " +
      "redesigns, maintenance and advertising. Prices depend on scope. " +
      "Choose Request a quote from /menu to tell us about your project."
    );
  }

  if (action === "portfolio") {
    return ctx.reply(
      PORTFOLIO
        ? `🖼 Explore our portfolio:\n${PORTFOLIO}`
        : "Our portfolio link hasn't been configured yet. Please contact the owner for examples."
    );
  }

  if (action === "quote") {
    await setState(ctx.from.id, "lead_name", {});
    return ctx.reply("Let's start your quote. What name should we use?\n\nSend /cancel to stop.");
  }

  if (action === "advertise") {
    await setState(ctx.from.id, "ad_submission", {});
    return ctx.reply(
      "Send your complete advert text, including your business name and links. " +
      "The owner must approve it before publication. Send /cancel to stop."
    );
  }

  if (action === "join") {
    return ctx.reply("Join the WebWave Studio channel here:", {
      reply_markup: new InlineKeyboard().url("Join channel", CHANNEL_LINK)
    });
  }

  if (action === "referral") {
    const me = await bot.api.getMe();
    const link = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;
    return ctx.reply(`Your personal referral link:\n${link}`);
  }
});

async function handleLeadStep(ctx, state, data, text) {
  const id = ctx.from.id;
  const prompts = {
    lead_name: ["name", "lead_business", "What is your business name or idea?"],
    lead_business: ["business", "lead_type", "What do you need: landing page, business website, online store, redesign or something else?"],
    lead_type: ["project_type", "lead_budget", "What budget range are you considering? You can say you're not sure."],
    lead_budget: ["budget", "lead_deadline", "When would you ideally like the project completed?"],
    lead_deadline: ["deadline", "lead_contact", "What is the best way to contact you? A Telegram username is fine."]
  };

  if (state === "lead_contact") {
    data.contact = text.slice(0, 500);

    const details = {
      name: data.name,
      business: data.business,
      project_type: data.project_type,
      budget: data.budget,
      deadline: data.deadline,
      contact: data.contact
    };

    const result = await pool.query(
      `INSERT INTO leads (telegram_id, username, details)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [id, ctx.from.username || null, JSON.stringify(details)]
    );

    await clearState(id);

    await ctx.reply(
      `Thanks! Your enquiry #${result.rows[0].id} has been sent to WebWave Studio. ` +
      "The owner will review your requirements and follow up."
    );

    await tellAdmins(
      `🆕 NEW CUSTOMER LEAD #${result.rows[0].id}\n` +
      `Telegram ID: ${id}\nUsername: ${ctx.from.username ? "@" + ctx.from.username : "not set"}\n\n` +
      JSON.stringify(details, null, 2)
    );
    return;
  }

  const [field, nextState, question] = prompts[state];
  data[field] = text.slice(0, 500);
  await setState(id, nextState, data);
  await ctx.reply(question);
}

async function handleCustomerMessage(ctx) {
  const id = ctx.from.id;
  const text = ctx.message.text.trim();

  if (!text || text.startsWith("/")) return;
  if (text.length > 2000) {
    return ctx.reply("Please keep your message under 2,000 characters.");
  }

  await ensureUser(ctx);

  const userResult = await pool.query(
    "SELECT state, state_data, last_ai_at FROM users WHERE telegram_id=$1",
    [id]
  );

  const user = userResult.rows[0];
  if (!user) return;

  if (user.state === "ad_submission") {
    const result = await pool.query(
      `INSERT INTO ads (telegram_id, username, body)
       VALUES ($1, $2, $3) RETURNING id`,
      [id, ctx.from.username || null, text.slice(0, 3000)]
    );

    await clearState(id);
    await ctx.reply(
      `Your advert submission #${result.rows[0].id} is awaiting review. ` +
      "It will not be published unless the owner approves it."
    );

    await tellAdmins(
      `📢 AD SUBMITTED #${result.rows[0].id}\n` +
      `From: ${ctx.from.username ? "@" + ctx.from.username : id}\n\n` +
      `${text.slice(0, 2500)}\n\n` +
      `Review with /pending_ads`
    );
    return;
  }

  if (user.state?.startsWith("lead_")) {
    return handleLeadStep(ctx, user.state, user.state_data || {}, text);
  }

  const lastAi = user.last_ai_at ? new Date(user.last_ai_at).getTime() : 0;
  if (Date.now() - lastAi < 2000) {
    return ctx.reply("One moment please — send your next question shortly.");
  }

  const usage = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_messages
     WHERE telegram_id=$1 AND role='user'
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [id]
  );

  if (usage.rows[0].n >= 30) {
    return ctx.reply(
      "You've reached today's automated reply limit. Use /quote to send " +
      "a project enquiry, or try again later."
    );
  }

  await pool.query(
    "UPDATE users SET last_ai_at=NOW() WHERE telegram_id=$1",
    [id]
  );

  await pool.query(
    "INSERT INTO chat_messages (telegram_id, role, content) VALUES ($1, 'user', $2)",
    [id, text]
  );

  try {
    const history = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [id]
    );

    const response = await openai.responses.create({
      model: MODEL,
      instructions: BRAND_RULES,
      input: history.rows.reverse().map(row => ({
        role: row.role,
        content: row.content
      })),
      max_output_tokens: 350
    });

    const answer = response.output_text?.trim() ||
      "Sorry, I couldn't prepare an answer just now. Please try again or use /quote.";

    await pool.query(
      "INSERT INTO chat_messages (telegram_id, role, content) VALUES ($1, 'assistant', $2)",
      [id, answer.slice(0, 4000)]
    );

    await ctx.reply(answer.slice(0, 4000));
  } catch (err) {
    console.error("AI request failed:", err.message);
    await ctx.reply(
      "Sorry, the AI assistant is temporarily unavailable. " +
      "You can still use /quote to send your project enquiry."
    );
  }
}

bot.on("message:text", handleCustomerMessage);

let processingSchedule = false;

async function publishDuePosts() {
  if (processingSchedule) return;
  processingSchedule = true;

  try {
    while (true) {
      const result = await pool.query(`
        UPDATE scheduled_posts
        SET status='publishing'
        WHERE id = (
          SELECT id FROM scheduled_posts
          WHERE status='scheduled' AND publish_at <= NOW()
          ORDER BY publish_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, body
      `);

      if (!result.rows.length) break;

      const post = result.rows[0];

      try {
        await bot.api.sendMessage(CHANNEL, post.body);
        await pool.query(
          `UPDATE scheduled_posts
           SET status='published', published_at=NOW() WHERE id=$1`,
          [post.id]
        );
        await tellAdmins(`✅ Scheduled post #${post.id} published.`);
      } catch (err) {
        console.error("Scheduled post failed:", post.id, err.message);
        await pool.query(
          `UPDATE scheduled_posts SET status='failed' WHERE id=$1`,
          [post.id]
        );
        await tellAdmins(`⚠️ Scheduled post #${post.id} failed. Check the bot logs.`);
      }
    }
  } catch (err) {
    console.error("Scheduler error:", err.message);
  } finally {
    processingSchedule = false;
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("WebWave Studio Bot is running.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "webwave-telegram-bot" });
});

app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log("Health server started.");
});

bot.catch(err => {
  console.error("Telegram bot error:", err.message);
});

await initDb();
await bot.api.setMyCommands([
  { command: "start", description: "Start the assistant" },
  { command: "menu", description: "Open the main menu" },
  { command: "services", description: "View our services" },
  { command: "quote", description: "Request a project quote" },
  { command: "advertise", description: "Submit an advert for review" },
  { command: "referral", description: "Get your referral link" },
  { command: "cancel", description: "Cancel the current step" }
]);

setInterval(publishDuePosts, 15000);
await publishDuePosts();

bot.start({
  onStart: info => console.log(`Bot started as @${info.username}`)
}).catch(err => {
  console.error("Bot startup failed:", err);
  process.exit(1);
});
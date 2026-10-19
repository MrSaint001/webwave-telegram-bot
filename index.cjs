
require("dotenv").config();

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const OpenAI = require("openai");
const { Pool } = require("pg");

const required = ["BOT_TOKEN", "DATABASE_URL", "ADMIN_IDS", "CHANNEL_ID", "CHANNEL_LINK"];
for (const key of required) {
  if (!process.env[key]?.trim()) throw new Error(`Missing environment variable: ${key}`);
}

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
});

const admins = new Set(
  process.env.ADMIN_IDS.split(",").map(x => x.trim()).filter(x => /^\d+$/.test(x))
);
const CHANNEL = process.env.CHANNEL_ID;
const CHANNEL_LINK = process.env.CHANNEL_LINK;
const BANK = process.env.PAYMENT_BANK_NAME || "";
const ACCOUNT_NAME = process.env.PAYMENT_ACCOUNT_NAME || "";
const ACCOUNT_NUMBER = process.env.PAYMENT_ACCOUNT_NUMBER || "";
const PHOTO = process.env.WELCOME_PHOTO_URL || "";
const PORTFOLIO = process.env.PORTFOLIO_URL || "";
const CURRENCY = "₦";

const packages = [
  {
    key: "starter",
    name: process.env.AD_PACKAGE_1_NAME || "Starter Spotlight",
    price: Number(process.env.AD_PACKAGE_1_PRICE || 5000),
    duration: process.env.AD_PACKAGE_1_DURATION || "24 hours",
    description: process.env.AD_PACKAGE_1_DESCRIPTION || "One sponsored advert post."
  },
  {
    key: "growth",
    name: process.env.AD_PACKAGE_2_NAME || "Growth Campaign",
    price: Number(process.env.AD_PACKAGE_2_PRICE || 10000),
    duration: process.env.AD_PACKAGE_2_DURATION || "3 days",
    description: process.env.AD_PACKAGE_2_DESCRIPTION || "Sponsored post plus one scheduled reminder."
  },
  {
    key: "premium",
    name: process.env.AD_PACKAGE_3_NAME || "Premium Feature",
    price: Number(process.env.AD_PACKAGE_3_PRICE || 20000),
    duration: process.env.AD_PACKAGE_3_DURATION || "7 days",
    description: process.env.AD_PACKAGE_3_DESCRIPTION || "Premium sponsored placement and reminders."
  }
];

if (packages.some(p => !Number.isFinite(p.price) || p.price <= 0)) {
  throw new Error("Advertising prices must be positive numbers.");
}

const ai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

function isAdmin(ctx) {
  const userId = ctx.from?.id ?? ctx.message?.from?.id;
  const authorised = userId != null && admins.has(String(userId));

  console.log("ADMIN CHECK:", {
    userId,
    authorised,
    admins: [...admins]
  });

  return authorised;
}

function money(n) {
  return CURRENCY + Number(n).toLocaleString("en-NG");
}

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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

    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS state_data JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ai_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS ads (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      username TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE ads ADD COLUMN IF NOT EXISTS package_key TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS package_name TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS amount_ngn NUMERIC(12,2);
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS photo_file_id TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS receipt_file_id TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS receipt_file_type TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS business_link TEXT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS admin_id BIGINT;
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS leads (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      username TEXT,
      details JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
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

    ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS target_chat_id TEXT;

    CREATE INDEX IF NOT EXISTS ads_status_idx ON ads(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS scheduled_due_idx ON scheduled_posts(status, publish_at);
  `);
}

async function ensureUser(ctx, referral) {
  if (!ctx.from) return;

  const ref = referral &&
    /^\d+$/.test(referral) &&
    referral !== String(ctx.from.id)
    ? referral
    : null;

  await pool.query(`
    INSERT INTO users(telegram_id, username, first_name, referred_by)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=EXCLUDED.username,
      first_name=EXCLUDED.first_name
  `, [
    ctx.from.id,
    ctx.from.username || null,
    ctx.from.first_name || "",
    ref
  ]);
}

async function setState(id, state, data = {}) {
  await pool.query(
    "UPDATE users SET state=$2,state_data=$3::jsonb WHERE telegram_id=$1",
    [id, state, JSON.stringify(data)]
  );
}

async function clearState(id) {
  await setState(id, null, {});
}

async function tellAdmins(text) {
  for (const id of admins) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (e) {
      console.error("Admin notification failed:", e.message);
    }
  }
}

function menuKeyboard() {
  return new InlineKeyboard()
    .text("💻 Our services", "services")
    .text("🖼 Portfolio", "portfolio").row()
    .text("📝 Get a quote", "quote")
    .text("📣 Advertise", "advertise").row()
    .text("📢 Join channel", "join")
    .text("🤝 Refer a friend", "referral");
}

async function showMenu(ctx) {
  const name = esc(ctx.from?.first_name || "there");
  const caption =
    `✨ <b>WELCOME TO WEBWAVE STUDIO, ${name.toUpperCase()}!</b>\n\n` +
    `Your ideas deserve more than an ordinary online presence.\n\n` +
    `🚀 <b>WE HELP BUSINESSES GROW</b>\n` +
    `🌐 Professional websites and landing pages\n` +
    `🛍️ Online stores and digital experiences\n` +
    `🎨 Website redesigns and maintenance\n` +
    `📣 Sponsored advertising and promotions\n\n` +
    `Choose an option below. Whether you're launching a brand, looking for a website, or promoting a product, let's make your next move count.\n\n` +
    `<i>WEBWAVE STUDIO — Build better. Reach further.</i>`;

  if (PHOTO) {
    try {
      return await ctx.replyWithPhoto(PHOTO, {
        caption,
        parse_mode: "HTML",
        reply_markup: menuKeyboard()
      });
    } catch (e) {
      console.error("Welcome photo failed:", e.message);
    }
  }

  return ctx.reply(caption, {
    parse_mode: "HTML",
    reply_markup: menuKeyboard()
  });
}

function packageKeyboard() {
  const kb = new InlineKeyboard();
  for (const p of packages) {
    kb.text(`${p.name} — ${money(p.price)}`, `package:${p.key}`).row();
  }
  kb.text("↩️ Main menu", "menu");
  return kb;
}

async function startAdvert(ctx) {
  await setState(ctx.from.id, "ad_details", {});
  await ctx.reply(
    `📣 <b>LET'S GET YOUR BUSINESS NOTICED</b>\n\n` +
    `Choose the advertising package that fits your campaign.\n\n` +
    `Each package displays its price, duration and deliverables before checkout.\n` +
    `After you submit your advert and receipt, our team will verify the payment in the actual bank account before anything is published.\n\n` +
    `👇 <b>SELECT YOUR CAMPAIGN</b>`,
    { parse_mode: "HTML", reply_markup: packageKeyboard() }
  );
}

async function choosePackage(ctx, key) {
  const p = packages.find(x => x.key === key);
  if (!p) return ctx.reply("That package is unavailable. Open /menu and try again.");

  await setState(ctx.from.id, "ad_text", {
    packageKey: p.key,
    packageName: p.name,
    price: p.price
  });

  await ctx.reply(
    `💎 <b>${esc(p.name)}</b>\n\n` +
    `💰 Price: <b>${money(p.price)}</b>\n` +
    `⏱ Duration: ${esc(p.duration)}\n` +
    `📦 Includes: ${esc(p.description)}\n\n` +
    `📝 <b>STEP 1 — YOUR ADVERT</b>\n` +
    `Send your advert text, business name, offer and public contact/link.\n\n` +
    `Keep the claims accurate. Send /cancel to stop.`,
    { parse_mode: "HTML" }
  );
}

async function checkout(ctx, data) {
  if (!BANK || !ACCOUNT_NAME || !ACCOUNT_NUMBER) {
    await clearState(ctx.from.id);
    await ctx.reply(
      "⚠️ Checkout is not configured yet. Please contact WebWave Studio while the owner sets up the bank details."
    );
    await tellAdmins(
      "⚠️ <b>CHECKOUT CONFIGURATION REQUIRED</b>\nSet PAYMENT_BANK_NAME, PAYMENT_ACCOUNT_NAME and PAYMENT_ACCOUNT_NUMBER in the hosting environment."
    );
    return;
  }

  const result = await pool.query(`
    INSERT INTO ads(
      telegram_id, username, body, status, package_key,
      package_name, amount_ngn, photo_file_id, business_link
    )
    VALUES($1,$2,$3,'awaiting_receipt',$4,$5,$6,$7,$8)
    RETURNING id
  `, [
    ctx.from.id,
    ctx.from.username || null,
    data.body,
    data.packageKey,
    data.packageName,
    data.price,
    data.photoFileId || null,
    data.businessLink || null
  ]);

  const id = result.rows[0].id;
  await setState(ctx.from.id, "ad_receipt", { adId: id });

  await ctx.reply(
    `🧾 <b>SECURE CHECKOUT — ADVERT #${id}</b>\n\n` +
    `📦 Package: <b>${esc(data.packageName)}</b>\n` +
    `💰 Amount due: <b>${money(data.price)}</b>\n\n` +
    `🏦 <b>BANK TRANSFER DETAILS</b>\n` +
    `Bank: ${esc(BANK)}\n` +
    `Account name: ${esc(ACCOUNT_NAME)}\n` +
    `Account number: <code>${esc(ACCOUNT_NUMBER)}</code>\n\n` +
    `After transferring, send your receipt as a photo or document here.\n\n` +
    `🔐 Never send your bank PIN, password or banking login.\n` +
    `⚠️ A receipt is not payment confirmation. The admin will check the bank account before approving publication.`,
    { parse_mode: "HTML" }
  );
}


async function sendReview(ad) {
  const keyboard = new InlineKeyboard()
    .text("Payment verified - publish", `adapprove:${ad.id}`).row()
    .text("Decline application", `addecline:${ad.id}`);

  const msg =
    `<b>NEW ADVERT APPLICATION #${ad.id}</b>\n\n` +
    `Customer: ${esc(ad.username ? "@" + ad.username : String(ad.telegram_id))}\n` +
    `Package: ${esc(ad.package_name || "N/A")}\n` +
    `Amount: <b>${money(ad.amount_ngn || 0)}</b>\n` +
    `Status: Awaiting manual payment verification\n\n` +
    `<b>ADVERT CONTENT</b>\n${esc(ad.body).slice(0, 2200)}\n\n` +
    `${ad.business_link ? `Link: ${esc(ad.business_link)}\n\n` : ""}` +
    `Check the actual bank account before approving.`;

  let delivered = 0;

  for (const admin of admins) {
    try {
      await bot.api.sendMessage(admin, msg, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });

      delivered++;
      console.log(`Review notification sent to admin ${admin}, advert #${ad.id}`);

      if (ad.receipt_file_id) {
        try {
          if (ad.receipt_file_type === "photo") {
            await bot.api.sendPhoto(admin, ad.receipt_file_id, {
              caption: `Payment receipt for advert #${ad.id}`
            });
          } else {
            await bot.api.sendDocument(admin, ad.receipt_file_id, {
              caption: `Payment receipt for advert #${ad.id}`
            });
          }
        } catch (e) {
          console.error(`Receipt delivery failed for admin ${admin}:`, e.message);
        }
      }

      if (ad.photo_file_id) {
        try {
          await bot.api.sendPhoto(admin, ad.photo_file_id, {
            caption: `Advert image for application #${ad.id}`
          });
        } catch (e) {
          console.error(`Advert image delivery failed for admin ${admin}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`Review DM failed for admin ${admin}:`, e.message);
    }
  }

  return delivered;
}


async function publishAd(ctx, id) {
  const result = await pool.query(
    "SELECT * FROM ads WHERE id=$1 AND status='pending_review' FOR UPDATE",
    [id]
  );

  if (!result.rows.length) {
    return ctx.reply("This advert is not awaiting review or has already been handled.");
  }

  const ad = result.rows[0];

  const caption =
    `📣 <b>SPONSORED ADVERTISEMENT</b>\n\n` +
    `${esc(ad.body).slice(0, 850)}` +
    `${ad.business_link ? `\n\n🔗 ${esc(ad.business_link)}` : ""}` +
    `\n\n<i>Advert placement by WebWave Studio</i>`;

  try {
    if (ad.photo_file_id) {
      await bot.api.sendPhoto(CHANNEL, ad.photo_file_id, {
        caption,
        parse_mode: "HTML"
      });
    } else {
      await bot.api.sendMessage(CHANNEL, caption, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true }
      });
    }

    await pool.query(
      "UPDATE ads SET status='published',admin_id=$2,reviewed_at=NOW() WHERE id=$1 AND status='pending_review'",
      [id, ctx.from.id]
    );
const delivered = await sendReview(r.rows[0]);

if (delivered > 0) {
  await ctx.reply(
    `✅ Receipt saved and admin notification sent for application #${id}.\n\nPayment will only be confirmed after the bank transfer is verified.`,
    { parse_mode: "HTML" }
  );
} else {
  await ctx.reply(
    `⚠️ Your receipt has been saved, but our admin notification failed. Please contact the administrator and quote application #${id}.`,
    { parse_mode: "HTML" }
  );
}

return;

    await tellAdmins(`✅ Advert #${id} was published by admin ${ctx.from.id}.`);
  } catch (e) {
    console.error("Advert publication failed:", e.message);
    await ctx.reply("❌ Publishing failed. Check the bot's channel admin permissions and try again.");
  }
}

bot.command("start", async ctx => {
  const payload = ctx.message.text.split(/\s+/)[1] || "";
  await ensureUser(ctx, payload.startsWith("ref_") ? payload.slice(4) : null);
  await clearState(ctx.from.id);
  await showMenu(ctx);
});

bot.command("menu", async ctx => {
  await ensureUser(ctx);
  await clearState(ctx.from.id);
  await showMenu(ctx);
});

bot.command("cancel", async ctx => {
  await clearState(ctx.from.id);
  await ctx.reply("Step cancelled. Your existing submissions are unchanged. Use /menu whenever you're ready.");
});

bot.command("advertise", startAdvert);

bot.command("services", ctx => ctx.reply(
  `💼 <b>WEBWAVE STUDIO SERVICES</b>\n\n` +
  `🌐 Business websites\n🎯 Landing pages\n🛍️ Online stores\n🎨 Redesigns\n🛠️ Maintenance\n📣 Sponsored advertising\n\n` +
  `Tell us what you're building and we'll help you choose the next step.`,
  { parse_mode: "HTML", reply_markup: menuKeyboard() }
));

bot.command("referral", async ctx => {
  const me = await bot.api.getMe();
  await ctx.reply(
    `🤝 <b>YOUR INVITATION LINK</b>\n\nhttps://t.me/${me.username}?start=ref_${ctx.from.id}\n\n` +
    `Share it with people who may genuinely need our services. Referrals are counted when new users start through your link.`,
    { parse_mode: "HTML" }
  );
});

bot.command("post", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  const body = ctx.message.text.replace(/^\/post(?:@\w+)?\s*/i, "").trim();
  if (!body) return ctx.reply("Usage: /post Your channel announcement");
  try {
    await bot.api.sendMessage(CHANNEL, body);
    await ctx.reply("✅ Posted to your channel.");
  } catch (e) {
    console.error(e.message);
    await ctx.reply("Posting failed. Make the bot a channel administrator with permission to post.");
  }
});

bot.command("posthere", async ctx => {
  console.log("POSTHERE DEBUG:", {
    chatType: ctx.chat?.type,
    chatId: ctx.chat?.id,
    sender: ctx.from,
    messageSender: ctx.message?.from,
    updateType: Object.keys(ctx.update || {})
  });

  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  if (!["group", "supergroup"].includes(ctx.chat.type)) {
    return ctx.reply("Use /posthere inside the target group.");
  }
  const body = ctx.message.text.replace(/^\/posthere(?:@\w+)?\s*/i, "").trim();
  if (!body) return ctx.reply("Usage: /posthere Your group announcement");
  try {
    await bot.api.sendMessage(ctx.chat.id, body);
  } catch (e) {
    console.error(e.message);
    await ctx.reply("Could not post. Check group permissions and bot restrictions.");
  }
});

bot.command("schedule", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  const value = ctx.message.text.replace(/^\/schedule(?:@\w+)?\s*/i, "");
  const sep = value.indexOf("|");
  if (sep < 0) return ctx.reply("Usage: /schedule 2026-12-01T15:00:00Z | Your post");

  const date = new Date(value.slice(0, sep).trim());
  const body = value.slice(sep + 1).trim();
  if (!body || !Number.isFinite(date.getTime()) || date <= new Date()) {
    return ctx.reply("Enter a valid future UTC date/time and a message.");
  }

  const r = await pool.query(
    "INSERT INTO scheduled_posts(body,publish_at,target_chat_id) VALUES($1,$2,$3) RETURNING id",
    [body, date.toISOString(), CHANNEL]
  );
  await ctx.reply(`🗓️ Channel post #${r.rows[0].id} scheduled for ${date.toISOString()} UTC.`);
});

bot.command("schedulehere", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  if (!["group", "supergroup"].includes(ctx.chat.type)) {
    return ctx.reply("Run /schedulehere inside the group you want to post in.");
  }

  const value = ctx.message.text.replace(/^\/schedulehere(?:@\w+)?\s*/i, "");
  const sep = value.indexOf("|");
  if (sep < 0) return ctx.reply("Usage: /schedulehere 2026-12-01T15:00:00Z | Your group post");

  const date = new Date(value.slice(0, sep).trim());
  const body = value.slice(sep + 1).trim();
  if (!body || !Number.isFinite(date.getTime()) || date <= new Date()) {
    return ctx.reply("Enter a valid future UTC date/time and a message.");
  }

  const r = await pool.query(
    "INSERT INTO scheduled_posts(body,publish_at,target_chat_id) VALUES($1,$2,$3) RETURNING id",
    [body, date.toISOString(), String(ctx.chat.id)]
  );
  await ctx.reply(`🗓️ Group post #${r.rows[0].id} scheduled for ${date.toISOString()} UTC.`);
});

bot.command("pending_ads", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  const r = await pool.query(
    "SELECT id,telegram_id,username,package_name,amount_ngn,status FROM ads WHERE status IN ('awaiting_receipt','pending_review') ORDER BY created_at DESC LIMIT 15"
  );
  if (!r.rows.length) return ctx.reply("No pending advert applications.");

  for (const ad of r.rows) {
    await ctx.reply(
      `📢 <b>APPLICATION #${ad.id}</b>\n` +
      `Customer: ${esc(ad.username ? "@" + ad.username : String(ad.telegram_id))}\n` +
      `Package: ${esc(ad.package_name || "N/A")}\n` +
      `Amount: ${money(ad.amount_ngn || 0)}\n` +
      `Status: ${esc(ad.status)}\n\n` +
      `/approve_ad ${ad.id}\n/reject_ad ${ad.id}`,
      { parse_mode: "HTML" }
    );
  }
});

bot.command("approve_ad", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(id) || id < 1) return ctx.reply("Usage: /approve_ad ID");
  const r = await pool.query(
    "SELECT * FROM ads WHERE id=$1 AND status='pending_review'",
    [id]
  );
  if (!r.rows.length) return ctx.reply("No receipt-backed application is awaiting review.");
  await publishAd(ctx, id);
});

bot.command("reject_ad", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(id) || id < 1) return ctx.reply("Usage: /reject_ad ID");

  const r = await pool.query(
    "UPDATE ads SET status='rejected',admin_id=$2,reviewed_at=NOW() WHERE id=$1 AND status IN ('awaiting_receipt','pending_review') RETURNING telegram_id",
    [id, ctx.from.id]
  );
  if (!r.rows.length) return ctx.reply("Application not found or already reviewed.");

  await ctx.reply(`Application #${id} declined.`);
  await bot.api.sendMessage(
    r.rows[0].telegram_id,
    `Your advertising application #${id} was declined. Contact WebWave Studio if you need assistance.`
  ).catch(() => {});
});

bot.command("admin", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("Not authorised.");
  await ctx.reply(
    `🔐 <b>WEBWAVE ADMIN DESK</b>\n\n` +
    `/post MESSAGE — channel post\n` +
    `/posthere MESSAGE — post in this group\n` +
    `/schedule ISO_DATE_TIME | MESSAGE — schedule channel post\n` +
    `/schedulehere ISO_DATE_TIME | MESSAGE — schedule group post\n` +
    `/pending_ads — pending adverts\n` +
    `/approve_ad ID — approve after checking payment\n` +
    `/reject_ad ID — decline advert\n`,
    { parse_mode: "HTML" }
  );
});

bot.on("callback_query:data", async ctx => {
  const action = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  if (action === "menu") {
    await clearState(ctx.from.id);
    return showMenu(ctx);
  }
  if (action === "services") {
    return ctx.reply(
      "💻 Websites • Landing pages • Online stores • Redesigns • Advertising\n\nUse /menu to explore your options.",
      { reply_markup: menuKeyboard() }
    );
  }
  if (action === "portfolio") {
    return ctx.reply(
      PORTFOLIO ? `🖼️ Explore our work:\n${PORTFOLIO}` : "Portfolio link has not been configured yet.",
      { reply_markup: PORTFOLIO ? new InlineKeyboard().url("View portfolio", PORTFOLIO) : undefined }
    );
  }
  if (action === "quote") {
    await setState(ctx.from.id, "lead", {});
    return ctx.reply("📝 Tell us about your project, your budget range and when you'd like it completed. Send /cancel to stop.");
  }
  if (action === "advertise") return startAdvert(ctx);
  if (action === "join") {
    return ctx.reply("📢 Join the WebWave Studio channel:", {
      reply_markup: new InlineKeyboard().url("Join channel", CHANNEL_LINK)
    });
  }
  if (action === "referral") {
    const me = await bot.api.getMe();
    return ctx.reply(`🤝 Your referral link:\nhttps://t.me/${me.username}?start=ref_${ctx.from.id}`);
  }
  if (action.startsWith("package:")) {
    return choosePackage(ctx, action.split(":")[1]);
  }
  if (action.startsWith("adapprove:") || action.startsWith("addecline:")) {
    if (!isAdmin(ctx)) return ctx.reply("Not authorised.");

    const [operation, rawId] = action.split(":");
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) return ctx.reply("Invalid application.");

    if (operation === "adapprove") {
      return publishAd(ctx, id);
    }

    const r = await pool.query(
      "UPDATE ads SET status='rejected',admin_id=$2,reviewed_at=NOW() WHERE id=$1 AND status IN ('awaiting_receipt','pending_review') RETURNING telegram_id",
      [id, ctx.from.id]
    );
    if (!r.rows.length) return ctx.reply("Application not found or already reviewed.");

    await ctx.reply(`Application #${id} declined.`);
    await bot.api.sendMessage(
      r.rows[0].telegram_id,
      `Your advertising application #${id} was declined. Contact WebWave Studio if you need help.`
    ).catch(() => {});
  }
});

async function handleMessage(ctx) {
  if (!ctx.from || !ctx.message) return;

  if (ctx.chat.type !== "private") {
    // Group replies only when addressed; no unsolicited mass messaging.
    const text = ctx.message?.text || "";
    if (/^\/start|^\/menu/i.test(text)) return showMenu(ctx);
    return;
  }

  if (ctx.message?.text?.startsWith("/")) return;

  await ensureUser(ctx);
  const result = await pool.query(
    "SELECT state,state_data FROM users WHERE telegram_id=$1",
    [ctx.from.id]
  );
  const user = result.rows[0];
  if (!user) return;

  const state = user.state;
  const data = user.state_data || {};

  if (state === "ad_text") {
    if (!ctx.message.text?.trim()) return ctx.reply("Please send your advert as text.");
    data.body = ctx.message.text.trim().slice(0, 2500);
    await setState(ctx.from.id, "ad_photo", data);
    return ctx.reply("🖼️ Send one advert image, or send /skip for a text-only advert.");
  }

  if (state === "ad_photo") {
    if (ctx.message.text?.trim() === "/skip") return checkout(ctx, data);

    if (ctx.message.photo?.length) {
      data.photoFileId = ctx.message.photo.at(-1).file_id;
      return checkout(ctx, data);
    }

    if (ctx.message.document?.mime_type?.startsWith("image/")) {
      data.photoFileId = ctx.message.document.file_id;
      return checkout(ctx, data);
    }

    return ctx.reply("Send an image or /skip.");
  }

  if (state === "ad_receipt") {
    let fileId;
    let fileType;

    if (ctx.message.photo?.length) {
      fileId = ctx.message.photo.at(-1).file_id;
      fileType = "photo";
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
      fileType = "document";
    }

    if (!fileId) return ctx.reply("Send your receipt as a photo or document.");

    const id = Number(data.adId);
    const r = await pool.query(
      "UPDATE ads SET receipt_file_id=$2,receipt_file_type=$3,status='pending_review' WHERE id=$1 AND telegram_id=$4 AND status='awaiting_receipt' RETURNING *",
      [id, fileId, fileType, ctx.from.id]
    );

    await clearState(ctx.from.id);
    if (!r.rows.length) return ctx.reply("I couldn't find your active advert application. Use /advertise to start again.");

    await ctx.reply(
      `✅ <b>RECEIPT SUBMITTED</b>\n\nApplication #${id} has been sent to our admin team. They will verify payment in the bank account and message you after reviewing it.\n\nSubmitting a receipt does not confirm payment.`,
      { parse_mode: "HTML" }
    );
    return sendReview(r.rows[0]);
  }

  if (state === "lead") {
    const text = ctx.message.text || "";
    if (!text.trim()) return ctx.reply("Please describe your project in a text message.");

    const r = await pool.query(
      "INSERT INTO leads(telegram_id,username,details) VALUES($1,$2,$3::jsonb) RETURNING id",
      [ctx.from.id, ctx.from.username || null, JSON.stringify({ enquiry: text.slice(0, 3000) })]
    );
    await clearState(ctx.from.id);
    await ctx.reply(`✅ Your project enquiry #${r.rows[0].id} has been sent to WebWave Studio.`);
    return tellAdmins(
      `🆕 <b>NEW PROJECT ENQUIRY #${r.rows[0].id}</b>\nCustomer ID: ${ctx.from.id}\n\n${esc(text).slice(0, 2500)}`
    );
  }

  const text = (ctx.message.text || "").trim();
  if (!text) return ctx.reply("Use /menu to explore our services or /advertise to promote your business.");
  if (!ai) return ctx.reply("Welcome to WebWave Studio! Use /menu for services and /advertise for promotion packages.");

  try {
    const response = await ai.responses.create({
      model: MODEL,
      instructions:
        "You are the friendly, professional WebWave Studio customer assistant. Help customers with websites, landing pages, online stores and advertising. Use clear formatting and warm concise responses. Never invent prices, guarantees, testimonials or payment status. For advertising checkout direct them to /advertise; for project enquiries direct them to /menu.",
      input: text,
      max_output_tokens: 400
    });
    await ctx.reply(
      response.output_text?.trim() || "Please use /menu to explore services or /advertise for campaign packages."
    );
  } catch (e) {
    console.error("AI reply failed:", e.message);
    await ctx.reply("I'm having trouble responding right now. Use /menu to access our services.");
  }
}

bot.on("message", handleMessage);

async function publishDuePosts() {
  const r = await pool.query(`
    UPDATE scheduled_posts
    SET status='publishing'
    WHERE id IN (
      SELECT id FROM scheduled_posts
      WHERE status='scheduled' AND publish_at <= NOW()
      ORDER BY publish_at
      FOR UPDATE SKIP LOCKED
      LIMIT 5
    )
    RETURNING id,body,target_chat_id
  `).catch(e => {
    console.error("Scheduler query failed:", e.message);
    return { rows: [] };
  });

  for (const post of r.rows) {
    try {
      await bot.api.sendMessage(post.target_chat_id || CHANNEL, post.body);
      await pool.query(
        "UPDATE scheduled_posts SET status='published',published_at=NOW() WHERE id=$1",
        [post.id]
      );
    } catch (e) {
      console.error("Scheduled post failed:", post.id, e.message);
      await pool.query(
        "UPDATE scheduled_posts SET status='failed' WHERE id=$1",
        [post.id]
      );
      await tellAdmins(`⚠️ Scheduled post #${post.id} failed. Check group/channel permissions.`);
    }
  }
}

app.get("/", (_req, res) => res.status(200).send("WebWave Studio Bot is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function start() {
  await initDb();

  await bot.api.setMyCommands([
    { command: "start", description: "Open welcome menu" },
    { command: "menu", description: "Explore services" },
    { command: "services", description: "View services" },
    { command: "advertise", description: "Advertising packages and checkout" },
    { command: "referral", description: "Get your referral link" },
    { command: "cancel", description: "Cancel current step" }
  ]);

  app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
    console.log("WebWave health server started.");
  });

  setInterval(publishDuePosts, 15000);
  await publishDuePosts();

  bot.catch(err => console.error("Telegram bot error:", err.message));
  await bot.start({
    onStart: info => console.log(`WebWave Studio bot running as @${info.username}`)
  });
}

start().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});

var express = require("express");
const crypto = require("crypto");
const Settings = require("../models/Settings");
const WalletAuditLog = require("../models/WalletAuditLog");
const { requireActiveAdmin } = require("../middleware/auth");
const { rateLimit, clientIp } = require("../middleware/rateLimit");
const { compareHashedPassword, sendWalletChangeAlert } = require("../utils");
var router = express.Router();

/* =====================================================================
   Crypto deposit wallets.
   - There are NO default/seeded addresses: the Fund Account page only
     offers wallets an admin has saved here.
   - Writes need a still-active admin in the DB (requireActiveAdmin), the
     admin's current password (so a stolen token alone can't redirect
     deposits), the version the admin loaded (no blind overwrites), and
     are rate limited per admin.
   - Every address is validated against its network's format.
   - The saved list is HMAC-signed with a server-side secret; if the DB
     row is edited behind the API's back the public endpoint refuses to
     serve it rather than show a possibly attacker-controlled address.
   - Every change and every rejected attempt is written to WalletAuditLog
     and emailed to support.
   ===================================================================== */

const MAX_WALLETS = 20;

const BASE58 = "1-9A-HJ-NP-Za-km-z";
const BECH32 = "ac-hj-np-z02-9";
const NETWORKS = {
  bitcoin: { name: "Bitcoin (BTC)", re: new RegExp(`^(bc1[${BECH32}]{25,87}|[13][${BASE58}]{25,34})$`) },
  evm: { name: "Ethereum / EVM (ERC-20, BEP-20, Polygon…)", re: /^0x[a-fA-F0-9]{40}$/ },
  tron: { name: "Tron (TRX / TRC-20)", re: new RegExp(`^T[${BASE58}]{33}$`) },
  solana: { name: "Solana (SOL / SPL)", re: new RegExp(`^[${BASE58}]{32,44}$`) },
  litecoin: { name: "Litecoin (LTC)", re: new RegExp(`^(ltc1[${BECH32}]{25,87}|[LM3][${BASE58}]{26,33})$`) },
  dogecoin: { name: "Dogecoin (DOGE)", re: new RegExp(`^[DA9][${BASE58}]{25,34}$`) },
};

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
const LABEL_RE = /^[A-Za-z0-9 ()._\/-]{1,40}$/;
// Keys the Fund Account page already uses for non-crypto methods, plus
// anything that could clash with object internals.
const RESERVED_KEYS = new Set(["wire", "demo", "constructor", "prototype", "hasownproperty", "tostring", "valueof"]);

// Signing key never lives in the DB. Set WALLET_SIGNING_SECRET to rotate it
// independently; otherwise it's derived from JWT_SECRET.
const SIGNING_KEY = process.env.WALLET_SIGNING_SECRET
  ? Buffer.from(process.env.WALLET_SIGNING_SECRET)
  : crypto.createHmac("sha256", process.env.JWT_SECRET).update("deposit-wallet-integrity-v1").digest();

function plainWallets(list) {
  return (list || []).map((w) => ({
    key: w.key,
    label: w.label,
    network: w.network,
    address: w.address,
    enabled: w.enabled !== false,
  }));
}

function signWallets(wallets, version) {
  const canonical = JSON.stringify({
    v: version,
    w: wallets.map((w) => [w.key, w.label, w.network, w.address, w.enabled]),
  });
  return crypto.createHmac("sha256", SIGNING_KEY).update(canonical).digest("hex");
}

function signatureValid(settings) {
  const wallets = plainWallets(settings.cryptoWallets);
  const version = settings.walletsVersion || 0;
  if (!wallets.length && version === 0) return true; // nothing saved yet
  const expected = Buffer.from(signWallets(wallets, version), "hex");
  const actual = Buffer.from(String(settings.walletsSignature || ""), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Strict allowlist validation — builds fresh objects so nothing unexpected
// from the request body is ever persisted.
function validateWallets(input) {
  if (!Array.isArray(input)) return { error: "wallets must be an array" };
  if (input.length > MAX_WALLETS) return { error: `At most ${MAX_WALLETS} wallets are allowed` };

  const seen = new Set();
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    const where = `Wallet #${i + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: `${where}: invalid entry` };

    const { key, label, network, address, enabled } = entry;
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      return { error: `${where}: id must be 2-32 chars, lowercase letters, digits or _ and start with a letter` };
    }
    if (RESERVED_KEYS.has(key)) return { error: `${where}: "${key}" is a reserved id` };
    if (seen.has(key)) return { error: `${where}: duplicate id "${key}"` };
    seen.add(key);

    if (typeof label !== "string" || !LABEL_RE.test(label.trim())) {
      return { error: `${where}: label must be 1-40 chars (letters, digits, spaces, ( ) . _ / -)` };
    }
    if (typeof network !== "string" || !Object.prototype.hasOwnProperty.call(NETWORKS, network)) {
      return { error: `${where}: unknown network` };
    }
    if (typeof address !== "string" || !NETWORKS[network].re.test(address.trim())) {
      return { error: `${where} (${label}): "${String(address).slice(0, 100)}" is not a valid ${NETWORKS[network].name} address` };
    }
    if (enabled !== undefined && typeof enabled !== "boolean") return { error: `${where}: enabled must be true/false` };

    out.push({ key, label: label.trim(), network, address: address.trim(), enabled: enabled !== false });
  }
  return { wallets: out };
}

async function audit(req, fields) {
  try {
    await WalletAuditLog.create({
      adminId: String((req.admin && req.admin.userId) || ""),
      adminEmail: (req.admin && req.admin.email) || "",
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      ...fields,
    });
  } catch (error) {
    console.error("Failed to write wallet audit log:", error);
  }
}

function noStore(req, res, next) {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
  next();
}

const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const adminReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => "admin-read:" + clientIp(req),
});
// Per-admin and per-IP caps on write attempts: also caps password guessing
// with a stolen token.
const writeLimiterByIp = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyFn: (req) => "wallet-write-ip:" + clientIp(req),
  message: "Too many wallet update attempts. Try again in a minute.",
});
const writeLimiterByAdmin = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyFn: (req) => "wallet-write-admin:" + req.admin.userId,
  message: "Too many wallet update attempts. Try again in a minute.",
});

// Public: the Fund Account page lists only enabled, admin-saved wallets.
router.get("/wallets", publicLimiter, noStore, async function (req, res) {
  try {
    const settings = await Settings.findOne({ key: "global" });
    if (!settings) return res.status(200).json({ code: "Ok", data: [] });

    if (!signatureValid(settings)) {
      console.error("🚨 [settings.wallets] INTEGRITY CHECK FAILED — wallets in DB were not saved through the admin API. Refusing to serve them.");
      return res.status(503).json({ message: "Deposit wallets are temporarily unavailable" });
    }

    const data = plainWallets(settings.cryptoWallets)
      .filter((w) => w.enabled)
      .map(({ key, label, network, address }) => ({ key, label, network, address }));
    res.status(200).json({ code: "Ok", data });
  } catch (error) {
    console.error("Error fetching deposit wallets:", error);
    res.status(500).json({ message: "Failed to fetch deposit wallets" });
  }
});

// Admin: full list (incl. disabled), version for the next save, and history.
router.get("/wallets/admin", adminReadLimiter, noStore, requireActiveAdmin, async function (req, res) {
  try {
    const settings = await Settings.findOne({ key: "global" });
    const history = await WalletAuditLog.find({})
      .sort({ at: -1 })
      .limit(25)
      .select("at action reason adminEmail ip fromVersion toVersion before after")
      .lean();

    res.status(200).json({
      code: "Ok",
      data: {
        wallets: settings ? plainWallets(settings.cryptoWallets) : [],
        version: (settings && settings.walletsVersion) || 0,
        updatedAt: (settings && settings.walletsUpdatedAt) || null,
        updatedBy: (settings && settings.walletsUpdatedBy) || "",
        integrityOk: settings ? signatureValid(settings) : true,
        networks: Object.entries(NETWORKS).map(([id, n]) => ({ id, name: n.name })),
        history,
      },
    });
  } catch (error) {
    console.error("Error fetching deposit wallets (admin):", error);
    res.status(500).json({ message: "Failed to fetch deposit wallets" });
  }
});

// Admin: replace the whole set of deposit wallets.
// Body: { wallets: [{ key, label, network, address, enabled }], version, currentPassword }
router.put("/wallets", writeLimiterByIp, noStore, requireActiveAdmin, writeLimiterByAdmin, async function (req, res) {
  const { wallets, version, currentPassword } = req.body || {};

  if (typeof currentPassword !== "string" || !currentPassword) {
    return res.status(400).json({ message: "Your current password is required to change deposit wallets" });
  }
  let passwordOk = false;
  try {
    passwordOk = !!req.adminUser.password && compareHashedPassword(req.adminUser.password, currentPassword);
  } catch (e) {
    passwordOk = false;
  }
  if (!passwordOk) {
    await audit(req, { action: "denied", reason: "wrong password" });
    console.warn(`[settings.wallets] wrong password on wallet update by ${req.admin.email} from ${clientIp(req)}`);
    return res.status(403).json({ message: "Incorrect password" });
  }

  if (!Number.isInteger(version) || version < 0) {
    return res.status(400).json({ message: "version is required — reload the page and try again" });
  }

  const result = validateWallets(wallets);
  if (result.error) return res.status(400).json({ message: result.error });

  try {
    const current = await Settings.findOne({ key: "global" });
    const currentVersion = (current && current.walletsVersion) || 0;
    if (version !== currentVersion) {
      await audit(req, { action: "denied", reason: `version conflict (sent ${version}, current ${currentVersion})` });
      return res.status(409).json({ message: "Wallets were changed by someone else since you loaded them. Reload and try again." });
    }

    const before = current ? plainWallets(current.cryptoWallets) : [];
    const nextVersion = currentVersion + 1;
    const now = new Date();

    // Conditional on the version so two simultaneous saves can't both win.
    let saved;
    try {
      saved = await Settings.findOneAndUpdate(
        { key: "global", walletsVersion: currentVersion === 0 ? { $in: [0, null] } : currentVersion },
        {
          $set: {
            cryptoWallets: result.wallets,
            walletsVersion: nextVersion,
            walletsSignature: signWallets(result.wallets, nextVersion),
            walletsUpdatedAt: now,
            walletsUpdatedBy: req.admin.email,
          },
          $unset: { depositWallets: 1 },
        },
        { new: true, upsert: true }
      );
    } catch (error) {
      if (error && error.code === 11000) saved = null; // lost the race against another save
      else throw error;
    }
    if (!saved || saved.walletsVersion !== nextVersion) {
      await audit(req, { action: "denied", reason: "concurrent update" });
      return res.status(409).json({ message: "Wallets were changed by someone else since you loaded them. Reload and try again." });
    }

    await audit(req, { action: "update", fromVersion: currentVersion, toVersion: nextVersion, before, after: result.wallets });
    console.log(
      `[settings.wallets] v${currentVersion} -> v${nextVersion} by ${req.admin.email} (userId=${req.admin.userId}) from ${clientIp(req)} at ${now.toISOString()}:`,
      result.wallets
    );
    sendWalletChangeAlert({
      adminEmail: req.admin.email,
      ip: clientIp(req),
      timestamp: now.toISOString(),
      before,
      after: result.wallets,
    }).catch((e) => console.error("Wallet change alert email failed:", e));

    res.status(200).json({
      code: "Ok",
      data: { wallets: plainWallets(saved.cryptoWallets), version: saved.walletsVersion, updatedAt: now, updatedBy: req.admin.email },
    });
  } catch (error) {
    console.error("Error updating deposit wallets:", error);
    res.status(500).json({ message: "Failed to update deposit wallets" });
  }
});

module.exports = router;

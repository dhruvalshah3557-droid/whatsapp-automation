// WhatsApp Web client for the Colourdiam messaging app.
//
// Connects a personal WhatsApp number the same way web.whatsapp.com does
// (Baileys implements the WhatsApp Web multi-device protocol, no Meta
// Business Cloud API / page token needed). The user pairs the number by
// scanning a QR code shown in the app's Connector view.
//
//   - GET  /api/wa/status -> { connected, qr, phone, pairing, lastError }
//   - POST /api/wa/logout -> clears the stored session so a new QR appears
//   - POST /api/wa/send   -> { to, text } sends a WhatsApp message
//   - Inbound messages are recorded as "whatsapp-web" events so they show
//     up in the app's chat list like every other platform.
//
// The session (auth state) is persisted to server/wa-session/ (git-ignored)
// so a server restart keeps the number connected.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import QRCode from "qrcode";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, "wa-session");

const quietLogger = {
  child: () => quietLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
};

const state = {
  socket: null,
  connected: false,
  pairing: false,
  qr: "", // data URL of the current pairing QR
  qrId: 0, // increments on every new QR so the app can refresh stale codes
  phone: "", // "####" masked number once paired
  lastError: "",
  lastConnectedAt: null,
  started: false,
};

let recordEvent = () => {};

export function setWaEventSink(fn) {
  if (typeof fn === "function") recordEvent = fn;
}

export function waStatus() {
  return {
    ok: true,
    enabled: true,
    connected: state.connected,
    pairing: state.pairing,
    qr: state.qr,
    qrId: state.qrId,
    phone: state.phone,
    lastError: state.lastError,
    lastConnectedAt: state.lastConnectedAt,
    started: state.started,
  };
}

export function waConfig() {
  return { sessionDir: SESSION_DIR };
}

function maskPhone(jid) {
  const m = String(jid || "").replace(/@.*$/, "").replace(/[^0-9]/g, "");
  if (!m) return "";
  if (m.length <= 4) return m;
  return "••••" + m.slice(-4);
}

async function makeSocket() {
  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version,
      auth: authState,
      browser: Browsers.macOS("Desktop"),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      logger: quietLogger,
    });

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", (update) => onConnectionUpdate(socket, update));
    socket.ev.on("messages.upsert", onMessagesUpsert);

    state.socket = socket;
    state.started = true;
    state.lastError = "";
    return socket;
  } catch (err) {
    state.lastError = "failed to start socket: " + ((err && err.message) || err);
    console.error("wa: " + state.lastError);
    return null;
  }
}

function onConnectionUpdate(socket, update) {
  const { qr, connection, lastDisconnect, isNewLogin } = update;

  if (qr) {
    state.pairing = true;
    state.connected = false;
    state.qrId += 1;
    QRCode.toDataURL(qr, { margin: 1, width: 320 })
      .then((dataUrl) => { state.qr = dataUrl; })
      .catch((err) => {
        state.lastError = "qr encode failed: " + ((err && err.message) || err);
        console.error("wa: " + state.lastError);
      });
    return;
  }

  if (connection === "open") {
    state.connected = true;
    state.pairing = false;
    state.qr = "";
    state.phone = maskPhone(socket.user && socket.user.id);
    state.lastConnectedAt = new Date().toISOString();
    state.lastError = "";
    console.log("wa: connected as " + (state.phone || "unknown number"));
    return;
  }

  if (connection === "close") {
    const wasLoggedOut = lastDisconnect && lastDisconnect.error &&
      lastDisconnect.error.output && lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut;
    state.connected = false;
    state.qr = "";
    state.phone = "";
    if (wasLoggedOut) {
      state.pairing = false;
      state.lastError = "logged out — scan a new QR to reconnect";
      console.log("wa: logged out");
    } else {
      state.lastError = "disconnected — will retry automatically";
      console.log("wa: disconnected (" + ((lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || "close") + ")");
    }
  }
}

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage && message.extendedTextMessage.text) return message.extendedTextMessage.text;
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
  if (message.videoMessage && message.videoMessage.caption) return message.videoMessage.caption;
  if (message.documentMessage && message.documentMessage.fileName) return "📄 " + message.documentMessage.fileName;
  if (message.audioMessage) return "🎤 Voice message";
  if (message.stickerMessage) return "🖼 Sticker";
  if (message.contactMessage) return "👤 " + ((message.contactMessage.displayName) || "Contact");
  if (message.locationMessage) return "📍 Location";
  return "";
}

function onMessagesUpsert({ type, messages }) {
  if (type !== "notify") return;
  for (const msg of messages || []) {
    if (!msg || !msg.key || msg.key.fromMe) continue;
    const remoteJid = msg.key.remoteJid || "";
    if (!remoteJid.endsWith("@s.whatsapp.net")) continue;
    const text = extractText(msg.message);
    if (!text) continue;
    try { recordEvent("whatsapp-web", remoteJid, text); } catch (err) { console.error("wa: recordEvent failed:", (err && err.message) || err); }
  }
}

export async function startWa() {
  if (state.started && state.socket) return waStatus();
  state.started = true;
  await makeSocket();
  return waStatus();
}

export async function waLogout() {
  try {
    if (state.socket) {
      state.socket.end(undefined);
      state.socket = null;
    }
  } catch (err) { /* ignore */ }
  state.connected = false;
  state.pairing = false;
  state.qr = "";
  state.phone = "";
  state.lastError = "";
  try {
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("wa: could not clear session dir:", (err && err.message) || err);
  }
  state.started = false;
  await startWa();
  return { ok: true };
}

export async function waSend(to, text) {
  const socket = state.socket;
  if (!socket || !state.connected) {
    return { status: 400, body: { error: "WhatsApp Web is not connected — open the Connector view and scan the QR code first" } };
  }
  if (!to || !String(text)) return { status: 400, body: { error: "to and text are required" } };
  let jid = String(to).trim();
  if (/^\d+$/.test(jid)) jid += "@s.whatsapp.net";
  try {
    await socket.sendMessage(jid, { text: String(text) });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 502, body: { error: "WhatsApp Web send failed", detail: String((err && err.message) || err) } };
  }
}

export function waIsConnected() {
  return state.connected;
}

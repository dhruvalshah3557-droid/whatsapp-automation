// Minimal FTP client used by /api/media/* endpoints.
// Implements login (USER/PASS), passive data connections (PASV), directory
// listing (LIST) and binary upload (STOR) over node:net. No third-party deps.

import net from "node:net";

const FTP_TIMEOUT = 10000;

function ftpConnect(cfg) {
  const host = String(cfg.host || "").trim();
  if (!host) throw new Error("FTP host is not configured");
  const port = Number(cfg.port || 21);
  return new Promise((resolve, reject) => {
    const sess = {
      socket: net.createConnection({ host, port }),
      buf: "",
      reply: null,
      wait: null,
      closed: false,
      ready: false,
    };
    const timer = setTimeout(() => {
      sess.closed = true;
      sess.socket.destroy();
      reject(new Error("FTP connection timed out"));
    }, FTP_TIMEOUT);
    sess.socket.setTimeout(FTP_TIMEOUT);
    sess.socket.on("timeout", () => {
      sess.closed = true;
      sess.socket.destroy();
      reject(new Error("FTP connection timed out"));
    });
    sess.socket.on("error", (err) => {
      if (!sess.closed) { sess.closed = true; reject(err); }
    });
    sess.socket.on("close", () => {
      if (!sess.closed) {
        sess.closed = true;
        if (sess.wait) { const w = sess.wait; sess.wait = null; w(new Error("FTP connection closed")); }
      }
    });
    sess.socket.on("data", (data) => {
      sess.buf += data.toString();
      let idx;
      while ((idx = sess.buf.indexOf("\r\n")) !== -1) {
        const line = sess.buf.slice(0, idx + 2);
        sess.buf = sess.buf.slice(idx + 2);
        handleLine(sess, line);
      }
    });
    sess.readyResolve = () => {
      clearTimeout(timer);
      sess.ready = true;
      resolve(sess);
    };
  });
}

function handleLine(sess, line) {
  const code = line.slice(0, 3);
  const sep = line[3];
  if (!sess.reply) sess.reply = { code, parts: [] };
  sess.reply.parts.push(line.trim());
  if (sep === "-") return;
  const reply = sess.reply;
  sess.reply = null;
  const w = sess.wait;
  sess.wait = null;
  if (w) w(reply);
  else if (!sess.ready) sess.readyResolve();
}

function cmd(sess, command) {
  return new Promise((resolve, reject) => {
    if (sess.closed) return reject(new Error("FTP connection closed"));
    sess.wait = (reply) => {
      if (reply instanceof Error) return reject(reply);
      // Preliminary 1xx replies are followed by a final reply — keep waiting.
      if (String(reply.code).startsWith("1")) {
        sess.wait = (final) => {
          if (final instanceof Error) return reject(final);
          resolve(final);
        };
        return;
      }
      resolve(reply);
    };
    sess.socket.write(command + "\r\n");
  });
}

function closeSess(sess) {
  if (sess.closed) return;
  sess.closed = true;
  try { sess.socket.write("QUIT\r\n"); } catch (err) {}
  sess.socket.end();
  sess.socket.destroy();
}

async function ftpLogin(cfg) {
  const sess = await ftpConnect(cfg);
  try {
    const user = await cmd(sess, "USER " + String(cfg.user || "anonymous"));
    if (!(user.code.startsWith("2") || user.code === "331")) {
      throw new Error("FTP login failed: " + user.code + " " + user.parts.join(" "));
    }
    const pass = await cmd(sess, "PASS " + String(cfg.pass || ""));
    if (!pass.code.startsWith("2")) {
      throw new Error("FTP login failed: " + pass.code + " " + pass.parts.join(" "));
    }
    return sess;
  } catch (err) {
    closeSess(sess);
    throw err;
  }
}

function pasvAddress(text) {
  const m = String(text).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) return null;
  return { host: [m[1], m[2], m[3], m[4]].join("."), port: Number(m[5]) * 256 + Number(m[6]) };
}

function openData(addr) {
  return new Promise((resolve, reject) => {
    const ds = net.createConnection({ host: addr.host, port: addr.port });
    ds.once("connect", () => resolve(ds));
    ds.once("error", reject);
  });
}

async function ftpData(cfg, remotePath, transfer) {
  let sess;
  try {
    sess = await ftpLogin(cfg);
  } catch (err) {
    throw err;
  }
  try {
    const type = await cmd(sess, "TYPE I");
    if (!type.code.startsWith("2")) throw new Error("TYPE I failed: " + type.parts.join(" "));
    const pasv = await cmd(sess, "PASV");
    const addr = pasvAddress(pasv.parts.join(" ") || pasv.parts[0]);
    if (!addr) throw new Error("PASV failed: " + pasv.parts.join(" "));
    const ds = await openData(addr);
    const done = new Promise((res, rej) => { ds.on("error", rej); ds.on("end", res); });
    const replyP = cmd(sess, "STOR " + remotePath);
    transfer(ds);
    await done;
    const reply = await replyP;
    if (!reply.code.startsWith("2")) throw new Error("Transfer failed: " + reply.parts.join(" "));
    return reply;
  } finally {
    closeSess(sess);
  }
}

async function ftpList(cfg, remotePath) {
  let sess;
  try {
    sess = await ftpLogin(cfg);
  } catch (err) {
    throw err;
  }
  try {
    const type = await cmd(sess, "TYPE A");
    if (!type.code.startsWith("2")) throw new Error("TYPE A failed: " + type.parts.join(" "));
    const pasv = await cmd(sess, "PASV");
    const addr = pasvAddress(pasv.parts.join(" ") || pasv.parts[0]);
    if (!addr) throw new Error("PASV failed: " + pasv.parts.join(" "));
    const ds = await openData(addr);
    const chunks = [];
    ds.on("data", (d) => chunks.push(d));
    const listDone = new Promise((res, rej) => { ds.on("end", res); ds.on("error", rej); });
    const replyP = cmd(sess, "LIST " + remotePath);
    await listDone;
    const reply = await replyP;
    if (!reply.code.startsWith("2")) throw new Error("LIST failed: " + reply.parts.join(" "));
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSess(sess);
  }
}

function ftpStore(cfg, remotePath, data) {
  return ftpData(cfg, remotePath, (ds) => {
    ds.write(data, () => ds.end());
  });
}

async function ftpMkdirs(cfg, remotePath) {
  const sess = await ftpLogin(cfg);
  try {
    const parts = String(remotePath || "").split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      const r = await cmd(sess, "MKD " + cur);
      if (!r.code.startsWith("2") && r.code !== "550") {
        throw new Error("MKD " + cur + " failed: " + r.parts.join(" "));
      }
    }
  } finally {
    closeSess(sess);
  }
}

export { ftpList, ftpStore, ftpMkdirs };

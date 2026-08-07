import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_DIR = path.join(__dirname, "tmp-auth");
const ENV = {
  PORT: String(PORT),
  VERIFY_TOKEN: "test_verify",
  EVENTS_FILE: path.join(__dirname, "tmp-auth-events.json"),
  MEDIA_CONFIG_FILE: path.join(__dirname, "tmp-auth-media.json"),
  INVENTORY_FILE: path.join(__dirname, "tmp-auth-inventory.json"),
  SYNC_ON_START: "0",
  AUTH_DATA_DIR: AUTH_DIR,
  ADMIN_EMAIL: "admin@test.local",
  ADMIN_PASSWORD: "AdminTest123!",
};

let child;
async function start() {
  child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], { env: { ...process.env, ...ENV }, stdio: "pipe" });
  const timer = setTimeout(() => { throw new Error("server did not start"); }, 8000);
  child.stderr.on("data", (d) => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (d.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
  });
}
async function stop() {
  if (child) child.kill();
}
async function api(method, pathname, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function login(email, password) {
  const r = await api("POST", "/api/auth/login", { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test.beforeEach(async () => { try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {} await start(); });
test.afterEach(async () => { await stop(); });

test("auth: default admin login works and returns a session token", async () => {
  const r = await login("admin@test.local", "AdminTest123!");
  assert.ok(r.token);
  assert.equal(r.user.role, "admin");
  assert.equal(r.user.mustChangePassword, true);
  assert.ok(!r.user.passwordHash);
});

test("auth: wrong password is rejected", async () => {
  const r = await api("POST", "/api/auth/login", { email: "admin@test.local", password: "wrongpass" });
  assert.equal(r.status, 401);
  assert.ok(r.data.error);
});

test("auth: /api/auth/me requires a valid token and never leaks the hash", async () => {
  const { token } = await login("admin@test.local", "AdminTest123!");
  const r = await api("GET", "/api/auth/me", undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, "admin@test.local");
  assert.ok(!("passwordHash" in r.data.user));
  const noAuth = await api("GET", "/api/auth/me");
  assert.equal(noAuth.status, 401);
});

test("auth: protected endpoints return 401 without a session", async () => {
  assert.equal((await api("GET", "/api/tasks")).status, 401);
  assert.equal((await api("GET", "/api/activity")).status, 401);
  assert.equal((await api("GET", "/api/admin/stats")).status, 401);
});

test("auth: password change requires current password and clears mustChange", async () => {
  const { token } = await login("admin@test.local", "AdminTest123!");
  const bad = await api("POST", "/api/auth/change-password", { oldPassword: "nope", newPassword: "NewPass123!" }, token);
  assert.equal(bad.status, 400);
  const ok = await api("POST", "/api/auth/change-password", { oldPassword: "AdminTest123!", newPassword: "NewPass123!" }, token);
  assert.equal(ok.status, 200);
  const me = await api("GET", "/api/auth/me", undefined, token);
  assert.equal(me.data.user.mustChangePassword, false);
  const relogin = await login("admin@test.local", "NewPass123!");
  assert.ok(relogin.token);
});

test("auth: logout invalidates the session", async () => {
  const { token } = await login("admin@test.local", "AdminTest123!");
  await api("POST", "/api/auth/logout", {}, token);
  const me = await api("GET", "/api/auth/me", undefined, token);
  assert.equal(me.status, 401);
});

test("auth: forgot + reset password flow", async () => {
  const admin = await api("POST", "/api/auth/login", { email: "admin@test.local", password: "AdminTest123!" });
  await api("POST", "/api/admin/users", { name: "Bob", email: "bob@test.local", role: "user", password: "BobTemp123!" }, admin.data.token);
  const forgot = await api("POST", "/api/auth/forgot", { email: "bob@test.local" });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.data.resetToken);
  const reset = await api("POST", "/api/auth/reset", { email: "bob@test.local", token: forgot.data.resetToken, newPassword: "BobNew123!" });
  assert.equal(reset.status, 200);
  const r = await api("POST", "/api/auth/login", { email: "bob@test.local", password: "BobTemp123!" });
  assert.equal(r.status, 401);
  const ok = await login("bob@test.local", "BobNew123!");
  assert.ok(ok.token);
});

test("admin: only admin can create / list / modify users", async () => {
  const admin = await login("admin@test.local", "AdminTest123!");
  const created = await api("POST", "/api/admin/users", { name: "Alice", email: "alice@test.local", role: "user", password: "AliceTemp123!" }, admin.token);
  assert.equal(created.status, 201);
  const dup = await api("POST", "/api/admin/users", { name: "Alice2", email: "alice@test.local", role: "user", password: "AliceTemp123!" }, admin.token);
  assert.equal(dup.status, 400);
  const bob = await api("POST", "/api/admin/users", { name: "Bob", email: "bob@test.local", role: "user", password: "BobTemp123!" }, admin.token);
  const bobId = bob.data.user.id;
  const suspend = await api("POST", `/api/admin/users/${bobId}/action`, { action: "suspend" }, admin.token);
  assert.equal(suspend.status, 200);
  assert.equal(suspend.data.user.active, false);
  const bobLogin = await api("POST", "/api/auth/login", { email: "bob@test.local", password: "BobTemp123!" });
  assert.equal(bobLogin.status, 401);
  const activate = await api("POST", `/api/admin/users/${bobId}/action`, { action: "activate" }, admin.token);
  assert.equal(activate.data.user.active, true);
  const reset = await api("POST", `/api/admin/users/${bobId}/action`, { action: "reset", password: "BobReset123!" }, admin.token);
  assert.equal(reset.status, 200);
  assert.equal(reset.data.user.mustChangePassword, true);
});

test("admin: non-admin cannot access admin endpoints", async () => {
  const admin = await login("admin@test.local", "AdminTest123!");
  await api("POST", "/api/admin/users", { name: "Carol", email: "carol@test.local", role: "user", password: "CarolTemp123!" }, admin.token);
  const carol = await login("carol@test.local", "CarolTemp123!");
  assert.equal((await api("GET", "/api/admin/stats", undefined, carol.token)).status, 403);
  assert.equal((await api("GET", "/api/admin/users", undefined, carol.token)).status, 403);
  assert.equal((await api("POST", "/api/admin/users", { name: "x", email: "x@test.local", role: "user", password: "XTemp123!" }, carol.token)).status, 403);
});

test("tasks: users only see their own tasks and cannot touch others", async () => {
  const admin = await login("admin@test.local", "AdminTest123!");
  await api("POST", "/api/admin/users", { name: "Dana", email: "dana@test.local", role: "user", password: "DanaTemp123!" }, admin.token);
  await api("POST", "/api/admin/users", { name: "Eve", email: "eve@test.local", role: "user", password: "EveTemp123!" }, admin.token);
  const dana = await login("dana@test.local", "DanaTemp123!");
  const eve = await login("eve@test.local", "EveTemp123!");

  const danaTask = await api("POST", "/api/tasks", { title: "Dana secret task", dueDate: "2030-01-01" }, dana.token);
  assert.equal(danaTask.status, 201);
  const eveTask = await api("POST", "/api/tasks", { title: "Eve secret task", dueDate: "2030-01-01" }, eve.token);
  assert.equal(eveTask.status, 201);

  const danaList = await api("GET", "/api/tasks", undefined, dana.token);
  assert.equal(danaList.data.tasks.length, 1);
  assert.equal(danaList.data.tasks[0].title, "Dana secret task");

  const eveList = await api("GET", "/api/tasks", undefined, eve.token);
  assert.equal(eveList.data.tasks.length, 1);
  assert.equal(eveList.data.tasks[0].title, "Eve secret task");

  const steal = await api("GET", "/api/tasks/" + danaTask.data.task.id, undefined, eve.token);
  assert.equal(steal.status, 403);

  const tamper = await api("PATCH", "/api/tasks/" + danaTask.data.task.id, { status: "completed" }, eve.token);
  assert.equal(tamper.status, 403);

  const adminSeesAll = await api("GET", "/api/tasks", undefined, admin.token);
  assert.equal(adminSeesAll.data.tasks.length, 2);
});

test("tasks: status/progress transitions and ownership audit", async () => {
  const admin = await login("admin@test.local", "AdminTest123!");
  const { token } = admin;
  const created = await api("POST", "/api/tasks", { title: "Build feature", status: "not_started" }, token);
  const id = created.data.task.id;
  const upd = await api("PATCH", `/api/tasks/${id}`, { status: "in_progress", progress: 50, priority: "high" }, token);
  assert.equal(upd.status, 200);
  assert.equal(upd.data.task.status, "in_progress");
  assert.equal(upd.data.task.progress, 50);
  const done = await api("PATCH", `/api/tasks/${id}`, { status: "completed" }, token);
  assert.equal(done.data.task.progress, 100);
  const del = await api("DELETE", `/api/tasks/${id}`, undefined, token);
  assert.equal(del.status, 200);
  const gone = await api("GET", `/api/tasks/${id}`, undefined, token);
  assert.equal(gone.status, 404);
});

test("admin: stats and report include per-user task counts", async () => {
  const admin = await login("admin@test.local", "AdminTest123!");
  await api("POST", "/api/tasks", { title: "A task" }, admin.token);
  const stats = await api("GET", "/api/admin/stats", undefined, admin.token);
  assert.equal(stats.status, 200);
  assert.ok(stats.data.totals.tasks >= 1);
  assert.ok(Array.isArray(stats.data.users));
  assert.ok("avgProgress" in stats.data.users[0]);
  const report = await api("GET", "/api/admin/report", undefined, admin.token);
  assert.equal(report.status, 200);
  assert.ok(Array.isArray(report.data.users));
});

test("audit: entries are append-only and appear in activity + admin audit", async () => {
  const admin = await login("admin@test.local", "AdminTest123!");
  await api("POST", "/api/tasks", { title: "Audited task" }, admin.token);
  const act = await api("GET", "/api/activity", undefined, admin.token);
  assert.ok(act.data.activity.some((a) => a.action === "task_created"));
  const adminAudit = await api("GET", "/api/admin/audit?limit=50", undefined, admin.token);
  assert.ok(adminAudit.data.audit.some((a) => a.action === "task_created"));
  assert.ok(!("delete" in adminAudit.data.audit[0]) && !("patch" in adminAudit.data.audit[0]));
  assert.ok("userId" in adminAudit.data.audit[0] && "at" in adminAudit.data.audit[0]);
});

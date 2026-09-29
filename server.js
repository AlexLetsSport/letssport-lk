const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./lib/store");
const { ROLES, visibleGroups, visibleChildren, canEditAttendance, canSeeAllGroups } = require("./lib/roles");
const { familyPeriod, allFamilyPeriods, familyQr } = require("./lib/billing");

const app = express();
const PORT = process.env.PORT || 3780;
const sessions = new Map();

app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname, "public")));

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

function ctx(req) {
  return req.auth || { role: "", familyId: "", trainerId: "" };
}

function isStaff(role) {
  return role === "admin" || role === "director";
}

function monthFrom(db, req) {
  const id = req.query.month || (req.body && req.body.monthId);
  return (db.months || []).find((m) => m.id === id) || db.months[0];
}

function stripSecrets(obj, canSee) {
  if (canSee) return obj;
  const copy = { ...obj };
  delete copy.password;
  delete copy.login;
  return copy;
}

function publicState(db, role, familyId, trainerId, month) {
  const groups = visibleGroups(db, role, familyId, trainerId).map((g) => ({ ...g }));
  const children = visibleChildren(db, role, familyId, trainerId).map((c) => ({ ...c }));
  const groupIds = new Set(groups.map((g) => g.id));
  const childIds = new Set(children.map((c) => c.id));
  const attendance = {};
  for (const [key, val] of Object.entries(db.attendance || {})) {
    const parts = key.split(":");
    if (parts.length === 4) {
      const [, gid, cid] = parts;
      if (groupIds.has(gid) && childIds.has(cid)) attendance[key] = val;
    }
  }
  const sick = {};
  for (const c of children) {
    if (db.sick && db.sick[c.id]) sick[c.id] = db.sick[c.id];
  }

  const staff = isStaff(role);
  const families = staff
    ? (db.families || []).map((f) => stripSecrets(f, role === "director"))
    : role === "parent"
      ? (db.families || []).filter((f) => f.id === familyId).map((f) => ({ ...f }))
      : [];

  const trainers = staff
    ? (db.trainers || []).map((t) => stripSecrets(t, role === "director"))
    : role === "trainer"
      ? (db.trainers || []).filter((t) => t.id === trainerId).map((t) => stripSecrets(t, false))
      : [];

  const period = role === "parent" && familyId ? familyPeriod(db, familyId, month) : null;
  const qrs = role === "parent" && familyId ? familyQr(db, familyId) : [];

  return {
    role,
    roleMeta: ROLES[role] || ROLES.parent,
    familyId,
    trainerId,
    month,
    months: db.months,
    branches: db.branches || [],
    groups,
    children,
    families,
    trainers,
    attendance,
    sick,
    settings: db.settings || {},
    period,
    qrs,
    permissions: {
      editAttendance: canEditAttendance(role),
      staff,
      allGroups: canSeeAllGroups(role)
    }
  };
}

const DEV_CALC = process.env.DEV_CALC !== "0"
  && (process.env.DEV_CALC === "1" || process.env.NODE_ENV !== "production");

app.get("/api/meta", (_req, res) => {
  res.json({ roles: ROLES, devCalc: DEV_CALC });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/login" || req.path === "/meta" || req.path === "/qr-map") return next();
  const token = req.get("X-Session") || "";
  const auth = sessions.get(token);
  if (!auth) return sendError(res, 401, "Сессия истекла. Войдите снова");
  req.auth = auth;
  next();
});

app.post("/api/login", (req, res) => {
  try {
    const result = store.login(req.body && req.body.login, req.body && req.body.password);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
      role: result.role,
      familyId: result.familyId || "",
      trainerId: result.trainerId || ""
    });
    res.json({ ...result, token });
  } catch (err) {
    sendError(res, 401, err.message);
  }
});

app.post("/api/logout", (req, res) => {
  const token = req.get("X-Session") || "";
  sessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/state", (req, res) => {
  try {
    const { role, familyId, trainerId } = ctx(req);
    const db = store.load();
    const month = monthFrom(db, req);
    res.json(publicState(db, role, familyId, trainerId, month));
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.get("/api/periods", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director" && role !== "admin") return sendError(res, 403, "Нет прав");
  try {
    const db = store.load();
    const month = monthFrom(db, req);
    const q = String(req.query.q || "").toLowerCase();
    let rows = allFamilyPeriods(db, month);
    if (q) {
      rows = rows.filter((r) => {
        const kids = db.children.filter((c) => c.familyId === r.family.id).map((c) => c.name).join(" ");
        return (r.family.parentName + " " + r.family.login + " " + kids).toLowerCase().includes(q);
      });
    }
    if (role !== "director") {
      rows = rows.map((row) => ({ ...row, family: stripSecrets(row.family, false) }));
    }
    res.json({ month, rows });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.get("/api/period/:familyId", (req, res) => {
  try {
    const { role, familyId } = ctx(req);
    if (role === "parent" && familyId !== req.params.familyId) return sendError(res, 403, "Нет прав");
    if (role === "trainer") return sendError(res, 403, "Нет прав");
    const db = store.load();
    const month = monthFrom(db, req);
    res.json(familyPeriod(db, req.params.familyId, month));
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.post("/api/attendance", (req, res) => {
  const { role } = ctx(req);
  if (!canEditAttendance(role)) return sendError(res, 403, "Нет прав отмечать посещаемость");
  const { groupId, childId, day, status } = req.body || {};
  if (!groupId || !childId || day == null) return sendError(res, 400, "Нужны groupId, childId и day");
  try {
    res.json(store.setAttendance(groupId, childId, day, role, status, req.body.monthId));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/sick", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Только координатор отмечает больничный");
  const { childId, dates, iso } = req.body || {};
  if (!childId) return sendError(res, 400, "Нужен childId");
  try {
    if (iso) return res.json(store.toggleSickDate(childId, iso));
    res.json(store.setSickDates(childId, dates || []));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/children", (req, res) => {
  const { role } = ctx(req);
  const kind = req.body && req.body.kind === "trial" ? "trial" : "regular";
  if (role === "parent") return sendError(res, 403, "Нет прав");
  if (role === "trainer" && kind !== "trial") return sendError(res, 403, "Тренер добавляет только пробников");
  try {
    res.json(store.addChild({ ...(req.body || {}), kind }, role));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.patch("/api/children/:id", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав редактировать");
  try {
    res.json(store.updateChild(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/children/:id/enroll", (req, res) => {
  const { role } = ctx(req);
  try {
    res.json(store.enrollFromTrial(req.params.id, role));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/children/:id/family", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.assignFamily(req.params.id, (req.body && req.body.familyId) || ""));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/groups/:id/children", (req, res) => {
  const { role } = ctx(req);
  if (role === "parent") return sendError(res, 403, "Нет прав");
  try {
    if (req.body && req.body.childId) {
      if (!isStaff(role)) return sendError(res, 403, "Нет прав");
      return res.json(store.addChildToGroup(req.params.id, req.body.childId));
    }
    const kind = req.body && req.body.kind === "trial" ? "trial" : "regular";
    if (role === "trainer" && kind !== "trial") return sendError(res, 403, "Тренер добавляет только пробников");
    res.json(store.addChild({ ...(req.body || {}), groupId: req.params.id, kind }, role));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.delete("/api/groups/:id/children/:childId", (req, res) => {
  const { role } = ctx(req);
  try {
    res.json(store.removeChildFromGroup(req.params.id, req.params.childId, role));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.delete("/api/children/:id", (req, res) => {
  const { role } = ctx(req);
  try {
    res.json(store.removeChild(req.params.id, role));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/families", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.createFamily(req.body || {}, req.body && req.body.childId));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.patch("/api/families/:id", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.updateFamily(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/groups", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.createGroup(req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.patch("/api/groups/:id", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.updateGroup(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/trainers", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.createTrainer(req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.patch("/api/trainers/:id", (req, res) => {
  const { role } = ctx(req);
  if (!isStaff(role)) return sendError(res, 403, "Нет прав");
  try {
    res.json(store.updateTrainer(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.patch("/api/branches/:id", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель меняет тариф");
  try {
    res.json(store.updateBranch(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/qr/:id", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель");
  const id = req.params.id === "qr2" ? "qr2" : "qr1";
  const dataUrl = req.body && req.body.dataUrl;
  if (!dataUrl || !String(dataUrl).startsWith("data:image")) return sendError(res, 400, "Нужно изображение");
  try {
    const m = String(dataUrl).match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) return sendError(res, 400, "Неверный файл");
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const file = path.join(__dirname, "public", "img", id + "." + ext);
    fs.writeFileSync(file, Buffer.from(m[2], "base64"));
    const mapFile = path.join(__dirname, "public", "img", "qr-map.json");
    let map = {};
    try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); } catch { map = {}; }
    map[id] = "/img/" + id + "." + ext + "?t=" + Date.now();
    fs.writeFileSync(mapFile, JSON.stringify(map));
    res.json({ ok: true, src: map[id] });
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.get("/api/qr-map", (_req, res) => {
  const file = path.join(__dirname, "public", "img", "qr-map.json");
  try {
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    res.json({ qr1: "/img/qr-1.jpg", qr2: "/img/qr-2.jpg" });
  }
});

app.post("/api/pay/parent", (req, res) => {
  const { role, familyId } = ctx(req);
  if (role !== "parent") return sendError(res, 403, "Только родитель");
  try {
    res.json(store.setParentPaid(familyId, req.body && req.body.monthId));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/pay/director", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель");
  const { familyId, incoming, requested } = req.body || {};
  if (!familyId) return sendError(res, 400, "Нужна семья");
  try {
    res.json(store.setDirectorPay(familyId, incoming, requested, req.body.monthId));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.post("/api/pay/opening", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель");
  const { familyId, openingSeed, monthId } = req.body || {};
  if (!familyId) return sendError(res, 400, "Нужна семья");
  try {
    res.json(store.setOpeningSeed(familyId, openingSeed, monthId));
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

app.get("/api/backup", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель может скачать резервную копию");
  try {
    const db = store.load();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="lk-backup-${stamp}.json"`);
    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.post("/api/backup/restore", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель может восстановить базу");
  try {
    const db = req.body;
    const required = ["months", "branches", "groups", "children", "families", "trainers"];
    if (!db || typeof db !== "object" || Array.isArray(db)) {
      return sendError(res, 400, "Файл не содержит объект JSON");
    }
    const missing = required.filter((key) => !Array.isArray(db[key]));
    if (missing.length) {
      return sendError(res, 400, "Это не резервная копия ЛК: нет " + missing.join(", "));
    }
    store.save(db, { backup: true });
    const restored = store.load();
    res.json({
      ok: true,
      children: restored.children.length,
      families: restored.families.length,
      months: restored.months.length
    });
  } catch (err) {
    sendError(res, 400, "Не удалось восстановить базу: " + err.message);
  }
});

app.get("/api/access-export", (req, res) => {
  const { role } = ctx(req);
  if (role !== "director") return sendError(res, 403, "Только руководитель может выгрузить доступы");
  try {
    const db = store.load();
    const childrenByFamily = new Map();
    for (const child of db.children || []) {
      if (!child.familyId) continue;
      const names = childrenByFamily.get(child.familyId) || [];
      names.push(child.name);
      childrenByFamily.set(child.familyId, names);
    }
    const data = {
      exportedAt: new Date().toISOString(),
      staff: (db.users || []).map((user) => ({
        role: user.role,
        name: user.name,
        login: user.login,
        password: user.password
      })),
      trainers: (db.trainers || []).map((item) => ({
        name: item.name,
        sport: item.sport,
        login: item.login,
        password: item.password
      })),
      families: (db.families || []).map((item) => ({
        family: item.parentName,
        children: childrenByFamily.get(item.id) || [],
        login: item.login,
        password: item.password
      }))
    };
    const stamp = new Date().toISOString().slice(0, 10);
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="lk-access-${stamp}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("ЛК «Займемся Спортом»: http://localhost:" + PORT);
});

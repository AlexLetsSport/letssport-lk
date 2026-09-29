const fs = require("fs");
const path = require("path");
const { migrate, needsMigrate, groupLabel } = require("./migrate");
const { attKey, childGroupIds, parseGroupWeekdays, packInfo } = require("./billing");
const { ensureSiteTrainers } = require("./trainers-seed");

const VALDAI_TARIFFS = [
  { id: "vt1", label: "8 занятий × 1,5 ч", packPrice: 9500, packLessons: 8, durationMin: 90 },
  { id: "vt2", label: "12 занятий × 1 ч", packPrice: 9500, packLessons: 12, durationMin: 60 },
  { id: "vt3", label: "8 занятий × 1 ч", packPrice: 7500, packLessons: 8, durationMin: 60 },
  { id: "vt4", label: "16 занятий × 1 ч", packPrice: 11500, packLessons: 16, durationMin: 60 }
];

function durationFromTime(timeStr) {
  const matches = String(timeStr || "").matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g);
  let best = null;
  for (const m of matches) {
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    const diff = end - start;
    if (diff > 0) best = diff >= 80 ? 90 : 60;
  }
  return best;
}

function ensureGroupPack(db, group) {
  const branch = (db.branches || []).find((b) => b.id === group.branchId);
  const fromTime = durationFromTime(group.time || group.name);
  if (fromTime && group.durationMin !== fromTime) {
    group.durationMin = fromTime;
  }
  if (!group.durationMin) group.durationMin = 60;

  if (!(Number(group.packLessons) > 0) || !(Number(group.packPrice) > 0)) {
    if (branch && branch.name === "ВАЛДАЙСКИЙ") {
      if (group.durationMin === 90) {
        group.packPrice = 9500;
        group.packLessons = 8;
      } else {
        group.packPrice = 7500;
        group.packLessons = 8;
      }
    } else {
      const packLessons = Number(db.settings && db.settings.packLessons) || 8;
      group.packLessons = packLessons;
      group.packPrice = group.durationMin === 90
        ? Number(branch && branch.priceHourHalf) || 0
        : Number(branch && branch.priceHour) || 0;
    }
  }
  group.title = groupLabel(group);
  return group;
}

const DATA_FILE = path.join(__dirname, "..", "data", "db.json");
const MAX_BACKUPS = 8;

function writeAtomic(file, json) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file);
}

function rotateBackup() {
  const dir = path.dirname(DATA_FILE);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `db.backup-${stamp}.json`);
  try {
    fs.copyFileSync(DATA_FILE, dest);
  } catch {
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("db.backup-") && f.endsWith(".json")).sort();
  while (files.length > MAX_BACKUPS) {
    const old = files.shift();
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      /* ignore */
    }
  }
}

function load() {
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const beforeMonths = (db.months || []).length;
  const wasNew = needsMigrate(db) || !db.migrated;
  migrate(db);
  let dirty = wasNew || (db.months || []).length !== beforeMonths;
  let parentsFixed = false;
  for (const fam of db.families || []) {
    if (!Array.isArray(fam.parents) || !fam.parents.length) parentsFixed = true;
    normalizeFamily(fam);
  }
  if (parentsFixed) dirty = true;

  db.settings = db.settings || {};
  if (!db.settings.packLessons) {
    db.settings.packLessons = 8;
    dirty = true;
  }
  // Раньше в полях была цена за 1 занятие — переводим в цену за 8
  if (!db.settings.pricesArePack8) {
    const pack = Number(db.settings.packLessons) || 8;
    for (const b of db.branches || []) {
      b.priceHour = Math.round((Number(b.priceHour) || 0) * pack);
      b.priceHourHalf = Math.round((Number(b.priceHourHalf) || 0) * pack);
    }
    db.settings.pricesArePack8 = true;
    dirty = true;
  }

  for (const b of db.branches || []) {
    if (b.name === "ВАЛДАЙСКИЙ" && !b.tariffs) {
      b.tariffs = VALDAI_TARIFFS.map((t) => ({ ...t }));
      b.priceHour = 7500;
      b.priceHourHalf = 9500;
      for (const g of (db.groups || []).filter((x) => x.branchId === b.id)) {
        delete g.packPrice;
        delete g.packLessons;
      }
      db.settings.groupPacksReady = false;
      dirty = true;
    }
  }

  if (!db.settings.groupPacksReady) {
    for (const g of db.groups || []) ensureGroupPack(db, g);
    db.settings.groupPacksReady = true;
    dirty = true;
  } else {
    for (const g of db.groups || []) {
      if (!(Number(g.packLessons) > 0) || !(Number(g.packPrice) > 0)) {
        ensureGroupPack(db, g);
        dirty = true;
      }
    }
  }

  // Демо: ребёнок в группах 1 ч и 1,5 ч — сводная таблица в ЛК родителя
  if (!db.settings.demoMixedDurationChild) {
    const child = (db.children || []).find((c) => /Шиманов\s+Арт[её]м/i.test(c.name))
      || (db.children || []).find((c) => c.id === "c89");
    if (child) {
      const ids = [...(child.groupIds || (child.groupId ? [child.groupId] : []))];
      const hasHour = ids.some((id) => {
        const g = (db.groups || []).find((x) => x.id === id);
        return g && Number(g.durationMin) !== 90;
      });
      const hasHalf = ids.some((id) => {
        const g = (db.groups || []).find((x) => x.id === id);
        return g && Number(g.durationMin) === 90;
      });
      if (!hasHour) {
        const hour = (db.groups || []).find((g) => Number(g.durationMin) !== 90 && !ids.includes(g.id));
        if (hour) ids.push(hour.id);
      }
      if (!hasHalf) {
        const half = (db.groups || []).find((g) => Number(g.durationMin) === 90 && !ids.includes(g.id));
        if (half) ids.push(half.id);
      }
      if (ids.length >= 2) {
        child.groupIds = ids;
        child.groupId = ids[0];
        db.settings.demoMixedDurationChild = true;
        dirty = true;
      }
    }
  }

  if (ensureSiteTrainers(db)) dirty = true;

  if (dirty) save(db, { backup: wasNew });
  return db;
}

function save(db, opts) {
  if (opts && opts.backup) rotateBackup();
  writeAtomic(DATA_FILE, JSON.stringify(db, null, 2));
}

function mutate(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

function nextId(items, prefix) {
  let max = 0;
  for (const x of items || []) {
    const n = Number(String(x.id).replace(/^[a-z]+/i, ""));
    if (n > max) max = n;
  }
  return prefix + (max + 1);
}

function monthOf(db, monthId) {
  return (db.months || []).find((m) => m.id === monthId) || db.months[0];
}

function getChild(db, id) {
  return (db.children || []).find((c) => c.id === id);
}

function getGroup(db, id) {
  return (db.groups || []).find((g) => g.id === id);
}

function login(loginName, password) {
  const db = load();
  const name = String(loginName || "").trim();
  const pass = String(password || "");
  const user = (db.users || []).find((u) => u.login === name && u.password === pass);
  if (user) return { role: user.role, name: user.name, familyId: "", trainerId: "" };
  const trainer = (db.trainers || []).find((t) => t.login === name && t.password === pass);
  if (trainer) return { role: "trainer", name: trainer.name, familyId: "", trainerId: trainer.id };
  const family = (db.families || []).find((f) => f.login === name && f.password === pass);
  if (family) return { role: "parent", name: family.parentName, familyId: family.id, trainerId: "" };
  throw new Error("Неверный логин или пароль");
}

function nextMark(child, current, role) {
  if (current === "sick") return "sick";
  const trial = child.kind === "trial";
  if (trial) {
    if (!current) return "trial0";
    if (current === "trial0") return "trial500";
    if (current === "trial500") return "";
    if (current === "present") return ""; // старый +, снимаем
    return "trial0";
  }
  // После зачисления отметки пробного 0/500 сохраняются и крутятся отдельно;
  // пустые клетки — как у обычных (+).
  if (current === "trial0") return "trial500";
  if (current === "trial500") return "trial0";
  if (!current) return "present";
  if (current === "present") return "";
  return "present";
}

function setAttendance(groupId, childId, day, role, forced, monthId) {
  return mutate((db) => {
    const child = getChild(db, childId);
    const group = getGroup(db, groupId);
    if (!child || !group) throw new Error("Ребёнок или группа не найдены");
    if (!(childGroupIds(child).includes(groupId))) throw new Error("Ребёнок не в этой группе");
    const month = monthOf(db, monthId);
    const key = attKey(month.id, groupId, childId, Number(day));
    const sickList = (db.sick && db.sick[child.id]) || [];
    const iso = `${month.id}-${String(day).padStart(2, "0")}`;
    if (sickList.includes(iso)) {
      if (role === "trainer") throw new Error("Больничный нельзя менять");
      return { mark: "sick" };
    }
    let next;
    if (forced === undefined || forced === null) {
      next = nextMark(child, db.attendance[key] || "", role);
    } else {
      next = forced;
    }
    if (next) db.attendance[key] = next;
    else delete db.attendance[key];
    return { mark: next || "" };
  });
}

function setSickDates(childId, dates) {
  return mutate((db) => {
    const child = getChild(db, childId);
    if (!child) throw new Error("Ребёнок не найден");
    db.sick = db.sick || {};
    const uniq = [...new Set((dates || []).filter(Boolean))].sort();
    db.sick[childId] = uniq;
    return { dates: uniq };
  });
}

function toggleSickDate(childId, iso) {
  return mutate((db) => {
    const child = getChild(db, childId);
    if (!child) throw new Error("Ребёнок не найден");
    db.sick = db.sick || {};
    const list = db.sick[childId] || [];
    const i = list.indexOf(iso);
    if (i >= 0) list.splice(i, 1);
    else list.push(iso);
    db.sick[childId] = list.sort();
    return { dates: db.sick[childId] };
  });
}

function stampTrialDay(db, child, groupId, dayHint) {
  if (!child || child.kind !== "trial" || !groupId) return;
  const month = db.months[0];
  if (!month) return;
  let day = Number(dayHint) || 0;
  const now = new Date();
  if (!day) {
    if (now.getFullYear() === month.year && now.getMonth() + 1 === month.month) day = now.getDate();
    else day = month.days[0].day;
  }
  if (!month.days.some((d) => d.day === day)) day = month.days[0].day;
  db.attendance = db.attendance || {};
  db.attendance[attKey(month.id, groupId, child.id, day)] = "trial0";
}

function addChild(fields, role) {
  return mutate((db) => {
    const name = String(fields.name || "").trim();
    if (!name) throw new Error("Нужно имя");
    const groupId = fields.groupId;
    const existing = db.children.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing && groupId) {
      if (childGroupIds(existing).includes(groupId)) throw new Error("Этот ребёнок уже есть в таблице");
      existing.groupIds = [...childGroupIds(existing), groupId];
      existing.groupId = existing.groupIds[0];
      if (fields.kind === "trial") existing.kind = "trial";
      if (existing.kind === "trial") stampTrialDay(db, existing, groupId, fields.day);
      return existing;
    }
    let familyId = fields.familyId || "";
    if (!familyId) {
      const fam = createFamilyRecord(db, { parentName: "Родитель " + name.split(/\s+/)[0] });
      familyId = fam.id;
    }
    const child = {
      id: nextId(db.children, "c"),
      name,
      groupId: groupId || "",
      groupIds: groupId ? [groupId] : [],
      familyId,
      discountPercent: null,
      documents: {
        doctor: false,
        insurance: "",
        certificate: false,
        application: false
      },
      kind: fields.kind === "trial" ? "trial" : "regular",
      addedBy: role || "admin"
    };
    db.children.push(child);
    if (child.kind === "trial" && groupId) stampTrialDay(db, child, groupId, fields.day);
    return child;
  });
}

function updateChild(id, patch) {
  return mutate((db) => {
    const child = getChild(db, id);
    if (!child) throw new Error("Ребёнок не найден");
    if (patch.name != null) child.name = String(patch.name).trim() || child.name;
    if (patch.kind) child.kind = patch.kind;
    if (patch.documents) {
      child.documents = { ...(child.documents || {}), ...patch.documents };
    }
    if (Array.isArray(patch.groupIds)) {
      child.groupIds = [...new Set(patch.groupIds)];
      child.groupId = child.groupIds[0] || "";
    }
    if (patch.familyId !== undefined) child.familyId = patch.familyId;
    return child;
  });
}

/** Пробный → постоянный в тех же группах; отметки 0/500 не трогаем. */
function enrollFromTrial(id, role) {
  return mutate((db) => {
    const child = getChild(db, id);
    if (!child) throw new Error("Ребёнок не найден");
    if (child.kind !== "trial") throw new Error("Ученик уже зачислен");
    if (role === "parent") throw new Error("Нет прав");
    if (role === "trainer" && !(child.addedBy === "trainer")) {
      throw new Error("Тренер может зачислить только своего пробника");
    }
    if (!childGroupIds(child).length) throw new Error("Сначала нужна группа");
    child.kind = "regular";
    return child;
  });
}

function addChildToGroup(groupId, childId) {
  return mutate((db) => {
    const child = getChild(db, childId);
    const group = getGroup(db, groupId);
    if (!child || !group) throw new Error("Ребёнок или группа не найдены");
    const ids = childGroupIds(child);
    if (ids.includes(groupId)) throw new Error("Этот ребёнок уже есть в таблице");
    child.groupIds = [...ids, groupId];
    child.groupId = child.groupIds[0];
    return child;
  });
}

function removeChildFromGroup(groupId, childId, role) {
  return mutate((db) => {
    const child = getChild(db, childId);
    if (!child) throw new Error("Ребёнок не найден");
    if (role === "trainer" && !(child.addedBy === "trainer" && child.kind === "trial")) {
      throw new Error("Тренер не может удалять тех, кого внёс координатор");
    }
    child.groupIds = childGroupIds(child).filter((g) => g !== groupId);
    child.groupId = child.groupIds[0] || "";
    return { ok: true };
  });
}

function removeChild(id, role) {
  return mutate((db) => {
    const child = getChild(db, id);
    if (!child) throw new Error("Ребёнок не найден");
    if (role === "trainer" && !(child.addedBy === "trainer" && child.kind === "trial")) {
      throw new Error("Тренер не может удалять тех, кого внёс координатор");
    }
    db.children = db.children.filter((c) => c.id !== id);
    return { ok: true };
  });
}

function createFamilyRecord(db, fields) {
  const name = String(fields.parentName || "Родитель").trim();
  const phone = String(fields.phone || "");
  const email = String(fields.email || "");
  const fam = {
    id: nextId(db.families, "f"),
    login: "",
    password: String(100000 + Math.floor(Math.random() * 900000)),
    parentName: name,
    phone,
    email,
    parents: [{
      id: "fp1",
      name,
      phone,
      email
    }]
  };
  db.families.push(fam);
  fam.login = "sem" + fam.id.replace(/\D/g, "");
  return fam;
}

function normalizeFamily(fam) {
  if (!fam) return fam;
  if (!Array.isArray(fam.parents) || !fam.parents.length) {
    fam.parents = [{
      id: "fp1",
      name: fam.parentName || "Родитель",
      phone: fam.phone || "",
      email: fam.email || ""
    }];
  }
  fam.parents = fam.parents.map((p, i) => ({
    id: p.id || ("fp" + (i + 1)),
    name: String(p.name || "Родитель").trim(),
    phone: String(p.phone || ""),
    email: String(p.email || "")
  }));
  fam.parentName = fam.parents[0].name;
  fam.phone = fam.parents[0].phone;
  fam.email = fam.parents[0].email;
  return fam;
}

function syncFamilyLegacy(fam) {
  if (!fam.parents || !fam.parents.length) return fam;
  fam.parentName = fam.parents[0].name;
  fam.phone = fam.parents[0].phone || "";
  fam.email = fam.parents[0].email || "";
  return fam;
}

function createFamily(fields, childId) {
  return mutate((db) => {
    const fam = createFamilyRecord(db, fields || {});
    if (childId) {
      const child = getChild(db, childId);
      if (child) child.familyId = fam.id;
    }
    return normalizeFamily(fam);
  });
}

function updateFamily(id, patch) {
  return mutate((db) => {
    const fam = (db.families || []).find((f) => f.id === id);
    if (!fam) throw new Error("Семья не найдена");
    normalizeFamily(fam);
    if (patch.login != null) fam.login = String(patch.login);
    if (patch.password != null) fam.password = String(patch.password);
    if (Array.isArray(patch.parents) && patch.parents.length) {
      fam.parents = patch.parents.map((p, index) => ({
        id: String(p.id || `fp${index + 1}`),
        name: String(p.name || "Родитель").trim(),
        phone: String(p.phone || ""),
        email: String(p.email || "")
      }));
    }

    if (patch.addParent) {
      const p = patch.addParent;
      const next = nextId(fam.parents.map((x) => ({ id: x.id })), "fp");
      fam.parents.push({
        id: next,
        name: String(p.name || "Родитель").trim(),
        phone: String(p.phone || ""),
        email: String(p.email || "")
      });
    }
    if (patch.parent && patch.parent.id) {
      const cur = fam.parents.find((x) => x.id === patch.parent.id);
      if (!cur) throw new Error("Родитель не найден");
      if (patch.parent.name != null) cur.name = String(patch.parent.name).trim() || cur.name;
      if (patch.parent.phone != null) cur.phone = String(patch.parent.phone);
      if (patch.parent.email != null) cur.email = String(patch.parent.email);
    }
    if (patch.removeParentId) {
      if (fam.parents.length <= 1) throw new Error("В семье должен остаться хотя бы один родитель");
      fam.parents = fam.parents.filter((x) => x.id !== patch.removeParentId);
    }

    // совместимость со старой формой
    if (patch.parentName != null || patch.phone != null || patch.email != null) {
      if (!fam.parents[0]) fam.parents[0] = { id: "fp1", name: "Родитель", phone: "", email: "" };
      if (patch.parentName != null) fam.parents[0].name = String(patch.parentName).trim() || fam.parents[0].name;
      if (patch.phone != null) fam.parents[0].phone = String(patch.phone);
      if (patch.email != null) fam.parents[0].email = String(patch.email);
    }

    if (patch.discountPercent !== undefined) {
      if (patch.discountPercent === null || patch.discountPercent === "" || patch.discountPercent === "auto") {
        delete fam.discountPercent;
      } else {
        fam.discountPercent = Math.max(0, Math.min(100, Number(patch.discountPercent) || 0));
      }
    }

    syncFamilyLegacy(fam);
    return fam;
  });
}

function assignFamily(childId, familyId) {
  return mutate((db) => {
    const child = getChild(db, childId);
    if (!child) throw new Error("Ребёнок не найден");
    if (!familyId) {
      const fam = createFamilyRecord(db, { parentName: "Родитель " + child.name.split(/\s+/)[0] });
      child.familyId = fam.id;
      return { child, family: fam };
    }
    const fam = (db.families || []).find((f) => f.id === familyId);
    if (!fam) throw new Error("Семья не найдена");
    child.familyId = familyId;
    return { child, family: fam };
  });
}

function createGroup(fields) {
  return mutate((db) => {
    const branch = (db.branches || []).find((b) => b.id === fields.branchId);
    if (!branch) throw new Error("Филиал не найден");
    const sport = fields.sport === "hg" ? "hg" : "sambo";
    const weekdays = Array.isArray(fields.weekdays) && fields.weekdays.length
      ? fields.weekdays
      : parseGroupWeekdays(fields.time || "");
    const g = {
      id: nextId(db.groups, "g"),
      name: "",
      branchId: branch.id,
      sport,
      durationMin: Number(fields.durationMin) === 90 ? 90 : 60,
      time: String(fields.time || "").trim(),
      weekdays
    };
    const sportName = sport === "hg" ? "ХГ" : "САМБО";
    g.name = `${sportName} ${branch.name} (${(g.weekdays || []).join("/")} ${g.time})`.trim();
    if (fields.packPrice != null) g.packPrice = Number(fields.packPrice) || 0;
    if (fields.packLessons != null) g.packLessons = Number(fields.packLessons) || 8;
    ensureGroupPack(db, g);
    db.groups.push(g);
    return g;
  });
}

function updateGroup(id, patch) {
  return mutate((db) => {
    const g = getGroup(db, id);
    if (!g) throw new Error("Группа не найдена");
    if (patch.durationMin) g.durationMin = Number(patch.durationMin) === 90 ? 90 : 60;
    if (patch.time != null) g.time = String(patch.time);
    if (Array.isArray(patch.weekdays)) g.weekdays = patch.weekdays;
    if (patch.sport) g.sport = patch.sport;
    if (patch.packPrice != null) g.packPrice = Number(patch.packPrice) || 0;
    if (patch.packLessons != null) g.packLessons = Math.max(1, Number(patch.packLessons) || 8);
    if (patch.tariffId && patch.branchId !== undefined) {
      /* noop */
    }
    if (patch.tariffId) {
      const branch = (db.branches || []).find((b) => b.id === g.branchId);
      const tariff = ((branch && branch.tariffs) || VALDAI_TARIFFS).find((t) => t.id === patch.tariffId);
      if (tariff) {
        g.packPrice = tariff.packPrice;
        g.packLessons = tariff.packLessons;
        g.durationMin = tariff.durationMin;
      }
    }
    const branch = (db.branches || []).find((b) => b.id === g.branchId);
    const sportName = g.sport === "hg" ? "ХГ" : "САМБО";
    g.name = `${sportName} ${branch ? branch.name : ""} (${(g.weekdays || []).join("/")} ${g.time})`.trim();
    g.title = groupLabel(g);
    return g;
  });
}

function updateTrainer(id, patch) {
  return mutate((db) => {
    const t = (db.trainers || []).find((x) => x.id === id);
    if (!t) throw new Error("Тренер не найден");
    if (patch.name != null) t.name = String(patch.name);
    if (patch.login != null) t.login = String(patch.login);
    if (patch.password != null) t.password = String(patch.password);
    if (Array.isArray(patch.groupIds)) t.groupIds = [...new Set(patch.groupIds)];
    if (patch.sport) t.sport = patch.sport;
    return t;
  });
}

function createTrainer(fields) {
  return mutate((db) => {
    const t = {
      id: nextId(db.trainers, "t"),
      name: String(fields.name || "Тренер").trim(),
      sport: fields.sport === "hg" ? "hg" : "sambo",
      login: String(fields.login || "").trim() || ("tr" + Date.now().toString().slice(-4)),
      password: String(fields.password || 100000 + Math.floor(Math.random() * 900000)),
      groupIds: Array.isArray(fields.groupIds) ? fields.groupIds : []
    };
    db.trainers.push(t);
    return t;
  });
}

function updateBranch(id, patch) {
  return mutate((db) => {
    const b = (db.branches || []).find((x) => x.id === id);
    if (!b) throw new Error("Филиал не найден");
    if (patch.priceHour != null) b.priceHour = Number(patch.priceHour) || 0;
    if (patch.priceHourHalf != null) b.priceHourHalf = Number(patch.priceHourHalf) || 0;
    if (patch.qr) b.qr = patch.qr === "qr2" ? "qr2" : "qr1";

    // Цена филиала → во все группы филиала (по длительности группы)
    if (patch.applyToGroups !== false && (patch.priceHour != null || patch.priceHourHalf != null)) {
      const packLessons = Number(db.settings && db.settings.packLessons) || 8;
      for (const g of (db.groups || []).filter((x) => x.branchId === b.id)) {
        const lessons = Number(g.packLessons) > 0 ? Number(g.packLessons) : packLessons;
        g.packLessons = lessons;
        g.packPrice = g.durationMin === 90 ? b.priceHourHalf : b.priceHour;
        g.title = groupLabel(g);
      }
    }
    return b;
  });
}

function setParentPaid(familyId, monthId) {
  return mutate((db) => {
    const month = monthOf(db, monthId);
    const key = `${familyId}:${month.id}`;
    db.familyPayments = db.familyPayments || {};
    const cur = db.familyPayments[key] || {};
    db.familyPayments[key] = {
      ...cur,
      status: "yellow",
      parentClickedAt: new Date().toISOString()
    };
    return db.familyPayments[key];
  });
}

function setDirectorPay(familyId, incoming, requested, monthId) {
  return mutate((db) => {
    const month = monthOf(db, monthId);
    const key = `${familyId}:${month.id}`;
    db.familyPayments = db.familyPayments || {};
    const sum = Number(incoming) || 0;
    const need = Number(requested);
    let status = "green";
    if (!Number.isNaN(need) && sum < need) status = "red";
    if (!Number.isNaN(need) && sum === need) status = "green";
    if (!Number.isNaN(need) && sum > need) status = "green";
    const cur = db.familyPayments[key] || {};
    db.familyPayments[key] = {
      ...cur,
      incoming: sum,
      status,
      directorAt: new Date().toISOString()
    };
    return db.familyPayments[key];
  });
}

/** Остаток на начало месяца: число или null/"" чтобы считать автоматически. */
function setOpeningSeed(familyId, openingSeed, monthId) {
  return mutate((db) => {
    const month = monthOf(db, monthId);
    const key = `${familyId}:${month.id}`;
    db.familyPayments = db.familyPayments || {};
    const cur = db.familyPayments[key] || {};
    const next = { ...cur };
    if (openingSeed == null || openingSeed === "") {
      delete next.openingSeed;
    } else {
      const n = Number(openingSeed);
      if (!Number.isFinite(n)) throw new Error("Некорректная сумма остатка");
      next.openingSeed = Math.round(n * 100) / 100;
    }
    next.openingAt = new Date().toISOString();
    db.familyPayments[key] = next;
    return db.familyPayments[key];
  });
}

module.exports = {
  load,
  save,
  DATA_FILE,
  login,
  monthOf,
  getChild,
  getGroup,
  setAttendance,
  setSickDates,
  toggleSickDate,
  addChild,
  updateChild,
  enrollFromTrial,
  addChildToGroup,
  removeChildFromGroup,
  removeChild,
  createFamily,
  updateFamily,
  assignFamily,
  createGroup,
  updateGroup,
  updateTrainer,
  createTrainer,
  updateBranch,
  setParentPaid,
  setDirectorPay,
  setOpeningSeed,
  normalizeFamily
};

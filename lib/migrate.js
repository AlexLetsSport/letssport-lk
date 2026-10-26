const { parseGroupWeekdays, monthDays, familyKey } = require("./billing");
const { buildSiteTrainers } = require("./trainers-seed");

const BRANCH_ORDER = ["ТИМИРЯЗЕВСКАЯ", "ВАЛДАЙСКИЙ", "ФЕСТИВАЛЬНАЯ", "СЕРЕБРЯНЫЙ", "БЕГОВАЯ", "ПЕТРОЗАВОДСКАЯ"];

function detectBranch(name) {
  const u = String(name).toUpperCase();
  if (u.includes("ВАЛДАЙ")) return "ВАЛДАЙСКИЙ";
  if (u.includes("ТИМИРЯЗ")) return "ТИМИРЯЗЕВСКАЯ";
  if (u.includes("ФЕСТИВАЛ")) return "ФЕСТИВАЛЬНАЯ";
  if (u.includes("СЕРЕБР")) return "СЕРЕБРЯНЫЙ";
  if (u.includes("БЕГОВ")) return "БЕГОВАЯ";
  if (u.includes("ПЕТРОЗАВОД")) return "ПЕТРОЗАВОДСКАЯ";
  return "ДРУГОЙ";
}

function detectSport(name) {
  return /^ХГ/i.test(name) ? "hg" : "sambo";
}

function groupTime(name) {
  const m = String(name).match(/\(([^)]+)\)/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function groupLabel(g) {
  const sport = g.sport === "hg" ? "ХГ" : "Самбо";
  const days = (g.weekdays || []).join("/");
  const dur = g.durationMin === 90 ? "1,5 ч" : "1 ч";
  return `${sport} · ${days} · ${g.time || ""} · ${dur}`.replace(/\s+/g, " ").trim();
}

function lastName(fullName) {
  return String(fullName).trim().split(/\s+/)[0] || "Семья";
}

function needsMigrate(db) {
  return !db.branches || !db.families || !db.trainers || !db.users;
}

const MONTH_LABELS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

function makeMonth(year, month) {
  return {
    id: year + "-" + String(month).padStart(2, "0"),
    label: MONTH_LABELS[month - 1] + " " + year,
    year,
    month,
    days: monthDays(year, month)
  };
}

/** Дописывает месяцы от первого в базе до текущего календарного + 1. */
function ensureMonths(db) {
  if (!db.months) db.months = [];
  const now = new Date();
  let endYear = now.getFullYear();
  let endMonth = now.getMonth() + 2; // текущий + 1
  if (endMonth > 12) {
    endMonth -= 12;
    endYear += 1;
  }

  if (!db.months.length) {
    db.months.push(makeMonth(now.getFullYear(), now.getMonth() + 1));
  }

  db.months.sort((a, b) => (a.year - b.year) || (a.month - b.month));
  const ids = new Set(db.months.map((m) => m.id));
  let y = db.months[0].year;
  let m = db.months[0].month;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const id = y + "-" + String(m).padStart(2, "0");
    if (!ids.has(id)) {
      db.months.push(makeMonth(y, m));
      ids.add(id);
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  db.months.sort((a, b) => (a.year - b.year) || (a.month - b.month));
}

function migrate(db) {
  if (!needsMigrate(db)) {
    ensureMonths(db);
    return db;
  }

  const branchNames = [];
  for (const g of db.groups || []) {
    const b = detectBranch(g.name);
    if (!branchNames.includes(b)) branchNames.push(b);
  }
  branchNames.sort((a, b) => {
    const ia = BRANCH_ORDER.indexOf(a);
    const ib = BRANCH_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  db.branches = branchNames.map((name, i) => ({
    id: "b" + (i + 1),
    name,
    priceHour: 8000,
    priceHourHalf: 12000,
    qr: i < 3 ? "qr1" : "qr2"
  }));

  for (const g of db.groups || []) {
    const bName = detectBranch(g.name);
    const branch = db.branches.find((x) => x.name === bName);
    g.branchId = branch ? branch.id : db.branches[0].id;
    g.sport = detectSport(g.name);
    g.durationMin = bName === "ВАЛДАЙСКИЙ" ? 90 : 60;
    g.time = groupTime(g.name);
    if (!g.weekdays || !g.weekdays.length) g.weekdays = parseGroupWeekdays(g.name);
    g.title = groupLabel(g);
  }

  const famMap = {};
  let fi = 0;
  db.families = [];
  for (const c of db.children || []) {
    if (!c.groupIds) c.groupIds = c.groupId ? [c.groupId] : [];
    if (!c.documents) c.documents = {};
    c.documents.doctor = !!c.documents.certificate;
    if (c.documents.insurance === true) c.documents.insurance = "yes";
    else if (c.documents.insurance !== "yes" && c.documents.insurance !== "no") c.documents.insurance = "";
    const key = familyKey(c.name) || ("solo-" + c.id);
    if (!famMap[key]) {
      fi += 1;
      const id = "f" + fi;
      famMap[key] = id;
      db.families.push({
        id,
        login: "sem" + fi,
        password: "s" + (1000 + fi),
        parentName: "Родитель " + lastName(c.name),
        phone: "",
        email: ""
      });
    }
    c.familyId = famMap[key];
  }

  db.trainers = buildSiteTrainers(db.groups || []);
  db.settings = db.settings || {};
  db.settings.siteTrainersSeeded = true;

  db.users = [
    { login: "coord", password: "coord", role: "admin", name: "Координатор" },
    { login: "boss", password: "boss", role: "director", name: "Руководитель" }
  ];

  db.sick = db.sick || {};
  const month = (db.months && db.months[0]) || { id: "2026-09" };
  const att = db.attendance || {};
  const next = {};
  for (const [key, val] of Object.entries(att)) {
    const parts = key.split(":");
    if (parts.length === 3) {
      const [, childId, day] = parts;
      const child = (db.children || []).find((c) => c.id === childId);
      const gid = child && (child.groupIds[0] || child.groupId);
      if (!gid) continue;
      if (val === "excused") {
        const dates = db.sick[childId] || [];
        const iso = month.id + "-" + String(day).padStart(2, "0");
        if (!dates.includes(iso)) dates.push(iso);
        db.sick[childId] = dates;
        continue;
      }
      next[`${month.id}:${gid}:${childId}:${day}`] = val === "trial" ? "trial500" : val;
    } else {
      next[key] = val === "trial" ? "trial500" : val === "excused" ? val : val;
    }
  }
  db.attendance = next;
  db.familyPayments = db.familyPayments || {};
  db.settings = db.settings || {};
  db.settings.trialPrice = 500;
  db.settings.packLessons = db.settings.packLessons || 8;
  db.settings.pricesArePack8 = true;
  ensureMonths(db);
  db.migrated = true;
  return db;
}

module.exports = { migrate, needsMigrate, detectBranch, groupLabel, BRANCH_ORDER };

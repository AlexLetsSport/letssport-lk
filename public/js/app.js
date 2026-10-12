const role = sessionStorage.getItem("lk-role") || "";
const family = sessionStorage.getItem("lk-family") || "";
const trainer = sessionStorage.getItem("lk-trainer") || "";
const sessionToken = sessionStorage.getItem("lk-session") || "";

if (!role || !sessionToken) location.href = "/";

const headers = () => ({
  "Content-Type": "application/json",
  "X-Session": sessionToken
});

const WEEK_ORDER = ["пн", "вт", "ср", "чт", "пт", "сб", "воскр"];
const WEEK_SHORT = { пн: "Пн", вт: "Вт", ср: "Ср", чт: "Чт", пт: "Пт", сб: "Сб", воскр: "Вс" };
const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const DAYS = [["пн","Пн"],["вт","Вт"],["ср","Ср"],["чт","Чт"],["пт","Пт"],["сб","Сб"],["воскр","Вс"]];

const rub = (n) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n || 0)) + " ₽";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
};

let monthId = "";
let qrMap = { qr1: "/img/qr-1.jpg", qr2: "/img/qr-2.jpg" };
let view = "";
let dirTab = "coord";
let calcTab = "prices";
let selectedGroup = "";
let selectedBranch = "";
let selectedChild = "";
let selectedSport = "";
let selectedTrainer = "";
let selectedFamily = "";
let calMode = sessionStorage.getItem("lk-cal-" + role) || sessionStorage.getItem("lk-cal") || "";
let selectedDay = Number(sessionStorage.getItem("lk-day-" + role) || sessionStorage.getItem("lk-day") || 0);
let sheet = null;
let trainerDraft = {};
let qAthletes = "";
let qParents = "";
let qSick = "";
let showFormula = false;
let showDirFormula = "";
let priceGroupsOpen = {};
let periods = null;
let eye = {};
let state = null;
let devCalcEnabled = false;
let devCalcOpen = false;
let devCalcFamily = "";
let devCalcQ = "";
let devCalcPeriods = null;
let attScroll = { left: 0, top: 0 };
const undoStack = [];
const UNDO_MAX = 25;
let toastTimer = null;

function rememberAttScroll() {
  const w = document.querySelector(".att-wrap");
  if (w) attScroll = { left: w.scrollLeft, top: w.scrollTop };
}

function restoreAttScroll() {
  const w = document.querySelector(".att-wrap");
  if (!w) return;
  w.scrollLeft = attScroll.left;
  w.scrollTop = attScroll.top;
}

function attKeyLocal(monthIdVal, groupId, childId, day) {
  return `${monthIdVal}:${groupId}:${childId}:${day}`;
}

function applyMarkToCell(el, child, groupId, day) {
  if (!el) return;
  const group = (state.groups || []).find((g) => g.id === groupId);
  const mark = cellMark(child, groupId, day);
  const train = isTrainingDay(group, day) ? "is-train" : "";
  el.className = `mark big-mark ${mark.cls} ${train}`.trim();
  el.textContent = mark.text;
}

function pushUndo(entry) {
  undoStack.push({ ...entry, at: Date.now() });
  while (undoStack.length > UNDO_MAX) undoStack.shift();
  renderUndoBtn();
}

function renderUndoBtn() {
  let btn = document.getElementById("undo-btn");
  if (!btn) {
    const top = document.querySelector(".top-slim");
    if (!top) return;
    btn = document.createElement("button");
    btn.id = "undo-btn";
    btn.type = "button";
    btn.className = "btn ghost undo-btn";
    btn.title = "Отменить последнее действие";
    const logout = document.getElementById("logout");
    top.insertBefore(btn, logout || null);
    btn.addEventListener("click", () => { runUndo(); });
  }
  const n = undoStack.length;
  btn.hidden = n === 0;
  btn.disabled = n === 0;
  btn.textContent = n ? `↩ Отменить${n > 1 ? ` (${n})` : ""}` : "↩ Отменить";
}

function showToast(text) {
  let el = document.getElementById("lk-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "lk-toast";
    el.className = "lk-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), 2200);
}

function askConfirm({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const root = document.getElementById("confirm-root");
    if (!root) {
      resolve(window.confirm([title, body].filter(Boolean).join("\n")));
      return;
    }
    root.innerHTML = `
      <div class="confirm-backdrop" data-confirm-cancel></div>
      <div class="confirm-card" role="dialog" aria-modal="true">
        <h3>${esc(title || "Подтвердите действие")}</h3>
        ${body ? `<p>${body}</p>` : ""}
        <div class="confirm-actions">
          <button type="button" class="btn ghost" data-confirm-cancel>Отмена</button>
          <button type="button" class="btn ${danger ? "danger" : ""}" data-confirm-ok>${esc(confirmLabel || "Подтвердить")}</button>
        </div>
      </div>`;
    root.className = "confirm-on";
    const done = (val) => {
      root.className = "";
      root.innerHTML = "";
      resolve(val);
    };
    root.querySelector("[data-confirm-ok]").onclick = () => done(true);
    root.querySelectorAll("[data-confirm-cancel]").forEach((b) => {
      b.onclick = () => done(false);
    });
  });
}

async function runUndo() {
  const entry = undoStack.pop();
  renderUndoBtn();
  if (!entry) return;
  try {
    if (entry.type === "attendance") {
      const res = await api("/api/attendance", "POST", {
        groupId: entry.groupId,
        childId: entry.childId,
        day: entry.day,
        monthId: entry.monthId,
        status: entry.prev || ""
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось отменить");
      const key = attKeyLocal(entry.monthId, entry.groupId, entry.childId, entry.day);
      if (data.mark && data.mark !== "sick") state.attendance[key] = data.mark;
      else delete state.attendance[key];
      const child = state.children.find((c) => c.id === entry.childId);
      const cell = document.querySelector(
        `[data-toggle-mark="${entry.childId}"][data-day="${entry.day}"][data-group="${entry.groupId}"]`
      );
      if (child && cell) applyMarkToCell(cell, child, entry.groupId, entry.day);
      else {
        rememberAttScroll();
        await load();
        restoreAttScroll();
      }
      showToast("Отметка отменена");
      return;
    }
    if (entry.type === "ungroup") {
      const res = await api(`/api/groups/${entry.groupId}/children`, "POST", { childId: entry.childId });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось вернуть в группу");
      rememberAttScroll();
      await load();
      restoreAttScroll();
      showToast("Ребёнок снова в группе");
      return;
    }
    if (entry.type === "sick") {
      const res = await api("/api/sick", "POST", { childId: entry.childId, iso: entry.iso });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось отменить");
      if (data.dates) state.sick[entry.childId] = data.dates;
      rememberAttScroll();
      await load();
      restoreAttScroll();
      showToast("Больничный отменён");
      return;
    }
    if (entry.type === "name") {
      const res = await api("/api/children/" + entry.childId, "PATCH", { name: entry.prev });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось вернуть имя");
      await load();
      showToast("Имя возвращено");
      return;
    }
    if (entry.type === "opening") {
      const res = await api("/api/pay/opening", "POST", {
        familyId: entry.familyId,
        openingSeed: entry.prev,
        monthId: entry.monthId
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось отменить");
      await loadPeriods();
      showToast("Остаток на начало отменён");
      return;
    }
    if (entry.type === "child-patch") {
      const res = await api("/api/children/" + entry.childId, "PATCH", entry.prev);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось отменить изменение");
      await load();
      showToast("Изменение ребёнка отменено");
      return;
    }
    if (entry.type === "family-patch") {
      const res = await api("/api/families/" + entry.familyId, "PATCH", entry.prev);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось отменить изменение семьи");
      await load();
      if (role === "director" && dirTab === "calc" && calcTab === "parents") await loadPeriods();
      showToast("Изменение семьи отменено");
      return;
    }
    if (entry.type === "trainer-patch") {
      const res = await api("/api/trainers/" + entry.trainerId, "PATCH", entry.prev);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось отменить изменение тренера");
      await load();
      showToast("Изменение тренера отменено");
      return;
    }
    showToast("Это действие уже нельзя отменить");
  } catch (err) {
    pushUndo(entry);
    alert(err.message || "Ошибка отмены");
  }
}

async function load() {
  const q = monthId ? ("?month=" + encodeURIComponent(monthId)) : "";
  const [res, qr, meta] = await Promise.all([
    fetch("/api/state" + q, { headers: headers() }),
    fetch("/api/qr-map"),
    fetch("/api/meta")
  ]);
  state = await res.json();
  if (qr.ok) qrMap = Object.assign(qrMap, await qr.json());
  if (meta.ok) {
    const m = await meta.json();
    devCalcEnabled = !!m.devCalc;
  }
  if (!res.ok) {
    document.getElementById("app").innerHTML = `<p class="warn-text">${esc(state.error || "Нет данных")}</p>`;
    renderDevCalc();
    return;
  }
  if (!view) view = defaultView();
  // Не даём «внутренним» view модалки семьи перетирать навигацию кабинета
  const navOk = ["parent", "attendance", "athletes", "sick", "branches", "groups", "group", "trainers", "trainer-sport", "trainer-one"].includes(view);
  if (!navOk) view = defaultView();
  if (!calMode) calMode = role === "trainer" ? "day" : "month";
  if (role === "parent" && calMode === "day") calMode = "month";
  if (!selectedDay) selectedDay = todayDay();
  persistCal();
  render();
}

function defaultView() {
  if (role === "parent") return "parent";
  if (role === "trainer") return "attendance";
  return "branches";
}

function persistCal() {
  sessionStorage.setItem("lk-cal-" + role, calMode);
  sessionStorage.setItem("lk-day-" + role, String(selectedDay));
  sessionStorage.setItem("lk-cal", calMode);
  sessionStorage.setItem("lk-day", String(selectedDay));
}

function api(url, method, body) {
  return fetch(url, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
}

async function downloadProtectedJson(url, fallbackName) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Не удалось скачать файл");
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/i);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = match ? match[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function todayDay() {
  const now = new Date();
  if (now.getFullYear() === state.month.year && now.getMonth() + 1 === state.month.month) return now.getDate();
  return state.month.days[0].day;
}

function isToday(day) {
  const now = new Date();
  return now.getFullYear() === state.month.year && now.getMonth() + 1 === state.month.month && now.getDate() === day;
}

function currentGroup() {
  const list = selectedBranch
    ? state.groups.filter((g) => g.branchId === selectedBranch)
    : state.groups;
  const id = (selectedGroup && list.some((g) => g.id === selectedGroup))
    ? selectedGroup
    : (list[0] && list[0].id) || (state.groups[0] && state.groups[0].id) || "";
  selectedGroup = id;
  return state.groups.find((g) => g.id === id);
}

function rosterKids(group) {
  const g = group || currentGroup();
  if (!g) return [];
  return state.children.filter((c) => (c.groupIds || []).includes(g.id));
}

function groupTitle(g) {
  if (!g) return "Группа";
  return g.title || g.name;
}

function branchName(branchId) {
  const b = (state.branches || []).find((x) => x.id === branchId);
  return b ? b.name : "";
}

function groupTitleFull(g) {
  if (!g) return "Группа";
  const branch = branchName(g.branchId);
  const title = groupTitle(g);
  return branch ? `${branch} · ${title}` : title;
}

function dayMeta(dayNum) {
  return state.month.days.find((d) => d.day === dayNum) || { day: dayNum, weekday: "пн" };
}

function isoOf(day, monthObj) {
  const m = monthObj || state.month;
  return `${m.id}-${String(day).padStart(2, "0")}`;
}

function isSick(childId, day, monthObj) {
  const m = monthObj || state.month;
  return ((state.sick && state.sick[childId]) || []).includes(isoOf(day, m));
}

function attOf(groupId, childId, day, monthObj) {
  const m = monthObj || state.month;
  return state.attendance[`${m.id}:${groupId}:${childId}:${day}`] || "";
}

function cellMark(child, groupId, day, monthObj) {
  const m = monthObj || state.month;
  const group = (state.groups || []).find((g) => g.id === groupId);
  if (isSick(child.id, day, m) && (!group || isTrainingDay(group, day, m))) {
    return { cls: "sick", text: "Б", locked: true };
  }
  const mark = attOf(groupId, child.id, day, m);
  if (mark === "trial0") return { cls: "trial0", text: "0", locked: false };
  if (mark === "trial500") return { cls: "trial500", text: "500", locked: false };
  if (mark === "present") return { cls: "present", text: "+", locked: false };
  return { cls: "", text: "", locked: false };
}

function daysOfMonth(year, monthNum) {
  const count = new Date(year, monthNum, 0).getDate();
  const days = [];
  for (let day = 1; day <= count; day++) {
    const date = new Date(year, monthNum - 1, day);
    days.push({ day, weekday: WEEK_ORDER[(date.getDay() + 6) % 7] });
  }
  return days;
}

function monthRef(year, monthNum) {
  const id = `${year}-${String(monthNum).padStart(2, "0")}`;
  const fromState = (state.months || []).find((m) => m.id === id);
  if (fromState) return fromState;
  return {
    id,
    year,
    month: monthNum,
    label: MONTH_NAMES[monthNum - 1] + " " + year,
    days: daysOfMonth(year, monthNum)
  };
}

function isTrainingDay(group, day, monthObj) {
  const m = monthObj || state.month;
  const d = (m.days || daysOfMonth(m.year, m.month)).find((x) => x.day === day);
  if (!d) return false;
  if (!group || !group.weekdays || !group.weekdays.length) return true;
  return group.weekdays.includes(d.weekday);
}

function countMonthMarks(child, groupId, monthObj) {
  const days = monthObj.days || daysOfMonth(monthObj.year, monthObj.month);
  let present = 0;
  let sick = 0;
  for (const d of days) {
    const mark = cellMark(child, groupId, d.day, monthObj);
    if (mark.text === "+") present += 1;
    if (mark.text === "Б") sick += 1;
  }
  return { present, sick };
}

function weekDays() {
  const date = new Date(state.month.year, state.month.month - 1, selectedDay);
  const mondayShift = (date.getDay() + 6) % 7;
  const start = new Date(date);
  start.setDate(date.getDate() - mondayShift);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(start);
    x.setDate(start.getDate() + i);
    days.push({
      day: x.getDate(),
      inMonth: x.getMonth() === state.month.month - 1 && x.getFullYear() === state.month.year,
      weekday: WEEK_ORDER[(x.getDay() + 6) % 7]
    });
  }
  return days;
}

function monthGrid() {
  const y = state.month.year;
  const m = state.month.month;
  const first = new Date(y, m - 1, 1);
  const pad = (first.getDay() + 6) % 7;
  const count = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < pad; i++) {
    const d = new Date(y, m - 1, 1 - (pad - i));
    cells.push({ day: d.getDate(), inMonth: false });
  }
  for (let day = 1; day <= count; day++) cells.push({ day, inMonth: true });
  while (cells.length % 7) cells.push({ day: cells.length - pad - count + 1, inMonth: false });
  return cells;
}

function trainerColumns() {
  if (calMode === "day") return state.month.days.filter((d) => d.day === selectedDay);
  if (calMode === "week") return weekDays().filter((d) => d.inMonth).map((d) => dayMeta(d.day));
  return state.month.days;
}

function canDelete(child) {
  if (role === "admin" || role === "director") return true;
  return role === "trainer" && child.addedBy === "trainer" && child.kind === "trial";
}

function canEnroll(child) {
  if (!child || child.kind !== "trial") return false;
  if (role === "admin" || role === "director") return true;
  return role === "trainer" && child.addedBy === "trainer";
}

function staffMode() {
  return role === "admin" || (role === "director" && dirTab === "coord");
}

function render() {
  rememberAttScroll();
  renderTabs();
  const app = document.getElementById("app");
  if (role === "parent") app.innerHTML = parentView();
  else if (role === "trainer") app.innerHTML = attendanceScreen();
  else if (role === "director" && dirTab === "calc") app.innerHTML = calcView();
  else app.innerHTML = coordView();
  drawOverlay();
  renderDevCalc();
  renderUndoBtn();
  requestAnimationFrame(() => restoreAttScroll());
}

function renderTabs() {
  const tabs = [];
  if (role === "director") {
    tabs.push(["coord", "Координирование"], ["calc", "Расчёты"]);
  } else if (staffMode()) {
    tabs.push(["athletes", "Спортсмены"], ["sick", "Больничный"], ["branches", "Филиалы"]);
  }
  document.getElementById("tabs").innerHTML = tabs.map(([id, title]) => {
    const branchish = ["branches", "groups", "group", "trainers", "trainer-sport", "trainer-one"].includes(view);
    const on = role === "director"
      ? dirTab === id
      : (id === "branches" ? branchish : view === id);
    return `<button class="${on ? "" : "is-off"}" data-tab="${id}">${title}</button>`;
  }).join("");
}

function calToolbar(showGroup) {
  const modes = [["day", "День"], ["week", "Неделя"], ["month", "Месяц"], ["year", "Год"]];
  const g = currentGroup();
  const groupBtn = showGroup ? `
    <button class="group-pick" type="button" data-open-groups>
      <span>${esc(groupTitle(g))}</span>
    </button>` : "";
  return `
    <div class="gcal-bar">
      <div class="gcal-modes">
        ${modes.map(([id, t]) => `<button type="button" class="${calMode === id ? "is-on" : ""}" data-cal="${id}">${t}</button>`).join("")}
      </div>
      <button type="button" class="btn ghost today-btn" data-today>Сегодня</button>
    </div>
    ${groupBtn}
    <div class="gcal-title">${calMode === "year" ? state.month.year : `${MONTH_NAMES[state.month.month - 1]} ${state.month.year}`}</div>
  `;
}

function attTable(opts) {
  const group = opts.group || currentGroup();
  const kids = opts.kids || rosterKids(group);
  const clickable = !!opts.clickable;
  const gid = group && group.id;
  if (calMode === "year") {
    const year = state.month.year;
    const months = MONTH_NAMES.map((name, i) => {
      const active = i + 1 === state.month.month;
      return `<th class="${active ? "is-now is-on" : ""}" data-pick-month="${i + 1}">${name.slice(0, 3)}</th>`;
    }).join("");
    const rows = kids.map((c) => {
      const cells = MONTH_NAMES.map((_, i) => {
        const mref = monthRef(year, i + 1);
        const { present, sick } = countMonthMarks(c, gid, mref);
        const active = i + 1 === state.month.month;
        const has = present || sick;
        const label = has ? (sick ? `${present}/${sick}` : String(present)) : "—";
        return `<td class="year-cell ${active ? "is-now" : ""} ${has ? "has-marks" : "is-out"}" data-pick-month="${i + 1}">${label}</td>`;
      }).join("");
      return `<tr>
        <th class="sticky ${c.kind === "trial" ? "name-trial" : ""}">${esc(c.name)}${c.kind === "trial" ? " <em>пробный</em>" : ""}</th>
        ${cells}
      </tr>`;
    }).join("");
    return `<div class="att-wrap"><table class="att-table att-year"><thead><tr><th class="sticky">Фамилия</th>${months}</tr></thead><tbody>${rows || "<tr><td class=\"sticky\">Никого нет</td></tr>"}</tbody></table></div>
      <p class="hint">Год ${year}: в ячейке число «+» за месяц${" / Б"}. Нажмите месяц, чтобы открыть его подробно.</p>`;
  }
  const cols = trainerColumns();
  const head = cols.map((d) => `
    <th class="${isToday(d.day) ? "is-today" : ""} ${isTrainingDay(group, d.day) ? "is-train" : ""} ${d.day === selectedDay ? "is-on" : ""}" data-pick-day="${d.day}">
      <small>${WEEK_SHORT[d.weekday]}</small>${d.day}
    </th>`).join("");
  const rows = kids.map((c) => {
    const del = opts.deletable && canDelete(c)
      ? `<button class="icon-del" data-ungroup="${c.id}" type="button" aria-label="Убрать">×</button>`
      : "";
    const enroll = canEnroll(c)
      ? `<button class="btn-enroll" data-enroll="${c.id}" type="button">В группу</button>`
      : "";
    const cells = cols.map((d) => {
      const mark = cellMark(c, gid, d.day);
      const open = clickable && !mark.locked ? `data-toggle-mark="${c.id}" data-day="${d.day}" data-group="${gid}"` : "";
      return `<td class="mark big-mark ${mark.cls} ${isTrainingDay(group, d.day) ? "is-train" : ""}" ${open}>${mark.text}</td>`;
    }).join("");
    const trialTag = c.kind === "trial" ? `<span class="trial-tag">пробный</span>` : "";
    return `<tr>
      <th class="sticky ${c.kind === "trial" ? "name-trial" : ""}">
        <span class="name-row">${esc(c.name)} ${trialTag}</span>
        <span class="name-actions">${enroll}${del}</span>
      </th>
      ${cells}
    </tr>`;
  }).join("");
  const strip = calMode === "week" ? weekStrip() : "";
  return `${strip}<div class="att-wrap"><table class="att-table"><thead><tr><th class="sticky">Фамилия</th>${head}</tr></thead>
    <tbody>${rows || `<tr><td class="sticky">Никого нет</td>${cols.map(() => "<td></td>").join("")}</tr>`}</tbody></table></div>`;
}

function weekStrip() {
  const days = weekDays();
  return `<div class="week-strip">${days.map((d) => `
    <button type="button" class="week-day ${d.inMonth && d.day === selectedDay ? "is-on" : ""} ${d.inMonth ? "" : "is-out"} ${d.inMonth && isToday(d.day) ? "is-today" : ""}" data-pick-day="${d.inMonth ? d.day : ""}" ${d.inMonth ? "" : "disabled"}>
      <small>${WEEK_SHORT[d.weekday]}</small><strong>${d.day}</strong>
    </button>`).join("")}</div>`;
}

function addTrialForm() {
  const label = role === "trainer" ? "Пробник без записи" : "Фамилия Имя";
  const extra = (role === "admin" || role === "director")
    ? `<label class="trial-check"><input type="checkbox" name="trial"> пробный</label>`
    : `<input type="hidden" name="trialForced" value="1">`;
  return `<form class="add-bar" id="add-child">
    <input name="name" placeholder="${label}" required>
    ${extra}
    <button class="btn" type="submit">Добавить</button>
  </form>`;
}

function attendanceScreen() {
  const g = currentGroup();
  const staff = staffMode();
  const back = staff && view === "group"
    ? `<button class="btn ghost" type="button" data-back-nav="groups">← ${esc(branchName(g && g.branchId) || "К группам")}</button>`
    : "";
  return `
    <div class="gcal gcal-table">
      ${monthSwitch()}
      ${back}
      ${calToolbar(true)}
      ${attTable({ clickable: true, deletable: true, group: g })}
      ${addTrialForm()}
      ${staff ? addExistingForm() : ""}
    </div>`;
}

function addExistingForm() {
  const g = currentGroup();
  const inGroup = new Set(rosterKids(g).map((c) => c.id));
  const others = state.children.filter((c) => !inGroup.has(c.id)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return `<form class="add-bar" id="add-existing">
    <select name="childId" required>
      <option value="">Добавить из списка…</option>
      ${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
    </select>
    <button class="btn ghost" type="submit">В группу</button>
  </form>`;
}

function periodPhase(month) {
  if (!month) return "current";
  const now = new Date();
  const start = new Date(month.year, month.month - 1, 1);
  const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);
  if (now < start) return "upcoming";
  if (now > end) return "closed";
  return "current";
}

function periodPhaseLabel(phase) {
  if (phase === "closed") return "завершён";
  if (phase === "upcoming") return "ещё не начался";
  return "сейчас идёт";
}

function monthSwitch() {
  if (!state.months || !state.months.length) return "";
  return `<div class="subtabs period-tabs">${state.months.map((m) => {
    const phase = periodPhase(m);
    const tag = phase === "closed" ? " · завершён" : phase === "current" ? " · сейчас" : "";
    return `<button type="button" class="${state.month.id === m.id ? "" : "is-off"}" data-month="${m.id}">${esc(m.label)}${tag}</button>`;
  }).join("")}</div>`;
}

function parentPeriodBanner() {
  const m = state.month;
  const phase = periodPhase(m);
  const phaseText = periodPhaseLabel(phase);
  let extra = "Расчёт и счёт ниже закреплены за этим месяцем.";
  if (phase === "upcoming") {
    extra = "Будущий период: виден аванс и счёт. На начало уже учтён перенос за «Б» (до 4 занятий) или долг с прошлого месяца.";
  } else if (phase === "closed") {
    extra = "Период завершён. На следующий месяц уходит только компенсация за «Б» (макс. 4 занятия) минус долг. Неиспользованный аванс не переносится.";
  } else if (phase === "current") {
    extra = "Месяц идёт: списания за «+». Несгоревший аванс на октябрь сам не перейдёт — только «Б» по справке (до 4 занятий).";
  }
  return `
    <div class="period-banner period-${phase}">
      <p class="period-banner-title">Платёжный период · ${esc(m.label)}</p>
      <p class="period-banner-meta">Период <b>${phaseText}</b>. ${extra}</p>
    </div>`;
}

function parentPayBlocks(p, phase) {
  const qrs = (state.qrs || ["qr1"]).map((id) => `
    <figure>
      <img src="${qrMap[id] || "/img/qr-1.jpg"}" alt="QR">
      <figcaption>${id === "qr2" ? "QR 2" : "QR 1"}</figcaption>
    </figure>`).join("");
  const paid = p.status === "yellow" || p.status === "green";
  const endLabel = phase === "closed"
    ? "Перенос на следующий месяц"
    : phase === "current"
      ? "Перенос (если месяц закрыть сейчас)"
      : "";
  const balHint = phase === "upcoming"
    ? `<p class="hint">Перенос с прошлого: компенсация за «Б» (до 4) или долг. Неиспользованный аванс прошлого месяца сюда не входит.</p>`
    : phase === "closed"
      ? `<p class="hint">Перенос = компенсация за «Б» (макс. ${p.sickCarryMax || 4} зан.${p.sickCarrySessions != null ? `: ${p.sickCarrySessions}` : ""}${p.sickCarry ? ` · ${rub(p.sickCarry)}` : ""}) − долг. Сдача с аванса сгорает${p.forfeit ? ` (${rub(p.forfeit)})` : ""}.</p>`
      : `<p class="hint">Сейчас к переносу: за «Б» ${rub(p.sickCarry || 0)} (учтено ${(p.sickCarrySessions || 0)}/${p.sickCarryMax || 4})${p.sickCarryCapped ? " · лимит" : ""}${(p.unpaid || 0) > 0 ? ` − долг ${rub(p.unpaid)}` : ""}. Несписанный аванс не переносится${p.forfeit ? ` · сгорит ${rub(p.forfeit)}` : ""}.</p>`;

  return `
    <article class="child-card">
      <p class="card-period-tag">Баланс · ${esc(state.month.label)}${phase === "closed" ? " · завершён" : phase === "upcoming" ? " · ещё впереди" : " · сейчас"}</p>
      <div class="pay">
        <div><span>Остаток на начало месяца</span><strong>${rub(p.opening)}</strong></div>
        <div><span>Аванс за ${esc(state.month.label)}</span><strong>${rub(p.advance)}</strong></div>
        ${endLabel ? `<div><span>${endLabel}</span><strong>${rub(p.balance)}</strong></div>` : ""}
      </div>
      ${balHint}
    </article>
    <article class="child-card">
      <p class="card-period-tag">Счёт · ${esc(state.month.label)}</p>
      <div class="pay"><div><span>Итого к оплате</span><strong>${rub(Math.max(0, p.amountDue))}</strong></div></div>
      ${p.discountPercent ? `<p class="hint">Скидка многодетных ${p.discountPercent}%</p>` : ""}
      <button class="btn ghost" type="button" data-toggle-formula>${showFormula ? "Скрыть формулу" : "Показать формулу"}</button>
      ${showFormula ? formulaHtml(p, phase) : ""}
    </article>
    <article class="child-card pay-how">
      <h2>Как оплатить</h2>
      <p class="hint">Оплата относится к периоду ${esc(state.month.label)}</p>
      <div class="qr-row">${qrs}</div>
      <label class="field">Сумма<input value="${Math.round(Math.max(0, p.amountDue || 0))}" readonly></label>
      <button class="btn pay-btn ${paid ? "is-paid" : ""}" type="button" data-parent-pay ${paid ? "disabled" : ""}>
        ${p.status === "green" ? "Оплачено" : p.status === "yellow" ? "Ожидает подтверждения" : "Оплатил"}
      </button>
    </article>`;
}

function parentChildCalendarSection() {
  const child = state.children.find((c) => c.id === selectedChild);
  if (!child) return `<p class="hint">Ребёнок не найден</p>`;
  const row = (state.period && state.period.perChild || []).find((x) => x.childId === child.id);
  const groups = row && row.groups ? row.groups : [];
  const summary = groups.map((g) => `
    <div class="group-sum-card">
      <strong>${esc(g.branch ? g.branch + " · " : "")}${esc(g.title)}</strong>
      <p>${esc(g.durationLabel)} · пакет ${rub(g.packPrice)} / ${g.packLessons} = <b>${rub(g.unit)}</b> за занятие</p>
      <div class="pay">
        <div><span>Занятий в месяце</span><strong>${g.sessions}</strong></div>
        <div><span>Аванс</span><strong>${rub(g.advance)}</strong></div>
        <div><span>Был / Б</span><strong>${g.present} / ${g.sickCount}</strong></div>
      </div>
    </div>`).join("");
  return `
    <div class="gcal gcal-table parent-child">
      <h2>Календарь · ${esc(child.name)}</h2>
      <p class="note">«Б» только в дни занятий группы — те же числа, что в «Был / Б». Счёт и оплата за период — ниже.</p>
      <div class="group-sum-grid">${summary || "<p class=\"hint\">Нет групп</p>"}</div>
      ${calToolbar(false)}
      <h3 class="sheet-section">Таблица посещений</h3>
      ${parentCombinedAtt(child)}
    </div>`;
}

function parentView() {
  const p = state.period || {};
  const phase = periodPhase(state.month);
  const kids = (p.perChild || []).map((row) => {
    const groups = row.groups || [];
    const groupLines = groups.map((g) => `
      <div class="group-line">
        <span class="group-line-main">${esc(g.branch ? g.branch + " · " : "")}${esc(g.title)}</span>
        <span class="group-line-meta">${esc(g.durationLabel)} · ${g.sessions} зан. × ${rub(g.unit)} = <b>${rub(g.advance)}</b></span>
        <span class="group-line-meta">был ${g.present} · Б ${g.sickCount}</span>
      </div>`).join("");
    return `
    <article class="child-card parent-child-card ${selectedChild === row.childId ? "is-open-child" : ""}">
      <h2 class="${row.kind === "trial" ? "name-trial" : ""}">${esc(row.name)}${row.kind === "trial" ? " · пробный" : ""}</h2>
      ${groups.length > 1 ? `<p class="hint">Ходит в ${groups.length} группы — данные сведены ниже</p>` : ""}
      <div class="group-lines">${groupLines || "<p class=\"hint\">Нет группы</p>"}</div>
      <div class="pay">
        <div><span>Был / Б</span><strong>${row.present} / ${row.sickCount}</strong></div>
      </div>
      <button class="btn child-open-btn" type="button" data-open-child="${row.childId}">
        ${selectedChild === row.childId ? "Свернуть календарь" : "Календарь посещений"}
      </button>
    </article>`;
  }).join("");

  return `
    <div class="parent-shell">
      <div class="parent-home">
        ${monthSwitch()}
        ${parentPeriodBanner()}
        <div class="child-grid">${kids || "<p class=\"hint\">Нет детей в семье</p>"}</div>
      </div>
      ${selectedChild ? parentChildCalendarSection() : ""}
      <div class="parent-home">
        ${parentPayBlocks(p, phase)}
      </div>
    </div>`;
}

function formulaHtml(p, phase) {
  const phaseNow = phase || periodPhase(state.month);
  const kids = (p.perChild || []).map((c) => {
    const visits = (c.formula || []).filter((l) => l.day != null || l.mark);
    const adv = (c.formula || []).filter((l) => l.sessions != null);
    const groupBits = (c.groups || []).map((g) =>
      `<li class="f-adv">${esc(g.branch ? g.branch + " · " : "")}${esc(g.title)} · ${esc(g.durationLabel)} · ${g.sessions}×${rub(g.unit)} = <b>${rub(g.advance)}</b></li>`
    ).join("");
    return `<details class="formula-child" open>
      <summary><b>${esc(c.name)}</b>${c.kind === "trial" ? " · пробный" : ""} —
        аванс ${rub(c.advance)}, списано ${rub(c.spent)}, был ${c.present}, Б ${c.sickCount}${c.trial500 ? ", 500×" + c.trial500 : ""}</summary>
      <ul>
        ${groupBits || adv.map((l) => `<li class="f-adv">Аванс: ${esc(l.group)} · ${l.sessions} зан. × ${rub(l.price)} = <b>${rub(l.part)}</b>${l.note ? `<br><small>${esc(l.note)}</small>` : ""}</li>`).join("")}
        ${visits.map((l) => `<li class="f-visit">${esc(l.group)} · ${l.day} число · <b>${esc(l.mark)}</b> → ${l.price ? "−" + rub(l.price) : "0 ₽"}${l.note ? " (" + esc(l.note) + ")" : ""}</li>`).join("") || "<li>Нет отметок посещений</li>"}
      </ul>
    </details>`;
  }).join("");
  const credit = p.credit != null ? p.credit : Math.max(0, p.opening || 0);
  const debt = p.debt != null ? p.debt : Math.max(0, -(p.opening || 0));
  const balStep = phaseNow === "upcoming"
    ? `<li>На начало уже учтён перенос с прошлого: <b>${rub(p.opening)}</b> (только «Б» до 4 зан. или долг — не сдача с аванса).</li>`
    : `<li>Перенос на следующий месяц: компенсация за «Б» <b>${rub(p.sickCarry || 0)}</b> (${p.sickCarrySessions || 0}/${p.sickCarryMax || 4} зан.)${(p.unpaid || 0) > 0 ? ` − долг ${rub(p.unpaid)}` : ""} = <b>${rub(p.balance)}</b>. Неиспользованный аванс не переносится${p.forfeit ? ` (сгорит ${rub(p.forfeit)})` : ""}.</li>`;
  return `<div class="formula">
    <h3>Ход расчёта · ${esc(state.month.label)}</h3>
    <ol class="formula-steps">
      <li>Аванс сырой (занятия × цена пакета ÷ занятий в пакете): <b>${rub(p.advanceRaw)}</b></li>
      <li>Скидка многодетных ${p.discountPercent || 0}%: аванс = ${rub(p.advanceRaw)} × (1 − ${p.discountPercent || 0}/100) = <b>${rub(p.advance)}</b></li>
      <li>Остаток на начало (перенос за «Б» / долг${p.openingManual ? " · задан вручную" : ""}): <b>${rub(credit)}</b>${debt ? ` · долг прошлого: <b class="warn-text">${rub(debt)}</b>` : ""}</li>
      <li>Счёт к оплате: аванс ${rub(p.advance)} − остаток ${rub(credit)} + долг ${rub(debt)} = <b>${rub(p.requested)}</b></li>
      <li>Приход (подтверждённый): <b>${rub(p.incoming)}</b></li>
      <li>Списано за «+» / 500: <b>−${rub(p.spent)}</b></li>
      <li>«Б» по справке: всего ${p.sickCount || 0} зан., к переносу макс. ${p.sickCarryMax || 4} → <b>${rub(p.sickCarry || 0)}</b>${p.sickCarryCapped ? " (лишние Б сверх лимита не переносятся)" : ""}</li>
      <li>К оплате сейчас: счёт ${rub(p.requested)} − приход ${rub(p.incoming)} = <b>${rub(p.amountDue)}</b></li>
      ${balStep}
    </ol>
    <h3>По детям</h3>
    ${kids || "<p class=\"hint\">Нет детей</p>"}
  </div>`;
}

function packExplainHtml() {
  const list = (state.groups || []).slice().sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name, "ru"));
  const rows = list.map((g) => {
    const packLessons = Number(g.packLessons) || 8;
    const packPrice = Number(g.packPrice) || 0;
    const unit = packLessons ? Math.round(packPrice / packLessons) : 0;
    const sessions = (state.month.days || []).filter((d) => (g.weekdays || []).includes(d.weekday)).length;
    const branch = branchName(g.branchId);
    return `<div class="dev-calc-pack">
      <b>${esc(branch)}</b> · ${esc(groupTitle(g))}<br>
      пакет <code>${rub(packPrice)}</code> / <code>${packLessons}</code> = <b>${rub(unit)}</b> за занятие ·
      в месяце по расписанию <b>${sessions}</b> зан. → аванс группы <b>${rub(sessions * unit)}</b>
    </div>`;
  }).join("");
  return `<div class="dev-calc-packs">${rows || "<p class=\"hint\">Нет групп в зоне видимости</p>"}</div>`;
}

function devCalcRefHtml() {
  return `<div class="dev-calc-ref">
    <strong>Справочник формул (разработка)</strong>
    <ul>
      <li>Цена занятия = <code>packPrice / packLessons</code> (для филиала Валдай — тарифы 1 ч / 1,5 ч).</li>
      <li>Аванс ребёнка = сумма по группам: <code>число тренировок в месяце × цена занятия</code>. Пробный — 0.</li>
      <li>Скидка семьи: авто 10% при 2 детях, 20% при 3+ (только regular), либо ручная 0/10/20 у руководителя.</li>
      <li>Счёт = аванс со скидкой − перенос прошлого (только «Б» до 4) + долг прошлого.</li>
      <li>Списание: «+» = цена занятия, «500» = пробное, «Б» = 0.</li>
      <li>На следующий месяц: неиспользованный аванс <b>не</b> переносится. Переносится только сумма за «Б» (справка), максимум 4 занятия, минус долг.</li>
      <li>Баланс у родителя/руководителя — полный ход; у тренера денег нет — только отметки.</li>
    </ul>
    <p class="hint" style="margin:10px 0 0">Кнопка «Открыть расчёты» видна только пока на сервере <code>DEV_CALC≠0</code> и не production. Перед сдачей: <code>DEV_CALC=0</code> или <code>NODE_ENV=production</code>.</p>
  </div>`;
}

function renderDevCalc() {
  const root = document.getElementById("dev-calc-root");
  if (!root) return;
  if (!devCalcEnabled) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  if (!devCalcOpen) {
    root.innerHTML = `<button type="button" class="dev-calc-fab" data-dev-calc-open>Открыть расчёты</button>`;
    return;
  }

  let body = "";
  if (role === "parent" && state.period) {
    body = `
      ${devCalcRefHtml()}
      <h3 style="margin:0 0 8px">Ваша семья · ${esc(state.month.label)}</h3>
      ${formulaHtml(state.period)}
      <h3 style="margin:20px 0 8px">Пакеты групп (видимые)</h3>
      ${packExplainHtml()}`;
  } else if (role === "trainer") {
    body = `
      ${devCalcRefHtml()}
      <h3 style="margin:0 0 8px">Группы тренера · как считается цена</h3>
      <p class="hint">Деньги считаются в кабинете родителя/руководителя. Здесь — из чего складывается цена занятия по вашим группам.</p>
      ${packExplainHtml()}`;
  } else {
    const q = devCalcQ.trim().toLowerCase();
    const rows = ((devCalcPeriods && devCalcPeriods.rows) || periods && periods.rows || []).filter((r) => {
      if (!q) return true;
      const kids = state.children.filter((c) => c.familyId === r.family.id).map((c) => c.name).join(" ");
      return (r.family.parentName + " " + r.family.login + " " + kids).toLowerCase().includes(q);
    });
    const list = rows.map((r) => {
      const open = devCalcFamily === r.family.id;
      return `<details class="dev-calc-family" ${open ? "open" : ""} data-dev-fam="${r.family.id}">
        <summary>${esc(r.family.parentName)} · ${esc(r.family.login)} · к оплате ${rub(Math.max(0, r.period.amountDue))} · аванс ${rub(r.period.advance)}</summary>
        ${open ? formulaHtml(r.period) : "<p class=\"hint\">Раскрывается при выборе…</p>"}
      </details>`;
    }).join("");
    body = `
      ${devCalcRefHtml()}
      <h3 style="margin:0 0 8px">Пакеты по группам</h3>
      ${packExplainHtml()}
      <h3 style="margin:20px 0 8px">Семьи · ${esc(state.month.label)}</h3>
      <input class="search-input" data-dev-calc-q placeholder="Поиск семьи / ребёнка" value="${esc(devCalcQ)}">
      ${list || "<p class=\"hint\">Нет данных по периодам (откройте ещё раз или зайдите под руководителем)</p>"}`;
  }

  root.innerHTML = `
    <div class="dev-calc-modal" role="dialog" aria-modal="true">
      <div class="dev-calc-head">
        <h2>Расчёты <span class="badge-dev">только для разработки</span></h2>
        <button type="button" class="btn ghost" data-dev-calc-close>Закрыть</button>
      </div>
      <div class="dev-calc-body">${body}</div>
    </div>`;
}

async function openDevCalc() {
  devCalcOpen = true;
  if (role === "admin" || role === "director") {
    const q = monthId ? ("?month=" + encodeURIComponent(monthId)) : "";
    const res = await fetch("/api/periods" + q, { headers: headers() });
    if (res.ok) {
      devCalcPeriods = await res.json();
      periods = periods || devCalcPeriods;
    }
  }
  renderDevCalc();
}

function parentCombinedAtt(child) {
  const groups = state.groups.filter((g) => (child.groupIds || []).includes(g.id));
  if (!groups.length) return `<p class="hint">Нет группы</p>`;

  if (calMode === "year") {
    const year = state.month.year;
    const head = MONTH_NAMES.map((name, i) => {
      const active = i + 1 === state.month.month;
      return `<th class="${active ? "is-now is-on" : ""}" data-pick-month="${i + 1}">${name.slice(0, 3)}</th>`;
    }).join("");
    const rows = groups.map((g) => {
      const packLessons = Number(g.packLessons) || 8;
      const packPrice = Number(g.packPrice) || 0;
      const unit = packLessons ? Math.round(packPrice / packLessons) : 0;
      const dur = g.durationMin === 90 ? "1,5 ч" : "1 ч";
      const branch = branchName(g.branchId);
      const cells = MONTH_NAMES.map((_, i) => {
        const mref = monthRef(year, i + 1);
        const { present, sick } = countMonthMarks(child, g.id, mref);
        const active = i + 1 === state.month.month;
        const has = present || sick;
        const label = has ? (sick ? `${present}/${sick}` : String(present)) : "—";
        return `<td class="year-cell ${active ? "is-now" : ""} ${has ? "has-marks" : "is-out"}" data-pick-month="${i + 1}">${label}</td>`;
      }).join("");
      return `<tr>
        <th class="sticky">
          <span class="sheet-item-branch">${esc(branch || "Филиал")} · ${dur} · ${rub(unit)}</span>
          <span>${esc(groupTitle(g))}</span>
        </th>
        ${cells}
      </tr>`;
    }).join("");
    return `
      <div class="att-wrap">
        <table class="att-table att-year">
          <thead><tr><th class="sticky">Группа / тариф</th>${head}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="hint">Год ${year}: в ячейке число посещений «+» за месяц (и Б через /). Нажмите месяц, чтобы открыть дни.</p>`;
  }

  const cols = trainerColumns();
  const head = cols.map((d) => `
    <th class="${isToday(d.day) ? "is-today" : ""} ${d.day === selectedDay ? "is-on" : ""}" data-pick-day="${d.day}">
      <small>${WEEK_SHORT[d.weekday]}</small>${d.day}
    </th>`).join("");
  const rows = groups.map((g) => {
    const packLessons = Number(g.packLessons) || 8;
    const packPrice = Number(g.packPrice) || 0;
    const unit = packLessons ? Math.round(packPrice / packLessons) : 0;
    const dur = g.durationMin === 90 ? "1,5 ч" : "1 ч";
    const branch = branchName(g.branchId);
    const cells = cols.map((d) => {
      const mark = cellMark(child, g.id, d.day);
      return `<td class="mark big-mark ${mark.cls} ${isTrainingDay(g, d.day) ? "is-train" : ""}">${mark.text}</td>`;
    }).join("");
    return `<tr>
      <th class="sticky">
        <span class="sheet-item-branch">${esc(branch || "Филиал")} · ${dur} · ${rub(unit)}</span>
        <span>${esc(groupTitle(g))}</span>
      </th>
      ${cells}
    </tr>`;
  }).join("");
  const strip = calMode === "week" ? weekStrip() : "";
  return `
    ${strip}
    <div class="att-wrap">
      <table class="att-table">
        <thead><tr><th class="sticky">Группа / тариф</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function staffSub() {
  if (role !== "director") return "";
  const items = [
    ["athletes", "Спортсмены"],
    ["sick", "Больничный"],
    ["branches", "Филиалы"]
  ];
  const onBranches = ["branches", "groups", "group", "trainers", "trainer-sport", "trainer-one"].includes(view);
  return `<div class="subtabs">${items.map(([id, t]) => {
    const on = id === "branches" ? onBranches : view === id;
    return `<button type="button" class="${on ? "" : "is-off"}" data-go="${id}">${t}</button>`;
  }).join("")}</div>`;
}

function coordView() {
  const inner = view === "athletes" ? athletesView()
    : view === "sick" ? sickView()
    : (view === "trainers" || view === "trainer-sport" || view === "trainer-one") ? trainersView()
    : view === "group" ? attendanceScreen()
    : view === "groups" ? groupsOfBranch()
    : branchesView();
  return staffSub() + inner;
}

function branchesView() {
  const cards = (state.branches || []).map((b) => {
    const n = state.groups.filter((g) => g.branchId === b.id).length;
    const note = b.name === "ВАЛДАЙСКИЙ" ? "занятия 1,5 часа" : "";
    return `<button class="branch-card" type="button" data-open-branch="${b.id}">
      <strong>${esc(b.name)}</strong>
      <small>${n} групп${note ? " · " + note : ""}</small>
    </button>`;
  }).join("");
  return `
    <div class="branch-grid">${cards}</div>
    <div class="center-row">
      <button class="btn" type="button" data-go="trainers">Редактирование тренеров</button>
    </div>
    ${role === "director" ? `
      <article class="child-card backup-card">
        <h2>Резервные копии и доступы</h2>
        <p class="hint">Скачайте полную базу перед обновлением контейнера. Восстановление полностью заменит текущие данные.</p>
        <div class="backup-actions">
          <button class="btn" type="button" data-download-backup>Скачать базу JSON</button>
          <label class="btn ghost file-btn">Восстановить из JSON
            <input type="file" accept="application/json,.json" data-restore-backup hidden>
          </label>
          <button class="btn ghost" type="button" data-download-access>Выгрузить доступы</button>
        </div>
      </article>` : ""}`;
}

function groupsOfBranch() {
  const b = state.branches.find((x) => x.id === selectedBranch);
  const list = state.groups.filter((g) => g.branchId === selectedBranch);
  return `
    <button class="btn ghost" type="button" data-go="branches">← Филиалы</button>
    <h2>${esc(b ? b.name : "")}</h2>
    <div class="list-cards">
      ${list.map((g) => `<button class="sheet-item" type="button" data-open-group="${g.id}">${esc(groupTitle(g))}</button>`).join("") || "<p class=\"hint\">Нет групп</p>"}
    </div>
    <form class="add-bar stack-form" id="new-group">
      <p class="hint">Новая группа</p>
      <select name="sport"><option value="hg">ХГ</option><option value="sambo">Самбо / борьба</option></select>
      <input name="time" placeholder="время, напр. 17:30–18:30" required>
      <div class="day-picks">
        ${DAYS.map(([id, t]) => `<label class="check"><input type="checkbox" name="wd" value="${id}"> ${t}</label>`).join("")}
      </div>
      <select name="durationMin">
        <option value="60" ${b && b.name !== "ВАЛДАЙСКИЙ" ? "selected" : ""}>1 час</option>
        <option value="90" ${b && b.name === "ВАЛДАЙСКИЙ" ? "selected" : ""}>1,5 часа</option>
      </select>
      <button class="btn" type="submit">Создать группу</button>
    </form>`;
}

function athletesView() {
  const q = qAthletes.trim().toLowerCase();
  const list = state.children
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .filter((c) => !q || c.name.toLowerCase().includes(q));
  const rows = list.map((c) => {
    const n = (c.groupIds || []).length;
    const ins = (c.documents && c.documents.insurance) || "";
    const insLabel = ins === "yes" ? "оформлена" : ins === "no" ? "отказ" : "не решено";
    return `<article class="ath-card ${c.kind === "trial" ? "is-trial-card" : ""}">
      <div class="ath-head">
        <strong>${esc(c.name)}</strong>
        <button class="icon-btn" type="button" data-edit-name="${c.id}" title="Редактировать">✎</button>
      </div>
      ${c.kind === "trial" ? `<span class="trial-tag">пробный</span>` : ""}
      <div class="ath-meta">
        <label class="check">справка врача <input type="checkbox" data-doc="${c.id}" data-field="doctor" ${c.documents && c.documents.doctor ? "checked" : ""}></label>
        <label>страховка
          <select data-ins="${c.id}">
            <option value="" ${!ins ? "selected" : ""}>не решено</option>
            <option value="yes" ${ins === "yes" ? "selected" : ""}>оформление</option>
            <option value="no" ${ins === "no" ? "selected" : ""}>отказ</option>
          </select>
        </label>
        <span class="muted-inline">${insLabel}</span>
      </div>
      <div class="ath-actions">
        ${canEnroll(c) ? `<button class="btn" type="button" data-enroll="${c.id}">Зачислить в группу</button>` : ""}
        <button class="btn ghost" type="button" data-child-groups="${c.id}">
          ${n ? "Группы: " + n : "<span class=\"warn-text\">Нет группы</span>"}
        </button>
        <button class="btn ghost" type="button" data-child-family="${c.id}">Семья</button>
      </div>
    </article>`;
  }).join("");
  return `
    <input class="search-input" data-ath-q placeholder="Поиск по ФИО" value="${esc(qAthletes)}">
    <div class="ath-list">${rows || "<p class=\"hint\">Никого нет</p>"}</div>`;
}

function sickView() {
  const q = qSick.trim().toLowerCase();
  const hits = q
    ? state.children.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 20)
    : [];
  if (selectedChild) {
    const child = state.children.find((c) => c.id === selectedChild);
    const cells = monthGrid().map((c) => {
      if (!c.inMonth) return `<span class="m-cell is-out"></span>`;
      const on = isSick(child.id, c.day);
      return `<button type="button" class="m-cell ${on ? "is-sick" : ""} ${isToday(c.day) ? "is-today" : ""}" data-toggle-sick="${isoOf(c.day)}">
        <span>${c.day}</span>${on ? "<b class=\"big-mark sick\">Б</b>" : ""}
      </button>`;
    }).join("");
    return `
      <button class="btn ghost" type="button" data-clear-sick>← Поиск</button>
      ${monthSwitch()}
      <h2>${esc(child ? child.name : "")} · ${esc(state.month.label)}</h2>
      <p class="hint">Отметьте дни болезни — буква Б появится во всех группах ребёнка на эти даты.</p>
      <div class="month-grid">${WEEK_ORDER.map((w) => `<span class="dow">${WEEK_SHORT[w]}</span>`).join("")}${cells}</div>`;
  }
  return `
    <input class="search-input" data-sick-q placeholder="Введите ФИО" value="${esc(qSick)}" autofocus>
    <div class="list-cards">${hits.map((c) => `<button class="sheet-item" type="button" data-sick-child="${c.id}">${esc(c.name)}</button>`).join("")}</div>`;
}

function trainersView() {
  if (view === "trainers") {
    return `
      <button class="btn ghost" type="button" data-go="branches">← Филиалы</button>
      <h2>Тренеры</h2>
      <div class="branch-grid">
        <button class="branch-card" type="button" data-sport="hg"><strong>ХГ</strong><small>художественная гимнастика</small></button>
        <button class="branch-card" type="button" data-sport="sambo"><strong>Борьба</strong><small>самбо</small></button>
      </div>`;
  }

  const sportLabel = selectedSport === "hg" ? "ХГ" : "Борьба";
  const list = state.trainers.filter((t) => t.sport === selectedSport);

  if (view === "trainer-sport" || !selectedTrainer) {
    const cards = list.map((t) => {
      const n = (t.groupIds || []).length;
      return `<button class="sheet-item trainer-list-card" type="button" data-open-trainer="${t.id}">
        <strong>${esc(t.name)}</strong>
        <span class="sheet-item-branch">${role === "director" ? `логин ${esc(t.login)} · ` : ""}групп: ${n}</span>
      </button>`;
    }).join("");
    return `
      <button class="btn ghost" type="button" data-go="trainers">← Виды</button>
      <h2>${sportLabel}</h2>
      <p class="hint">Выберите тренера, чтобы посмотреть и назначить группы.</p>
      <div class="list-cards">${cards || "<p class=\"hint\">Нет тренеров</p>"}</div>
      <form class="add-bar" id="new-trainer">
        <input name="name" placeholder="Имя тренера" required>
        <input name="login" placeholder="логин" required>
        <input name="password" placeholder="пароль" required>
        <button class="btn" type="submit">Добавить</button>
      </form>`;
  }

  const t = state.trainers.find((x) => x.id === selectedTrainer);
  if (!t) {
    selectedTrainer = "";
    view = "trainer-sport";
    return trainersView();
  }
  if (!trainerDraft[t.id]) trainerDraft[t.id] = [...(t.groupIds || [])];
  const selected = new Set(trainerDraft[t.id]);
  const groups = state.groups.filter((g) => g.sport === selectedSport);
  const sorted = groups.slice().sort((a, b) => {
    const as = selected.has(a.id) ? 0 : 1;
    const bs = selected.has(b.id) ? 0 : 1;
    if (as !== bs) return as - bs;
    const ba = branchName(a.branchId).localeCompare(branchName(b.branchId), "ru");
    if (ba) return ba;
    return groupTitle(a).localeCompare(groupTitle(b), "ru");
  });
  const opts = sorted.map((g) => `
    <button type="button" class="sheet-item ${selected.has(g.id) ? "is-on" : ""}" data-toggle-tg="${t.id}" data-group="${g.id}">
      <span class="sheet-item-branch">${esc(branchName(g.branchId) || "Филиал")}</span>
      <span class="sheet-item-title">${esc(groupTitle(g))}</span>
    </button>`).join("");
  return `
    <button class="btn ghost" type="button" data-back-trainers>← ${sportLabel}</button>
    <h2>${esc(t.name)}</h2>
    ${role === "director"
      ? `<p class="hint">логин ${esc(t.login)} · пароль ${esc(t.password)}</p>`
      : `<p class="hint">Доступы к кабинетам выгружает руководитель.</p>`}
    <p class="hint">Сначала выбранные. В названии — филиал. Нажмите на группу, чтобы закрепить или снять.</p>
    <div class="multi multi-pick">${opts || "<p class=\"hint\">Нет групп</p>"}</div>
    <button class="btn" type="button" data-save-trainer="${t.id}">Сохранить группы</button>`;
}

function calcView() {
  const sub = `${monthSwitch()}
    <div class="subtabs">
      <button class="${calcTab === "prices" ? "" : "is-off"}" data-calc="prices">Стоимость занятий</button>
      <button class="${calcTab === "parents" ? "" : "is-off"}" data-calc="parents">Родители</button>
    </div>`;
  if (calcTab === "prices") return sub + pricesView();
  return sub + parentsCalcView();
}

function pricesView() {
  const pack = Number(state.settings && state.settings.packLessons) || 8;
  const cards = (state.branches || []).map((b) => {
    const groups = state.groups.filter((g) => g.branchId === b.id);
    const tariffs = b.tariffs || [];
    const open = !!priceGroupsOpen[b.id];
    return `
    <article class="ath-card price-branch">
      <strong>${esc(b.name)}</strong>
      <p class="hint">Цена филиала применяется сразу ко <b>всем группам</b> этого филиала (1 ч и 1,5 ч — по длительности группы).</p>
      <form class="add-bar" data-branch-price="${b.id}">
        <label class="field">${pack} занятий · 1 час, ₽
          <input name="priceHour" type="number" value="${b.priceHour}">
        </label>
        <label class="field">${pack} занятий · 1,5 часа, ₽
          <input name="priceHourHalf" type="number" value="${b.priceHourHalf}">
        </label>
        <label class="field">Выберите QR для оплаты
          <select name="qr">
            <option value="qr1" ${b.qr === "qr1" ? "selected" : ""}>QR 1</option>
            <option value="qr2" ${b.qr === "qr2" ? "selected" : ""}>QR 2</option>
          </select>
        </label>
        <button class="btn" type="submit">Сохранить для всех групп филиала</button>
      </form>
      ${tariffs.length ? `
        <p class="hint">Тарифы-шаблоны Валдайского:
          ${tariffs.map((t) => `${esc(t.label)} — ${rub(t.packPrice)}`).join(" · ")}
        </p>` : ""}
      <button class="btn ghost" type="button" data-toggle-price-groups="${b.id}">
        ${open ? "Скрыть группы" : "Настроить цену в группах филиала"}
      </button>
      ${open ? `
      <h3 class="sheet-section">Группы · индивидуальная настройка</h3>
      <p class="hint">Нужно только если у части групп свой пакет (например 12 или 16 занятий), отличный от базы филиала.</p>
      <div class="price-groups">
        ${groups.map((g) => {
          const lessons = Number(g.packLessons) || pack;
          const price = Number(g.packPrice) || (g.durationMin === 90 ? b.priceHourHalf : b.priceHour);
          const unit = lessons ? Math.round(price / lessons) : 0;
          return `
          <form class="add-bar stack-form price-group" data-group-pack="${g.id}">
            <p class="hint"><b>${esc(groupTitle(g))}</b></p>
            <label class="field">цена пакета, ₽
              <input name="packPrice" type="number" value="${price}">
            </label>
            <label class="field">занятий в пакете
              <input name="packLessons" type="number" min="1" value="${lessons}">
            </label>
            <label class="field">длительность
              <select name="durationMin">
                <option value="60" ${g.durationMin !== 90 ? "selected" : ""}>1 час</option>
                <option value="90" ${g.durationMin === 90 ? "selected" : ""}>1,5 часа</option>
              </select>
            </label>
            ${tariffs.length ? `
            <label class="field">тариф с бумажки
              <select name="tariffId">
                <option value="">— не менять —</option>
                ${tariffs.map((t) => `<option value="${t.id}">${esc(t.label)} (${rub(t.packPrice)})</option>`).join("")}
              </select>
            </label>` : ""}
            <p class="hint price-hint">1 занятие = ${rub(unit)}</p>
            <button class="btn" type="submit">Сохранить группу</button>
          </form>`;
        }).join("") || "<p class=\"hint\">Нет групп</p>"}
      </div>` : ""}
    </article>`;
  }).join("");
  return `
    <article class="child-card">
      <h2>Скидка многодетных</h2>
      <p class="hint">Скидка <b>не задаётся здесь</b>. Она считается автоматически по числу детей в семье и настраивается во вкладке <b>«Родители»</b>: 2 ребёнка → 10%, 3+ → 20%. Можно выставить вручную у конкретной семьи.</p>
    </article>
    <p class="note">Сначала сохраните цену филиала — она проставится во все его группы. Точечная правка групп — по кнопке ниже в карточке филиала.</p>
    <div class="ath-list">${cards}</div>
    <article class="child-card">
      <h2>QR для оплаты</h2>
      <p class="hint">У каждого филиала выше выберите QR 1 или QR 2. Здесь можно загрузить сами картинки. Родителю показывается QR его филиалов.</p>
      <div class="qr-row">
        ${["qr1","qr2"].map((id) => `
          <figure>
            <img src="${qrMap[id]}" alt="${id}">
            <figcaption>${id === "qr1" ? "QR 1" : "QR 2"}</figcaption>
            <label class="btn ghost file-btn">Загрузить
              <input type="file" accept="image/*" data-qr-file="${id}" hidden>
            </label>
          </figure>`).join("")}
      </div>
    </article>`;
}

function parentsCalcView() {
  if (!periods) return `<p class="hint">Загрузка…</p>`;
  const q = qParents.trim().toLowerCase();
  const monthLabel = (periods.month && periods.month.label) || state.month.label;
  const rows = (periods.rows || []).filter((r) => {
    if (!q) return true;
    const kids = state.children.filter((c) => c.familyId === r.family.id).map((c) => c.name).join(" ");
    return (r.family.parentName + " " + r.family.login + " " + kids).toLowerCase().includes(q);
  });
  const html = rows.map((r) => {
    const p = r.period;
    const st = p.status || "red";
    const exact = st === "green" && p.incoming >= p.requested && p.amountDue <= 0 && p.incoming === p.requested;
    const showPass = !!eye[r.family.id];
    const kidsN = state.children.filter((c) => c.familyId === r.family.id && c.kind !== "trial").length;
    const auto = p.discountAuto != null ? p.discountAuto : (kidsN >= 3 ? 20 : kidsN >= 2 ? 10 : 0);
    const curDisc = p.discountManual ? String(p.discountPercent) : "auto";
    const openingVal = p.openingManual ? p.opening : "";
    return `<article class="pay-row status-${st} ${exact ? "is-white" : ""}">
      <div class="pay-row-main">
        <strong>${esc(r.family.parentName)}</strong>
        <span class="ball ball-${st}"></span>
      </div>
      <div class="cred">
        <span>${esc(r.family.login)} / ${showPass ? esc(r.family.password) : "••••••"}</span>
        <button class="icon-btn" type="button" data-eye="${r.family.id}" title="Показать пароль">👁</button>
      </div>
      <label class="field discount-field">Скидка многодетных
        <select data-fam-discount="${r.family.id}">
          <option value="auto" ${curDisc === "auto" ? "selected" : ""}>Авто (${auto}% · ${kidsN} дет.)</option>
          <option value="0" ${curDisc === "0" ? "selected" : ""}>0%</option>
          <option value="10" ${curDisc === "10" ? "selected" : ""}>10%</option>
          <option value="20" ${curDisc === "20" ? "selected" : ""}>20%</option>
        </select>
      </label>
      <div class="opening-edit">
        <label class="field">Остаток на начало · ${esc(monthLabel)}
          <input type="number" step="1" data-opening-input="${r.family.id}" value="${openingVal}" placeholder="${p.opening}">
        </label>
        <div class="opening-edit-actions">
          <button class="btn" type="button" data-save-opening="${r.family.id}">Сохранить остаток</button>
          ${p.openingManual ? `<button class="btn ghost" type="button" data-clear-opening="${r.family.id}">Сбросить</button>` : ""}
        </div>
        <p class="hint opening-hint">Сейчас в расчёте: <b>${rub(p.opening)}</b>${p.openingManual ? " (задано вручную — автоперенос с прошлого месяца отключён)" : " (авто: перенос за Б / долг с прошлого)"}. «+» — перенос за справку, «−» — долг. Чтобы подтянуть сентябрь → нажмите «Сбросить».</p>
      </div>
      <div class="pay-nums">
        <div><span>К оплате</span><b>${rub(Math.max(0, p.amountDue))}</b></div>
        <div><span>Счёт</span><b>${rub(p.requested)}</b></div>
        <div><span>Баланс</span><b>${rub(p.balance)}</b></div>
        <div><span>Скидка сейчас</span><b>${p.discountPercent || 0}%</b></div>
        ${p.parentClickedAt ? `<div><span>Родитель нажал</span><b>${fmtWhen(p.parentClickedAt)}</b></div>` : ""}
      </div>
      <div class="pay-row-actions">
        <button class="btn ghost" type="button" data-dir-pay="${r.family.id}" data-need="${Math.max(0, p.amountDue)}">Сменить статус</button>
        <button class="btn" type="button" data-dir-formula="${r.family.id}">${showDirFormula === r.family.id ? "Скрыть формулу" : "Показать формулу"}</button>
      </div>
      ${showDirFormula === r.family.id ? formulaHtml(p) : ""}
    </article>`;
  }).join("");
  return `
    <article class="child-card">
      <h2>Родители · ${esc(monthLabel)}</h2>
      <p class="hint">Стартовый остаток на начало месяца (ручной ввод) — если учёт начинается с сентября. Автоперенос дальше: только «Б» до 4 занятий, аванс сам не переносится.</p>
      <p class="hint">Скидка многодетных: авто 2 ребёнка = 10%, 3+ = 20%, либо вручную 0 / 10 / 20.</p>
    </article>
    <input class="search-input" data-par-q placeholder="Поиск семьи или ребёнка" value="${esc(qParents)}">
    <div class="ath-list">${html || "<p class=\"hint\">Нет семей</p>"}</div>`;
}

function currentMonthId() {
  return monthId || (state && state.month && state.month.id) || "";
}

async function loadPeriods() {
  const q = monthId ? ("?month=" + encodeURIComponent(monthId)) : "";
  const res = await fetch("/api/periods" + q, { headers: headers() });
  periods = await res.json();
  render();
}

function drawOverlay() {
  const el = document.getElementById("overlay");
  if (!sheet) {
    el.innerHTML = "";
    el.className = "";
    return;
  }
  el.className = "overlay-on";
  if (sheet.type === "groups") {
    const q = (sheet.q || "").toLowerCase();
    const items = state.groups.filter((g) => (g.title || g.name).toLowerCase().includes(q));
    el.innerHTML = `
      <div class="sheet" role="dialog">
        <p class="sheet-kicker">Группа</p>
        <input class="sheet-search" placeholder="Найти" value="${esc(sheet.q || "")}" data-group-q>
        <div class="sheet-list">
          ${items.map((g) => `<button type="button" class="sheet-item ${g.id === selectedGroup ? "is-on" : ""}" data-pick-group="${g.id}">${esc(groupTitle(g))}</button>`).join("")}
        </div>
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
    const input = el.querySelector("[data-group-q]");
    if (input) { input.focus(); const v = sheet.q || ""; input.setSelectionRange(v.length, v.length); }
    return;
  }
  if (sheet.type === "child-groups") {
    const child = state.children.find((c) => c.id === sheet.childId);
    if (!sheet.selected) sheet.selected = [...((child && child.groupIds) || [])];
    const selected = new Set(sheet.selected);
    const sorted = state.groups.slice().sort((a, b) => {
      const as = selected.has(a.id) ? 0 : 1;
      const bs = selected.has(b.id) ? 0 : 1;
      if (as !== bs) return as - bs;
      const ba = branchName(a.branchId).localeCompare(branchName(b.branchId), "ru");
      if (ba) return ba;
      return groupTitle(a).localeCompare(groupTitle(b), "ru");
    });
    el.innerHTML = `
      <div class="sheet" role="dialog">
        ${sheet.backFamily
          ? `<button class="sheet-back" type="button" data-back-family aria-label="Назад">← Назад</button>`
          : `<button class="sheet-back" type="button" data-close-sheet aria-label="Назад">← Назад</button>`}
        <p class="sheet-kicker">${esc(child ? child.name : "")} · группы</p>
        <p class="hint">Сначала выбранные. В названии указан филиал. Нажмите на группу, чтобы добавить или убрать.</p>
        <div class="sheet-list">
          ${sorted.map((g) => `
            <button type="button" class="sheet-item ${selected.has(g.id) ? "is-on" : ""}" data-toggle-cg="${g.id}">
              <span class="sheet-item-branch">${esc(branchName(g.branchId) || "Филиал")}</span>
              <span class="sheet-item-title">${esc(groupTitle(g))}</span>
            </button>`).join("")}
        </div>
        <button class="btn" type="button" data-save-cgroups>Сохранить</button>
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
    return;
  }
  if (sheet.type === "family") {
    el.innerHTML = familySheetHtml();
  }
}

function familySheetHtml() {
  const child = state.children.find((c) => c.id === sheet.childId);
  const fam = state.families.find((f) => f.id === (sheet.familyId || (child && child.familyId)));
  const sheetView = sheet.view || "home";
  const back = sheetView !== "home"
    ? `<button class="sheet-back" type="button" data-fam-view="home" aria-label="Назад">← Назад</button>`
    : "";

  if (!fam && sheetView !== "assign") {
    return `
      <div class="sheet" role="dialog">
        <p class="sheet-kicker">Семья · ${esc(child ? child.name : "")}</p>
        <div class="family-help">
          <p class="hint"><b>Как устроить семью</b></p>
          <ol class="family-help-list">
            <li><b>Создать новую</b> — отдельный логин/пароль для кабинета родителя.</li>
            <li><b>Назначить из списка</b> — объединить с уже существующей семьёй (общий кабинет и скидка).</li>
          </ol>
        </div>
        <button class="btn" type="button" data-do-assign>Создать новую семью</button>
        <button class="btn ghost" type="button" data-fam-view="assign">Назначить из списка</button>
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
  }

  if (sheetView === "assign") {
    return `
      <div class="sheet" role="dialog">
        ${child && child.familyId ? back : `<button class="sheet-back" type="button" data-fam-view="home" aria-label="Назад">← Назад</button>`}
        <p class="sheet-kicker">Назначить / объединить семью</p>
        <div class="family-help">
          <ol class="family-help-list">
            <li>Выберите семью — ребёнок перейдёт в неё (общий ЛК родителя).</li>
            <li>«Создать новую» — отдельная семья только для этого ребёнка.</li>
            <li>Братья/сёстры в одной семье: скидка 10% (2 детей) или 20% (3+).</li>
          </ol>
        </div>
        <select data-assign-fam>
          <option value="">— создать новую семью —</option>
          ${state.families.map((f) => `<option value="${f.id}" ${fam && fam.id === f.id ? "selected" : ""}>${esc(f.parentName)} (${esc(f.login)})</option>`).join("")}
        </select>
        <button class="btn" type="button" data-do-assign>Назначить</button>
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
  }

  if (!fam) {
    sheet.view = "home";
    return familySheetHtml();
  }

  if (sheetView === "parent-new") {
    return `
      <div class="sheet" role="dialog">
        ${back}
        <p class="sheet-kicker">Новый родитель</p>
        <form id="fam-parent-new">
          <label class="field">ФИО<input name="name" required placeholder="Фамилия Имя"></label>
          <label class="field">телефон<input name="phone" placeholder="+7..."></label>
          <label class="field">почта<input name="email" type="email" placeholder="email@"></label>
          <button class="btn" type="submit">Добавить</button>
        </form>
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
  }

  if (sheetView === "parent-edit") {
    const parent = (fam.parents || []).find((p) => p.id === sheet.parentId) || (fam.parents || [])[0];
    if (!parent) {
      sheet.view = "home";
      return familySheetHtml();
    }
    return `
      <div class="sheet" role="dialog">
        ${back}
        <p class="sheet-kicker">Родитель</p>
        <form id="fam-parent-edit">
          <input type="hidden" name="id" value="${esc(parent.id)}">
          <label class="field">ФИО<input name="name" required value="${esc(parent.name)}"></label>
          <label class="field">телефон<input name="phone" value="${esc(parent.phone || "")}"></label>
          <label class="field">почта<input name="email" type="email" value="${esc(parent.email || "")}"></label>
          <button class="btn" type="submit">Сохранить</button>
        </form>
        ${(fam.parents || []).length > 1
          ? `<button class="btn ghost warn-btn" type="button" data-remove-parent="${esc(parent.id)}">Убрать из семьи</button>`
          : ""}
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
  }

  if (sheetView === "child") {
    const kid = state.children.find((c) => c.id === sheet.viewChildId);
    if (!kid) {
      sheet.view = "home";
      return familySheetHtml();
    }
    const groups = state.groups.filter((g) => (kid.groupIds || []).includes(g.id));
    return `
      <div class="sheet" role="dialog">
        ${back}
        <p class="sheet-kicker">${esc(kid.name)}</p>
        ${kid.kind === "trial" ? `<span class="trial-tag">пробный</span>` : ""}
        <p class="hint">Группы ребёнка</p>
        <div class="sheet-list">
          ${groups.map((g) => `
            <div class="sheet-item is-static">
              <span class="sheet-item-branch">${esc(branchName(g.branchId) || "Филиал")}</span>
              <span class="sheet-item-title">${esc(groupTitle(g))}</span>
            </div>`).join("") || `<p class="hint">Нет группы</p>`}
        </div>
        <button class="btn" type="button" data-open-kid-groups="${kid.id}">Изменить группы</button>
        <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
      </div>`;
  }

  const parents = fam.parents || [];
  const kids = state.children.filter((c) => c.familyId === fam.id);
  return `
    <div class="sheet" role="dialog">
      <p class="sheet-kicker">Семья · ${esc(child ? child.name : fam.parentName)}</p>
      ${role === "director" ? `
        <div class="cred-block">
          <div><span>логин</span><b>${esc(fam.login)}</b></div>
          <div><span>пароль</span><b>${esc(fam.password)}</b></div>
        </div>` : ""}

      <details class="family-help">
        <summary>Алгоритм семей</summary>
        <ol class="family-help-list">
          <li><b>Новая семья</b> — «Сменить / объединить» → создать новую: свой логин для ЛК.</li>
          <li><b>Объединить</b> — выбрать существующую семью: дети в одном кабинете, общая оплата.</li>
          <li><b>Родители</b> — несколько контактов; правка по клику на карточку.</li>
          <li><b>Дети</b> — из карточки ребёнка можно править группы.</li>
        </ol>
      </details>

      <h3 class="sheet-section">Родители</h3>
      <div class="sheet-list">
        ${parents.map((p) => `
          <button type="button" class="sheet-item contact-card" data-edit-parent="${esc(p.id)}">
            <strong>${esc(p.name)}</strong>
            <span>${esc(p.phone || "телефон не указан")}</span>
            <span>${esc(p.email || "почта не указана")}</span>
          </button>`).join("")}
      </div>
      <button class="btn ghost" type="button" data-fam-view="parent-new">+ Добавить родителя</button>

      <h3 class="sheet-section">Дети в семье</h3>
      <div class="sheet-list">
        ${kids.map((k) => `
          <button type="button" class="sheet-item" data-fam-child="${k.id}">
            ${esc(k.name)}${k.kind === "trial" ? " · пробный" : ""}
          </button>`).join("") || `<p class="hint">Нет детей</p>`}
      </div>

      <button class="btn ghost" type="button" data-fam-view="assign">Сменить / объединить семью</button>
      <button type="button" class="btn ghost sheet-cancel" data-close-sheet>Закрыть</button>
    </div>`;
}


document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", headers: headers() }).catch(() => {});
  sessionStorage.clear();
  location.href = "/";
});

document.getElementById("tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  const id = btn.dataset.tab;
  if (role === "director") {
    dirTab = id;
    if (id === "coord" && (view === "parent" || !view)) view = "branches";
    if (id === "calc") {
      calcTab = calcTab || "prices";
      if (calcTab === "parents") await loadPeriods();
    }
  } else {
    view = id;
    selectedChild = "";
  }
  render();
});

document.getElementById("app").addEventListener("click", async (e) => {
  if (e.target.closest("[data-download-backup]")) {
    try {
      await downloadProtectedJson("/api/backup", "lk-backup.json");
      showToast("Резервная копия скачана");
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (e.target.closest("[data-download-access]")) {
    try {
      await downloadProtectedJson("/api/access-export", "lk-access.json");
      showToast("Список доступов скачан");
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const cal = e.target.closest("[data-cal]");
  if (cal) { calMode = cal.dataset.cal; persistCal(); render(); return; }
  const monthBtn = e.target.closest("[data-month]");
  if (monthBtn) {
    monthId = monthBtn.dataset.month;
    await load();
    if (role === "director" && dirTab === "calc" && calcTab === "parents") await loadPeriods();
    return;
  }
  if (e.target.closest("[data-today]")) {
    selectedDay = todayDay();
    if (role === "trainer") calMode = "day";
    persistCal(); render(); return;
  }
  const pick = e.target.closest("[data-pick-day]");
  if (pick && pick.dataset.pickDay) { selectedDay = Number(pick.dataset.pickDay); persistCal(); render(); return; }
  const pickMonth = e.target.closest("[data-pick-month]");
  if (pickMonth && pickMonth.dataset.pickMonth) {
    const num = Number(pickMonth.dataset.pickMonth);
    const id = `${state.month.year}-${String(num).padStart(2, "0")}`;
    const found = (state.months || []).find((m) => m.id === id);
    if (!found) {
      alert(`Период «${MONTH_NAMES[num - 1]} ${state.month.year}» ещё не открыт в учёте`);
      return;
    }
    monthId = id;
    calMode = "month";
    persistCal();
    await load();
    if (role === "director" && dirTab === "calc" && calcTab === "parents") await loadPeriods();
    return;
  }
  if (e.target.closest("[data-open-groups]")) { sheet = { type: "groups", q: "" }; drawOverlay(); return; }

  const go = e.target.closest("[data-go]");
  if (go) {
    view = go.dataset.go;
    selectedChild = "";
    if (view === "trainers") selectedTrainer = "";
    render();
    return;
  }

  const backNav = e.target.closest("[data-back-nav]");
  if (backNav) {
    const to = backNav.dataset.backNav;
    if (to === "groups") {
      const g = currentGroup();
      if (g && g.branchId) selectedBranch = g.branchId;
      view = "groups";
    } else if (to === "branches") {
      view = "branches";
    } else {
      view = to;
    }
    render();
    return;
  }

  const br = e.target.closest("[data-open-branch]");
  if (br) { selectedBranch = br.dataset.openBranch; view = "groups"; render(); return; }

  const og = e.target.closest("[data-open-group]");
  if (og) {
    selectedGroup = og.dataset.openGroup;
    const g = state.groups.find((x) => x.id === selectedGroup);
    if (g) selectedBranch = g.branchId;
    view = "group";
    render();
    return;
  }

  const sport = e.target.closest("[data-sport]");
  if (sport) {
    selectedSport = sport.dataset.sport;
    selectedTrainer = "";
    view = "trainer-sport";
    render();
    return;
  }

  const openTr = e.target.closest("[data-open-trainer]");
  if (openTr) {
    selectedTrainer = openTr.dataset.openTrainer;
    view = "trainer-one";
    render();
    return;
  }

  if (e.target.closest("[data-back-trainers]")) {
    selectedTrainer = "";
    view = "trainer-sport";
    render();
    return;
  }

  const openChild = e.target.closest("[data-open-child]");
  if (openChild) {
    const id = openChild.dataset.openChild;
    selectedChild = selectedChild === id ? "" : id;
    showFormula = false;
    render();
    return;
  }
  if (e.target.closest("[data-back-parent]")) { selectedChild = ""; render(); return; }

  if (e.target.closest("[data-toggle-formula]")) { showFormula = !showFormula; render(); return; }

  const togPriceGroups = e.target.closest("[data-toggle-price-groups]");
  if (togPriceGroups) {
    const id = togPriceGroups.dataset.togglePriceGroups;
    priceGroupsOpen[id] = !priceGroupsOpen[id];
    render();
    return;
  }

  const toggle = e.target.closest("[data-toggle-mark]");
  if (toggle) {
    const groupId = toggle.dataset.group;
    const childId = toggle.dataset.toggleMark;
    const day = Number(toggle.dataset.day);
    const mid = state.month.id;
    const key = attKeyLocal(mid, groupId, childId, day);
    const prev = state.attendance[key] || "";
    const res = await api("/api/attendance", "POST", {
      groupId,
      childId,
      day,
      monthId: mid
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    if (data.mark === "sick") return;
    if (data.mark) state.attendance[key] = data.mark;
    else delete state.attendance[key];
    const child = state.children.find((c) => c.id === childId);
    if (child) applyMarkToCell(toggle, child, groupId, day);
    pushUndo({
      type: "attendance",
      label: "отметка посещения",
      groupId,
      childId,
      day,
      monthId: mid,
      prev,
      next: data.mark || ""
    });
    return;
  }

  const un = e.target.closest("[data-ungroup]");
  if (un) {
    e.preventDefault();
    const child = state.children.find((c) => c.id === un.dataset.ungroup);
    const ok = await askConfirm({
      title: "Убрать из группы?",
      body: child
        ? `Ребёнок <b>${esc(child.name)}</b> будет убран из текущей группы. Посещения в других группах сохранятся.`
        : "Ребёнок будет убран из текущей группы.",
      confirmLabel: "Убрать",
      danger: true
    });
    if (!ok) return;
    const g = currentGroup();
    const res = await api(`/api/groups/${g.id}/children/${un.dataset.ungroup}`, "DELETE");
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    pushUndo({
      type: "ungroup",
      groupId: g.id,
      childId: un.dataset.ungroup,
      label: "удаление из группы"
    });
    rememberAttScroll();
    await load();
    restoreAttScroll();
    showToast("Убран из группы · можно отменить");
    return;
  }

  const enrollBtn = e.target.closest("[data-enroll]");
  if (enrollBtn) {
    e.preventDefault();
    const child = state.children.find((c) => c.id === enrollBtn.dataset.enroll);
    const ok = await askConfirm({
      title: "Зачислить в группу?",
      body: child
        ? `<b>${esc(child.name)}</b>: отметки 0 и 500 сохранятся, дальше можно ставить «+» как обычным ученикам.`
        : "Отметки 0 и 500 сохранятся, дальше можно ставить «+».",
      confirmLabel: "Зачислить"
    });
    if (!ok) return;
    const res = await api(`/api/children/${enrollBtn.dataset.enroll}/enroll`, "POST");
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    rememberAttScroll();
    await load();
    restoreAttScroll();
    showToast("Зачислен в группу");
    return;
  }

  if (e.target.closest("[data-parent-pay]")) {
    const ok = await askConfirm({
      title: "Подтвердить оплату?",
      body: `Период <b>${esc(state.month.label)}</b>. Статус у руководителя станет жёлтым — ожидает подтверждения прихода.`,
      confirmLabel: "Я оплатил"
    });
    if (!ok) return;
    await api("/api/pay/parent", "POST", { monthId: state.month.id });
    await load();
    showToast("Отмечено как оплачено");
    return;
  }

  const editName = e.target.closest("[data-edit-name]");
  if (editName) {
    const child = state.children.find((c) => c.id === editName.dataset.editName);
    const prev = child ? child.name : "";
    const name = prompt("Фамилия Имя", prev);
    if (!name || name === prev) return;
    const ok = await askConfirm({
      title: "Изменить ФИО?",
      body: `<b>${esc(prev)}</b> → <b>${esc(name)}</b>`,
      confirmLabel: "Сохранить"
    });
    if (!ok) return;
    await api("/api/children/" + child.id, "PATCH", { name });
    pushUndo({ type: "name", childId: child.id, prev, next: name });
    await load();
    showToast("Имя изменено · можно отменить");
    return;
  }

  const cg = e.target.closest("[data-child-groups]");
  if (cg) {
    const child = state.children.find((c) => c.id === cg.dataset.childGroups);
    sheet = {
      type: "child-groups",
      childId: cg.dataset.childGroups,
      selected: [...((child && child.groupIds) || [])]
    };
    drawOverlay();
    return;
  }
  const cf = e.target.closest("[data-child-family]");
  if (cf) {
    const child = state.children.find((c) => c.id === cf.dataset.childFamily);
    sheet = {
      type: "family",
      childId: cf.dataset.childFamily,
      familyId: child ? child.familyId : "",
      view: "home",
      returnView: view
    };
    drawOverlay();
    return;
  }

  const sc = e.target.closest("[data-sick-child]");
  if (sc) { selectedChild = sc.dataset.sickChild; render(); return; }
  if (e.target.closest("[data-clear-sick]")) { selectedChild = ""; render(); return; }
  const ts = e.target.closest("[data-toggle-sick]");
  if (ts) {
    const iso = ts.dataset.toggleSick;
    const had = ((state.sick && state.sick[selectedChild]) || []).includes(iso);
    const ok = await askConfirm({
      title: had ? "Снять больничный?" : "Отметить больничный?",
      body: had
        ? `Убрать «Б» на <b>${esc(iso)}</b> во всех группах ребёнка.`
        : `Поставить «Б» на <b>${esc(iso)}</b> во всех группах ребёнка.`,
      confirmLabel: had ? "Снять" : "Отметить",
      danger: had
    });
    if (!ok) return;
    await api("/api/sick", "POST", { childId: selectedChild, iso });
    pushUndo({ type: "sick", childId: selectedChild, iso, label: "больничный" });
    await load();
    showToast(had ? "Больничный снят · можно отменить" : "Больничный отмечен · можно отменить");
    return;
  }

  const calc = e.target.closest("[data-calc]");
  if (calc) {
    calcTab = calc.dataset.calc;
    if (calcTab === "parents") await loadPeriods();
    else render();
    return;
  }

  const eyeBtn = e.target.closest("[data-eye]");
  if (eyeBtn) { eye[eyeBtn.dataset.eye] = !eye[eyeBtn.dataset.eye]; render(); return; }

  const df = e.target.closest("[data-dir-formula]");
  if (df) { showDirFormula = showDirFormula === df.dataset.dirFormula ? "" : df.dataset.dirFormula; render(); return; }

  const dp = e.target.closest("[data-dir-pay]");
  if (dp) {
    const incoming = prompt("Сумма прихода, ₽", dp.dataset.need || "0");
    if (incoming == null) return;
    const ok = await askConfirm({
      title: "Подтвердить приход?",
      body: `Записать приход <b>${esc(rub(Number(incoming)))}</b> по счёту <b>${esc(rub(Number(dp.dataset.need)))}</b> за период <b>${esc((state.month && state.month.label) || "")}</b>.`,
      confirmLabel: "Записать"
    });
    if (!ok) return;
    await api("/api/pay/director", "POST", {
      familyId: dp.dataset.dirPay,
      incoming: Number(incoming),
      requested: Number(dp.dataset.need),
      monthId: currentMonthId()
    });
    await loadPeriods();
    showToast("Статус оплаты обновлён");
    return;
  }

  const saveOpen = e.target.closest("[data-save-opening]");
  if (saveOpen) {
    const fid = saveOpen.dataset.saveOpening;
    const input = document.querySelector(`[data-opening-input="${fid}"]`);
    const raw = input ? String(input.value).trim() : "";
    if (raw === "") return alert("Введите сумму остатка на начало (0 если ничего не было)");
    const row = (periods && periods.rows || []).find((r) => r.family.id === fid);
    const prev = row && row.period.openingManual ? row.period.opening : null;
    const ok = await askConfirm({
      title: "Сохранить остаток на начало?",
      body: `Для периода <b>${esc((state.month && state.month.label) || "")}</b> задать остаток <b>${esc(rub(Number(raw)))}</b>. Автоперенос с прошлого месяца будет отключён.`,
      confirmLabel: "Сохранить"
    });
    if (!ok) return;
    await api("/api/pay/opening", "POST", {
      familyId: fid,
      openingSeed: Number(raw),
      monthId: currentMonthId()
    });
    pushUndo({
      type: "opening",
      familyId: fid,
      monthId: currentMonthId(),
      prev,
      next: Number(raw)
    });
    await loadPeriods();
    showToast("Остаток сохранён · можно отменить");
    return;
  }

  const clearOpen = e.target.closest("[data-clear-opening]");
  if (clearOpen) {
    const fid = clearOpen.dataset.clearOpening;
    const row = (periods && periods.rows || []).find((r) => r.family.id === fid);
    const prev = row && row.period.openingManual ? row.period.opening : null;
    const ok = await askConfirm({
      title: "Сбросить ручной остаток?",
      body: "Вернётся автоматический перенос с прошлого месяца (за «Б» / долг).",
      confirmLabel: "Сбросить"
    });
    if (!ok) return;
    await api("/api/pay/opening", "POST", {
      familyId: fid,
      openingSeed: null,
      monthId: currentMonthId()
    });
    pushUndo({
      type: "opening",
      familyId: fid,
      monthId: currentMonthId(),
      prev,
      next: null
    });
    await loadPeriods();
    showToast("Остаток сброшен · можно отменить");
    return;
  }

  const saveT = e.target.closest("[data-save-trainer]");
  if (saveT) {
    const tid = saveT.dataset.saveTrainer;
    const ids = trainerDraft[tid] || [];
    const current = (state.trainers || []).find((item) => item.id === tid);
    const prev = [...((current && current.groupIds) || [])];
    await api("/api/trainers/" + tid, "PATCH", { groupIds: ids });
    pushUndo({ type: "trainer-patch", trainerId: tid, prev: { groupIds: prev } });
    delete trainerDraft[tid];
    await load();
    selectedTrainer = tid;
    view = "trainer-one";
    showToast("Группы тренера изменены · можно отменить");
    return;
  }

  const toggleTg = e.target.closest("[data-toggle-tg]");
  if (toggleTg) {
    const tid = toggleTg.dataset.toggleTg;
    const gid = toggleTg.dataset.group;
    const t = (state.trainers || []).find((x) => x.id === tid);
    if (!trainerDraft[tid]) trainerDraft[tid] = [...((t && t.groupIds) || [])];
    const set = new Set(trainerDraft[tid]);
    if (set.has(gid)) set.delete(gid);
    else set.add(gid);
    trainerDraft[tid] = [...set];
    render();
    return;
  }

  const qrFile = e.target.closest("[data-qr-file]");
  if (qrFile) return;
});

document.getElementById("app").addEventListener("change", async (e) => {
  const backupFile = e.target.closest("[data-restore-backup]");
  if (backupFile && backupFile.files && backupFile.files[0]) {
    const file = backupFile.files[0];
    try {
      const parsed = JSON.parse(await file.text());
      const ok = await askConfirm({
        title: "Восстановить базу?",
        body: `Файл <b>${esc(file.name)}</b> полностью заменит текущих детей, семьи, посещения и оплаты. Перед заменой сервер сохранит локальную резервную копию.`,
        confirmLabel: "Восстановить",
        danger: true
      });
      if (!ok) {
        backupFile.value = "";
        return;
      }
      const res = await api("/api/backup/restore", "POST", parsed);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось восстановить базу");
      monthId = "";
      selectedChild = "";
      selectedGroup = "";
      periods = null;
      await load();
      showToast(`База восстановлена: детей ${data.children}, семей ${data.families}`);
    } catch (err) {
      alert(err instanceof SyntaxError ? "Выбранный файл содержит повреждённый JSON" : err.message);
    } finally {
      backupFile.value = "";
    }
    return;
  }
  if (e.target.dataset.doc) {
    const childId = e.target.dataset.doc;
    const child = state.children.find((item) => item.id === childId);
    const prev = !!(child && child.documents && child.documents.doctor);
    await api("/api/children/" + childId, "PATCH", {
      documents: { doctor: e.target.checked }
    });
    pushUndo({ type: "child-patch", childId, prev: { documents: { doctor: prev } } });
    await load();
    showToast("Справка изменена · можно отменить");
    return;
  }
  if (e.target.dataset.ins) {
    const childId = e.target.dataset.ins;
    const child = state.children.find((item) => item.id === childId);
    const prev = (child && child.documents && child.documents.insurance) || "";
    await api("/api/children/" + childId, "PATCH", {
      documents: { insurance: e.target.value }
    });
    pushUndo({ type: "child-patch", childId, prev: { documents: { insurance: prev } } });
    await load();
    showToast("Страховка изменена · можно отменить");
    return;
  }
  if (e.target.dataset.famDiscount) {
    const familyId = e.target.dataset.famDiscount;
    const fam = (state.families || []).find((item) => item.id === familyId);
    const prev = fam && fam.discountPercent != null ? fam.discountPercent : "auto";
    const val = e.target.value;
    await api("/api/families/" + familyId, "PATCH", {
      discountPercent: val === "auto" ? "auto" : Number(val)
    });
    pushUndo({ type: "family-patch", familyId, prev: { discountPercent: prev } });
    await loadPeriods();
    showToast("Скидка изменена · можно отменить");
    return;
  }
  const file = e.target.closest("[data-qr-file]");
  if (file && file.files && file.files[0]) {
    const reader = new FileReader();
    reader.onload = async () => {
      await api("/api/qr/" + file.dataset.qrFile, "POST", { dataUrl: reader.result });
      await load();
    };
    reader.readAsDataURL(file.files[0]);
  }
});

document.getElementById("app").addEventListener("input", (e) => {
  if (e.target.dataset.athQ !== undefined) {
    qAthletes = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = document.querySelector("[data-ath-q]");
    if (input) { input.focus(); input.setSelectionRange(pos, pos); }
  }
  if (e.target.dataset.sickQ !== undefined) {
    qSick = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = document.querySelector("[data-sick-q]");
    if (input) { input.focus(); input.setSelectionRange(pos, pos); }
  }
  if (e.target.dataset.parQ !== undefined) {
    qParents = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = document.querySelector("[data-par-q]");
    if (input) { input.focus(); input.setSelectionRange(pos, pos); }
  }
});

document.getElementById("app").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.id === "add-child") {
    const name = e.target.name.value;
    const trial = !!(e.target.trial && e.target.trial.checked) || !!(e.target.trialForced);
    const g = currentGroup();
    const res = await api("/api/groups/" + g.id + "/children", "POST", {
      name,
      kind: trial ? "trial" : "regular",
      day: selectedDay || todayDay()
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    await load();
  }
  if (e.target.id === "add-existing") {
    const g = currentGroup();
    const res = await api("/api/groups/" + g.id + "/children", "POST", { childId: e.target.childId.value });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    await load();
  }
  if (e.target.id === "new-group") {
    const wds = [...e.target.querySelectorAll("[name=wd]:checked")].map((i) => i.value);
    const res = await api("/api/groups", "POST", {
      branchId: selectedBranch,
      sport: e.target.sport.value,
      time: e.target.time.value,
      weekdays: wds,
      durationMin: Number(e.target.durationMin.value)
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    await load();
    view = "groups";
  }
  if (e.target.id === "new-trainer") {
    const res = await api("/api/trainers", "POST", {
      name: e.target.name.value,
      login: e.target.login.value,
      password: e.target.password.value,
      sport: selectedSport
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    await load();
    selectedTrainer = "";
    view = "trainer-sport";
  }
  const bp = e.target.closest("[data-branch-price]");
  if (bp) {
    await api("/api/branches/" + bp.dataset.branchPrice, "PATCH", {
      priceHour: Number(e.target.priceHour.value),
      priceHourHalf: Number(e.target.priceHourHalf.value),
      qr: e.target.qr.value,
      applyToGroups: true
    });
    await load();
    dirTab = "calc";
    calcTab = "prices";
  }
  const gp = e.target.closest("[data-group-pack]");
  if (gp) {
    const body = {
      packPrice: Number(e.target.packPrice.value),
      packLessons: Number(e.target.packLessons.value),
      durationMin: Number(e.target.durationMin.value)
    };
    if (e.target.tariffId && e.target.tariffId.value) body.tariffId = e.target.tariffId.value;
    const res = await api("/api/groups/" + gp.dataset.groupPack, "PATCH", body);
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    await load();
    dirTab = "calc";
    calcTab = "prices";
  }
});

document.getElementById("overlay").addEventListener("click", async (e) => {
  if (e.target.id === "overlay" || e.target.closest("[data-close-sheet]")) {
    sheet = null; drawOverlay(); return;
  }
  const g = e.target.closest("[data-pick-group]");
  if (g) { selectedGroup = g.dataset.pickGroup; sheet = null; render(); return; }
  const toggleCg = e.target.closest("[data-toggle-cg]");
  if (toggleCg && sheet && sheet.type === "child-groups") {
    const id = toggleCg.dataset.toggleCg;
    const set = new Set(sheet.selected || []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    sheet.selected = [...set];
    drawOverlay();
    return;
  }
  if (e.target.closest("[data-back-family]") && sheet && sheet.backFamily) {
    sheet = { ...sheet.backFamily, type: "family" };
    drawOverlay();
    return;
  }
  if (e.target.closest("[data-save-cgroups]") && sheet) {
    const ids = sheet.selected || [];
    const childId = sheet.childId;
    const current = state.children.find((item) => item.id === childId);
    const prev = [...((current && current.groupIds) || [])];
    const backFamily = sheet.backFamily || null;
    await api("/api/children/" + childId, "PATCH", { groupIds: ids });
    pushUndo({ type: "child-patch", childId, prev: { groupIds: prev } });
    await load();
    if (backFamily) {
      sheet = { ...backFamily, type: "family" };
      drawOverlay();
    } else {
      sheet = null;
      drawOverlay();
      render();
    }
    showToast("Группы ребёнка изменены · можно отменить");
    return;
  }

  const famView = e.target.closest("[data-fam-view]");
  if (famView && sheet && sheet.type === "family") {
    sheet.view = famView.dataset.famView;
    sheet.parentId = "";
    sheet.viewChildId = "";
    drawOverlay();
    return;
  }
  const editParent = e.target.closest("[data-edit-parent]");
  if (editParent && sheet && sheet.type === "family") {
    sheet.view = "parent-edit";
    sheet.parentId = editParent.dataset.editParent;
    drawOverlay();
    return;
  }
  const famChild = e.target.closest("[data-fam-child]");
  if (famChild && sheet && sheet.type === "family") {
    sheet.view = "child";
    sheet.viewChildId = famChild.dataset.famChild;
    drawOverlay();
    return;
  }
  const openKidGroups = e.target.closest("[data-open-kid-groups]");
  if (openKidGroups) {
    const kid = state.children.find((c) => c.id === openKidGroups.dataset.openKidGroups);
    sheet = {
      type: "child-groups",
      childId: openKidGroups.dataset.openKidGroups,
      selected: [...((kid && kid.groupIds) || [])],
      backFamily: sheet && sheet.type === "family" ? { ...sheet, view: "child", viewChildId: openKidGroups.dataset.openKidGroups } : null
    };
    drawOverlay();
    return;
  }
  const removeParent = e.target.closest("[data-remove-parent]");
  if (removeParent && sheet && sheet.type === "family") {
    const child = state.children.find((c) => c.id === sheet.childId);
    const famId = sheet.familyId || (child && child.familyId);
    const ok = await askConfirm({
      title: "Убрать родителя из семьи?",
      body: "Контакты родителя будут удалены из этой семьи.",
      confirmLabel: "Убрать",
      danger: true
    });
    if (!ok) return;
    const fam = (state.families || []).find((item) => item.id === famId);
    const prevParents = JSON.parse(JSON.stringify((fam && fam.parents) || []));
    const res = await api("/api/families/" + famId, "PATCH", { removeParentId: removeParent.dataset.removeParent });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    pushUndo({ type: "family-patch", familyId: famId, prev: { parents: prevParents } });
    await load();
    sheet = { type: "family", childId: sheet.childId, familyId: famId, view: "home", returnView: sheet.returnView || view };
    drawOverlay();
    showToast("Родитель убран · можно отменить");
    return;
  }

  if (e.target.closest("[data-do-assign]") && sheet) {
    const sel = document.querySelector("[data-assign-fam]");
    const familyId = sel ? sel.value : "";
    const returnView = sheet.returnView || view;
    const previousChild = state.children.find((item) => item.id === sheet.childId);
    const previousFamilyId = (previousChild && previousChild.familyId) || "";
    const res = await api("/api/children/" + sheet.childId + "/family", "POST", { familyId });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    pushUndo({
      type: "child-patch",
      childId: sheet.childId,
      prev: { familyId: previousFamilyId }
    });
    view = returnView;
    await load();
    const child = state.children.find((c) => c.id === sheet.childId) || data.child;
    sheet = {
      type: "family",
      childId: sheet.childId,
      familyId: (child && child.familyId) || (data.family && data.family.id) || "",
      view: "home",
      returnView
    };
    drawOverlay();
    showToast("Семья изменена · можно отменить");
    return;
  }
});

document.getElementById("overlay").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sheet || sheet.type !== "family") return;
  const child = state.children.find((c) => c.id === sheet.childId);
  const famId = sheet.familyId || (child && child.familyId);
  const returnView = sheet.returnView || view;
  if (!famId) {
    alert("Сначала назначьте семью");
    return;
  }

  if (e.target.id === "fam-parent-edit") {
    const fam = (state.families || []).find((item) => item.id === famId);
    const prevParents = JSON.parse(JSON.stringify((fam && fam.parents) || []));
    const res = await api("/api/families/" + famId, "PATCH", {
      parent: {
        id: e.target.elements.id.value,
        name: e.target.elements.name.value,
        phone: e.target.elements.phone.value,
        email: e.target.elements.email.value
      }
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Не удалось сохранить");
    pushUndo({ type: "family-patch", familyId: famId, prev: { parents: prevParents } });
    view = returnView;
    await load();
    sheet = { type: "family", childId: sheet.childId, familyId: famId, view: "home", returnView };
    drawOverlay();
    showToast("Родитель изменён · можно отменить");
    return;
  }
  if (e.target.id === "fam-parent-new") {
    const fam = (state.families || []).find((item) => item.id === famId);
    const prevParents = JSON.parse(JSON.stringify((fam && fam.parents) || []));
    const res = await api("/api/families/" + famId, "PATCH", {
      addParent: {
        name: e.target.elements.name.value,
        phone: e.target.elements.phone.value,
        email: e.target.elements.email.value
      }
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Не удалось добавить");
    pushUndo({ type: "family-patch", familyId: famId, prev: { parents: prevParents } });
    view = returnView;
    await load();
    sheet = { type: "family", childId: sheet.childId, familyId: famId, view: "home", returnView };
    drawOverlay();
    showToast("Родитель добавлен · можно отменить");
  }
});

document.getElementById("overlay").addEventListener("input", (e) => {
  if (e.target.dataset.groupQ !== undefined && sheet) {
    sheet.q = e.target.value;
    drawOverlay();
  }
});

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-dev-calc-open]")) {
    await openDevCalc();
    return;
  }
  if (e.target.closest("[data-dev-calc-close]")) {
    devCalcOpen = false;
    renderDevCalc();
    return;
  }
  const fam = e.target.closest("[data-dev-fam]");
  if (fam && e.target.closest("summary")) {
    const id = fam.getAttribute("data-dev-fam");
    devCalcFamily = devCalcFamily === id ? "" : id;
    e.preventDefault();
    renderDevCalc();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-dev-calc-q]")) {
    devCalcQ = e.target.value;
    clearTimeout(document._devCalcQTimer);
    document._devCalcQTimer = setTimeout(() => renderDevCalc(), 180);
  }
});

load();

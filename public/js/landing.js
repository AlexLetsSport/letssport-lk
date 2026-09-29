const form = document.getElementById("login");
const err = document.getElementById("login-err");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.classList.add("hidden");
  const login = form.login.value.trim();
  const password = form.password.value;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password })
  });
  const data = await res.json();
  if (!res.ok) {
    err.textContent = data.error || "Не удалось войти";
    err.classList.remove("hidden");
    return;
  }
  sessionStorage.setItem("lk-role", data.role);
  sessionStorage.setItem("lk-family", data.familyId || "");
  sessionStorage.setItem("lk-trainer", data.trainerId || "");
  sessionStorage.setItem("lk-name", data.name || "");
  sessionStorage.setItem("lk-session", data.token || "");
  location.href = "/cabinet.html";
});

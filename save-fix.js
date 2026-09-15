/**
 * Надёжное сохранение: явные ошибки + уведомления
 * Подключается после app.js
 */
(function () {
  const SESSION_KEY = "tvoyhod_session_v1";

  function getProfile() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }

  function getClient() {
    if (!window.supabase || typeof SUPABASE_URL === "undefined") return null;
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  function toast(msg, isError) {
    let el = document.getElementById("tvoyhod-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "tvoyhod-toast";
      el.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;" +
        "padding:12px 20px;border-radius:12px;font-size:0.95rem;font-weight:600;" +
        "box-shadow:0 8px 24px rgba(0,0,0,0.45);transition:opacity .3s;max-width:90%;text-align:center;";
      document.body.appendChild(el);
    }
    el.style.background = isError ? "#7f1d1d" : "#14532d";
    el.style.color = "#fff";
    el.style.border = isError ? "1px solid #f87171" : "1px solid #4ade80";
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; }, 3500);
  }

  function getDay(iso) {
    if (!iso) return "";
    const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    return days[new Date(iso + "T12:00:00").getDay()];
  }

  async function persistItem(item, isUpdate) {
    const client = getClient();
    const profile = getProfile();
    if (!client) return toast("Нет подключения к облаку", true);
    if (!profile) return toast("Сначала войди в аккаунт", true);

    const payload = {
      kind: item.kind,
      date: item.date || null,
      day: item.day || getDay(item.date),
      title: item.title,
      format: item.format || "",
      status: item.status || "Запланировано",
      notes: item.notes || "",
      author: profile.display_name || profile.nickname || "",
      author_id: profile.id
    };

    try {
      if (isUpdate && item.id) {
        const { error } = await client.from("content_items").update(payload).eq("id", item.id);
        if (error) throw error;
        toast("Сохранено ✓");
      } else {
        const { error } = await client.from("content_items").insert(payload);
        if (error) throw error;
        toast("Добавлено ✓");
      }
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      console.error(err);
      toast("Ошибка: " + (err.message || err), true);
    }
  }

  function bindForm() {
    const form = document.getElementById("item-form");
    if (!form || form.dataset.fixBound) return;
    form.dataset.fixBound = "1";

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      const title = (document.getElementById("form-title")?.value || "").trim();
      if (!title) return toast("Укажи название", true);

      const id = document.getElementById("form-id")?.value || "";
      const date = document.getElementById("form-date")?.value || "";
      const item = {
        id: id || null,
        kind: document.getElementById("form-type")?.value || "task",
        date,
        day: getDay(date),
        title,
        format: (document.getElementById("form-format")?.value || "").trim(),
        status: document.getElementById("form-status")?.value || "Запланировано",
        notes: (document.getElementById("form-notes")?.value || "").trim()
      };

      document.getElementById("modal")?.classList.remove("open");
      await persistItem(item, !!id);
    }, true);
  }

  function start() { bindForm(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  setInterval(bindForm, 2000);
})();

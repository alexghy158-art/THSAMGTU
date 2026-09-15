(function () {
  var SESSION_KEY = "tvoyhod_session_v1";

  function getProfile() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }

  function getClient() {
    if (!window.supabase || typeof SUPABASE_URL === "undefined") return null;
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  function toast(msg, isError) {
    var el = document.getElementById("tvoyhod-toast");
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
    el._t = setTimeout(function () { el.style.opacity = "0"; }, 3500);
  }

  function getDay(iso) {
    if (!iso) return "";
    var days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    return days[new Date(iso + "T12:00:00").getDay()];
  }

  async function persistItem(item, isUpdate) {
    var client = getClient();
    var profile = getProfile();
    if (!client) return toast("Нет подключения к облаку", true);
    if (!profile) return toast("Сначала войди в аккаунт", true);

    var payload = {
      kind: item.kind,
      date: item.date || null,
      day: item.day || getDay(item.date),
      title: item.title,
      format: item.format || "",
      status: item.status || "Запланировано",
      notes: item.notes || "",
      author: profile.display_name || profile.nickname || ""
    };

    try {
      if (isUpdate && item.id) {
        var up = await client.from("content_items").update(payload).eq("id", item.id);
        if (up.error) throw up.error;
        toast("Сохранено");
      } else {
        var ins = await client.from("content_items").insert(payload);
        if (ins.error) throw ins.error;
        toast("Добавлено");
      }
      setTimeout(function () { location.reload(); }, 500);
    } catch (err) {
      console.error(err);
      toast("Ошибка: " + (err.message || err), true);
    }
  }

  function bindForm() {
    var form = document.getElementById("item-form");
    if (!form || form.dataset.fixBound) return;
    form.dataset.fixBound = "1";

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();

      var titleEl = document.getElementById("form-title");
      var title = (titleEl && titleEl.value || "").trim();
      if (!title) return toast("Укажи название", true);

      var idEl = document.getElementById("form-id");
      var dateEl = document.getElementById("form-date");
      var typeEl = document.getElementById("form-type");
      var formatEl = document.getElementById("form-format");
      var statusEl = document.getElementById("form-status");
      var notesEl = document.getElementById("form-notes");

      var id = (idEl && idEl.value) || "";
      var date = (dateEl && dateEl.value) || "";
      var item = {
        id: id || null,
        kind: (typeEl && typeEl.value) || "task",
        date: date,
        day: getDay(date),
        title: title,
        format: ((formatEl && formatEl.value) || "").trim(),
        status: (statusEl && statusEl.value) || "Запланировано",
        notes: ((notesEl && notesEl.value) || "").trim()
      };

      var modal = document.getElementById("modal");
      if (modal) modal.classList.remove("open");
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

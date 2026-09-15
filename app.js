(function () {
  const STATUS_CYCLE = ["Запланировано", "В работе", "Готово", "Опубликовано"];
  const statusClass = {
    "Запланировано": "badge-planned",
    "В работе": "badge-progress",
    "Готово": "badge-ready",
    "Опубликовано": "badge-published"
  };
  const kindLabel = { post: "Пост", story: "Story", task: "Задача", idea: "Идея" };
  const SESSION_KEY = "tvoyhod_session_v1";

  let supabase = null;
  let profile = null;
  let items = [];
  let activities = [];
  let onlineUsers = {};
  let currentFilter = "all";
  let currentMonth = "2026-09";
  let currentTab = "posts";
  let presenceChannel = null;
  let authMode = "login";

  async function hashPassword(password) {
    const data = new TextEncoder().encode("tvoyhod-samgtu-2026:" + password);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function normalizeNick(nick) {
    return (nick || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function saveSession(member) {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        id: member.id,
        nickname: member.nickname,
        display_name: member.display_name,
        role: member.role
      })
    );
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  async function init() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      showAuthError("Не заполнен config.js — облако не подключено.");
      document.getElementById("auth-screen").classList.remove("hidden");
      return;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const session = loadSession();
    if (session && session.id) {
      const { data } = await supabase.from("members").select("*").eq("id", session.id).maybeSingle();
      if (data) {
        await onLoggedIn(data);
        return;
      }
      clearSession();
    }
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
  }

  async function onLoggedIn(member) {
    profile = {
      id: member.id,
      nickname: member.nickname,
      display_name: member.display_name || member.nickname,
      role: member.role || "участник"
    };
    saveSession(profile);
    await supabase.from("members").update({ last_seen: new Date().toISOString() }).eq("id", profile.id);

    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    document.getElementById("header-name").textContent = profile.display_name;

    setSyncStatus("В сети · данные в облаке", "ok");
    await loadItems();
    await loadActivity();
    setupPresence();
    subscribeRealtime();
  }

  function showAuthError(msg) {
    const el = document.getElementById("auth-error");
    if (el) el.textContent = msg || "";
  }

  document.querySelectorAll(".auth-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      authMode = btn.dataset.auth;
      document.getElementById("auth-submit").textContent =
        authMode === "register" ? "Создать аккаунт" : "Войти";
      showAuthError("");
    });
  });

  document.getElementById("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showAuthError("");
    const name = document.getElementById("auth-name").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!name) return showAuthError("Укажи ник или имя");
    if (password.length < 6) return showAuthError("Пароль не короче 6 символов");

    const nickname = normalizeNick(name);
    if (nickname.length < 2) return showAuthError("Слишком короткий ник");

    try {
      const password_hash = await hashPassword(password);

      if (authMode === "register") {
        const { data: existing } = await supabase
          .from("members")
          .select("id")
          .eq("nickname", nickname)
          .maybeSingle();
        if (existing) return showAuthError("Такой ник уже занят — выбери другой или войди");

        const { data, error } = await supabase
          .from("members")
          .insert({
            nickname,
            password_hash,
            display_name: name,
            role: "участник"
          })
          .select()
          .single();

        if (error) {
          if (/relation .* does not exist/i.test(error.message)) {
            return showAuthError("Таблица members не создана");
          }
          throw error;
        }
        await onLoggedIn(data);
        await logActivity("зарегистрировался(ась) в платформе");
      } else {
        const { data, error } = await supabase
          .from("members")
          .select("*")
          .eq("nickname", nickname)
          .maybeSingle();
        if (error) {
          if (/relation .* does not exist/i.test(error.message)) {
            return showAuthError("Таблица members не создана");
          }
          throw error;
        }
        if (!data || data.password_hash !== password_hash) {
          return showAuthError("Неверный ник или пароль");
        }
        await onLoggedIn(data);
        await logActivity("вошёл(а) в платформу");
      }
    } catch (err) {
      console.error(err);
      showAuthError(err.message || "Ошибка входа");
    }
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    teardownPresence();
    clearSession();
    profile = null;
    document.getElementById("app").classList.add("hidden");
    document.getElementById("auth-screen").classList.remove("hidden");
  });

  function setupPresence() {
    if (!supabase || !profile) return;
    teardownPresence();
    presenceChannel = supabase.channel("team-presence", {
      config: { presence: { key: profile.id } }
    });

    presenceChannel
      .on("presence", { event: "sync" }, () => {
        const state = presenceChannel.presenceState();
        onlineUsers = {};
        Object.values(state).forEach((arr) => {
          arr.forEach((p) => {
            onlineUsers[p.user_id] = p;
          });
        });
        renderOnline();
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await presenceChannel.track({
            user_id: profile.id,
            name: profile.display_name,
            online_at: new Date().toISOString(),
            tab: currentTab
          });
        }
      });
  }

  function teardownPresence() {
    if (presenceChannel) {
      supabase.removeChannel(presenceChannel);
      presenceChannel = null;
    }
    onlineUsers = {};
  }

  async function updatePresenceTab() {
    if (presenceChannel && profile) {
      await presenceChannel.track({
        user_id: profile.id,
        name: profile.display_name,
        online_at: new Date().toISOString(),
        tab: currentTab
      });
    }
  }

  function renderOnline() {
    const list = document.getElementById("online-list");
    if (!list) return;
    const users = Object.values(onlineUsers);
    const onlineStat = document.getElementById("stat-online");
    if (onlineStat) onlineStat.textContent = users.length;
    if (!users.length) {
      list.innerHTML = "<div class=\"empty-sm\">Никого нет в сети</div>";
      return;
    }
    const tabMap = { posts: "Посты", stories: "Stories", tasks: "Задачи", ideas: "Идеи", chat: "Чат", team: "Команда" };
    list.innerHTML = users
      .map(function (u) {
        return (
          '<div class="online-item">' +
          '<span class="online-dot"></span>' +
          "<div>" +
          '<div class="online-name">' +
          escapeHtml(u.name) +
          "</div>" +
          '<div class="online-meta">смотрит: ' +
          (tabMap[u.tab] || u.tab || "—") +
          "</div></div></div>"
        );
      })
      .join("");
  }

  async function logActivity(action, details) {
    if (!supabase || !profile) return;
    details = details || "";
    await supabase.from("activity_log").insert({
      user_id: profile.id,
      user_name: profile.display_name,
      action: action,
      details: details
    });
  }

  async function loadActivity() {
    const { data } = await supabase
      .from("activity_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(40);
    activities = data || [];
    renderActivity();
  }

  function renderActivity() {
    const list = document.getElementById("activity-list");
    if (!list) return;
    if (!activities.length) {
      list.innerHTML = "<div class=\"empty-sm\">Пока тихо</div>";
      return;
    }
    list.innerHTML = activities
      .map(function (a) {
        const time = new Date(a.created_at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        });
        return (
          '<div class="activity-item"><div class="activity-main"><strong>' +
          escapeHtml(a.user_name || "Кто-то") +
          "</strong> " +
          escapeHtml(a.action) +
          (a.details ? " «" + escapeHtml(a.details) + "»" : "") +
          '</div><div class="activity-time">' +
          time +
          "</div></div>"
        );
      })
      .join("");
  }

  async function loadItems() {
    const { data, error } = await supabase
      .from("content_items")
      .select("*")
      .order("date", { ascending: true });
    if (error) {
      console.error(error);
      setSyncStatus("Ошибка загрузки: " + error.message, "error");
      return;
    }
    if (!data || data.length === 0) {
      await seedCloud();
      const res = await supabase.from("content_items").select("*").order("date");
      items = (res.data || []).map(fromDb);
    } else {
      items = data.map(fromDb);
    }
    renderAll();
  }

  async function seedCloud() {
    const seed = seedData();
    for (var i = 0; i < seed.length; i++) {
      await supabase.from("content_items").insert(toDb(seed[i]));
    }
  }

  function seedData() {
    const result = [];
    if (typeof posts !== "undefined") {
      posts.forEach(function (p) {
        result.push({
          kind: "post",
          date: p.date,
          day: p.day,
          title: p.title,
          format: p.format,
          status: p.status,
          notes: p.notes || "",
          textReady: p.textReady || "",
          author: ""
        });
      });
    }
    if (typeof stories !== "undefined") {
      stories.forEach(function (s) {
        result.push({
          kind: "story",
          date: s.date,
          day: s.day,
          title: s.title,
          format: s.format,
          status: s.status,
          notes: s.notes || "",
          textReady: "",
          author: ""
        });
      });
    }
    return result;
  }

  function toDb(item) {
    return {
      kind: item.kind,
      date: item.date || null,
      day: item.day || "",
      title: item.title,
      format: item.format || "",
      status: item.status,
      notes: item.notes || "",
      text_ready: item.textReady || "",
      author: item.author || "",
      author_id: item.author_id || (profile && profile.id) || null
    };
  }

  function fromDb(row) {
    return {
      id: row.id,
      kind: row.kind,
      date: row.date,
      day: row.day || getDay(row.date),
      title: row.title,
      format: row.format || "",
      status: row.status,
      notes: row.notes || "",
      textReady: row.text_ready || "",
      author: row.author || "",
      author_id: row.author_id
    };
  }

  function getDay(iso) {
    if (!iso) return "";
    const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    return days[new Date(iso + "T12:00:00").getDay()];
  }

  function formatDate(iso) {
    if (!iso) return "";
    const parts = iso.split("-");
    return parts[2] + "." + parts[1];
  }

  function getMonthKey(iso) {
    return iso ? iso.slice(0, 7) : "";
  }

  async function saveItem(item) {
    const payload = toDb(item);
    try {
      if (item.id) {
        const { error } = await supabase.from("content_items").update(payload).eq("id", item.id);
        if (error) throw error;
        await logActivity("обновил(а) " + (kindLabel[item.kind] || "запись"), item.title);
      } else {
        payload.author = (profile && profile.display_name) || "";
        payload.author_id = profile && profile.id;
        const { data, error } = await supabase.from("content_items").insert(payload).select().single();
        if (error) throw error;
        if (data) item.id = data.id;
        await logActivity("добавил(а) " + (kindLabel[item.kind] || "запись"), item.title);
      }
      await loadItems();
      await loadActivity();
    } catch (err) {
      console.error(err);
      setSyncStatus("Ошибка сохранения: " + (err.message || err), "error");
      alert("Не удалось сохранить: " + (err.message || err));
    }
  }

  async function updateStatus(id, newStatus) {
    const item = items.find(function (i) { return i.id === id; });
    if (!item) return;
    try {
      const { error } = await supabase.from("content_items").update({ status: newStatus }).eq("id", id);
      if (error) throw error;
      await logActivity("сменил(а) статус на «" + newStatus + "»", item.title);
      await loadItems();
      await loadActivity();
    } catch (err) {
      console.error(err);
      alert("Не удалось сменить статус: " + (err.message || err));
    }
  }

  async function deleteItem(id) {
    if (!confirm("Удалить?")) return;
    const item = items.find(function (i) { return i.id === id; });
    try {
      const { error } = await supabase.from("content_items").delete().eq("id", id);
      if (error) throw error;
      if (item) await logActivity("удалил(а) " + (kindLabel[item.kind] || "запись"), item.title);
      await loadItems();
      await loadActivity();
    } catch (err) {
      console.error(err);
      alert("Не удалось удалить: " + (err.message || err));
    }
  }

  function subscribeRealtime() {
    supabase
      .channel("items-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "content_items" }, function () { loadItems(); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, function () { loadActivity(); })
      .subscribe();
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  function createCard(item) {
    const badge = statusClass[item.status] || "badge-planned";
    const author = item.author
      ? '<div class="card-author">👤 ' + escapeHtml(item.author) + "</div>"
      : "";
    const notes = item.notes ? '<div class="card-notes">' + escapeHtml(item.notes) + "</div>" : "";

    return (
      '<article class="card">' +
      '<div class="card-top">' +
      '<div class="card-date">' +
      '<span class="card-day">' +
      (item.day || "") +
      "</span>" +
      (item.date ? " · " + formatDate(item.date) : "") +
      "</div>" +
      '<button class="badge ' +
      badge +
      ' badge-clickable" data-action="cycle-status" data-id="' +
      item.id +
      '">' +
      item.status +
      "</button></div>" +
      '<h3 class="card-title">' +
      escapeHtml(item.title) +
      "</h3>" +
      '<div class="card-meta">' +
      '<span class="tag">' +
      (kindLabel[item.kind] || item.kind) +
      "</span>" +
      (item.format ? '<span class="tag">' + escapeHtml(item.format) + "</span>" : "") +
      "</div>" +
      author +
      notes +
      '<div class="card-actions">' +
      '<button class="btn-text" data-action="edit" data-id="' +
      item.id +
      '">Изменить</button>' +
      '<button class="btn-text danger" data-action="delete" data-id="' +
      item.id +
      '">Удалить</button>' +
      "</div></article>"
    );
  }

  function getFiltered(kind) {
    let list = items.filter(function (i) { return i.kind === kind; });
    if (currentMonth !== "all" && (kind === "post" || kind === "story")) {
      list = list.filter(function (i) { return getMonthKey(i.date) === currentMonth; });
    }
    if (currentFilter !== "all") list = list.filter(function (i) { return i.status === currentFilter; });
    const q = ((document.getElementById("search") && document.getElementById("search").value) || "").toLowerCase().trim();
    if (q) {
      list = list.filter(function (i) {
        return (
          i.title.toLowerCase().indexOf(q) !== -1 ||
          (i.notes || "").toLowerCase().indexOf(q) !== -1 ||
          (i.author || "").toLowerCase().indexOf(q) !== -1
        );
      });
    }
    return list.sort(function (a, b) { return (a.date || "").localeCompare(b.date || ""); });
  }

  function renderAll() {
    const map = {
      posts: getFiltered("post"),
      stories: getFiltered("story"),
      tasks: getFiltered("task"),
      ideas: getFiltered("idea")
    };
    const pg = document.getElementById("posts-grid");
    const sg = document.getElementById("stories-grid");
    const tg = document.getElementById("tasks-grid");
    const ig = document.getElementById("ideas-grid");
    if (pg) pg.innerHTML = map.posts.length ? map.posts.map(createCard).join("") : '<div class="empty">Нет постов</div>';
    if (sg) sg.innerHTML = map.stories.length ? map.stories.map(createCard).join("") : '<div class="empty">Нет Stories</div>';
    if (tg) tg.innerHTML = map.tasks.length ? map.tasks.map(createCard).join("") : '<div class="empty">Нет задач — добавь первую</div>';
    if (ig) ig.innerHTML = map.ideas.length ? map.ideas.map(createCard).join("") : '<div class="empty">Нет идей — добавь первую</div>';

    let postsCount = items.filter(function (i) { return i.kind === "post"; });
    if (currentMonth !== "all") postsCount = postsCount.filter(function (i) { return getMonthKey(i.date) === currentMonth; });
    const st = document.getElementById("stat-total");
    const sk = document.getElementById("stat-tasks");
    if (st) st.textContent = postsCount.length;
    if (sk) sk.textContent = items.filter(function (i) { return i.kind === "task"; }).length;
  }

  function setSyncStatus(text, type) {
    const el = document.getElementById("sync-status");
    if (el) {
      el.textContent = text;
      el.className = "sync-status " + (type || "");
    }
  }

  const modal = document.getElementById("modal");
  function openModal(item) {
    item = item || null;
    const defaultType =
      currentTab === "stories"
        ? "story"
        : currentTab === "tasks"
          ? "task"
          : currentTab === "ideas"
            ? "idea"
            : "post";
    document.getElementById("modal-title").textContent = item ? "Редактировать" : "Добавить";
    document.getElementById("form-id").value = (item && item.id) || "";
    document.getElementById("form-type").value = (item && item.kind) || defaultType;
    document.getElementById("form-date").value = (item && item.date) || new Date().toISOString().slice(0, 10);
    document.getElementById("form-title").value = (item && item.title) || "";
    document.getElementById("form-format").value = (item && item.format) || "";
    document.getElementById("form-status").value = (item && item.status) || "Запланировано";
    document.getElementById("form-notes").value = (item && item.notes) || "";
    modal.classList.add("open");
  }
  function closeModal() {
    modal.classList.remove("open");
  }

  document.getElementById("item-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const id = document.getElementById("form-id").value || null;
    const item = {
      id: id || undefined,
      kind: document.getElementById("form-type").value,
      date: document.getElementById("form-date").value,
      day: getDay(document.getElementById("form-date").value),
      title: document.getElementById("form-title").value.trim(),
      format: document.getElementById("form-format").value.trim(),
      status: document.getElementById("form-status").value,
      notes: document.getElementById("form-notes").value.trim(),
      textReady: "",
      author: (profile && profile.display_name) || "",
      author_id: profile && profile.id
    };
    closeModal();
    await saveItem(item);
  });

  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("btn-cancel").onclick = closeModal;
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });
  document.getElementById("btn-add").onclick = function () { openModal(); };

  document.body.addEventListener("click", async function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "cycle-status") {
      const item = items.find(function (i) { return i.id === id; });
      if (!item) return;
      const idx = STATUS_CYCLE.indexOf(item.status);
      await updateStatus(id, STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]);
    }
    if (btn.dataset.action === "edit") {
      const item = items.find(function (i) { return i.id === id; });
      if (item) openModal(item);
    }
    if (btn.dataset.action === "delete") await deleteItem(id);
  });

  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".nav-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentTab = btn.dataset.tab;
      document.querySelectorAll(".tab-content").forEach(function (el) { el.classList.remove("active"); });
      const tabEl = document.getElementById("tab-" + currentTab);
      if (tabEl) tabEl.classList.add("active");
      const showFilters = currentTab !== "team" && currentTab !== "chat";
      const filters = document.getElementById("filters");
      if (filters) filters.style.display = showFilters ? "flex" : "none";
      const monthBar = document.getElementById("month-bar");
      if (monthBar) {
        monthBar.style.display =
          currentTab === "posts" || currentTab === "stories" ? "flex" : "none";
      }
      const hero = document.getElementById("hero-block");
      if (hero) hero.style.display = currentTab === "chat" ? "none" : "";
      updatePresenceTab();
    });
  });

  document.querySelectorAll(".month-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".month-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentMonth = btn.dataset.month;
      renderAll();
    });
  });

  document.querySelectorAll(".filter-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderAll();
    });
  });

  document.getElementById("search").addEventListener("input", function () { renderAll(); });

  init();
})();

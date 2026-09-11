(function () {
  const STATUS_CYCLE = ["Запланировано", "В работе", "Готово", "Опубликовано"];
  const statusClass = {
    "Запланировано": "badge-planned",
    "В работе": "badge-progress",
    "Готово": "badge-ready",
    "Опубликовано": "badge-published"
  };
  const kindLabel = { post: "Пост", story: "Story", task: "Задача", idea: "Идея" };

  let supabase = null;
  let user = null;
  let profile = null;
  let items = [];
  let activities = [];
  let onlineUsers = {};
  let currentFilter = "all";
  let currentMonth = "2026-09";
  let currentTab = "posts";
  let presenceChannel = null;
  let authMode = "login";

  // ---------- Init ----------
  async function init() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      showAuthError("Заполни config.js (SUPABASE_URL и ключ), иначе вход и облако не работают.");
      document.getElementById("auth-screen").classList.remove("hidden");
      return;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      await onLoggedIn(session.user);
    } else {
      document.getElementById("auth-screen").classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        await onLoggedIn(session.user);
      }
      if (event === "SIGNED_OUT") {
        teardownPresence();
        user = null;
        profile = null;
        document.getElementById("app").classList.add("hidden");
        document.getElementById("auth-screen").classList.remove("hidden");
      }
    });
  }

  async function onLoggedIn(u) {
    user = u;
    // load or create profile
    let { data: prof } = await supabase.from("profiles").select("*").eq("id", u.id).single();
    if (!prof) {
      const name = u.user_metadata?.name || u.email.split("@")[0];
      await supabase.from("profiles").upsert({ id: u.id, name, role: "участник" });
      ({ data: prof } = await supabase.from("profiles").select("*").eq("id", u.id).single());
    }
    profile = prof;
    await supabase.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", u.id);

    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    document.getElementById("header-name").textContent = profile?.name || u.email;

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

  // Ник → технический email для Supabase Auth (пользователь email не видит)
  function nickToEmail(nick) {
    let slug = (nick || "").toLowerCase().trim();
    // если ввели почту целиком — берём только часть до @
    if (slug.includes("@")) slug = slug.split("@")[0];
    // только латиница, цифры, точка, подчёркивание, дефис
    slug = slug
      .replace(/\s+/g, "_")
      .replace(/[а-яё]/g, (ch) => "u" + ch.charCodeAt(0).toString(16))
      .replace(/[^a-z0-9._-]/g, "")
      .replace(/[._-]{2,}/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "");
    if (!slug || slug.length < 2) slug = "user" + Date.now().toString(36);
    // .com проходит валидацию Supabase (домен не обязан существовать)
    return slug + "@tvoyhod-samgtu.com";
  }

  // ---------- Auth UI ----------
  document.querySelectorAll(".auth-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      authMode = btn.dataset.auth;
      document.getElementById("auth-submit").textContent = authMode === "register" ? "Создать аккаунт" : "Войти";
      document.getElementById("auth-password").autocomplete = authMode === "register" ? "new-password" : "current-password";
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

    const email = nickToEmail(name);

    try {
      if (authMode === "register") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name } }
        });
        if (error) throw error;
        if (data.user) {
          await supabase.from("profiles").upsert({ id: data.user.id, name, role: "участник" });
        }
        // Сразу пробуем войти (если подтверждение email выключено — это обычный случай)
        const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password });
        if (loginErr) {
          showAuthError("Аккаунт создан. Если не пустило — выключи Confirm email в Supabase → Authentication → Providers → Email.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          // возможно ник написали в другом регистре/пробелами — уже нормализовали
          throw error;
        }
      }
    } catch (err) {
      let msg = err.message || "Ошибка входа";
      if (/Invalid login credentials/i.test(msg)) msg = "Неверный ник или пароль";
      if (/already registered/i.test(msg)) msg = "Такой ник уже занят — войди или выбери другой";
      showAuthError(msg);
    }
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  // ---------- Presence (online) ----------
  function setupPresence() {
    if (!supabase || !user) return;
    teardownPresence();
    presenceChannel = supabase.channel("team-presence", {
      config: { presence: { key: user.id } }
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
            user_id: user.id,
            name: profile?.name || user.email,
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
    if (presenceChannel && user) {
      await presenceChannel.track({
        user_id: user.id,
        name: profile?.name || user.email,
        online_at: new Date().toISOString(),
        tab: currentTab
      });
    }
  }

  function renderOnline() {
    const list = document.getElementById("online-list");
    const users = Object.values(onlineUsers);
    document.getElementById("stat-online").textContent = users.length;
    if (!users.length) {
      list.innerHTML = `<div class="empty-sm">Никого нет в сети</div>`;
      return;
    }
    list.innerHTML = users
      .map((u) => {
        const tabMap = { posts: "Посты", stories: "Stories", tasks: "Задачи", ideas: "Идеи", team: "Команда" };
        return `
          <div class="online-item">
            <span class="online-dot"></span>
            <div>
              <div class="online-name">${escapeHtml(u.name)}</div>
              <div class="online-meta">смотрит: ${tabMap[u.tab] || u.tab || "—"}</div>
            </div>
          </div>`;
      })
      .join("");
  }

  // ---------- Activity ----------
  async function logActivity(action, details = "") {
    if (!supabase || !user) return;
    await supabase.from("activity_log").insert({
      user_id: user.id,
      user_name: profile?.name || user.email,
      action,
      details
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
    if (!activities.length) {
      list.innerHTML = `<div class="empty-sm">Пока тихо</div>`;
      return;
    }
    list.innerHTML = activities
      .map((a) => {
        const time = new Date(a.created_at).toLocaleString("ru-RU", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
        });
        return `
          <div class="activity-item">
            <div class="activity-main">
              <strong>${escapeHtml(a.user_name || "Кто-то")}</strong>
              ${escapeHtml(a.action)}
              ${a.details ? `<span class="activity-details">«${escapeHtml(a.details)}»</span>` : ""}
            </div>
            <div class="activity-time">${time}</div>
          </div>`;
      })
      .join("");
  }

  // ---------- Items CRUD ----------
  async function loadItems() {
    const { data, error } = await supabase.from("content_items").select("*").order("date", { ascending: true });
    if (error) {
      console.error(error);
      setSyncStatus("Ошибка загрузки", "error");
      // seed if empty table access works but no rows
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
    for (const item of seed) {
      await supabase.from("content_items").insert(toDb(item));
    }
  }

  function seedData() {
    const result = [];
    if (typeof posts !== "undefined") {
      posts.forEach((p) => result.push({
        kind: "post", date: p.date, day: p.day, title: p.title, format: p.format,
        status: p.status, notes: p.notes || "", textReady: p.textReady || "", author: ""
      }));
    }
    if (typeof stories !== "undefined") {
      stories.forEach((s) => result.push({
        kind: "story", date: s.date, day: s.day, title: s.title, format: s.format,
        status: s.status, notes: s.notes || "", textReady: "", author: ""
      }));
    }
    return result;
  }

  function toDb(item) {
    return {
      id: item.id || undefined,
      kind: item.kind,
      date: item.date,
      day: item.day || "",
      title: item.title,
      format: item.format || "",
      status: item.status,
      notes: item.notes || "",
      text_ready: item.textReady || "",
      author: item.author || "",
      author_id: item.author_id || user?.id || null
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
    const [y, m, d] = iso.split("-");
    return `${d}.${m}`;
  }

  function getMonthKey(iso) {
    return iso ? iso.slice(0, 7) : "";
  }

  async function saveItem(item) {
    const payload = toDb(item);
    if (item.id) {
      await supabase.from("content_items").update(payload).eq("id", item.id);
      await logActivity("обновил(а) " + (kindLabel[item.kind] || "запись"), item.title);
    } else {
      payload.author = profile?.name || "";
      payload.author_id = user.id;
      const { data } = await supabase.from("content_items").insert(payload).select().single();
      if (data) item.id = data.id;
      await logActivity("добавил(а) " + (kindLabel[item.kind] || "запись"), item.title);
    }
    await loadItems();
    await loadActivity();
  }

  async function updateStatus(id, newStatus) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    await supabase.from("content_items").update({ status: newStatus }).eq("id", id);
    await logActivity("сменил(а) статус на «" + newStatus + "»", item.title);
    await loadItems();
    await loadActivity();
  }

  async function deleteItem(id) {
    if (!confirm("Удалить?")) return;
    const item = items.find((i) => i.id === id);
    await supabase.from("content_items").delete().eq("id", id);
    if (item) await logActivity("удалил(а) " + (kindLabel[item.kind] || "запись"), item.title);
    await loadItems();
    await loadActivity();
  }

  function subscribeRealtime() {
    supabase
      .channel("items-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "content_items" }, () => loadItems())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, () => loadActivity())
      .subscribe();
  }

  // ---------- Render ----------
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function createCard(item) {
    const badge = statusClass[item.status] || "badge-planned";
    const author = item.author
      ? `<div class="card-author">👤 ${escapeHtml(item.author)}</div>`
      : "";
    const notes = item.notes ? `<div class="card-notes">${escapeHtml(item.notes)}</div>` : "";

    return `
      <article class="card">
        <div class="card-top">
          <div class="card-date">
            <span class="card-day">${item.day || ""}</span>
            ${item.date ? " · " + formatDate(item.date) : ""}
          </div>
          <button class="badge ${badge} badge-clickable" data-action="cycle-status" data-id="${item.id}">
            ${item.status}
          </button>
        </div>
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        <div class="card-meta">
          <span class="tag">${kindLabel[item.kind] || item.kind}</span>
          ${item.format ? `<span class="tag">${escapeHtml(item.format)}</span>` : ""}
        </div>
        ${author}
        ${notes}
        <div class="card-actions">
          <button class="btn-text" data-action="edit" data-id="${item.id}">Изменить</button>
          <button class="btn-text danger" data-action="delete" data-id="${item.id}">Удалить</button>
        </div>
      </article>`;
  }

  function getFiltered(kind) {
    let list = items.filter((i) => i.kind === kind);
    if (currentMonth !== "all" && (kind === "post" || kind === "story")) {
      list = list.filter((i) => getMonthKey(i.date) === currentMonth);
    }
    if (currentFilter !== "all") list = list.filter((i) => i.status === currentFilter);
    const q = (document.getElementById("search")?.value || "").toLowerCase().trim();
    if (q) {
      list = list.filter((i) =>
        i.title.toLowerCase().includes(q) ||
        (i.notes || "").toLowerCase().includes(q) ||
        (i.author || "").toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  }

  function renderAll() {
    const map = {
      posts: getFiltered("post"),
      stories: getFiltered("story"),
      tasks: getFiltered("task"),
      ideas: getFiltered("idea")
    };
    document.getElementById("posts-grid").innerHTML =
      map.posts.length ? map.posts.map(createCard).join("") : `<div class="empty">Нет постов</div>`;
    document.getElementById("stories-grid").innerHTML =
      map.stories.length ? map.stories.map(createCard).join("") : `<div class="empty">Нет Stories</div>`;
    document.getElementById("tasks-grid").innerHTML =
      map.tasks.length ? map.tasks.map(createCard).join("") : `<div class="empty">Нет задач — добавь первую</div>`;
    document.getElementById("ideas-grid").innerHTML =
      map.ideas.length ? map.ideas.map(createCard).join("") : `<div class="empty">Нет идей — добавь первую</div>`;

    let posts = items.filter((i) => i.kind === "post");
    if (currentMonth !== "all") posts = posts.filter((i) => getMonthKey(i.date) === currentMonth);
    document.getElementById("stat-total").textContent = posts.length;
    document.getElementById("stat-tasks").textContent = items.filter((i) => i.kind === "task").length;
  }

  function setSyncStatus(text, type) {
    const el = document.getElementById("sync-status");
    if (el) {
      el.textContent = text;
      el.className = "sync-status " + (type || "");
    }
  }

  // ---------- Modal ----------
  const modal = document.getElementById("modal");
  function openModal(item = null) {
    const defaultType = currentTab === "stories" ? "story" : currentTab === "tasks" ? "task" : currentTab === "ideas" ? "idea" : "post";
    document.getElementById("modal-title").textContent = item ? "Редактировать" : "Добавить";
    document.getElementById("form-id").value = item?.id || "";
    document.getElementById("form-type").value = item?.kind || defaultType;
    document.getElementById("form-date").value = item?.date || new Date().toISOString().slice(0, 10);
    document.getElementById("form-title").value = item?.title || "";
    document.getElementById("form-format").value = item?.format || "";
    document.getElementById("form-status").value = item?.status || "Запланировано";
    document.getElementById("form-notes").value = item?.notes || "";
    modal.classList.add("open");
  }
  function closeModal() { modal.classList.remove("open"); }

  document.getElementById("item-form").addEventListener("submit", async (e) => {
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
      author: profile?.name || "",
      author_id: user?.id
    };
    closeModal();
    await saveItem(item);
  });

  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("btn-cancel").onclick = closeModal;
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.getElementById("btn-add").onclick = () => openModal();

  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "cycle-status") {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      const idx = STATUS_CYCLE.indexOf(item.status);
      await updateStatus(id, STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]);
    }
    if (btn.dataset.action === "edit") {
      const item = items.find((i) => i.id === id);
      if (item) openModal(item);
    }
    if (btn.dataset.action === "delete") await deleteItem(id);
  });

  // Tabs
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.dataset.tab;
      document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
      document.getElementById(`tab-${currentTab}`).classList.add("active");
      const showFilters = currentTab !== "team";
      document.getElementById("filters").style.display = showFilters ? "flex" : "none";
      document.getElementById("month-bar").style.display =
        currentTab === "posts" || currentTab === "stories" ? "flex" : "none";
      updatePresenceTab();
    });
  });

  document.querySelectorAll(".month-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".month-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentMonth = btn.dataset.month;
      renderAll();
    });
  });

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderAll();
    });
  });

  document.getElementById("search").addEventListener("input", () => renderAll());

  init();
})();

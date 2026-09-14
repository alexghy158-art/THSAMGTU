/**
 * Командный чат «Твой Ход»
 * Работает поверх основной платформы (supabase + session из localStorage)
 */
(function () {
  const SESSION_KEY = "tvoyhod_session_v1";
  let chatMessages = [];
  let chatChannel = null;
  let sb = null;
  let profile = null;
  let started = false;

  function getClient() {
    if (sb) return sb;
    if (typeof SUPABASE_URL === "undefined" || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    if (!window.supabase) return null;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return sb;
  }

  function getProfile() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(text, type) {
    const el = document.getElementById("chat-status");
    if (!el) return;
    el.textContent = text;
    el.className = "chat-status " + (type || "");
  }

  function renderChat() {
    const box = document.getElementById("chat-messages");
    if (!box) return;
    profile = getProfile();
    if (!chatMessages.length) {
      box.innerHTML = `<div class="chat-empty">Пока нет сообщений — напишите первое</div>`;
      return;
    }
    box.innerHTML = chatMessages
      .map((m) => {
        const mine = profile && m.user_id === profile.id;
        const time = new Date(m.created_at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        });
        return `
          <div class="chat-msg ${mine ? "mine" : ""}">
            <div class="chat-msg-top">
              <span class="chat-msg-author">${escapeHtml(m.user_name || "Участник")}</span>
              <span class="chat-msg-time">${time}</span>
            </div>
            <div class="chat-msg-body">${escapeHtml(m.body)}</div>
          </div>`;
      })
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  async function loadChat() {
    const client = getClient();
    if (!client) {
      setStatus("нет подключения", "error");
      return;
    }
    const { data, error } = await client
      .from("chat_messages")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) {
      if (/does not exist|Could not find the table/i.test(error.message || "")) {
        setStatus("нужен SQL chat_messages", "error");
      } else {
        setStatus("ошибка", "error");
        console.error(error);
      }
      return;
    }
    chatMessages = data || [];
    renderChat();
    setStatus("онлайн", "ok");
  }

  async function sendChat(body) {
    profile = getProfile();
    const client = getClient();
    if (!client || !profile || !body.trim()) return;
    const { error } = await client.from("chat_messages").insert({
      user_id: profile.id,
      user_name: profile.display_name || profile.nickname || "Участник",
      body: body.trim()
    });
    if (error) {
      alert("Не удалось отправить: " + error.message);
      return;
    }
    await loadChat();
  }

  function subscribeChat() {
    const client = getClient();
    if (!client) return;
    if (chatChannel) {
      client.removeChannel(chatChannel);
      chatChannel = null;
    }
    chatChannel = client
      .channel("chat-messages-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const row = payload.new;
          if (!chatMessages.some((m) => m.id === row.id)) {
            chatMessages.push(row);
            renderChat();
          }
        }
      )
      .subscribe();
  }

  function bindUI() {
    const form = document.getElementById("chat-form");
    if (form && !form.dataset.bound) {
      form.dataset.bound = "1";
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("chat-input");
        const body = (input.value || "").trim();
        if (!body) return;
        input.value = "";
        await sendChat(body);
      });
    }

    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.tab === "chat") {
          loadChat();
          const hero = document.getElementById("hero-block");
          if (hero) hero.style.display = "none";
          const filters = document.getElementById("filters");
          if (filters) filters.style.display = "none";
          const month = document.getElementById("month-bar");
          if (month) month.style.display = "none";
        } else {
          const hero = document.getElementById("hero-block");
          if (hero) hero.style.display = "";
        }
      });
    });
  }

  function tryStart() {
    const app = document.getElementById("app");
    if (!app || app.classList.contains("hidden")) return;
    profile = getProfile();
    if (!profile) return;
    if (started) return;
    started = true;
    bindUI();
    loadChat();
    subscribeChat();
  }

  const obs = new MutationObserver(() => tryStart());
  obs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["class"] });
  setInterval(tryStart, 1500);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryStart);
  } else {
    tryStart();
  }
})();

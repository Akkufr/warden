// WARDEN Front-End Engine — HackAthena 2.0 (Team TITANS)

const WARDEN_API_KEY = "warden-dev-key-9941";
let currentRegistrationChallenge = null;

// Dynamic Backend Configuration (Supports Vercel Frontend + Railway Backend)
function getSavedBackendUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const paramBackend = params.get("backend") || params.get("api");
    if (paramBackend) {
      let clean = paramBackend.trim();
      if (clean.endsWith("/")) clean = clean.slice(0, -1);
      localStorage.setItem("warden_backend_url", clean);
      return clean;
    }
  } catch (e) {}

  let saved = localStorage.getItem("warden_backend_url") || window.WARDEN_BACKEND_URL || "";
  if (saved && saved.endsWith("/")) saved = saved.slice(0, -1);
  return saved;
}

function getBackendUrl(path = "") {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const base = getSavedBackendUrl();
  if (!path.startsWith("/")) path = "/" + path;
  return base ? `${base}${path}` : path;
}

function getWebSocketUrl() {
  const base = getSavedBackendUrl() || window.location.origin;
  try {
    const urlObj = new URL(base, window.location.href);
    const wsProtocol = urlObj.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${urlObj.host}/ws/pipeline`;
  } catch (e) {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${window.location.host}/ws/pipeline`;
  }
}

async function wardenFetch(url, options = {}) {
  const fullUrl = getBackendUrl(url);
  const opts = { ...options };
  opts.headers = {
    "X-Warden-API-Key": WARDEN_API_KEY,
    ...(opts.headers || {})
  };
  return fetch(fullUrl, opts);
}

async function fetchRegistrationChallenge() {
  try {
    const res = await wardenFetch("/api/registration/challenge");
    if (res.ok) {
      const data = await res.json();
      currentRegistrationChallenge = data.challenge_token;
      return data;
    }
  } catch (e) {
    console.warn("Could not fetch registration challenge token:", e);
  }
  return null;
}

let currentMode = "guard"; // "guard" or "ledger"
let earlyExit = false;
let currentThreshold = 0.50; // Calibrated SFace threshold
let socket = null;
let isPipelineRunning = false;

// Media Ingestion State
let currentActiveFilePath = null;
let currentActiveSampleId = "sample_registrant_anandhu.jpg";
let currentMediaType = "IMAGE";

// Telemetry & Queue State
let activeFacesQueue = [];
let detectedLedger = [];
let highestMatchResult = null; // Preserves positive match across frames
let currentVectorProjection = new Array(32).fill(0.05);

// Registration UX State
let webcamStream = null;
let regStep = 1; // 1 to 4
let regCaptures = []; // array of base64 images

let lastActiveTabId = "tab-pipeline";

document.addEventListener("DOMContentLoaded", () => {
  initSplashScreen();
  initThemeToggle();
  initTabs();
  initModeControls();
  initBackendConnection();
  initConsoleCLI();
  initMediaUploader();
  initVectorDisplay();
  initPipelineVisualizer();
  initRegistrationUX();
  initRegistryDashboard();
  initDpdpTooltip();
  fetchRegistryStats();
  initAutoRunParam();
});

// ==========================================
// 0. BACKEND CONNECTION & MODAL FOR VERCEL DEPLOYMENT
// ==========================================
function initBackendConnection() {
  const badge = document.getElementById("backend-status-badge");
  const modal = document.getElementById("backend-modal");
  const closeBtn = document.getElementById("close-backend-modal-btn");
  const saveBtn = document.getElementById("save-backend-btn");
  const resetBtn = document.getElementById("reset-backend-btn");
  const input = document.getElementById("backend-url-input");
  const statusDiv = document.getElementById("backend-modal-status");

  function openModal() {
    if (modal) {
      if (input) input.value = getSavedBackendUrl() || "";
      if (statusDiv) {
        statusDiv.style.display = "none";
        statusDiv.textContent = "";
      }
      modal.style.display = "flex";
      if (input) input.focus();
    }
  }

  function closeModal() {
    if (modal) modal.style.display = "none";
  }

  if (badge) badge.addEventListener("click", openModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const val = input ? input.value.trim() : "";
      if (val) {
        let clean = val;
        if (clean.endsWith("/")) clean = clean.slice(0, -1);
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
          clean = "https://" + clean;
        }
        localStorage.setItem("warden_backend_url", clean);
        if (statusDiv) {
          statusDiv.style.display = "block";
          statusDiv.style.background = "rgba(6, 182, 212, 0.15)";
          statusDiv.style.color = "#06b6d4";
          statusDiv.textContent = "Testing connection to " + clean + "...";
        }
        try {
          const res = await fetch(`${clean}/api/health`, {
            headers: { "X-Warden-API-Key": WARDEN_API_KEY }
          });
          if (res.ok) {
            showToast("Connected to Railway Backend successfully!", "success");
            closeModal();
            updateBackendBadge(true);
            fetchRegistryStats(false);
          } else {
            if (statusDiv) {
              statusDiv.style.display = "block";
              statusDiv.style.background = "rgba(239, 68, 68, 0.15)";
              statusDiv.style.color = "#ef4444";
              statusDiv.textContent = `Server responded with HTTP ${res.status}. Check API key or URL.`;
            }
          }
        } catch (err) {
          if (statusDiv) {
            statusDiv.style.display = "block";
            statusDiv.style.background = "rgba(239, 68, 68, 0.15)";
            statusDiv.style.color = "#ef4444";
            statusDiv.textContent = `Connection failed: ${err.message}. Make sure Railway server is online.`;
          }
        }
      } else {
        localStorage.removeItem("warden_backend_url");
        updateBackendBadge(null);
        closeModal();
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem("warden_backend_url");
      if (input) input.value = "";
      updateBackendBadge(null);
      showToast("Reset to same origin", "info");
      closeModal();
      fetchRegistryStats(false);
    });
  }

  // Periodic and initial check
  checkBackendHealth();
  setInterval(checkBackendHealth, 30000);
}

async function checkBackendHealth() {
  try {
    const res = await wardenFetch("/api/health");
    if (res.ok) {
      const data = await res.json();
      updateBackendBadge(true, data);
    } else {
      updateBackendBadge(false);
    }
  } catch (e) {
    updateBackendBadge(false);
  }
}

function updateBackendBadge(isHealthy, data = null) {
  const badgeText = document.getElementById("sys-status-text");
  const badgeDot = document.querySelector("#backend-status-badge .status-dot");
  const savedUrl = getSavedBackendUrl();

  if (isHealthy === true) {
    if (badgeText) badgeText.textContent = savedUrl ? "RAILWAY ONLINE" : "FAISS READY";
    if (badgeDot) {
      badgeDot.style.background = "#10b981";
      badgeDot.style.boxShadow = "0 0 8px #10b981";
    }
  } else if (isHealthy === false) {
    if (badgeText) badgeText.textContent = savedUrl ? "RAILWAY OFFLINE" : "CONNECT RAILWAY";
    if (badgeDot) {
      badgeDot.style.background = "#ef4444";
      badgeDot.style.boxShadow = "0 0 8px #ef4444";
    }
    // Auto-prompt on Vercel if not yet connected
    if (window.location.hostname.includes("vercel.app") && !savedUrl) {
      setTimeout(() => {
        const modal = document.getElementById("backend-modal");
        if (modal && modal.style.display !== "flex") {
          const input = document.getElementById("backend-url-input");
          if (input) input.value = "";
          modal.style.display = "flex";
        }
      }, 1500);
    }
  }
}

// ==========================================
// 0A. EXTENSION & INTEGRATION AUTO-RUN HOOK
// ==========================================
function applyRoutedMedia(config = {}) {
  const { filePath, fileName, mediaType, source } = config;
  if (!filePath) return;

  // 1. Instantly dismiss splash screen so live dashboard is immediately visible
  const splash = document.getElementById("warden-splash");
  if (splash) {
    splash.classList.add("splash-hidden");
    splash.style.display = "none";
  }

  // 2. Ensure Live Pipeline tab is active
  const navPipelineBtn = document.getElementById("nav-pipeline-btn");
  if (navPipelineBtn && !navPipelineBtn.classList.contains("active")) {
    navPipelineBtn.click();
  }

  const isWhatsApp = source === "whatsapp" || (fileName && fileName.toLowerCase().includes("whatsapp"));
  const platformLabel = isWhatsApp ? "WhatsApp Web" : "Instagram DM";

  addLogEntry("INFO", `[${platformLabel} Gate] Intercepted attachment received. Initializing automatic verification pipeline...`);

  currentActiveFilePath = filePath;
  currentActiveSampleId = null;

  // Detect media format (video vs image)
  const isVideo = filePath.match(/\.(mp4|webm|avi|mov|mkv)$/i) || mediaType === "VIDEO";
  currentMediaType = isVideo ? "VIDEO" : "IMAGE";

  // Update dropzone UI indicators to reflect staged attachment
  const fileNameEl = document.getElementById("dropzone-file-name");
  const fileMetaEl = document.getElementById("dropzone-file-meta");
  const typeBadge = document.getElementById("media-type-badge");
  const resBadge = document.getElementById("badge-resolution");
  const dropzone = document.getElementById("upload-dropzone");

  const defaultAttachmentName = isWhatsApp ? "WhatsApp_Attachment" : "Instagram_Attachment";
  const displayFileName = fileName || filePath.split(/[\\/]/).pop() || defaultAttachmentName;

  if (dropzone) {
    dropzone.classList.remove("error-state");
    dropzone.classList.add("success-state");
  }
  if (fileNameEl) {
    fileNameEl.innerHTML = `<strong>📷 ${escapeHtml(displayFileName)}</strong>`;
  }
  if (fileMetaEl) {
    fileMetaEl.textContent = `${platformLabel} Interception • Automatic verification executing...`;
  }
  if (typeBadge) {
    typeBadge.style.display = "inline-block";
    typeBadge.textContent = `READY: ${currentMediaType}`;
    typeBadge.style.color = isVideo ? "var(--cyan)" : "var(--emerald)";
    typeBadge.style.borderColor = isVideo ? "var(--cyan)" : "var(--emerald)";
  }
  if (resBadge) {
    resBadge.textContent = isVideo ? "VIDEO STREAM" : "IMAGE DIRECT";
  }

  showToast(`${platformLabel} attachment received: ${displayFileName}. Auto-processing initiated.`, "info", 4000);

  // 3. Immediately execute verification pipeline with zero startup delay
  if (isPipelineRunning && socket) {
    try { socket.close(); } catch (e) {}
    isPipelineRunning = false;
  }
  runPipelineScan();
}

window.wardenRouteMedia = applyRoutedMedia;

function initAutoRunParam() {
  const urlParams = new URLSearchParams(window.location.search);
  const filePath = urlParams.get("file_path");
  const autoRun = urlParams.get("auto_run");
  const source = urlParams.get("source");
  const paramFileName = urlParams.get("filename");
  const paramMediaType = urlParams.get("media_type");

  if (source === "extension" || source === "whatsapp" || source === "instagram" || autoRun === "1") {
    if (filePath) {
      applyRoutedMedia({
        filePath: filePath,
        fileName: paramFileName,
        mediaType: paramMediaType,
        source: source
      });
    }
  }

  // Cross-tab real-time bus listeners (zero reload, sub-1ms response)
  if (window.BroadcastChannel) {
    try {
      const bc = new BroadcastChannel("warden_route_channel");
      bc.onmessage = (evt) => {
        if (evt.data && evt.data.filePath) {
          applyRoutedMedia(evt.data);
        }
      };
    } catch (e) {}
  }

  window.addEventListener("storage", (evt) => {
    if (evt.key === "warden_routed_media" && evt.newValue) {
      try {
        const data = JSON.parse(evt.newValue);
        if (data && data.filePath && (Date.now() - (data.ts || 0)) < 15000) {
          applyRoutedMedia(data);
        }
      } catch (e) {}
    }
  });

  window.addEventListener("warden:route-media", (evt) => {
    if (evt.detail) {
      applyRoutedMedia(evt.detail);
    }
  });
}

// ==========================================
// 0. SPLASH SCREEN (1-SECOND MINIMALISTIC TIMED LAUNCH)
// ==========================================
function initSplashScreen() {
  const splash = document.getElementById("warden-splash");
  if (!splash) return;

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("auto_run") === "1" || urlParams.get("source") || urlParams.get("file_path")) {
    splash.classList.add("splash-hidden");
    splash.style.display = "none";
    return;
  }

  const dismissSplash = () => {
    if (splash.classList.contains("splash-hidden")) return;
    splash.classList.add("splash-hidden");
    setTimeout(() => {
      splash.style.display = "none";
    }, 400);
  };

  // 1-second timed launch
  setTimeout(dismissSplash, 1000);

  // Instant dismiss on click/tap
  splash.addEventListener("click", dismissSplash);
}

// ==========================================
// 0B. THEME TOGGLE (LIGHT & DARK MODES)
// ==========================================
function initThemeToggle() {
  const toggleBtn = document.getElementById("theme-toggle-btn");
  const savedTheme = localStorage.getItem("warden_theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const nextTheme = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", nextTheme);
      localStorage.setItem("warden_theme", nextTheme);
      addLogEntry("SYSTEM", `Visual theme switched to ${nextTheme.toUpperCase()} mode.`);
    });
  }
}

// ==========================================
// 1. TAB NAVIGATION & ARCHITECTURE CORNER ICON
// ==========================================
function initTabs() {

  const navBtns = document.querySelectorAll(".nav-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  navBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-tab");
      lastActiveTabId = targetId;
      navBtns.forEach(b => b.classList.remove("active"));
      tabContents.forEach(tc => tc.classList.remove("active"));

      btn.classList.add("active");
      const targetSection = document.getElementById(targetId);
      if (targetSection) targetSection.classList.add("active");

      // Hide registration banners and dismiss camera warning toasts when navigating to other tabs
      if (targetId !== "tab-registration") {
        const banner = document.getElementById("face-detection-banner");
        if (banner) banner.style.display = "none";
        const autoBadge = document.getElementById("auto-snap-badge");
        if (autoBadge) autoBadge.style.display = "none";
        // Remove any persistent camera warning toasts
        const toasts = document.querySelectorAll(".warden-toast");
        toasts.forEach(t => t.remove());
      }

      if (targetId === "tab-registry") {
        fetchRegistryStats();
      }
    });
  });

  // Architecture corner icon button
  const openArchBtn = document.getElementById("open-arch-btn");
  if (openArchBtn) {
    openArchBtn.addEventListener("click", () => {
      navBtns.forEach(b => b.classList.remove("active"));
      tabContents.forEach(tc => tc.classList.remove("active"));
      const archSection = document.getElementById("tab-architecture");
      if (archSection) archSection.classList.add("active");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  const archCloseBtn = document.getElementById("arch-close-btn");
  if (archCloseBtn) {
    archCloseBtn.addEventListener("click", () => {
      const prevBtn = document.querySelector(`.nav-btn[data-tab="${lastActiveTabId}"]`) || document.getElementById("nav-pipeline-btn");
      if (prevBtn) prevBtn.click();
    });
  }

  const brandLink = document.getElementById("brand-link");
  if (brandLink) {
    brandLink.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("nav-pipeline-btn").click();
    });
  }
}

// ==========================================
// 2. UNIFIED MODE & POLICY CONTROLS
// ==========================================
function addCliOutput(text, type = "normal") {
  const screen = document.getElementById("console-cli-output");
  if (!screen) return;
  const line = document.createElement("div");
  line.className = `term-line ${type}`;
  line.textContent = text;
  screen.appendChild(line);
  screen.scrollTop = screen.scrollHeight;
}

function setSystemMode(mode, isEarlyExit = false) {
  currentMode = mode === "ledger" ? "ledger" : "guard";
  earlyExit = currentMode === "ledger" ? false : Boolean(isEarlyExit);

  // 1. Header Triple Buttons
  const hGuard = document.getElementById("btn-mode-guard");
  const hEarly = document.getElementById("btn-mode-early");
  const hLedger = document.getElementById("btn-mode-ledger");

  if (hGuard) hGuard.classList.remove("active");
  if (hEarly) hEarly.classList.remove("active");
  if (hLedger) hLedger.classList.remove("active");

  if (currentMode === "ledger") {
    if (hLedger) hLedger.classList.add("active");
  } else if (earlyExit) {
    if (hEarly) hEarly.classList.add("active");
  } else {
    if (hGuard) hGuard.classList.add("active");
  }

  // 2. Deployment Console Buttons
  const cGuard = document.getElementById("console-mode-guard");
  const cEarly = document.getElementById("console-mode-early");
  const cLedger = document.getElementById("console-mode-ledger");

  if (cGuard) cGuard.classList.remove("active");
  if (cEarly) cEarly.classList.remove("active");
  if (cLedger) cLedger.classList.remove("active");

  if (currentMode === "ledger") {
    if (cLedger) cLedger.classList.add("active");
    if (cEarly) {
      cEarly.disabled = true;
      cEarly.classList.add("disabled");
    }
  } else {
    if (cGuard) cGuard.classList.add("active");
    if (cEarly) {
      cEarly.disabled = false;
      cEarly.classList.remove("disabled");
      if (earlyExit) cEarly.classList.add("active");
    }
  }

  // 3. Viewport Telemetry Badge
  const modeBadge = document.getElementById("badge-mode-ind");
  if (modeBadge) {
    if (currentMode === "ledger") {
      modeBadge.textContent = "MODE: LEDGER (FULL AUDIT)";
    } else if (earlyExit) {
      modeBadge.textContent = "MODE: GUARD (EARLY-EXIT)";
    } else {
      modeBadge.textContent = "MODE: GUARD (GATING)";
    }
  }

  const modeStr = currentMode === "ledger"
    ? "LEDGER (Full-Scan Forensic Audit)"
    : `GUARD (Upload Gating, Early Exit: ${earlyExit ? "ON" : "OFF"})`;

  addLogEntry("SYSTEM", `System Mode Updated: ${modeStr}`);
  addCliOutput(`[MODE] Active mode switched to: ${modeStr}`, "cmd");
}

function initModeControls() {
  // Header 3 Buttons
  const hGuard = document.getElementById("btn-mode-guard");
  const hEarly = document.getElementById("btn-mode-early");
  const hLedger = document.getElementById("btn-mode-ledger");

  if (hGuard) {
    hGuard.addEventListener("click", () => setSystemMode("guard", false));
  }
  if (hEarly) {
    hEarly.addEventListener("click", () => setSystemMode("guard", true));
  }
  if (hLedger) {
    hLedger.addEventListener("click", () => setSystemMode("ledger", false));
  }

  // Deployment Console Toggle Buttons
  const cGuard = document.getElementById("console-mode-guard");
  const cEarly = document.getElementById("console-mode-early");
  const cLedger = document.getElementById("console-mode-ledger");

  if (cGuard) {
    cGuard.addEventListener("click", () => setSystemMode("guard", false));
  }
  if (cLedger) {
    cLedger.addEventListener("click", () => setSystemMode("ledger", false));
  }
  if (cEarly) {
    cEarly.addEventListener("click", () => {
      if (currentMode === "guard") {
        setSystemMode("guard", !earlyExit);
      }
    });
  }
}

// ==========================================
// 2B. DEPLOYMENT CONSOLE OPERATOR TERMINAL
// ==========================================
function initConsoleCLI() {
  const form = document.getElementById("console-cli-form");
  const input = document.getElementById("console-cli-input");
  if (!form || !input) return;

  const commandHistory = [];
  let historyIndex = -1;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawCmd = input.value.trim();
    if (!rawCmd) return;

    commandHistory.push(rawCmd);
    historyIndex = commandHistory.length;
    input.value = "";

    addCliOutput(`operator@warden:~$ ${rawCmd}`, "cmd");
    await handleCliCommand(rawCmd);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      if (historyIndex > 0) {
        historyIndex--;
        input.value = commandHistory[historyIndex];
      }
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (historyIndex < commandHistory.length - 1) {
        historyIndex++;
        input.value = commandHistory[historyIndex];
      } else {
        historyIndex = commandHistory.length;
        input.value = "";
      }
      e.preventDefault();
    }
  });
}

async function handleCliCommand(rawCmd) {
  const parts = rawCmd.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");
  const argLower = arg.toLowerCase();

  switch (cmd) {
    case "help":
      addCliOutput("AVAILABLE OPERATOR COMMANDS:", "info");
      addCliOutput("  guard               - Switch system to GUARD mode (upload gating)", "sys");
      addCliOutput("  ledger              - Switch system to LEDGER mode (forensic scan)", "sys");
      addCliOutput("  early-exit <on|off> - Toggle early exit policy (GUARD mode only)", "sys");
      addCliOutput("  status              - Display runtime operational status & config", "sys");
      addCliOutput("  ping | health       - Check backend API latency & status", "sys");
      addCliOutput("  pipeline [url]      - Inspect or update input pipeline endpoint", "sys");
      addCliOutput("  db [conn]           - Inspect or update registry database target", "sys");
      addCliOutput("  stats               - Query FAISS index vector count and metrics", "sys");
      addCliOutput("  whoami              - Show current operator identity and role", "sys");
      addCliOutput("  clear | cls         - Clear terminal display buffer", "sys");
      break;

    case "guard":
      setSystemMode("guard", false);
      addCliOutput("OK: System switched to GUARD mode (Gating verdict: PASS/BLOCK).", "cmd");
      break;

    case "ledger":
      setSystemMode("ledger", false);
      addCliOutput("OK: System switched to LEDGER mode (Full forensic scan enabled. Early Exit disabled).", "cmd");
      break;

    case "early-exit":
    case "earlyexit":
      if (currentMode === "ledger") {
        addCliOutput("WARN: Cannot enable Early Exit while LEDGER mode is active. Switch to GUARD first.", "warn");
        return;
      }
      if (argLower === "on" || argLower === "true" || argLower === "1") {
        setSystemMode("guard", true);
        addCliOutput("OK: Early Exit ENABLED. Pipeline terminates evaluation on first confirmed likeness match.", "cmd");
      } else if (argLower === "off" || argLower === "false" || argLower === "0") {
        setSystemMode("guard", false);
        addCliOutput("OK: Early Exit DISABLED. Pipeline evaluates all faces in frame.", "cmd");
      } else {
        setSystemMode("guard", !earlyExit);
        addCliOutput(`OK: Early Exit toggled to: ${earlyExit ? "ENABLED" : "DISABLED"}.`, "cmd");
      }
      break;

    case "status":
      addCliOutput("--- WARDEN RUNTIME STATUS ---", "info");
      addCliOutput(`Mode:            ${currentMode.toUpperCase()}`, "sys");
      addCliOutput(`Early Exit:      ${earlyExit ? "ON" : "OFF"}`, "sys");
      addCliOutput(`Threshold:       ${currentThreshold} (Cosine similarity)`, "sys");
      const pipeVal = document.getElementById("console-input-pipeline")?.value || "N/A";
      const dbVal = document.getElementById("console-registry-db")?.value ? "******** (Configured)" : "Unset";
      addCliOutput(`Input Pipeline:  ${pipeVal}`, "sys");
      addCliOutput(`Registry DB:     ${dbVal}`, "sys");
      addCliOutput(`Pipeline Active: ${isPipelineRunning ? "RUNNING" : "IDLE"}`, "sys");
      break;

    case "ping":
    case "health":
      try {
        const startT = performance.now();
        const res = await wardenFetch("/api/health");
        const lat = Math.round(performance.now() - startT);
        if (res.ok) {
          const d = await res.json();
          addCliOutput(`PONG: API 200 OK (${lat}ms) | Engine: ${d.version || "SFace 128D"} | Status: HEALTHY`, "cmd");
        } else {
          addCliOutput(`ERR: API returned HTTP ${res.status} (${lat}ms)`, "error");
        }
      } catch (e) {
        addCliOutput(`ERR: API connection failed: ${e.message}`, "error");
      }
      break;

    case "pipeline":
      const pipeInput = document.getElementById("console-input-pipeline");
      if (arg) {
        if (pipeInput) pipeInput.value = arg;
        addCliOutput(`OK: Input pipeline updated to: ${arg}`, "cmd");
      } else {
        addCliOutput(`Current Input Pipeline: ${pipeInput ? pipeInput.value : "None"}`, "sys");
      }
      break;

    case "db":
    case "database":
      const dbInput = document.getElementById("console-registry-db");
      if (arg) {
        if (dbInput) dbInput.value = arg;
        addCliOutput("OK: Registry database connection string updated.", "cmd");
      } else {
        addCliOutput(`Current Registry DB: ${dbInput && dbInput.value ? "******** (Configured)" : "None"}`, "sys");
      }
      break;

    case "stats":
      try {
        const res = await wardenFetch("/api/registry");
        if (res.ok) {
          const st = await res.json();
          addCliOutput(`FAISS Vectors:   ${st.indexed_vectors ?? (st.registrants ? st.registrants.length * 4 : 0)}`, "info");
          addCliOutput(`Enrolled Faces:  ${st.active_registrants ?? (st.registrants ? st.registrants.length : 0)}`, "info");
          addCliOutput(`Index Architecture: IndexFlatIP Cosine Similarity`, "sys");
          addCliOutput(`Feature Space:   128-D Unit Normalized Embeddings`, "sys");
        } else {
          addCliOutput("ERR: Could not retrieve registry stats", "error");
        }
      } catch (e) {
        addCliOutput(`ERR: Stats query failed: ${e.message}`, "error");
      }
      break;

    case "whoami":
      addCliOutput("operator@warden-node-01 (role: DPDP Compliance Administrator, level: ROOT)", "sys");
      break;

    case "clear":
    case "cls":
      const scr = document.getElementById("console-cli-output");
      if (scr) scr.innerHTML = "";
      break;

    default:
      addCliOutput(`Command not recognized: '${cmd}'. Type 'help' for available commands.`, "warn");
      break;
  }
}

// ==========================================
// 3. MEDIA UPLOADER & AUTO DETECTION (NO DROPDOWN)
// ==========================================
function initMediaUploader() {
  const dropzone = document.getElementById("upload-dropzone");
  const fileInput = document.getElementById("media-upload-input");
  const benchmarkBtn = document.getElementById("benchmark-sample-btn");
  const fileNameEl = document.getElementById("dropzone-file-name");
  const fileMetaEl = document.getElementById("dropzone-file-meta");
  const typeBadge = document.getElementById("media-type-badge");
  const resBadge = document.getElementById("badge-resolution");

  // Click to open file dialog
  dropzone.addEventListener("click", () => fileInput.click());

  // Drag and drop events
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleSelectedFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleSelectedFile(e.target.files[0]);
    }
  });

  async function handleSelectedFile(file) {
    if (!file) return;

    // Reset previous states
    dropzone.classList.remove("error-state", "success-state");

    const ext = file.name.split('.').pop().toLowerCase();
    const allowedExtensions = ["jpg", "jpeg", "png", "webp", "mp4", "mov", "avi", "webm"];

    // 1. Client-Side Format Validation
    if (!allowedExtensions.includes(ext)) {
      dropzone.classList.add("error-state");
      fileNameEl.innerHTML = `<span style="color:var(--crimson); font-weight:700;">⚠️ UNSUPPORTED FORMAT: ${escapeHtml(file.name)}</span>`;
      fileMetaEl.innerHTML = `<span style="color:var(--crimson);">Extension '.${ext}' is not supported. Supported: JPG, PNG, WEBP, MP4, MOV, WEBM, AVI.</span>`;
      typeBadge.style.display = "inline-block";
      typeBadge.textContent = "UNSUPPORTED";
      typeBadge.style.color = "var(--crimson)";
      typeBadge.style.borderColor = "var(--crimson)";
      currentActiveFilePath = null;
      currentActiveSampleId = null;
      showToast(`Unsupported file format (.${ext}). Only image and video media can be processed.`, "danger", 6000);
      addLogEntry("WARN", `[Ingestion Blocked] Unsupported file '${file.name}' (.${ext}) rejected. Only standard image/video formats supported.`);
      return;
    }

    // 2. Client-Side Empty / Corrupt File Validation
    if (file.size === 0) {
      dropzone.classList.add("error-state");
      fileNameEl.innerHTML = `<span style="color:var(--crimson); font-weight:700;">⚠️ CORRUPT / EMPTY FILE: ${escapeHtml(file.name)}</span>`;
      fileMetaEl.innerHTML = `<span style="color:var(--crimson);">File size is 0 bytes. Media file is damaged, truncated, or empty.</span>`;
      typeBadge.style.display = "inline-block";
      typeBadge.textContent = "CORRUPT (0 BYTES)";
      typeBadge.style.color = "var(--crimson)";
      typeBadge.style.borderColor = "var(--crimson)";
      currentActiveFilePath = null;
      currentActiveSampleId = null;
      showToast("Empty file detected (0 bytes). File is corrupt or truncated.", "danger", 6000);
      addLogEntry("WARN", `[Ingestion Blocked] Zero-byte corrupt file '${file.name}' rejected.`);
      return;
    }

    // 3. Client-Side Max File Size Ceiling (60MB)
    if (file.size > 60 * 1024 * 1024) {
      dropzone.classList.add("error-state");
      fileNameEl.innerHTML = `<span style="color:var(--crimson); font-weight:700;">⚠️ FILE TOO LARGE: ${escapeHtml(file.name)}</span>`;
      fileMetaEl.innerHTML = `<span style="color:var(--crimson);">Size ${(file.size / (1024 * 1024)).toFixed(1)}MB exceeds 60MB safety ceiling.</span>`;
      typeBadge.style.display = "inline-block";
      typeBadge.textContent = "OVERSIZED (>60MB)";
      typeBadge.style.color = "var(--crimson)";
      typeBadge.style.borderColor = "var(--crimson)";
      currentActiveFilePath = null;
      currentActiveSampleId = null;
      showToast("File exceeds maximum allowed size of 60MB.", "danger", 6000);
      addLogEntry("WARN", `[Ingestion Blocked] File '${file.name}' exceeds 60MB safety threshold.`);
      return;
    }

    const isVideo = ["mp4", "webm", "avi", "mov"].includes(ext) || file.type.startsWith("video/");
    currentMediaType = isVideo ? "VIDEO" : "IMAGE";

    typeBadge.style.display = "inline-block";
    typeBadge.textContent = `DETECTED: ${currentMediaType}`;
    typeBadge.style.color = isVideo ? "var(--cyan)" : "var(--emerald)";
    typeBadge.style.borderColor = isVideo ? "var(--cyan)" : "var(--emerald)";

    fileNameEl.innerHTML = `<strong>${escapeHtml(file.name)}</strong>`;
    fileMetaEl.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB | ${file.type || ext.toUpperCase()} | Validating file signature...`;

    if (resBadge) {
      resBadge.textContent = currentMediaType === "VIDEO" ? "VIDEO STREAM" : "IMAGE DIRECT";
    }

    addLogEntry("SYSTEM", `Media Selected: ${file.name} | Auto-detected: ${currentMediaType}. Inspecting magic header on staging server...`);

    // Upload to backend for magic byte & container integrity inspection
    const formData = new FormData();
    formData.append("file", file);

    try {
      const resp = await wardenFetch("/api/upload", { method: "POST", body: formData });
      let data = {};
      try {
        data = await resp.json();
      } catch (e) {
        data = { detail: "Invalid server response or network communication error" };
      }

      if (!resp.ok) {
        const errorDetail = data.detail || `Upload rejected (Status ${resp.status})`;
        dropzone.classList.remove("success-state");
        dropzone.classList.add("error-state");

        const statusTag = resp.status === 413 ? "OVERSIZED" : (resp.status === 429 ? "QUARANTINED" : "CORRUPT / REJECTED");
        fileNameEl.innerHTML = `<span style="color:var(--crimson); font-weight:700;">⚠️ INGESTION REJECTED: ${escapeHtml(file.name)}</span>`;
        fileMetaEl.innerHTML = `<span style="color:var(--crimson);">${escapeHtml(errorDetail)}</span>`;
        typeBadge.style.display = "inline-block";
        typeBadge.textContent = statusTag;
        typeBadge.style.color = "var(--crimson)";
        typeBadge.style.borderColor = "var(--crimson)";

        currentActiveFilePath = null;
        currentActiveSampleId = null;

        showToast(`Media Ingestion Error: ${errorDetail}`, "danger", 6000);
        addLogEntry("WARN", `[Ingestion Rejected] ${file.name}: ${errorDetail}`);
        return;
      }

      if (data.file_path) {
        dropzone.classList.remove("error-state");
        dropzone.classList.add("success-state");
        currentActiveFilePath = data.file_path;
        currentActiveSampleId = null;

        fileNameEl.innerHTML = `<strong>${escapeHtml(file.name)}</strong>`;
        fileMetaEl.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB | ${data.content_type} | Verified Signature — Ready for Pipeline`;
        typeBadge.style.display = "inline-block";
        typeBadge.textContent = `READY: ${data.content_type}`;
        typeBadge.style.color = data.content_type === "VIDEO" ? "var(--cyan)" : "var(--emerald)";
        typeBadge.style.borderColor = data.content_type === "VIDEO" ? "var(--cyan)" : "var(--emerald)";

        showToast(`Media verified & staged: ${file.name} (${data.content_type})`, "success", 3500);
        addLogEntry("INFO", `[Staging Ready] File prepared at ${data.filename}. Click 'RUN VERIFICATION PIPELINE' to execute.`);
      }
    } catch (err) {
      dropzone.classList.remove("success-state");
      dropzone.classList.add("error-state");
      fileNameEl.innerHTML = `<span style="color:var(--crimson); font-weight:700;">⚠️ UPLOAD ERROR: ${escapeHtml(file.name)}</span>`;
      fileMetaEl.innerHTML = `<span style="color:var(--crimson);">${escapeHtml(err.message)}</span>`;
      typeBadge.textContent = "ERROR";
      typeBadge.style.color = "var(--crimson)";
      typeBadge.style.borderColor = "var(--crimson)";
      currentActiveFilePath = null;
      currentActiveSampleId = null;
      showToast(`Upload failed: ${err.message}`, "danger", 5000);
      addLogEntry("WARN", `Upload staging error: ${err.message}`);
    }
  }

  // Cross-reference / AI benchmark sample button (One-click test)
  let benchmarkToggle = 0;
  const benchmarkSamples = [
    { id: "sample_registrant_anandhu.jpg", name: "Opted-In Registrant Likeness (Anandhu A)", type: "IMAGE" },
    { id: "sample_dedup_video.mp4", name: "AI Video Stream (Intra-Content Dedup Proof)", type: "VIDEO" },
    { id: "sample_synthetic_broadcast.jpg", name: "Synthetic AI Studio Broadcast Frame", type: "IMAGE" }
  ];

  benchmarkBtn.addEventListener("click", () => {
    const sample = benchmarkSamples[benchmarkToggle % benchmarkSamples.length];
    benchmarkToggle++;

    currentActiveSampleId = sample.id;
    currentActiveFilePath = null;
    currentMediaType = sample.type;

    typeBadge.style.display = "inline-block";
    typeBadge.textContent = `BENCHMARK: ${sample.type}`;
    typeBadge.style.color = "var(--amber)";
    typeBadge.style.borderColor = "var(--amber)";

    fileNameEl.innerHTML = `<strong>${sample.name}</strong>`;
    fileMetaEl.textContent = `Pre-packaged Benchmark Asset [${sample.id}] | Auto-detected: ${sample.type}`;

    if (resBadge) {
      resBadge.textContent = sample.type === "VIDEO" ? "BENCHMARK VIDEO" : "BENCHMARK IMAGE";
    }

    addLogEntry("INFO", `[Benchmark Selected] Loaded ${sample.name}. Ready for verification.`);
  });
}

// ==========================================
// 4. VECTOR PROJECTION & COSINE ALIGNMENT (NO RADAR)
// ==========================================
function initVectorDisplay() {
  const barsContainer = document.getElementById("vector-bars-preview");
  if (!barsContainer) return;

  barsContainer.innerHTML = "";
  for (let i = 0; i < 32; i++) {
    const bar = document.createElement("div");
    bar.className = "v-bar";
    bar.id = `v-bar-${i}`;
    bar.style.height = "15%";
    barsContainer.appendChild(bar);
  }
}

function updateVectorProjectionDisplay(newVec, simScore, status, registrant) {
  if (newVec && newVec.length > 0) {
    newVec.forEach((val, idx) => {
      const bar = document.getElementById(`v-bar-${idx}`);
      if (bar) {
        const h = Math.max(8, Math.min(100, Math.round(Math.abs(val) * 350)));
        bar.style.height = `${h}%`;
        bar.style.background = status === "FLAGGED" ? "var(--crimson)" : (status === "CLEARED" ? "var(--emerald)" : "var(--cyan)");
      }
    });
  }

  const simVal = document.getElementById("sim-score-val");
  const statusBadge = document.getElementById("vector-status-badge");
  const targetName = document.getElementById("target-registrant-name");
  const marginInfo = document.getElementById("target-margin-info");

  const simPct = (simScore * 100).toFixed(1);
  if (simVal) simVal.textContent = `${simPct}%`;

  if (status === "FLAGGED" && registrant) {
    if (simVal) simVal.className = "sim-value flagged";
    if (statusBadge) {
      statusBadge.className = "face-status-badge flagged";
      statusBadge.textContent = "MATCH: BLOCKED";
    }
    if (targetName) targetName.textContent = `TARGET: ${registrant.name} (${registrant.affiliation || "Protected Identity"})`;
    const margin = ((simScore - currentThreshold) * 100).toFixed(1);
    if (marginInfo) {
      marginInfo.style.color = "var(--crimson)";
      marginInfo.textContent = `MARGIN: +${margin}% ABOVE 50% THRESHOLD`;
    }
  } else if (status === "CLEARED") {
    if (simVal) simVal.className = "sim-value cleared";
    if (statusBadge) {
      statusBadge.className = "face-status-badge cleared";
      statusBadge.textContent = "CLEARED: PASS";
    }
    if (targetName) targetName.textContent = `NO REGISTERED MATCH (Max Sim: ${simPct}%)`;
    if (marginInfo) {
      marginInfo.style.color = "var(--emerald)";
      marginInfo.textContent = `BELOW 50% THRESHOLD`;
    }
  }
}

// ==========================================
// 5. PIPELINE SCAN ENGINE & WEBSOCKET STREAM
// ==========================================
function initPipelineVisualizer() {
  const startBtn = document.getElementById("start-scan-btn");
  const dismissVerdictBtn = document.getElementById("dismiss-verdict-btn");

  // Filter buttons for terminal logs
  const filterBtns = document.querySelectorAll(".log-filter-btn");
  filterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.getAttribute("data-filter");
      filterLogs(filter);
    });
  });

  if (dismissVerdictBtn) {
    dismissVerdictBtn.addEventListener("click", () => {
      document.getElementById("verdict-banner").classList.remove("active");
    });
  }

  startBtn.addEventListener("click", () => {
    if (isPipelineRunning) return;
    runPipelineScan();
  });
}

function runPipelineScan() {
  const startBtn = document.getElementById("start-scan-btn");
  const placeholder = document.getElementById("viewport-placeholder");
  const hud = document.getElementById("hud-overlay");
  const progressBar = document.getElementById("pipeline-progress-bar");
  const verdictBanner = document.getElementById("verdict-banner");
  const queueContainer = document.getElementById("queue-container");

  // Validate that media source is loaded and was not rejected
  if (!currentActiveFilePath && !currentActiveSampleId) {
    showToast("Cannot execute pipeline: No valid media selected or uploaded file was rejected.", "danger", 6000);
    addLogEntry("WARN", "[Pipeline Blocked] Ingestion rejected: No verified media source staged.");
    if (placeholder) {
      placeholder.style.display = "flex";
      placeholder.innerHTML = `
        <svg class="placeholder-icon" style="color: var(--crimson);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <div>
          <strong style="color: var(--crimson);">Ingestion Blocked: No Valid Media</strong><br>
          <span style="font-size: 0.8rem; font-family: var(--font-mono); color: var(--text-muted);">Please upload an uncorrupted media file or click 'Load AI Benchmark Example'.</span>
        </div>
      `;
    }
    return;
  }

  verdictBanner.classList.remove("active");
  placeholder.style.display = "none";
  hud.style.display = "flex";
  progressBar.style.width = "0%";
  queueContainer.innerHTML = "";
  activeFacesQueue = [];
  detectedLedger = [];
  highestMatchResult = null;
  isPipelineRunning = true;

  startBtn.disabled = true;
  startBtn.innerHTML = `VERIFYING MEDIA...`;

  const wsUrl = getWebSocketUrl();
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    let payload = {
      action: "start",
      mode: currentMode,
      early_exit: earlyExit,
      threshold: currentThreshold
    };

    if (currentActiveFilePath) {
      payload.file_path = currentActiveFilePath;
      addLogEntry("INFO", `[Pipeline Stream] Initiating verification on uploaded media (${currentMediaType})...`);
    } else {
      payload.sample_id = currentActiveSampleId || "sample_registrant_anandhu.jpg";
      addLogEntry("INFO", `[Pipeline Stream] Initiating verification on benchmark sample (${payload.sample_id})...`);
    }

    socket.send(JSON.stringify(payload));
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handlePipelineEvent(data);
  };

  socket.onerror = () => {
    addLogEntry("WARN", `WebSocket connection interrupted.`);
    resetScanButton();
  };

  socket.onclose = () => {
    resetScanButton();
  };
}

function resetScanButton() {
  isPipelineRunning = false;
  const startBtn = document.getElementById("start-scan-btn");
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> RUN VERIFICATION PIPELINE`;
  }
}

// ==========================================
// 6. PIPELINE EVENT DISPATCHER
// ==========================================
function handlePipelineEvent(ev) {
  const hudLeft = document.getElementById("hud-left");
  const hudRight = document.getElementById("hud-right");
  const progressBar = document.getElementById("pipeline-progress-bar");

  switch (ev.type) {
    case "PIPELINE_START":
      addLogEntry("INFO", ev.message);
      break;

    case "LOG":
      addLogEntry(ev.level || "INFO", ev.message);
      break;

    case "FRAME_PROCESSED":
      renderFrameOnCanvas(ev);
      if (ev.total_frames > 0) {
        const pct = Math.min(100, Math.round(((ev.frame_index + 1) / ev.total_frames) * 100));
        progressBar.style.width = pct + "%";
      }
      hudLeft.textContent = `FRAME: ${String(ev.frame_index).padStart(4, '0')} | TIME: ${ev.time_str || "00:00"}`;
      hudRight.textContent = `FACES: ${ev.faces_in_frame} | FPS: ${ev.fps || 25}`;
      break;

    case "FACE_QUEUED":
      addFaceToQueue(ev);
      addLogEntry("INFO", ev.message);
      break;

    case "FACE_DEDUPLICATED":
      markFaceDeduplicated(ev);
      addLogEntry("DEDUP", ev.message);
      break;

    case "FACE_COMPARING":
      updateFaceStatus(ev.face_id, "COMPARING");
      if (ev.vector_preview) {
        updateVectorProjectionDisplay(ev.vector_preview, 0.0, "COMPARING", null);
      }
      addLogEntry("INFO", ev.message);
      break;

    case "FACE_MATCH_RESULT":
      finalizeFaceResult(ev);
      if (ev.status === "FLAGGED") {
        highestMatchResult = ev;
        addLogEntry("MATCH", `[MATCH POSITIVE] ${ev.face_id} -> ${ev.registrant.name} (${(ev.similarity * 100).toFixed(1)}% match)`);
      } else {
        addLogEntry("CLEARED", `[CLEARED] ${ev.face_id} -> ${(ev.similarity * 100).toFixed(1)}% (Threshold: 50.0%)`);
      }
      break;

    case "VERDICT":
      displayFinalVerdict(ev);
      progressBar.style.width = "100%";
      break;

    case "PIPELINE_COMPLETE":
      addLogEntry("INFO", ev.message);
      resetScanButton();
      break;

    case "ERROR":
      addLogEntry("WARN", `[Error] ${ev.message}`);
      showToast(`Verification Pipeline Error: ${ev.message}`, "danger", 6000);
      const errPlaceholder = document.getElementById("viewport-placeholder");
      if (errPlaceholder) {
        errPlaceholder.style.display = "flex";
        errPlaceholder.innerHTML = `
          <svg class="placeholder-icon" style="color: var(--crimson);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div>
            <strong style="color: var(--crimson);">Media Decoding / Pipeline Failed</strong><br>
            <span style="font-size: 0.8rem; font-family: var(--font-mono); color: var(--text-muted);">${escapeHtml(ev.message)}</span>
          </div>
        `;
      }
      resetScanButton();
      break;
  }
}

// ==========================================
// 7. CANVAS FRAME & OVERLAYS RENDERING
// ==========================================
function renderFrameOnCanvas(frameEv) {
  const canvas = document.getElementById("pipeline-canvas");
  const ctx = canvas.getContext("2d");

  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    if (frameEv.faces_data && frameEv.faces_data.length > 0) {
      frameEv.faces_data.forEach(face => {
        drawFaceOverlay(ctx, face);
      });
    }
  };
  img.src = `data:image/jpeg;base64,${frameEv.frame_b64}`;
}

function drawFaceOverlay(ctx, face) {
  const [x, y, w, h] = face.bbox;
  let strokeColor = "#00B4D8";
  let fillColor = "rgba(0, 180, 216, 0.18)";
  let tag = face.face_id;

  if (face.status === "FLAGGED") {
    strokeColor = "#E63946";
    fillColor = "rgba(230, 57, 70, 0.25)";
    tag += " [MATCH: BLOCKED]";
  } else if (face.status === "CLEARED") {
    strokeColor = "#2A9D8F";
    fillColor = "rgba(42, 157, 143, 0.20)";
    tag += " [CLEARED]";
  } else if (face.status === "DEDUP_DISCARD") {
    strokeColor = "#F4A261";
    fillColor = "rgba(244, 162, 97, 0.20)";
    tag += " [ALREADY IDENTIFIED]";
  }

  // Draw Box
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = fillColor;
  ctx.fillRect(x, y, w, h);

  // Corner HUD brackets
  const cornerLen = Math.min(16, w * 0.25);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(x, y + cornerLen);
  ctx.lineTo(x, y);
  ctx.lineTo(x + cornerLen, y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + w - cornerLen, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + cornerLen);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y + h - cornerLen);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + cornerLen, y + h);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + w - cornerLen, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w, y + h - cornerLen);
  ctx.stroke();

  // Landmarks (5 points)
  if (face.landmarks && face.landmarks.length === 5) {
    ctx.fillStyle = "#00B4D8";
    face.landmarks.forEach(([lx, ly]) => {
      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    // Mesh lines
    ctx.strokeStyle = "rgba(0, 180, 216, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(face.landmarks[0][0], face.landmarks[0][1]);
    ctx.lineTo(face.landmarks[1][0], face.landmarks[1][1]);
    ctx.lineTo(face.landmarks[2][0], face.landmarks[2][1]);
    ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(face.landmarks[2][0], face.landmarks[2][1]);
    ctx.lineTo(face.landmarks[3][0], face.landmarks[3][1]);
    ctx.lineTo(face.landmarks[4][0], face.landmarks[4][1]);
    ctx.closePath();
    ctx.stroke();
  }

  // Tag Badge
  ctx.font = "bold 11px 'JetBrains Mono', monospace";
  const textWidth = ctx.measureText(tag).width;
  ctx.fillStyle = strokeColor;
  ctx.fillRect(x, Math.max(0, y - 20), textWidth + 12, 18);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(tag, x + 6, Math.max(14, y - 6));
}

// ==========================================
// 8. FACE QUEUE & DEDUPLICATION
// ==========================================
function addFaceToQueue(ev) {
  const container = document.getElementById("queue-container");
  const countBadge = document.getElementById("queue-count-badge");

  const emptyHint = document.getElementById("empty-queue-hint");
  if (emptyHint) emptyHint.remove();

  const card = document.createElement("div");
  card.className = "face-card";
  card.id = `card-${ev.face_id}`;

  card.innerHTML = `
    <div class="face-thumb-wrapper">
      <img src="data:image/jpeg;base64,${ev.crop_b64}" alt="${ev.face_id}">
    </div>
    <div class="face-meta">
      <div class="face-header-line">
        <span class="face-id">${ev.face_id}</span>
        <span class="face-status-badge queued" id="status-${ev.face_id}">QUEUED</span>
      </div>
      <div class="face-subtext" id="sub-${ev.face_id}">
        Confidence: ${(ev.confidence * 100).toFixed(1)}% | BBox: [${ev.bbox.join(", ")}]
      </div>
    </div>
  `;

  container.prepend(card);
  activeFacesQueue.push(ev.face_id);
  countBadge.textContent = `${activeFacesQueue.length} ENQUEUED`;
}

function updateFaceStatus(faceId, status) {
  const badge = document.getElementById(`status-${faceId}`);
  if (badge) {
    badge.className = `face-status-badge ${status.toLowerCase()}`;
    badge.textContent = status;
  }
}

function markFaceDeduplicated(ev) {
  const container = document.getElementById("queue-container");

  const emptyHint = document.getElementById("empty-queue-hint");
  if (emptyHint) emptyHint.remove();

  const dedupCard = document.createElement("div");
  dedupCard.className = "face-card dedup-discard";
  dedupCard.id = `card-${ev.face_id}`;
  dedupCard.innerHTML = `
    <div class="face-thumb-wrapper" style="border-color: var(--amber);">
      ${ev.crop_b64 ? `<img src="data:image/jpeg;base64,${ev.crop_b64}" alt="${ev.face_id}">` : `<div style="background: #111; width:100%; height:100%; display:flex; align-items:center; justify-content:center; color: var(--amber); font-weight:bold; font-size:10px;">DEDUP</div>`}
    </div>
    <div class="face-meta">
      <div class="face-header-line">
        <span class="face-id">${ev.face_id}</span>
        <span class="face-status-badge dedup" id="status-${ev.face_id}">ALREADY IDENTIFIED</span>
      </div>
      <div class="face-subtext" id="sub-${ev.face_id}" style="color: var(--amber);">
        Matches ${ev.matched_session_id} in current session -> Skipped FAISS index query
      </div>
    </div>
  `;

  container.prepend(dedupCard);
  setTimeout(() => {
    if (!dedupCard.classList.contains("flagged") && dedupCard.classList.contains("dedup-discard")) {
      dedupCard.style.opacity = "0.35";
    }
  }, 1800);
}

function finalizeFaceResult(ev) {
  updateFaceStatus(ev.face_id, ev.status);
  const card = document.getElementById(`card-${ev.face_id}`);
  const subtext = document.getElementById(`sub-${ev.face_id}`);
  const simPct = (ev.similarity * 100).toFixed(1);

  if (ev.status === "FLAGGED") {
    if (card) {
      card.classList.remove("dedup-discard");
      card.classList.add("flagged");
      card.style.opacity = "1";
      card.style.borderColor = "var(--crimson)";
    }
    if (subtext) {
      subtext.style.color = "";
      subtext.innerHTML = `<span style="color: var(--crimson); font-weight:700;">MATCH FOUND:</span> ${ev.registrant.name} (${simPct}%)`;
    }
    // Update vector display immediately for positive match
    updateVectorProjectionDisplay(ev.vector_preview, ev.similarity, ev.status, ev.registrant);
  } else {
    if (subtext) {
      subtext.innerHTML = `<span style="color: var(--emerald);">CLEARED:</span> No registered identity match (${simPct}%)`;
    }
    // Only update vector display if no prior positive match was flagged
    if (!highestMatchResult) {
      updateVectorProjectionDisplay(ev.vector_preview, ev.similarity, ev.status, null);
    }
  }
}

// ==========================================
// 9. FINAL VERDICT BANNER
// ==========================================
function displayFinalVerdict(verdictEv) {
  const banner = document.getElementById("verdict-banner");
  const mainTag = document.getElementById("verdict-main-tag");
  const descText = document.getElementById("verdict-desc-text");
  const policyVal = document.getElementById("verdict-policy-val");
  const matchesVal = document.getElementById("verdict-matches-val");
  const uniqueVal = document.getElementById("verdict-unique-val");
  const detectionsVal = document.getElementById("verdict-detections-val");
  const ledgerWrapper = document.getElementById("ledger-table-wrapper");
  const ledgerTbody = document.getElementById("ledger-table-body");

  banner.className = `verdict-banner-container active ${verdictEv.verdict.toLowerCase()}`;

  if (verdictEv.verdict === "BLOCK") {
    mainTag.textContent = "[UPLOAD BLOCKED: BIOMETRIC CONSENT NOT OBTAINED]";
    const names = [...new Set((verdictEv.ledger || []).map(l => l.name).filter(Boolean))].join(", ") || "Protected Individual";
    descText.textContent = `We have not obtained consent from the person(s) present (${names}). Even if this person follows you, they have not given consent to upload pictures or videos containing their likeness. Either obtain explicit verified consent from ${names} or censor/blur their face.`;
  } else {
    mainTag.textContent = "[VERDICT: UPLOAD PASSED — NO PROTECTED IDENTITIES DETECTED]";
    descText.textContent = verdictEv.description;
  }
  policyVal.textContent = verdictEv.verdict;
  matchesVal.textContent = verdictEv.flagged_count;
  uniqueVal.textContent = verdictEv.unique_identities_count;
  detectionsVal.textContent = verdictEv.total_detections;

  if (verdictEv.ledger && verdictEv.ledger.length > 0) {
    ledgerWrapper.style.display = "block";
    ledgerTbody.innerHTML = "";

    // Group hits by individual identity name to prevent hogging the list
    const grouped = {};
    verdictEv.ledger.forEach(entry => {
      const key = entry.name || "Unknown";
      if (!grouped[key]) {
        grouped[key] = {
          name: entry.name,
          affiliation: entry.affiliation || "Protected Individual",
          consent_id: entry.consent_id || "DPDP-CONSENT",
          registrant_id: entry.registrant_id,
          max_similarity: entry.similarity,
          hits: []
        };
      }
      if (entry.similarity > grouped[key].max_similarity) {
        grouped[key].max_similarity = entry.similarity;
      }
      grouped[key].hits.push(entry);
    });

    let groupIdx = 0;
    Object.values(grouped).forEach(group => {
      groupIdx++;
      const hitsId = `group-hits-${groupIdx}`;
      const hitCount = group.hits.length;

      // Group Summary Row
      const tr = document.createElement("tr");
      tr.className = "grouped-identity-row";
      tr.title = "Click to expand/collapse all individual frame detections";
      tr.innerHTML = `
        <td>
          <button class="hits-dropdown-toggle-btn" id="btn-${hitsId}">
            <span class="dropdown-chevron">▾</span>
            <span><strong>${hitCount}</strong> ${hitCount === 1 ? 'Hit' : 'Hits'}</span>
          </button>
        </td>
        <td>
          <strong style="color: var(--crimson); font-size: 0.88rem;">${escapeHtml(group.name)}</strong>
          <span class="badge-tag" style="margin-left: 6px; font-size: 0.65rem;">${hitCount} FRAMES MATCHED</span>
        </td>
        <td>${escapeHtml(group.affiliation)}</td>
        <td><code>${escapeHtml(group.consent_id)}</code></td>
        <td>
          <strong style="color: var(--crimson);">${(group.max_similarity * 100).toFixed(1)}% Peak</strong>
        </td>
        <td>
          <span style="font-size: 0.72rem; color: var(--text-secondary);">
            Frames: ${group.hits.map(h => h.frame_index).slice(0, 6).join(", ")}${group.hits.length > 6 ? '...' : ''}
          </span>
        </td>
      `;

      // Collapsible Detail Row for individual frames
      const detailTr = document.createElement("tr");
      detailTr.className = "grouped-hits-detail-row";
      detailTr.id = hitsId;
      detailTr.style.display = "none";

      const innerRows = group.hits.map(h => `
        <tr>
          <td><code style="color: var(--cyan);">${escapeHtml(h.face_id)}</code></td>
          <td>Frame ${h.frame_index}</td>
          <td>${escapeHtml(h.timestamp)}</td>
          <td><strong style="color: var(--crimson);">${(h.similarity * 100).toFixed(1)}%</strong></td>
          <td><span class="face-status-badge flagged" style="font-size: 0.65rem;">FLAGGED</span></td>
        </tr>
      `).join("");

      detailTr.innerHTML = `
        <td colspan="6" style="padding: 0; background: rgba(15, 23, 42, 0.45);">
          <div class="grouped-hits-nested-box">
            <div class="nested-box-header">
              <span>All ${hitCount} Individual Frame Detections for <strong>${escapeHtml(group.name)}</strong></span>
              <span class="badge-tag" style="font-size: 0.65rem;">MAX SIMILARITY: ${(group.max_similarity * 100).toFixed(1)}%</span>
            </div>
            <table class="nested-hits-table">
              <thead>
                <tr>
                  <th>FACE ID</th>
                  <th>FRAME INDEX</th>
                  <th>TIMESTAMP</th>
                  <th>SIMILARITY</th>
                  <th>DECISION</th>
                </tr>
              </thead>
              <tbody>
                ${innerRows}
              </tbody>
            </table>
          </div>
        </td>
      `;

      // Click row or button to toggle dropdown
      const toggleHits = () => {
        const isHidden = detailTr.style.display === "none";
        detailTr.style.display = isHidden ? "table-row" : "none";
        const btn = tr.querySelector(".hits-dropdown-toggle-btn");
        if (btn) {
          btn.classList.toggle("open", isHidden);
          const chev = btn.querySelector(".dropdown-chevron");
          if (chev) chev.textContent = isHidden ? "▴" : "▾";
        }
      };

      tr.addEventListener("click", toggleHits);

      ledgerTbody.appendChild(tr);
      ledgerTbody.appendChild(detailTr);
    });
  } else {
    ledgerWrapper.style.display = currentMode === "ledger" ? "block" : "none";
    ledgerTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No protected individual likenesses logged during this scan.</td></tr>`;
  }

  banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ==========================================
// 10. TECHNICAL MONOSPACE LOG STREAM
// ==========================================
function addLogEntry(level, message) {
  const stream = document.getElementById("terminal-stream");
  if (!stream) return;

  const now = new Date();
  const timeStr = `[${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}]`;

  const entry = document.createElement("div");
  entry.className = `log-entry ${level.toLowerCase()}`;
  entry.setAttribute("data-level", level.toLowerCase());
  entry.innerHTML = `<span class="time">${timeStr}</span> <span class="msg">${escapeHtml(message)}</span>`;

  stream.appendChild(entry);
  stream.scrollTop = stream.scrollHeight;
}

function filterLogs(filter) {
  const entries = document.querySelectorAll(".log-entry");
  entries.forEach(entry => {
    const level = entry.getAttribute("data-level");
    if (filter === "all") {
      entry.style.display = "block";
    } else if (filter === "matches" && level === "match") {
      entry.style.display = "block";
    } else if (filter === "dedup" && level === "dedup") {
      entry.style.display = "block";
    } else {
      entry.style.display = "none";
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ==========================================
// 11. REGISTRATION MODULE (STRICT FACE VALIDATION & MULTI-ANGLE UX)
// ==========================================
let liveFaceCheckTimer = null;

function showFaceBanner(htmlText, colorKey = "text") {
  const regTab = document.getElementById("tab-registration");
  if (!regTab || !regTab.classList.contains("active")) return;

  const banner = document.getElementById("face-detection-banner");
  const textEl = document.getElementById("face-detection-status-text");
  if (!banner || !textEl) return;

  textEl.innerHTML = htmlText;
  banner.style.display = "block";

  if (colorKey === "crimson") {
    banner.style.borderColor = "var(--crimson)";
    banner.style.color = "var(--crimson)";
    banner.style.boxShadow = "0 0 12px var(--crimson-glow)";
  } else if (colorKey === "emerald") {
    banner.style.borderColor = "var(--emerald)";
    banner.style.color = "var(--emerald)";
    banner.style.boxShadow = "0 0 12px var(--emerald-glow)";
  } else if (colorKey === "amber") {
    banner.style.borderColor = "var(--amber)";
    banner.style.color = "var(--amber)";
    banner.style.boxShadow = "0 0 12px var(--amber-glow)";
  } else {
    banner.style.borderColor = "var(--border-bright)";
    banner.style.color = "var(--text-main)";
    banner.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
  }
}

function updateRegistrationDiagnostics(data) {
  const chipFace = document.getElementById("chip-face-detect");
  const chipCenter = document.getElementById("chip-centering");
  const chipPose = document.getElementById("chip-pose");
  const chipLiveness = document.getElementById("chip-liveness");
  const chipFaceVal = document.getElementById("chip-face-val");
  const chipCenterVal = document.getElementById("chip-center-val");
  const chipPoseVal = document.getElementById("chip-pose-val");
  const chipLivenessVal = document.getElementById("chip-liveness-val");
  const gateBadge = document.getElementById("reg-gate-status-badge");
  const guidanceBox = document.getElementById("diag-guidance-box");
  const primaryMsg = document.getElementById("diag-primary-msg");
  const detailMsg = document.getElementById("diag-detail-msg");

  if (!chipFace) return;

  if (!data) {
    chipFace.className = "diag-chip";
    chipFaceVal.textContent = "Standby";
    chipCenter.className = "diag-chip";
    chipCenterVal.textContent = "Standby";
    chipPose.className = "diag-chip";
    chipPoseVal.textContent = "Standby";
    chipLiveness.className = "diag-chip";
    chipLivenessVal.textContent = "Ready";
    if (gateBadge) {
      gateBadge.textContent = "GATE: STANDBY";
      gateBadge.className = "badge-tag";
      gateBadge.style.color = "var(--text-muted)";
      gateBadge.style.borderColor = "var(--border-subtle)";
    }
    if (guidanceBox) guidanceBox.className = "diag-guidance-box";
    if (primaryMsg) primaryMsg.textContent = "Waiting for camera activation or photo upload.";
    if (detailMsg) detailMsg.textContent = "Step advancement is locked until biometric conditions are satisfied. Non-supported or corrupt files are rejected.";
    return;
  }

  // 1. Face Presence
  if (!data.face_detected || data.face_count === 0) {
    chipFace.className = "diag-chip status-error";
    chipFaceVal.textContent = "Not Detected";
  } else if (data.face_count > 1) {
    chipFace.className = "diag-chip status-error";
    chipFaceVal.textContent = `${data.face_count} Faces (1 Max)`;
  } else {
    chipFace.className = "diag-chip status-ok";
    chipFaceVal.textContent = `Detected (${data.confidence || 95}%)`;
  }

  // 2. Guide Alignment / Centering
  if (!data.face_detected) {
    chipCenter.className = "diag-chip";
    chipCenterVal.textContent = "No Face";
  } else if (data.is_centered) {
    chipCenter.className = "diag-chip status-ok";
    chipCenterVal.textContent = "Centered in Oval";
  } else {
    chipCenter.className = "diag-chip status-warn";
    if (data.reason_code === "TOO_FAR") chipCenterVal.textContent = "Move Closer";
    else if (data.reason_code === "TOO_CLOSE") chipCenterVal.textContent = "Step Back";
    else if (data.reason_code === "OFF_CENTER_X") chipCenterVal.textContent = "Center Horizontally";
    else if (data.reason_code === "OFF_CENTER_Y") chipCenterVal.textContent = "Center Vertically";
    else chipCenterVal.textContent = "Center in Oval";
  }

  // 3. Pose / Expression for current step
  const stepTitles = ["", "Frontal Neutral", "Turn Left (~15–20°)", "Turn Right (~15–20°)", "Smiling Expression"];
  const currStepTitle = stepTitles[regStep] || `Step ${regStep}`;
  if (!data.face_detected) {
    chipPose.className = "diag-chip";
    chipPoseVal.textContent = currStepTitle;
  } else if (data.orientation_satisfied) {
    chipPose.className = "diag-chip status-ok";
    if (regStep === 4) chipPoseVal.textContent = `Smile OK (${data.smile_percent || 85}%)`;
    else chipPoseVal.textContent = `${(data.orientation || 'ALIGNED').toUpperCase()} OK`;
  } else {
    chipPose.className = "diag-chip status-warn";
    if (data.reason_code === "SMILE_DEFICIT") chipPoseVal.textContent = `Smile Needed (${data.smile_percent || 0}%)`;
    else if (data.reason_code === "EXPRESSION_MISMATCH") chipPoseVal.textContent = "Relax Face";
    else if (data.reason_code === "WRONG_ORIENTATION_LEFT") chipPoseVal.textContent = "Tilt Left Needed";
    else if (data.reason_code === "WRONG_ORIENTATION_RIGHT") chipPoseVal.textContent = "Tilt Right Needed";
    else if (data.reason_code === "WRONG_ORIENTATION_FRONTAL") chipPoseVal.textContent = "Look Straight";
    else chipPoseVal.textContent = "Pose Needed";
  }

  // 4. Liveness & Format
  if (data.anti_replay_flag || data.reason_code === "ANTI_REPLAY_FLAG") {
    chipLiveness.className = "diag-chip status-error";
    chipLivenessVal.textContent = "Replay Flagged";
  } else if (data.reason_code === "CORRUPT_FRAME") {
    chipLiveness.className = "diag-chip status-error";
    chipLivenessVal.textContent = "Corrupt Frame";
  } else if (data.reason_code === "UNSUPPORTED_FORMAT") {
    chipLiveness.className = "diag-chip status-error";
    chipLivenessVal.textContent = "Bad Format";
  } else {
    chipLiveness.className = "diag-chip status-ok";
    chipLivenessVal.textContent = "Stream/File OK";
  }

  // Overall Gate Status & Guidance
  if (data.position_correct && !data.anti_replay_flag) {
    if (gateBadge) {
      gateBadge.textContent = "GATE: READY TO ADVANCE";
      gateBadge.className = "badge-tag";
      gateBadge.style.color = "var(--emerald)";
      gateBadge.style.borderColor = "var(--emerald)";
    }
    if (guidanceBox) guidanceBox.className = "diag-guidance-box status-ok";
    if (primaryMsg) primaryMsg.textContent = `✓ Biometric geometry verified for Step ${regStep} of 4.`;
    if (detailMsg) detailMsg.textContent = "Hold still for auto-snap or click 'CAPTURE STEP' to advance to next biometric angle.";
  } else {
    const isError = !data.face_detected || data.face_count > 1 || data.anti_replay_flag || data.reason_code === "CORRUPT_FRAME" || data.reason_code === "UNSUPPORTED_FORMAT" || data.reason_code === "VERIFICATION_ERROR";
    if (gateBadge) {
      gateBadge.textContent = isError ? "GATE: ADVANCEMENT BLOCKED" : "GATE: AWAITING ALIGNMENT";
      gateBadge.className = "badge-tag";
      gateBadge.style.color = isError ? "var(--crimson)" : "var(--amber)";
      gateBadge.style.borderColor = isError ? "var(--crimson)" : "var(--amber)";
    }
    if (guidanceBox) guidanceBox.className = isError ? "diag-guidance-box status-error" : "diag-guidance-box status-warn";
    if (primaryMsg) primaryMsg.textContent = isError ? `❌ Capture Blocked: ${data.guidance || 'Verification failed.'}` : `⚠️ Alignment Needed: ${data.guidance || 'Adjust position.'}`;
    if (detailMsg) {
      if (!data.face_detected) {
        detailMsg.textContent = "Automatic verification cannot find a face in the oval guide. Make sure face is well-lit and directly facing camera.";
      } else if (data.face_count > 1) {
        detailMsg.textContent = `Multiple individuals (${data.face_count}) in frame. Face registry strictly requires 1 subject to advance steps.`;
      } else if (data.anti_replay_flag) {
        detailMsg.textContent = "Liveness guard detected a static image replay or zero frame entropy. Live micro-movements required.";
      } else if (data.reason_code === "CORRUPT_FRAME") {
        detailMsg.textContent = "Image frame is damaged or corrupt. Check webcam drivers or upload a clean, uncompressed image file.";
      } else if (data.reason_code === "SMILE_DEFICIT") {
        detailMsg.textContent = `Step 4 requires a smile to register expression elasticity. Current smile score is ${data.smile_percent || 0}%. Smile visibly to unlock gate.`;
      } else if (!data.is_centered) {
        detailMsg.textContent = `Position face inside oval guide. Centering and adequate size (${((data.face_ratio || 0.2) * 100).toFixed(0)}%) required.`;
      } else {
        detailMsg.textContent = `Follow the pose for Step ${regStep} (${stepTitles[regStep]}). Registration cannot advance until requirements are satisfied.`;
      }
    }
  }
}

function captureOvalMaskedCanvas(videoElem, targetW, targetH) {
  const canvas = document.createElement("canvas");
  const vw = videoElem.videoWidth || 640;
  const vh = videoElem.videoHeight || 480;
  const w = targetW || vw;
  const h = targetH || vh;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  // Neutral Deep Navy fill for background outside the oval zone
  ctx.fillStyle = "#0B1D36";
  ctx.fillRect(0, 0, w, h);

  // Exact oval face zone matching the on-screen guide oval
  const cx = w * 0.5;
  const cy = h * 0.5;
  const rx = w * 0.27; // ~27% width matches the 55% guide oval with safety boundary
  const ry = h * 0.35; // ~35% height matches the 70% guide oval with safety boundary

  // Clip strictly to the oval face zone
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();

  // Draw webcam frame inside oval zone only
  ctx.drawImage(videoElem, 0, 0, w, h);
  ctx.restore();

  return canvas;
}

let duplicateDetected = false;
let duplicateAcknowledged = false;
let lastDuplicateData = null;

function showDuplicateModal(data) {
  const modal = document.getElementById("duplicate-modal");
  if (!modal) return;

  lastDuplicateData = data;
  duplicateDetected = true;
  const reg = data.registrant || {};

  const newImgEl = document.getElementById("dup-new-photo");
  const regImgEl = document.getElementById("dup-existing-photo");
  const regPlaceholder = document.getElementById("dup-existing-placeholder");
  const matchBadge = document.getElementById("dup-match-badge");
  const scoreCallout = document.getElementById("dup-score-callout");
  const regNameEl = document.getElementById("dup-existing-name");
  const regIdEl = document.getElementById("dup-existing-id");
  const regAffilEl = document.getElementById("dup-existing-affil");
  const regStatusEl = document.getElementById("dup-reg-status");

  if (newImgEl && regCaptures.length > 0) {
    newImgEl.src = regCaptures[0];
  }

  if (matchBadge) {
    matchBadge.textContent = `${data.confidence_percent}% SIMILARITY MATCH`;
  }
  if (scoreCallout) {
    scoreCallout.textContent = `${data.similarity} SIM`;
  }

  if (regNameEl) regNameEl.textContent = reg.name || "Known Individual";
  if (regIdEl) regIdEl.textContent = reg.registrant_id || "REG-RECORD";
  if (regAffilEl) regAffilEl.textContent = `Affiliation: ${reg.affiliation || "Protected Individual"}`;
  if (regStatusEl) regStatusEl.textContent = reg.consent_id ? `CONSENT: ${reg.consent_id.slice(0, 16)}...` : "ACTIVE DPDP CONSENT";

  if (reg.photo_b64 && reg.photo_b64.length > 50) {
    if (regImgEl) {
      regImgEl.src = reg.photo_b64.startsWith("data:") ? reg.photo_b64 : `data:image/jpeg;base64,${reg.photo_b64}`;
      regImgEl.style.display = "block";
    }
    if (regPlaceholder) regPlaceholder.style.display = "none";
  } else {
    if (regImgEl) regImgEl.style.display = "none";
    if (regPlaceholder) regPlaceholder.style.display = "flex";
  }

  modal.style.display = "flex";
  const commitBtn = document.getElementById("commit-registration-btn");
  if (commitBtn && !duplicateAcknowledged) {
    commitBtn.disabled = true;
    commitBtn.textContent = "REGISTRATION BLOCKED: DUPLICATE LIKENESS DETECTED";
  }
  showFaceBanner(`❌ DUPLICATE BLOCKED: Likeness already enrolled as ${reg.name} (${data.confidence_percent}% match). Duplicate enrollments prohibited.`, "crimson");
}

function closeDuplicateModal() {
  const modal = document.getElementById("duplicate-modal");
  if (modal) modal.style.display = "none";
}

function resetRegistrationCaptures(showNotification = true) {
  regCaptures = [];
  regStep = 1;
  duplicateDetected = false;
  duplicateAcknowledged = false;
  lastDuplicateData = null;

  // Reset steps list
  for (let s = 1; s <= 4; s++) {
    const item = document.getElementById(`step-item-${s}`);
    if (item) item.className = s === 1 ? "step-item active" : "step-item";
  }

  // Reset progress rings & title
  const pctEl = document.getElementById("reg-progress-percent");
  const subEl = document.getElementById("reg-progress-sub");
  if (pctEl) pctEl.textContent = "0% COMPLETE";
  if (subEl) subEl.textContent = "Step 1 of 4: Frontal Neutral";

  // Reset buttons
  const capBtn = document.getElementById("capture-step-btn");
  const comBtn = document.getElementById("commit-registration-btn");
  if (capBtn) {
    capBtn.disabled = !webcamStream;
    capBtn.textContent = "CAPTURE STEP 1 OF 4";
  }
  if (comBtn) {
    comBtn.disabled = true;
    comBtn.textContent = "COMMIT EMBEDDINGS TO FAISS REGISTRY";
  }

  const oval = document.getElementById("guide-oval");
  if (oval) oval.className = webcamStream ? "guide-oval-svg waiting" : "guide-oval-svg";

  const autoSnapBadge = document.getElementById("auto-snap-badge");
  if (autoSnapBadge) autoSnapBadge.style.display = "none";

  updateRegistrationDiagnostics(null);
  closeDuplicateModal();
  fetchRegistrationChallenge();

  if (webcamStream) {
    // 3.5s preparation period before auto-snap activates
    window.autoSnapCooldownUntil = Date.now() + 3500;
    window.autoSnapStableCount = 0;
    showFaceBanner("Capture reset. Step 1 (Frontal Neutral) starts in 3s...", "emerald");
  } else {
    showFaceBanner("Capture sequence reset. Activate webcam or simulate capture to begin.", "text");
  }

  if (showNotification) {
    showToast("Capture sequence reset. Ready for Step 1.", "info");
    addLogEntry("INFO", "[Registration UX] Biometric capture sequence reset. Started new face capture session.");
  }
}

async function checkDuplicateFaceOnEnrolment(isEarlyPreCheck = false) {
  if (!regCaptures || regCaptures.length === 0) return;

  if (!isEarlyPreCheck) {
    showFaceBanner("🔍 Verifying likeness against active registry...", "amber");
  }
  addLogEntry("INFO", "[Registration UX] Checking captured face against active FAISS vector registry for existing records...");

  try {
    const resp = await wardenFetch("/api/check-duplicate-face", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64: regCaptures[0],
        images_b64: regCaptures,
        threshold: 0.50
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.warn("Duplicate check error:", data);
      return;
    }

    if (data.has_duplicate && data.registrant) {
      addLogEntry("DEDUP", `[Likeness Registry Hit] Registered match found: ${data.registrant.name} (${data.confidence_percent}% similarity)`);
      showDuplicateModal(data);
    } else {
      duplicateDetected = false;
      addLogEntry("CLEARED", `[Likeness Verified] No duplicate found in FAISS registry (highest sim: ${data.similarity}). Face is unique.`);
      if (!isEarlyPreCheck) {
        showFaceBanner("✓ Likeness verified as unique. Enter details & commit to FAISS registry.", "emerald");
        showToast("Likeness verified as unique (0 duplicates in registry).", "success");
      }
    }
  } catch (err) {
    console.warn("Could not check duplicate face:", err);
  }
}

function stopWebcam() {
  if (liveFaceCheckTimer) {
    clearInterval(liveFaceCheckTimer);
    liveFaceCheckTimer = null;
  }
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch (e) {
        console.warn("Error stopping media track:", e);
      }
    });
    webcamStream = null;
  }
  const webcamVideo = document.getElementById("webcam-video");
  if (webcamVideo) {
    webcamVideo.srcObject = null;
  }
  const placeholder = document.getElementById("webcam-placeholder");
  if (placeholder) {
    placeholder.style.display = "flex";
  }
  const activateCamBtn = document.getElementById("activate-webcam-btn");
  if (activateCamBtn) {
    activateCamBtn.style.display = "inline-flex";
  }
  const camStatusBadge = document.getElementById("webcam-status-badge");
  if (camStatusBadge) {
    camStatusBadge.textContent = "CAMERA OFFLINE";
    camStatusBadge.style.color = "var(--text-muted)";
  }
  const autoSnapBadge = document.getElementById("auto-snap-badge");
  if (autoSnapBadge) {
    autoSnapBadge.style.display = "none";
  }
  const banner = document.getElementById("face-detection-banner");
  if (banner) {
    banner.style.display = "none";
  }
  const guideOval = document.getElementById("guide-oval");
  if (guideOval) {
    guideOval.className = "guide-oval-svg";
  }
  addLogEntry("SYSTEM", "[Webcam] Camera hardware stream deactivated.");
}

function initRegistrationUX() {
  const activateCamBtn = document.getElementById("activate-webcam-btn");
  const captureStepBtn = document.getElementById("capture-step-btn");
  const resetCapturesBtn = document.getElementById("reset-captures-btn");
  const simulateBtn = document.getElementById("simulate-reg-btn");
  const commitBtn = document.getElementById("commit-registration-btn");
  const guideOval = document.getElementById("guide-oval");
  const webcamVideo = document.getElementById("webcam-video");
  const placeholder = document.getElementById("webcam-placeholder");
  const camStatusBadge = document.getElementById("webcam-status-badge");

  const autoSnapCheckbox = document.getElementById("auto-snap-checkbox");
  const autoSnapBadge = document.getElementById("auto-snap-badge");
  const autoSnapBadgeText = document.getElementById("auto-snap-badge-text");
  const cameraFlash = document.getElementById("camera-flash");

  // Modal actions
  const dupCloseBtn = document.getElementById("dup-close-btn");
  const dupCaptureAgainBtn = document.getElementById("dup-capture-again-btn");
  const dupKeepProceedBtn = document.getElementById("dup-keep-proceed-btn");

  if (dupCloseBtn) dupCloseBtn.addEventListener("click", closeDuplicateModal);
  if (dupCaptureAgainBtn) {
    dupCaptureAgainBtn.addEventListener("click", () => {
      stopWebcam();
      closeDuplicateModal();
      resetRegistrationCaptures(true);
    });
  }
  if (dupKeepProceedBtn) {
    dupKeepProceedBtn.addEventListener("click", () => {
      closeDuplicateModal();
      duplicateAcknowledged = true;
      const comBtn = document.getElementById("commit-registration-btn");
      if (comBtn) {
        comBtn.disabled = false;
        comBtn.textContent = "OVERRIDE DUPLICATE & COMMIT EMBEDDINGS";
      }
      showFaceBanner("✓ Existing likeness match acknowledged. Ready to commit embeddings.", "emerald");
      showToast("Likeness acknowledged. Override permitted.", "info");
      const nameInput = document.getElementById("reg-name-input");
      if (nameInput && !nameInput.value.trim()) nameInput.focus();
    });
  }

  let autoSnapEnabled = autoSnapCheckbox ? autoSnapCheckbox.checked : true;
  if (autoSnapCheckbox) {
    autoSnapCheckbox.addEventListener("change", (e) => {
      autoSnapEnabled = e.target.checked;
      if (!autoSnapEnabled && autoSnapBadge) {
        autoSnapBadge.style.display = "none";
      }
    });
  }

  window.autoSnapStableCount = 0;
  window.autoSnapCooldownUntil = 0;
  let isExecutingCapture = false;

  // Reset captures button handler
  if (resetCapturesBtn) {
    resetCapturesBtn.addEventListener("click", () => {
      resetRegistrationCaptures(true);
    });
  }

  // Ensure registration inputs start completely clean with no residual text
  const nameInput = document.getElementById("reg-name-input");
  const affilInput = document.getElementById("reg-affil-input");
  const allowlistInput = document.getElementById("reg-allowlist-input");
  if (nameInput) nameInput.value = "";
  if (affilInput) affilInput.value = "";
  if (allowlistInput) allowlistInput.value = "";

  activateCamBtn.addEventListener("click", async () => {
    try {
      await fetchRegistrationChallenge();
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
      });
      webcamVideo.srcObject = webcamStream;
      placeholder.style.display = "none";
      activateCamBtn.style.display = "none";
      captureStepBtn.disabled = false;
      captureStepBtn.textContent = `CAPTURE STEP 1 OF 4`;
      camStatusBadge.textContent = "DETECTING FACE...";
      camStatusBadge.style.color = "var(--amber)";

      guideOval.className = "guide-oval-svg waiting";
      showFaceBanner("Detecting face alignment... Position your face inside the oval.", "amber");
      addLogEntry("INFO", "[Registration UX] Camera active. Challenge token acquired. Guiding user for Step 1: Frontal Neutral capture.");

      // 3.5s preparation period before auto-snap triggers for Step 1
      window.autoSnapCooldownUntil = Date.now() + 3500;
      window.autoSnapStableCount = 0;

      // Start real-time live face alignment monitor (every 400ms)
      if (liveFaceCheckTimer) clearInterval(liveFaceCheckTimer);
      let isCheckingFace = false;

      liveFaceCheckTimer = setInterval(async () => {
        const regTab = document.getElementById("tab-registration");
        if (!regTab || !regTab.classList.contains("active")) return;
        if (!webcamStream || regStep > 4 || isCheckingFace) return;
        if (!webcamVideo.videoWidth || webcamVideo.videoWidth === 0) return;

        isCheckingFace = true;
        try {
          // Use oval-masked canvas to isolate face zone from any background people
          const tempCanvas = captureOvalMaskedCanvas(webcamVideo, 240, 180);
          const b64 = tempCanvas.toDataURL("image/jpeg", 0.65);
          const chkResp = await wardenFetch("/api/verify-face", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image_b64: b64,
              step: regStep,
              challenge_token: currentRegistrationChallenge,
              previous_images_b64: regCaptures
            })
          });
          const chk = await chkResp.json();

          if (!chkResp.ok) {
            updateRegistrationDiagnostics({
              face_detected: false,
              face_count: 0,
              position_correct: false,
              reason_code: "VERIFICATION_ERROR",
              guidance: chk.detail || "Server verification error"
            });
            showFaceBanner(`❌ SERVER ERROR: ${chk.detail || 'Could not verify face.'}`, "crimson");
            return;
          }

          updateRegistrationDiagnostics(chk);

          // Check Anti-Replay / Corrupt Stream flags
          if (chk.anti_replay_flag || chk.reason_code === "ANTI_REPLAY_FLAG") {
            window.autoSnapStableCount = 0;
            if (autoSnapBadge) autoSnapBadge.style.display = "none";
            guideOval.className = "guide-oval-svg error";
            camStatusBadge.textContent = "● LIVENESS FLAG";
            camStatusBadge.style.color = "var(--crimson)";
            showFaceBanner(`❌ LIVENESS FLAG: ${chk.guidance || 'Static photo detected. Live natural movement required.'}`, "crimson");
            return;
          }

          if (chk.reason_code === "CORRUPT_FRAME") {
            window.autoSnapStableCount = 0;
            if (autoSnapBadge) autoSnapBadge.style.display = "none";
            guideOval.className = "guide-oval-svg error";
            camStatusBadge.textContent = "● CORRUPT FRAME";
            camStatusBadge.style.color = "var(--crimson)";
            showFaceBanner("❌ CORRUPT FRAME: Camera frame could not be safely decoded.", "crimson");
            return;
          }

          const now = Date.now();
          const inCooldown = now < window.autoSnapCooldownUntil;

          // PREPARATION WINDOW: Give user 4s between steps to adjust pose!
          if (inCooldown) {
            window.autoSnapStableCount = 0;
            if (autoSnapBadge) autoSnapBadge.style.display = "none";
            guideOval.className = "guide-oval-svg waiting";
            const remainingSec = Math.max(1, Math.ceil((window.autoSnapCooldownUntil - now) / 1000));
            const stepInstructions = [
              "",
              `👉 Step 1 of 4: Look straight at camera (Frontal Neutral). Ready in ${remainingSec}s...`,
              `👉 Step 2 of 4: Turn your head slightly LEFT (~15–20°). Ready in ${remainingSec}s...`,
              `👉 Step 3 of 4: Turn your head slightly RIGHT (~15–20°). Ready in ${remainingSec}s...`,
              `👉 Step 4 of 4: Smile naturally. Ready in ${remainingSec}s...`
            ];
            const msg = regStep <= 4 ? stepInstructions[regStep] : "Preparing...";
            showFaceBanner(msg, "amber");
            camStatusBadge.textContent = `● PREPARING STEP ${regStep} (${remainingSec}s)`;
            camStatusBadge.style.color = "var(--amber)";
            return;
          }

          if (chk.face_detected && chk.face_count === 1) {
            if (chk.position_correct) {
              // TURN OVAL GREEN WHEN IN CORRECT POSITION!
              guideOval.className = "guide-oval-svg ready";
              if (regStep === 4) {
                camStatusBadge.textContent = `● SMILE DETECTED (${chk.smile_percent || 85}%)`;
              } else {
                camStatusBadge.textContent = `● POSITION CORRECT (${chk.confidence}%)`;
              }
              camStatusBadge.style.color = "var(--emerald)";
              captureStepBtn.disabled = false;

              if (autoSnapEnabled && regStep <= 4 && !isExecutingCapture) {
                window.autoSnapStableCount++;
                // Require 4 ticks (~1.6s) for smile step to avoid fatigue, 6 ticks for other steps
                const requiredStable = regStep === 4 ? 4 : 6;
                const remainingSec = Math.max(1, Math.ceil((requiredStable - window.autoSnapStableCount + 1) * 0.4));

                if (window.autoSnapStableCount < requiredStable) {
                  if (autoSnapBadge) {
                    autoSnapBadge.style.display = "flex";
                    if (autoSnapBadgeText) autoSnapBadgeText.textContent = `HOLD STILL (${remainingSec}s)...`;
                  }
                  const bannerTxt = regStep === 4 
                    ? `😁 Beautiful smile detected! Auto-snapping in ${remainingSec}s... Hold still!`
                    : `📸 Face aligned! Auto-snapping in ${remainingSec}s... Hold still!`;
                  showFaceBanner(bannerTxt, "emerald");
                } else {
                  if (autoSnapBadge) {
                    autoSnapBadge.style.display = "flex";
                    if (autoSnapBadgeText) autoSnapBadgeText.textContent = `⚡ SNAPPING NOW...`;
                  }
                  showFaceBanner(`⚡ Snapping Step ${regStep} photo...`, "emerald");
                  window.autoSnapStableCount = 0;
                  await triggerStepCapture(true);
                }
              } else {
                if (autoSnapBadge) autoSnapBadge.style.display = "none";
                showFaceBanner(`✓ Face aligned in correct position. Ready for Step ${regStep}.`, "emerald");
              }
            } else {
              // Face detected but needs centering or orientation -> Amber
              window.autoSnapStableCount = 0;
              if (autoSnapBadge) autoSnapBadge.style.display = "none";
              guideOval.className = "guide-oval-svg waiting";
              camStatusBadge.textContent = `● ${(chk.guidance || 'ADJUST POSITION').toUpperCase()}`;
              camStatusBadge.style.color = "var(--amber)";
              showFaceBanner(`⚠️ ${chk.guidance || 'Adjust position'}.`, "amber");
            }
          } else if (chk.face_count > 1) {
            window.autoSnapStableCount = 0;
            if (autoSnapBadge) autoSnapBadge.style.display = "none";
            guideOval.className = "guide-oval-svg error";
            camStatusBadge.textContent = `● MULTIPLE FACES (${chk.face_count})`;
            camStatusBadge.style.color = "var(--crimson)";
            showFaceBanner(`⚠️ ${chk.face_count} faces in view. Only 1 person permitted.`, "crimson");
          } else {
            // No face detected -> Neutral dashed outline
            window.autoSnapStableCount = 0;
            if (autoSnapBadge) autoSnapBadge.style.display = "none";
            guideOval.className = "guide-oval-svg";
            camStatusBadge.textContent = "● NO FACE DETECTED";
            camStatusBadge.style.color = "var(--text-muted)";
            showFaceBanner("Position your face inside the guide oval to begin.", "text");
          }
        } catch (e) {
          // Silent fallback for live monitor
        } finally {
          isCheckingFace = false;
        }
      }, 400);

    } catch (err) {
      alert("Could not access webcam. You can use 'SIMULATE CAPTURE' or 'UPLOAD PHOTO' to complete multi-angle registration.");
      addLogEntry("WARN", `Webcam access unavailable: ${err.message}. Use simulated capture or file upload.`);
    }
  });

  async function triggerStepCapture(isAuto = false) {
    if (isExecutingCapture || regStep > 4) return;
    if (!webcamVideo.videoWidth || webcamVideo.videoWidth === 0) return;
    isExecutingCapture = true;

    // Flash shutter animation
    if (cameraFlash) {
      cameraFlash.classList.add("flashing");
      setTimeout(() => cameraFlash.classList.remove("flashing"), 200);
    }

    // Capture strictly inside the face oval zone to ignore any background persons/distractions
    const canvas = captureOvalMaskedCanvas(webcamVideo, webcamVideo.videoWidth || 640, webcamVideo.videoHeight || 480);
    const b64 = canvas.toDataURL("image/jpeg", 0.92);

    captureStepBtn.disabled = true;
    captureStepBtn.textContent = isAuto ? "⚡ AUTO-SNAPPED! PROCESSING..." : "VERIFYING FACE GEOMETRY...";

    try {
      const vResp = await wardenFetch("/api/verify-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_b64: b64,
          step: regStep,
          challenge_token: currentRegistrationChallenge,
          previous_images_b64: regCaptures
        })
      });
      const vData = await vResp.json();
      updateRegistrationDiagnostics(vData);

      if (!vResp.ok) {
        guideOval.className = "guide-oval-svg error";
        showFaceBanner(`❌ SERVER ERROR: ${vData.detail || 'Verification rejected'}. Step cannot advance.`, "crimson");
        showToast(`Verification error: ${vData.detail || 'Could not verify face'}.`, "danger", 6000);
        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
        return;
      }

      // Check Anti-Replay / Liveness Violation
      if (vData.anti_replay_flag || vData.reason_code === "ANTI_REPLAY_FLAG") {
        guideOval.className = "guide-oval-svg error";
        showFaceBanner(`❌ LIVENESS ALERT: ${vData.message || vData.guidance}`, "crimson");
        showToast("Static image replay or synthetic stream detected! Live movement required.", "danger", 6000);
        addLogEntry("WARN", `[Liveness Violation] ${vData.message || vData.guidance}`);
        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
        return;
      }

      // STRICT VALIDATION: Prevent registration capture if no face is detected
      if (!vData.face_detected || vData.face_count === 0) {
        guideOval.className = "guide-oval-svg error";
        showFaceBanner("❌ CAPTURE REJECTED: No face detected. Please position your face inside the guide.", "crimson");
        showToast("No face detected! Please look at the camera. Step cannot advance.", "danger", 6000);
        addLogEntry("WARN", `[Registration Prevented] Step ${regStep} capture blocked: No face detected in frame.`);

        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
        return;
      }

      if (vData.face_count > 1) {
        guideOval.className = "guide-oval-svg error";
        showFaceBanner(`❌ CAPTURE REJECTED: Multiple faces (${vData.face_count}) detected in frame.`, "crimson");
        showToast(`Multiple faces detected (${vData.face_count}). Only 1 individual allowed. Step cannot advance.`, "danger", 6000);
        addLogEntry("WARN", `[Registration Prevented] Multiple faces (${vData.face_count}) in camera view.`);

        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
        return;
      }

      if (!vData.position_correct) {
        guideOval.className = "guide-oval-svg waiting";
        const guidanceMsg = vData.guidance || `Please align your face according to Step ${regStep} instructions.`;
        showFaceBanner(`⚠️ CAPTURE REJECTED: ${guidanceMsg}`, "amber");
        showToast(guidanceMsg, "danger", 6000);
        addLogEntry("WARN", `[Registration Prevented] Step ${regStep} capture blocked: ${guidanceMsg}`);

        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
        return;
      }

      // Valid face detected: accept capture, turn green, and advance
      guideOval.className = "guide-oval-svg ready";
      const methodStr = isAuto ? "⚡ Auto-snapped" : "✓ Captured";
      showFaceBanner(`${methodStr} step ${regStep}/4 verified (${vData.confidence}% quality).`, "emerald");
      showToast(`Step ${regStep}/4 ${isAuto ? "auto-captured" : "validated"} (${vData.confidence}% quality)`, "success");
      addLogEntry("INFO", `[Registration UX] Step ${regStep}/4 ${isAuto ? "auto-snapped" : "captured"} with valid geometry (${vData.confidence}% quality).`);

      processRegistrationStepCapture(b64);

      if (regStep === 2) {
        // Just completed Step 1 capture -> run early duplicate pre-check in background
        checkDuplicateFaceOnEnrolment(true);
      }

      // Give a generous 4-second adjustment window between steps!
      window.autoSnapCooldownUntil = Date.now() + 4000;
      window.autoSnapStableCount = 0;

      if (regStep <= 4) {
        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
      } else {
        // All 4 captures completed -> Check for duplicate face in registry!
        await checkDuplicateFaceOnEnrolment();
      }

    } catch (err) {
      console.error("Face verification check error:", err);
      showFaceBanner(`❌ VERIFICATION ERROR: ${err.message || 'Face verification failed'}. Step cannot advance.`, "crimson");
      showToast(`Face verification error: ${err.message || 'System failed to understand face'}. Registration step will not advance.`, "danger", 6000);
      addLogEntry("WARN", `[Registration Blocked] Step ${regStep} capture failed: ${err.message}. Advancement strictly prevented.`);
      updateRegistrationDiagnostics({
        face_detected: false,
        face_count: 0,
        position_correct: false,
        is_centered: false,
        orientation_satisfied: false,
        reason_code: "VERIFICATION_ERROR",
        guidance: `Verification failed: ${err.message || 'Frame processing error'}`
      });
      window.autoSnapCooldownUntil = Date.now() + 3000;
      window.autoSnapStableCount = 0;
    } finally {
      isExecutingCapture = false;
      if (regStep <= 4) {
        captureStepBtn.disabled = false;
        captureStepBtn.textContent = `CAPTURE STEP ${regStep} OF 4`;
      }
    }
  }

  captureStepBtn.addEventListener("click", () => triggerStepCapture(false));

  simulateBtn.addEventListener("click", async () => {
    addLogEntry("INFO", "[Simulation] Loading high-resolution face for sequential enrolment simulation...");
    try {
      await fetchRegistrationChallenge();
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = async () => {
        regCaptures = [];
        const variations = [
          { dx: 0, dy: 0, rot: 0, scale: 1.0 },
          { dx: -12, dy: 2, rot: -0.03, scale: 0.98 },
          { dx: 12, dy: -2, rot: 0.03, scale: 0.99 },
          { dx: 0, dy: -3, rot: 0.01, scale: 1.02 }
        ];

        for (let i = 0; i < 4; i++) {
          const varCanvas = document.createElement("canvas");
          varCanvas.width = img.width;
          varCanvas.height = img.height;
          const vctx = varCanvas.getContext("2d");
          vctx.fillStyle = "#0B1D36";
          vctx.fillRect(0, 0, varCanvas.width, varCanvas.height);
          vctx.save();
          vctx.beginPath();
          vctx.ellipse(varCanvas.width * 0.5, varCanvas.height * 0.5, varCanvas.width * 0.27, varCanvas.height * 0.35, 0, 0, Math.PI * 2);
          vctx.clip();
          const v = variations[i];
          vctx.translate(varCanvas.width / 2 + v.dx, varCanvas.height / 2 + v.dy);
          vctx.rotate(v.rot);
          vctx.scale(v.scale, v.scale);
          vctx.drawImage(img, -varCanvas.width / 2, -varCanvas.height / 2);
          vctx.restore();
          regCaptures.push(varCanvas.toDataURL("image/jpeg", 0.92));
        }

        for (let s = 1; s <= 4; s++) {
          const item = document.getElementById(`step-item-${s}`);
          if (item) item.className = "step-item completed";
        }
        document.getElementById("reg-progress-percent").textContent = "100% COMPLETE";
        document.getElementById("reg-progress-sub").textContent = "All 4 Biometric Angles Captured & Validated";
        guideOval.className = "guide-oval-svg ready";

        commitBtn.disabled = false;
        commitBtn.scrollIntoView({ behavior: "smooth" });

        // If name input is blank, provide prompt focus
        const nameField = document.getElementById("reg-name-input");
        if (nameField && !nameField.value.trim()) {
          nameField.focus();
        }

        addLogEntry("INFO", "[Simulation] 4-angle sequential capture complete. Verifying duplicate status...");
        await checkDuplicateFaceOnEnrolment();
      };
      img.src = getBackendUrl("/backend/samples/sample_registrant_anandhu.jpg");
    } catch (e) {
      addLogEntry("WARN", `Simulation error: ${e.message}`);
    }
  });

  commitBtn.addEventListener("click", async () => {
    const name = document.getElementById("reg-name-input").value.trim();
    const affil = document.getElementById("reg-affil-input").value.trim();
    const allowlistStr = document.getElementById("reg-allowlist-input").value.trim();
    const consentChecked = document.getElementById("reg-consent-checkbox").checked;

    // Strict validation checks
    if (!name) {
      alert("Please enter the full legal or stage name before registering.");
      const nameInput = document.getElementById("reg-name-input");
      if (nameInput) nameInput.focus();
      return;
    }

    if (!regCaptures || regCaptures.length === 0) {
      alert("Registration prevented: No facial capture data recorded. Please complete the guided webcam capture steps.");
      showToast("Cannot register: No face captures recorded.", "danger");
      return;
    }

    if (duplicateDetected && !duplicateAcknowledged) {
      showDuplicateModal(lastDuplicateData);
      alert("A matching face was detected in the registry. Please review and choose whether to 'Keep & Proceed' or 'Capture Again' in the dialog.");
      return;
    }

    if (!consentChecked) {
      alert("You must grant biometric consent under GDPR Article 9 / DPDP Act to enroll your likeness.");
      return;
    }

    const allowlist = allowlistStr ? allowlistStr.split(",").map(s => s.trim()).filter(Boolean) : [];

    commitBtn.disabled = true;
    commitBtn.textContent = "INDEXING EMBEDDINGS INTO FAISS...";

    try {
      const resp = await wardenFetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          affiliation: affil || "Protected Individual",
          images_b64: regCaptures,
          photo_b64: regCaptures[0] || "",
          allowlist: allowlist,
          notes: "Enrolled via Warden Guided UX",
          allow_override: (duplicateAcknowledged && duplicateDetected),
          challenge_token: currentRegistrationChallenge
        })
      });

      const resData = await resp.json();
      if (!resp.ok) {
        if (resp.status === 409) {
          showFaceBanner(`❌ ${resData.detail}`, "crimson");
          showToast("Registration blocked: Duplicate face exists in registry.", "danger");
        }
        throw new Error(resData.detail || "Registration failed");
      }

      showToast(`Likeness enrolled: ${name} (${resData.registrant.registrant_id})`, "success");
      addLogEntry("MATCH", `[Enrolment Successful] ${name} committed to FAISS index. Consent ID: ${resData.registrant.consent_id}`);

      // Clear input fields and reset state for subsequent registrations
      document.getElementById("reg-name-input").value = "";
      document.getElementById("reg-affil-input").value = "";
      document.getElementById("reg-allowlist-input").value = "";
      stopWebcam();
      resetRegistrationCaptures(false);

      await fetchRegistryStats(false);
      document.getElementById("nav-registry-btn").click();

      alert(`Likeness Registered Successfully!\n\nRegistrant ID: ${resData.registrant.registrant_id}\nConsent Certificate: ${resData.registrant.consent_id}\nVectors Indexed: ${resData.captures_processed}\n\nYour facial geometry is now protected across all integrating platforms.`);

    } catch (err) {
      alert(`Registration error: ${err.message}`);
      commitBtn.disabled = false;
      commitBtn.textContent = "COMMIT EMBEDDINGS TO FAISS REGISTRY";
    }
  });
}

function processRegistrationStepCapture(b64) {
  regCaptures.push(b64);
  const currentItem = document.getElementById(`step-item-${regStep}`);
  if (currentItem) {
    currentItem.className = "step-item completed";
  }

  regStep++;
  const progressPct = Math.round(((regStep - 1) / 4) * 100);
  document.getElementById("reg-progress-percent").textContent = `${progressPct}% COMPLETE`;

  if (regStep <= 4) {
    const nextItem = document.getElementById(`step-item-${regStep}`);
    if (nextItem) nextItem.className = "step-item active";

    const titles = [
      "",
      "Step 1 of 4: Frontal Neutral",
      "Step 2 of 4: Slight Left Turn (~15–20°)",
      "Step 3 of 4: Slight Right Turn (~15–20°)",
      "Step 4 of 4: Smiling Expression"
    ];
    document.getElementById("reg-progress-sub").textContent = titles[regStep];
    addLogEntry("INFO", `[Registration UX] Capture ${regStep - 1}/4 verified. Proceeding to: ${titles[regStep]}`);
  } else {
    document.getElementById("reg-progress-percent").textContent = `100% COMPLETE`;
    document.getElementById("reg-progress-sub").textContent = "All 4 Facial Angles Successfully Captured & Quality Checked";
    document.getElementById("capture-step-btn").disabled = true;
    document.getElementById("commit-registration-btn").disabled = false;
    document.getElementById("guide-oval").className = "guide-oval-svg ready";
    showFaceBanner("✓ All 4 biometric angles captured. Enter name & commit to FAISS index.", "emerald");
    addLogEntry("CLEARED", "[Registration UX] All multi-angle captures complete and validated. Ready to commit embeddings.");
  }
}

// ==========================================
// 12. REGISTRY & TRUST DASHBOARD (AUTO-SYNC & MULTI-SELECT REVOCATION)
// ==========================================
let selectedRegIds = new Set();
let registryAutoSyncTimer = null;
let lastKnownRegistryPayload = "";

function showToast(message, type = "info", duration = 3500) {
  if (message.toLowerCase().includes("multiple faces")) {
    const regTab = document.getElementById("tab-registration");
    if (!regTab || !regTab.classList.contains("active")) return;
  }
  const container = document.getElementById("warden-toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `warden-toast toast-${type}`;
  
  let iconSvg = "";
  if (type === "danger") {
    iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--crimson)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  } else if (type === "success") {
    iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--emerald)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  } else {
    iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }

  toast.innerHTML = `
    <span style="display:flex; align-items:center;">${iconSvg}</span>
    <span style="flex:1; line-height: 1.3;">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(20px)";
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

function initDpdpTooltip() {
  const box = document.getElementById("dpdp-badge-box");
  if (!box) return;

  // Toggle on click/tap for touch and keyboard accessibility
  box.addEventListener("click", (e) => {
    if (e.target.closest(".dpdp-popover-card")) return;
    const isExpanded = box.classList.toggle("force-active");
    box.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target)) {
      box.classList.remove("force-active");
      box.setAttribute("aria-expanded", "false");
    }
  });

  // Close on Escape key
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      box.classList.remove("force-active");
      box.setAttribute("aria-expanded", "false");
      box.blur();
    }
  });
}

function initRegistryDashboard() {
  const refreshBtn = document.getElementById("refresh-registry-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fetchRegistryStats(false);
      showToast("Registry synchronized with active FAISS index.", "info", 2000);
    });
  }

  // Select All Header Checkbox
  const selectAllCb = document.getElementById("select-all-regs");
  if (selectAllCb) {
    selectAllCb.addEventListener("change", (e) => {
      const isChecked = e.target.checked;
      const rowCheckboxes = document.querySelectorAll(".reg-select-cb");
      
      rowCheckboxes.forEach(cb => {
        cb.checked = isChecked;
        const id = cb.getAttribute("data-id");
        if (isChecked) {
          selectedRegIds.add(id);
          const tr = document.getElementById(`reg-row-${id}`);
          if (tr) tr.classList.add("row-selected");
        } else {
          selectedRegIds.delete(id);
          const tr = document.getElementById(`reg-row-${id}`);
          if (tr) tr.classList.remove("row-selected");
        }
      });
      updateBulkToolbar();
    });
  }

  // Bulk Revoke Action Button
  const bulkRevokeBtn = document.getElementById("bulk-revoke-btn");
  if (bulkRevokeBtn) {
    bulkRevokeBtn.addEventListener("click", () => executeBulkRevoke());
  }

  // Bulk Cancel / Deselect All Button
  const bulkCancelBtn = document.getElementById("bulk-cancel-btn");
  if (bulkCancelBtn) {
    bulkCancelBtn.addEventListener("click", () => clearSelection());
  }

  // Auto-sync polling every 3.5 seconds
  startRegistryAutoSync();

  // Instant refresh when user returns to window or switches tabs
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      fetchRegistryStats(true);
    }
  });

  window.addEventListener("focus", () => {
    fetchRegistryStats(true);
  });
}

function startRegistryAutoSync() {
  if (registryAutoSyncTimer) clearInterval(registryAutoSyncTimer);
  registryAutoSyncTimer = setInterval(() => {
    if (!document.hidden) {
      fetchRegistryStats(true);
    }
  }, 3500);
}

function updateBulkToolbar() {
  const count = selectedRegIds.size;
  const toolbar = document.getElementById("bulk-actions-toolbar");
  const countText = document.getElementById("bulk-selection-count");
  const countBadge = document.getElementById("bulk-count-badge");
  const selectAllCb = document.getElementById("select-all-regs");

  if (countText) countText.textContent = `${count} record${count === 1 ? "" : "s"} selected`;
  if (countBadge) countBadge.textContent = count;

  if (toolbar) {
    toolbar.style.display = count > 0 ? "inline-flex" : "none";
  }

  const allRowCbs = document.querySelectorAll(".reg-select-cb");
  if (selectAllCb) {
    if (allRowCbs.length > 0 && count === allRowCbs.length) {
      selectAllCb.checked = true;
      selectAllCb.indeterminate = false;
    } else if (count > 0) {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = true;
    } else {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = false;
    }
  }
}

function clearSelection() {
  selectedRegIds.clear();
  const selectAllCb = document.getElementById("select-all-regs");
  if (selectAllCb) {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
  }
  document.querySelectorAll(".reg-select-cb").forEach(cb => {
    cb.checked = false;
  });
  document.querySelectorAll(".ledger-audit-table tbody tr").forEach(tr => {
    tr.classList.remove("row-selected");
  });
  updateBulkToolbar();
}

async function fetchRegistryStats(isSilent = false) {
  try {
    // Add timestamp to prevent browser HTTP caching
    const resp = await wardenFetch(`/api/registry?_t=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    
    if (!resp.ok) {
      console.warn("Registry fetch failed with status:", resp.status);
      return;
    }

    const data = await resp.json();
    const stats = data.stats || {};
    const registrants = data.registrants || [];

    // Update stats counters
    const totalEl = document.getElementById("stat-total-regs");
    const activeEl = document.getElementById("stat-active-regs");
    const indexedEl = document.getElementById("stat-indexed-vectors");
    const dimEl = document.getElementById("stat-vector-dim");

    if (totalEl) totalEl.textContent = stats.total_registrants ?? 0;
    if (activeEl) activeEl.textContent = stats.active_registrants ?? 0;
    if (indexedEl) indexedEl.textContent = stats.indexed_vectors ?? 0;
    if (dimEl) dimEl.textContent = `${stats.vector_dimension || 128}-D`;

    // Only rebuild DOM if the registrants dataset or selection changed
    const payloadSignature = JSON.stringify(registrants);
    const existingIds = new Set(registrants.map(r => r.registrant_id));

    // Prune any selected IDs that no longer exist
    let selectionChanged = false;
    for (const id of Array.from(selectedRegIds)) {
      if (!existingIds.has(id)) {
        selectedRegIds.delete(id);
        selectionChanged = true;
      }
    }

    if (isSilent && payloadSignature === lastKnownRegistryPayload && !selectionChanged) {
      return; // No UI changes required
    }
    lastKnownRegistryPayload = payloadSignature;

    const tbody = document.getElementById("registrants-table-body");
    if (!tbody) return;

    if (registrants.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-family: var(--font-mono); font-size: 0.85rem;">No active likenesses enrolled. Use the Registration UX to onboard protected profiles.</td></tr>`;
      clearSelection();
      return;
    }

    tbody.innerHTML = "";

    registrants.forEach(reg => {
      const isSelected = selectedRegIds.has(reg.registrant_id);
      const tr = document.createElement("tr");
      tr.id = `reg-row-${reg.registrant_id}`;
      if (isSelected) tr.classList.add("row-selected");

      const enrolledDate = reg.registered_at ? new Date(reg.registered_at).toLocaleDateString() : "Active";
      const expiryDate = reg.expires_at ? new Date(reg.expires_at).toLocaleDateString() : "1 Year";

      tr.innerHTML = `
        <td style="text-align: center;">
          <input type="checkbox" class="reg-select-cb" data-id="${reg.registrant_id}" ${isSelected ? "checked" : ""} style="cursor: pointer; width: 16px; height: 16px;">
        </td>
        <td><strong style="font-family: var(--font-mono); font-size: 0.82rem; color: var(--accent);">${reg.registrant_id}</strong></td>
        <td><strong style="color: var(--text-main);">${reg.name}</strong></td>
        <td><span style="color: var(--text-secondary);">${reg.affiliation || "Protected Individual"}</span></td>
        <td><code style="color: var(--cyan); font-size: 0.75rem;">${reg.consent_id}</code></td>
        <td style="font-family: var(--font-mono); font-size: 0.78rem;">${enrolledDate}</td>
        <td style="font-family: var(--font-mono); font-size: 0.78rem;">${expiryDate}</td>
        <td><span class="badge-tag" style="font-size: 0.7rem;">${reg.num_vectors || 1} Vectors</span></td>
        <td><span style="color: var(--emerald); font-weight: 700; font-family: var(--font-mono); font-size: 0.75rem;">ACTIVE</span></td>
        <td>
          <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.72rem; border-color: var(--crimson); color: var(--crimson); background: transparent; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;" onclick="revokeConsent('${reg.registrant_id}', '${(reg.name || '').replace(/'/g, "\\'")}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            REVOKE
          </button>
        </td>
      `;

      // Row checkbox listener
      const cb = tr.querySelector(".reg-select-cb");
      cb.addEventListener("change", (e) => {
        if (e.target.checked) {
          selectedRegIds.add(reg.registrant_id);
          tr.classList.add("row-selected");
        } else {
          selectedRegIds.delete(reg.registrant_id);
          tr.classList.remove("row-selected");
        }
        updateBulkToolbar();
      });

      tbody.appendChild(tr);
    });

    updateBulkToolbar();

  } catch (err) {
    if (!isSilent) {
      console.error("Failed to load registry stats:", err);
    }
  }
}

window.revokeConsent = async function(regId, name = "") {
  const displayName = name ? `${name} (${regId})` : regId;
  const confirmed = confirm(
    `Revoke biometric consent and permanently remove ${displayName}?\n\n` +
    `Associated facial vector embeddings will be completely purged from the active FAISS index immediately under GDPR Art. 9 & DPDP regulations.`
  );
  if (!confirmed) return;

  // Immediate visual feedback
  const tr = document.getElementById(`reg-row-${regId}`);
  if (tr) {
    tr.style.opacity = "0.3";
    tr.style.pointerEvents = "none";
  }

  try {
    const resp = await wardenFetch(`/api/registry/${regId}`, {
      method: "DELETE",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    const resData = await resp.json();

    if (resp.ok) {
      selectedRegIds.delete(regId);
      addLogEntry("INFO", `[Consent Revoked] ${displayName} purged from FAISS index and database.`);
      showToast(`Likeness revoked: ${displayName} purged from registry`, "danger");
      // Immediate automatic refresh
      await fetchRegistryStats(false);
    } else {
      if (tr) {
        tr.style.opacity = "1";
        tr.style.pointerEvents = "auto";
      }
      alert(`Revocation error: ${resData.detail || "Unable to revoke record"}`);
    }
  } catch (e) {
    alert(`Revocation error: ${e.message}`);
    fetchRegistryStats(false);
  }
};

async function executeBulkRevoke() {
  const ids = Array.from(selectedRegIds);
  if (ids.length === 0) return;

  const confirmed = confirm(
    `Revoke biometric consent and permanently delete all ${ids.length} selected record(s)?\n\n` +
    `Vector embeddings for these individuals will be completely purged from the FAISS vector index immediately.`
  );
  if (!confirmed) return;

  const bulkRevokeBtn = document.getElementById("bulk-revoke-btn");
  if (bulkRevokeBtn) {
    bulkRevokeBtn.disabled = true;
    bulkRevokeBtn.textContent = "PURGING...";
  }

  try {
    const resp = await wardenFetch("/api/registry/batch-delete", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      },
      body: JSON.stringify({ registrant_ids: ids })
    });

    const resData = await resp.json();

    if (resp.ok) {
      const deletedCount = resData.deleted_count ?? ids.length;
      addLogEntry("INFO", `[Bulk Revoke] ${deletedCount} record(s) permanently purged from FAISS index.`);
      showToast(`Successfully revoked and purged ${deletedCount} record(s)`, "danger");
      selectedRegIds.clear();
      updateBulkToolbar();
      await fetchRegistryStats(false);
    } else {
      alert(`Bulk revocation failed: ${resData.detail || "Server error"}`);
    }
  } catch (err) {
    alert(`Bulk revocation error: ${err.message}`);
  } finally {
    if (bulkRevokeBtn) {
      bulkRevokeBtn.disabled = false;
      updateBulkToolbar();
    }
  }
}

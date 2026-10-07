/**
 * WARDEN — Chrome Extension Toolbar Popup Logic
 */

document.addEventListener("DOMContentLoaded", () => {
  const pill = document.getElementById("server-status-pill");
  const label = document.getElementById("server-status-label");
  const regEl = document.getElementById("stat-registrants");
  const vecEl = document.getElementById("stat-vectors");

  const btnDashboard = document.getElementById("btn-open-dashboard");
  const btnWaTestbench = document.getElementById("btn-open-wa-testbench");
  const btnTestbench = document.getElementById("btn-open-testbench");
  const btnIgRegistry = document.getElementById("btn-open-ig-registry");

  // Query background service worker for status
  chrome.runtime.sendMessage({ action: "CHECK_SERVER" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.online) {
      pill.className = "status-pill offline";
      label.textContent = "OFFLINE";
      regEl.textContent = "0";
      vecEl.textContent = "0";
      return;
    }

    pill.className = "status-pill online";
    label.textContent = "FAISS READY";
    const stats = (response.data && response.data.stats) || {};
    regEl.textContent = stats.active_registrants ?? stats.total_registrants ?? "4";
    vecEl.textContent = stats.indexed_vectors ?? "16";
  });

  // Open live dashboard
  btnDashboard.addEventListener("click", () => {
    chrome.tabs.create({ url: "http://127.0.0.1:8000/?source=extension" });
  });

  // Open WhatsApp Web testbench
  if (btnWaTestbench) {
    btnWaTestbench.addEventListener("click", () => {
      chrome.tabs.create({ url: "http://127.0.0.1:8000/test_whatsapp_web_mock.html" });
    });
  }

  // Open Instagram DM testbench
  if (btnTestbench) {
    btnTestbench.addEventListener("click", () => {
      chrome.tabs.create({ url: "http://127.0.0.1:8000/test_instagram_dm_mock.html" });
    });
  }

  // Open Face Registry page
  if (btnIgRegistry) {
    btnIgRegistry.addEventListener("click", () => {
      chrome.tabs.create({ url: "http://127.0.0.1:8000/mock_instagram_registry.html" });
    });
  }
});

/**
 * WARDEN — Chrome Extension Background Service Worker (Manifest V3)
 * Handles local API communication with Warden server (http://127.0.0.1:8000),
 * bypasses mixed-content constraints, and opens live monitoring tabs.
 * Supports both Instagram Direct Messages and WhatsApp Web upload screening.
 */

const WARDEN_BASE_URL = "http://127.0.0.1:8000";
const WARDEN_API_KEY = "warden-dev-key-9941";

// Convert Data URL / Base64 to Blob using native browser fetch (sub-10ms, C++ native, zero-delay)
async function dataUrlToBlob(dataUrl, contentType) {
  try {
    const cleanUrl = dataUrl.startsWith("data:") 
      ? dataUrl 
      : `data:${contentType || "application/octet-stream"};base64,${dataUrl}`;
    const res = await fetch(cleanUrl);
    return await res.blob();
  } catch (e) {
    console.warn("[Warden Background] Native dataUrl fetch failed, falling back:", e);
    return base64ToBlob(dataUrl, contentType);
  }
}

// Convert Base64 string to Blob (pure fallback)
function base64ToBlob(base64Data, contentType) {
  const cleanB64 = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
  const binaryString = atob(cleanB64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType || "image/jpeg" });
}

// Check server health
async function checkServerHealth(timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WARDEN_BASE_URL}/api/health`, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return { online: false, status: res.status };
    const data = await res.json();
    return { online: true, data };
  } catch (err) {
    clearTimeout(timer);
    return { online: false, error: err.name === "AbortError" ? "Timeout" : err.message };
  }
}

let activeDashboardTabId = null;

chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (closedTabId === activeDashboardTabId) {
    activeDashboardTabId = null;
  }
});

function isDashboardUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    const isWardenHost = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && 
                         (u.port === "8000" || u.port === "");
    const isMock = u.pathname.includes("test_") || 
                   u.pathname.includes("mock_") || 
                   u.pathname.endsWith(".html");
    const isDashboardPath = u.pathname === "/" || u.pathname === "" || u.pathname === "/index.html";
    return isWardenHost && isDashboardPath && !isMock;
  } catch (e) {
    return false;
  }
}

async function findDashboardTab() {
  if (activeDashboardTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeDashboardTabId);
      if (tab && tab.url && isDashboardUrl(tab.url)) {
        return tab;
      }
    } catch (e) {
      activeDashboardTabId = null;
    }
  }

  try {
    const tabs = await chrome.tabs.query({});
    const found = tabs.find(t => isDashboardUrl(t.url));
    if (found) {
      activeDashboardTabId = found.id;
      return found;
    }
  } catch (e) {
    console.warn("[Warden Background] tabs.query failed:", e);
  }
  return null;
}

// Open or update existing Warden dashboard tab to prevent duplicate tabs
async function openOrUpdateDashboardTab(targetUrl, mediaMeta) {
  try {
    const existingTab = await findDashboardTab();
    if (existingTab && existingTab.id) {
      activeDashboardTabId = existingTab.id;
      // Focus existing tab without forcing full page reload
      await chrome.tabs.update(existingTab.id, { active: true });
      if (existingTab.windowId) {
        chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
      }

      // 1. Try sending direct message to content script on dashboard tab
      if (mediaMeta) {
        let sentDirect = false;
        try {
          sentDirect = await new Promise((resolve) => {
            chrome.tabs.sendMessage(existingTab.id, { action: "WARDEN_ROUTE_MEDIA", ...mediaMeta }, (res) => {
              if (chrome.runtime.lastError || !res) {
                resolve(false);
              } else {
                resolve(true);
              }
            });
          });
        } catch (msgErr) {
          sentDirect = false;
        }

        if (sentDirect) {
          return existingTab;
        }

        // 2. Try chrome.scripting.executeScript if available
        if (chrome.scripting && chrome.scripting.executeScript) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: existingTab.id },
              func: (meta) => {
                if (typeof window.wardenRouteMedia === "function") {
                  window.wardenRouteMedia(meta);
                } else {
                  window.dispatchEvent(new CustomEvent("warden:route-media", { detail: meta }));
                }
              },
              args: [mediaMeta]
            });
            return existingTab;
          } catch (scriptErr) {
            console.warn("[Warden Background] executeScript fallback to tabs.update:", scriptErr);
          }
        }
      }

      // 3. Fallback: navigate tab only if fast zero-reload messaging failed
      await chrome.tabs.update(existingTab.id, { url: targetUrl, active: true });
      return existingTab;
    } else {
      const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
      activeDashboardTabId = newTab.id;
      return newTab;
    }
  } catch (e) {
    console.warn("[Warden Background] Tab management error:", e);
    const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
    activeDashboardTabId = newTab.id;
    return newTab;
  }
}

// Process media upload and verification
async function processMedia(payload) {
  const {
    fileName,
    fileType,
    stagedFilePath: preStagedPath,
    fileBuffer,
    fileDataB64,
    platform = "instagram",
    mode = "guard",
    threshold = 0.50,
    queueIndex = 0,
    totalInQueue = 1
  } = payload;

  const isVideo = (fileType && fileType.startsWith("video/")) || /\.(mp4|webm|avi|mov|mkv)$/i.test(fileName || "");
  const defaultFileName = platform === "whatsapp" 
    ? (isVideo ? "whatsapp_video.mp4" : "whatsapp_photo.jpg")
    : (isVideo ? "instagram_video.mp4" : "instagram_photo.jpg");
  const actualFileName = fileName || defaultFileName;

  let stagedFilePath = preStagedPath || null;

  // 1. If not already staged directly by content script, stage via background worker
  if (!stagedFilePath) {
    let blob = null;
    if (fileBuffer && typeof fileBuffer === "object" && (fileBuffer.byteLength > 0 || fileBuffer.size > 0)) {
      blob = new Blob([fileBuffer], { type: fileType || (isVideo ? "video/mp4" : "image/jpeg") });
    } else if (fileDataB64) {
      blob = await dataUrlToBlob(fileDataB64, fileType);
    }

    if (!blob) {
      return {
        status: "ERROR",
        verdict: "ERROR",
        message: "No binary media payload provided for scan."
      };
    }

    // Direct Stage Media Upload to Server (Instant loopback transfer)
    try {
      const stageForm = new FormData();
      stageForm.append("file", blob, actualFileName);
      const stageRes = await fetch(`${WARDEN_BASE_URL}/api/upload`, {
        method: "POST",
        headers: { "X-Warden-API-Key": WARDEN_API_KEY },
        body: stageForm
      });

      if (!stageRes.ok) {
        const errData = await stageRes.json().catch(() => ({}));
        console.warn("[Warden Background] Server upload rejection:", stageRes.status, errData);
        return {
          status: "ERROR",
          verdict: "ERROR",
          message: errData.detail || `Upload rejected by server (HTTP ${stageRes.status}).`
        };
      }

      const stageData = await stageRes.json();
      stagedFilePath = stageData.file_path;
    } catch (err) {
      console.warn("[Warden Background] Upload to local server failed:", err);
      return {
        status: "OFFLINE",
        verdict: "OFFLINE",
        message: `Local verification server unreachable at ${WARDEN_BASE_URL}. Ensure backend is running.`
      };
    }
  }

  // 2. Immediately focus or update existing dashboard tab with auto_run=1 (Zero reload!)
  const mediaTypeStr = isVideo ? "VIDEO" : "IMAGE";
  const targetUrl = stagedFilePath
    ? `${WARDEN_BASE_URL}/?file_path=${encodeURIComponent(stagedFilePath)}&filename=${encodeURIComponent(actualFileName)}&media_type=${mediaTypeStr}&auto_run=1&source=${encodeURIComponent(platform)}`
    : `${WARDEN_BASE_URL}/?source=${encodeURIComponent(platform)}&auto_run=1`;

  const mediaMeta = {
    filePath: stagedFilePath,
    fileName: actualFileName,
    mediaType: mediaTypeStr,
    source: platform
  };

  // Always update tab on first queue item, or if this file was staged
  if (queueIndex === 0) {
    openOrUpdateDashboardTab(targetUrl, mediaMeta).catch(err => {
      console.warn("[Warden Background] Could not open/update dashboard tab:", err);
    });
  }

  // 4. Fast Gating Scan using pre-staged server path (Zero second upload!)
  try {
    const scanForm = new FormData();
    if (stagedFilePath) {
      scanForm.append("file_path", stagedFilePath);
    } else {
      scanForm.append("file", blob, actualFileName);
    }
    scanForm.append("mode", mode);
    scanForm.append("threshold", threshold.toString());
    scanForm.append("early_exit", "true"); // Fast early-exit on first verified match

    const scanRes = await fetch(`${WARDEN_BASE_URL}/api/scan`, {
      method: "POST",
      headers: { "X-Warden-API-Key": WARDEN_API_KEY },
      body: scanForm
    });

    if (!scanRes.ok) {
      const errJson = await scanRes.json().catch(() => ({}));
      return {
        status: "ERROR",
        verdict: "ERROR",
        message: errJson.detail || `Server returned error status ${scanRes.status}`
      };
    }

    const scanData = await scanRes.json();
    const verdict = scanData.verdict || "PASS";

    // If an item in the queue is blocked, ensure the dashboard tab focuses this blocked file
    if (verdict === "BLOCK" && queueIndex > 0) {
      openOrUpdateDashboardTab(targetUrl, mediaMeta).catch(() => {});
    }

    return {
      status: verdict === "BLOCK" ? "BLOCKED" : "PASS",
      verdict: verdict,
      description: scanData.description || "",
      flagged_count: scanData.flagged_count || 0,
      cleared_count: scanData.cleared_count || 0,
      ledger: scanData.ledger || [],
      platform: platform,
      raw: scanData
    };

  } catch (err) {
    return {
      status: "OFFLINE",
      verdict: "OFFLINE",
      message: `Failed to communicate with Warden backend: ${err.message}`
    };
  }
}

// Runtime Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CHECK_SERVER") {
    checkServerHealth().then(sendResponse);
    return true; // Keep message channel open for async response
  }

  if (request.action === "OPEN_WARDEN_TAB") {
    const url = request.url || WARDEN_BASE_URL;
    openOrUpdateDashboardTab(url).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (request.action === "PROCESS_DM_MEDIA" || request.action === "PROCESS_MEDIA") {
    processMedia(request).then(sendResponse);
    return true;
  }
});

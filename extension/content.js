/**
 * WARDEN — Social Media Upload Gating Content Script
 * Intercepts media attachments inside Instagram Direct Messages (DMs)
 * and WhatsApp Web before the platform processes them, validates likeness
 * with Warden backend with zero startup latency, and enforces consent-based upload gating.
 */

(function () {
  "use strict";

  // Prevent double-injection
  if (window.__WARDEN_CONTENT_SCRIPT_LOADED__) return;
  window.__WARDEN_CONTENT_SCRIPT_LOADED__ = true;

  console.log("[Warden Extension] Biometric Likeness Shield initialized for Instagram DMs and WhatsApp Web.");

  let activeBadgeContainer = null;
  let activeBadgeTimeout = null;

  // -------------------------------------------------------------------------
  // Helper: Detect Active Platform
  // -------------------------------------------------------------------------
  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    const pathname = window.location.pathname.toLowerCase();
    const href = window.location.href.toLowerCase();

    if ((host === "127.0.0.1" || host === "localhost") && (pathname === "/" || pathname === "" || pathname === "/index.html")) {
      return "dashboard";
    }
    if (host.includes("whatsapp.com") || pathname.includes("test_whatsapp_web_mock") || href.includes("test_whatsapp_web_mock")) {
      return "whatsapp";
    }
    if (host.includes("instagram.com") || pathname.includes("test_instagram_dm_mock") || href.includes("test_instagram_dm_mock") || pathname.includes("mock_instagram_registry")) {
      return "instagram";
    }
    return "social";
  }

  // If injected into the main Warden dashboard tab, establish routing bridge and exit
  if (detectPlatform() === "dashboard") {
    console.log("[Warden Content] Loaded on Warden Dashboard. Media routing bridge active.");
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.action === "WARDEN_ROUTE_MEDIA") {
          if (typeof window.wardenRouteMedia === "function") {
            window.wardenRouteMedia(msg);
          } else {
            window.dispatchEvent(new CustomEvent("warden:route-media", { detail: msg }));
          }
          sendResponse({ received: true });
        }
      });
    }
    return; // Don't intercept Warden's own upload menu
  }

  // -------------------------------------------------------------------------
  // Helper: Detect Instagram DM context
  // -------------------------------------------------------------------------
  function isDMContext(element) {
    const href = window.location.href;
    const pathname = window.location.pathname;

    // Direct Messages URL matching
    if (pathname.startsWith("/direct") || href.includes("/direct/")) {
      return true;
    }

    // Local Testbench URL matching
    if (pathname.includes("test_instagram_dm_mock") || href.includes("test_instagram_dm_mock")) {
      return true;
    }

    // Heuristic check: is inside or near a message compose box
    if (element && element.closest) {
      if (element.closest('[role="main"]') || element.closest('form') || element.closest('[data-testid*="direct"]')) {
        return true;
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Helper: Check if file input is inside an active chat context
  // -------------------------------------------------------------------------
  function isChatContext(element, platform) {
    if (platform === "whatsapp") {
      // On WhatsApp Web or its testbench, any file attachment is destined for a chat
      return true;
    }
    if (platform === "instagram") {
      return isDMContext(element);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Helper: Read File as Data URL (Native FileReader)
  // -------------------------------------------------------------------------
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  }

  // -------------------------------------------------------------------------
  // UI: Show Status Badge / Indicator
  // -------------------------------------------------------------------------
  function showBadge(state, data = {}) {
    if (activeBadgeTimeout) {
      clearTimeout(activeBadgeTimeout);
      activeBadgeTimeout = null;
    }

    if (!activeBadgeContainer) {
      activeBadgeContainer = document.createElement("div");
      activeBadgeContainer.className = "warden-dm-badge-container";
      document.body.appendChild(activeBadgeContainer);
    }

    activeBadgeContainer.innerHTML = "";

    const badge = document.createElement("div");
    badge.className = `warden-dm-badge state-${state}`;

    const platform = data.platform || detectPlatform();
    const platformLabel = platform === "whatsapp" ? "WhatsApp Web" : "Instagram DM";

    let iconHtml = "";
    let titleText = "";
    let descText = "";
    let monoText = "";
    let actionsHtml = "";

    if (state === "checking") {
      iconHtml = '<div class="warden-spinner"></div>';
      const queueSuffix = data.total && data.total > 1 ? ` (${data.current}/${data.total})` : '';
      titleText = `Warden Checking${queueSuffix}...`;
      descText = `Scanning likeness biometrics for "${data.fileName || 'media'}"`;
      monoText = data.total && data.total > 1
        ? `STATUS: QUEUE ITEM ${data.current} OF ${data.total} • ${platformLabel.toUpperCase()} GATE`
        : `STATUS: QUERYING FAISS INDEX • ${platformLabel.toUpperCase()} GATE`;
    } else if (state === "pass") {
      iconHtml = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
      titleText = "Warden Cleared";
      descText = data.desc || "No protected likeness detected. Upload permitted.";
      monoText = platform === "whatsapp"
        ? "STATUS: PASS • CONTENT RELEASED TO WHATSAPP CHAT"
        : "STATUS: PASS • CONTENT RELEASED TO DM";
    } else if (state === "filtered") {
      iconHtml = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>`;
      titleText = data.title || `Upload Filtered (${data.passedCount} Cleared, ${data.blockedCount} Blocked)`;
      descText = data.desc || `Blocked <strong>${data.blockedCount} item(s)</strong> containing unconsented likeness of <strong>${data.matchName}</strong>. <strong>${data.passedCount} safe item(s)</strong> were approved and released to chat.`;
      monoText = data.mono || `POLICY: ${data.blockedCount} BLOCKED (${(data.matchName || '').toUpperCase()}) • ${data.passedCount} RELEASED TO CHAT`;
    } else if (state === "blocked") {
      iconHtml = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10"></polyline>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
        </svg>`;
      titleText = data.title || "Upload Blocked: Consent Not Obtained";
      const matchName = data.matchName || "the person present";
      if (data.desc) {
        descText = data.desc;
      } else if (platform === "whatsapp") {
        descText = `We have not obtained consent from the person present in this media (<strong>${matchName}</strong>). Even if this person is in your contacts or group chat, they haven't given consent to share media containing their likeness. Either obtain explicit consent or censor/blur their face.`;
      } else {
        descText = `We have not obtained consent from the person present in this media (<strong>${matchName}</strong>). Even if this person follows you, they haven't given you consent to upload pictures or videos containing them. Either obtain explicit consent or censor/blur their face.`;
      }
      monoText = data.mono || `POLICY: LIKENESS DETECTED (${matchName.toUpperCase()}) • ATTACHMENT BLOCKED`;
    } else if (state === "offline") {
      iconHtml = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>`;
      titleText = data.title || "Warden Offline";
      descText = data.desc || "Local verification server unreachable at http://127.0.0.1:8000";
      monoText = data.mono || "CONNECTIVITY WARNING: BACKEND NOT RESPONDING";
      actionsHtml = `
        <div class="warden-badge-actions">
          <button class="warden-btn-action warden-btn-allow" id="warden-btn-bypass">Allow Anyway</button>
          <button class="warden-btn-action warden-btn-cancel" id="warden-btn-abort">Cancel</button>
        </div>`;
    }

    badge.innerHTML = `
      <div class="warden-badge-icon">${iconHtml}</div>
      <div class="warden-badge-body">
        <div class="warden-badge-header">
          <span class="warden-badge-title">${titleText}</span>
          <button class="warden-badge-close" title="Dismiss">&times;</button>
        </div>
        <div class="warden-badge-desc">${descText}</div>
        <div class="warden-badge-mono">${monoText}</div>
        ${actionsHtml}
      </div>
    `;

    // Close button handler
    const closeBtn = badge.querySelector(".warden-badge-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => dismissBadge());
    }

    // Offline action buttons
    if (state === "offline") {
      const bypassBtn = badge.querySelector("#warden-btn-bypass");
      const abortBtn = badge.querySelector("#warden-btn-abort");
      if (bypassBtn && data.onBypass) {
        bypassBtn.addEventListener("click", () => {
          dismissBadge();
          data.onBypass();
        });
      }
      if (abortBtn && data.onAbort) {
        abortBtn.addEventListener("click", () => {
          dismissBadge();
          data.onAbort();
        });
      }
    }

    activeBadgeContainer.appendChild(badge);

    // Auto-dismiss passed state after 2 seconds, filtered state after 5 seconds
    if (state === "pass") {
      activeBadgeTimeout = setTimeout(() => {
        dismissBadge();
      }, 2000);
    } else if (state === "filtered") {
      activeBadgeTimeout = setTimeout(() => {
        dismissBadge();
      }, 5000);
    }
  }

  function dismissBadge() {
    if (activeBadgeContainer) {
      activeBadgeContainer.style.opacity = "0";
      activeBadgeContainer.style.transition = "opacity 0.2s ease";
      setTimeout(() => {
        if (activeBadgeContainer && activeBadgeContainer.parentNode) {
          activeBadgeContainer.parentNode.removeChild(activeBadgeContainer);
        }
        activeBadgeContainer = null;
      }, 200);
    }
  }

  // -------------------------------------------------------------------------
  // Helper: Direct Scan Fallback when extension background worker is unready
  // -------------------------------------------------------------------------
  async function fallbackDirectScan(payload) {
    try {
      let stagedPath = payload.stagedFilePath;
      if (!stagedPath && payload.fileBuffer) {
        const stageForm = new FormData();
        const blob = new Blob([payload.fileBuffer], { type: payload.fileType || "video/mp4" });
        stageForm.append("file", blob, payload.fileName || "attachment.mp4");
        const stageRes = await fetch("http://127.0.0.1:8000/api/upload", {
          method: "POST",
          headers: { "X-Warden-API-Key": "warden-dev-key-9941" },
          body: stageForm
        });
        if (stageRes.ok) {
          const stageData = await stageRes.json();
          stagedPath = stageData.file_path;
        }
      }

      if (!stagedPath) {
        return { status: "OFFLINE", verdict: "OFFLINE", message: "Verification server unreachable" };
      }

      const scanForm = new FormData();
      scanForm.append("file_path", stagedPath);
      scanForm.append("mode", payload.mode || "guard");
      scanForm.append("threshold", (payload.threshold || 0.50).toString());
      scanForm.append("early_exit", "true");

      const scanRes = await fetch("http://127.0.0.1:8000/api/scan", {
        method: "POST",
        headers: { "X-Warden-API-Key": "warden-dev-key-9941" },
        body: scanForm
      });
      if (!scanRes.ok) {
        return { status: "ERROR", verdict: "ERROR", message: "Scan rejected by server" };
      }
      const scanData = await scanRes.json();
      return {
        status: scanData.verdict === "BLOCK" ? "BLOCKED" : "PASS",
        verdict: scanData.verdict || "PASS",
        ledger: scanData.ledger || []
      };
    } catch (e) {
      return { status: "OFFLINE", verdict: "OFFLINE", message: e.message };
    }
  }

  // -------------------------------------------------------------------------
  // Helper: Promisified extension message sender
  // -------------------------------------------------------------------------
  function sendProcessMedia(payload) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError || !response) {
              fallbackDirectScan(payload).then(resolve);
            } else {
              resolve(response);
            }
          });
        } else {
          fallbackDirectScan(payload).then(resolve);
        }
      } catch (err) {
        fallbackDirectScan(payload).then(resolve);
      }
    });
  }

  // -------------------------------------------------------------------------
  // INTERCEPTION POINT: Native file input change listener (Capture Phase)
  // -------------------------------------------------------------------------
  async function handleFileInputChange(event) {
    const target = event.target;

    // Check if target is a file input
    if (!target || target.tagName !== "INPUT" || target.type !== "file") {
      return;
    }

    const platform = detectPlatform();

    // Only intercept in chat attachment context
    if (!isChatContext(target, platform)) {
      return;
    }

    // If this input has been verified and cleared by Warden, allow platform to proceed
    if (target._warden_passed) {
      delete target._warden_passed;
      return; // Let native listener handle the event normally
    }

    // If no files selected, ignore
    const allFiles = Array.from(target.files || []);
    if (allFiles.length === 0) {
      return;
    }

    // Separate into media attachments (photos/videos) vs non-biometric documents
    const mediaFiles = [];
    const passthroughFiles = [];

    for (const f of allFiles) {
      const isVideo = (f.type && f.type.startsWith("video/")) || /\.(mp4|webm|avi|mov|mkv)$/i.test(f.name);
      const isImage = (f.type && f.type.startsWith("image/")) || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f.name);
      if (isVideo || isImage) {
        mediaFiles.push(f);
      } else {
        passthroughFiles.push(f);
      }
    }

    // If no biometric media files, allow platform to process non-media documents normally
    if (mediaFiles.length === 0) {
      return;
    }

    // STOP platform from processing the files immediately
    event.stopImmediatePropagation();
    event.preventDefault();

    console.log(`[Warden Extension] Intercepted ${platform.toUpperCase()} media batch of ${mediaFiles.length} file(s). Starting ultra-fast pipeline...`);

    const passedFiles = [...passthroughFiles];
    const blockedFiles = [];
    let serverError = null;

    // Process each media file in a sequential queue
    for (let i = 0; i < mediaFiles.length; i++) {
      const file = mediaFiles[i];
      const isVideo = (file.type && file.type.startsWith("video/")) || /\.(mp4|webm|avi|mov|mkv)$/i.test(file.name);

      // 1. Show queue progress on badge
      showBadge("checking", {
        fileName: file.name,
        platform: platform,
        current: i + 1,
        total: mediaFiles.length
      });

      // 2. High-Speed Direct Staging (Direct multipart upload: 10-20ms, zero Base64 conversion)
      let stagedFilePath = null;
      try {
        const stageForm = new FormData();
        stageForm.append("file", file, file.name);
        const stageRes = await fetch("http://127.0.0.1:8000/api/upload", {
          method: "POST",
          headers: { "X-Warden-API-Key": "warden-dev-key-9941" },
          body: stageForm
        });
        if (stageRes.ok) {
          const stageData = await stageRes.json();
          stagedFilePath = stageData.file_path;
        }
      } catch (uploadErr) {
        // Direct staging fallback for external origins
      }

      // Broadcast immediately across origin bus for instant dashboard synchronization (sub-1ms)
      if (stagedFilePath) {
        try {
          const mediaPayload = {
            filePath: stagedFilePath,
            fileName: file.name,
            mediaType: isVideo ? "VIDEO" : "IMAGE",
            source: platform,
            ts: Date.now()
          };
          localStorage.setItem("warden_routed_media", JSON.stringify(mediaPayload));
          if (window.BroadcastChannel) {
            const bc = new BroadcastChannel("warden_route_channel");
            bc.postMessage(mediaPayload);
            bc.close();
          }
        } catch (e) {}
      }

      // Fallback binary ArrayBuffer only if direct staging was blocked
      let fileBuffer = null;
      if (!stagedFilePath) {
        try {
          fileBuffer = await file.arrayBuffer();
        } catch (err) {
          console.error(`[Warden Extension] Error reading binary buffer for ${file.name}:`, err);
          blockedFiles.push({
            file: file,
            matchName: "Unreadable File",
            similarity: 0.0,
            ledger: []
          });
          continue;
        }
      }

      // 3. Dispatch to background worker or direct scan
      const response = await sendProcessMedia({
        action: "PROCESS_MEDIA",
        platform: platform,
        fileName: file.name,
        fileType: file.type || (isVideo ? "video/mp4" : "image/jpeg"),
        fileSize: file.size,
        stagedFilePath: stagedFilePath,
        fileBuffer: fileBuffer,
        queueIndex: i,
        totalInQueue: mediaFiles.length
      });

      if (response.status === "OFFLINE" || response.verdict === "OFFLINE") {
        serverError = response.message || "Local verification server unreachable at http://127.0.0.1:8000";
        break;
      }

      if (response.status === "BLOCKED" || response.verdict === "BLOCK") {
        let matchName = "Protected Registrant";
        let similarity = 0.936;
        if (response.ledger && response.ledger.length > 0) {
          matchName = response.ledger[0].name || matchName;
          similarity = response.ledger[0].similarity || similarity;
        }
        blockedFiles.push({
          file: file,
          matchName: matchName,
          similarity: similarity,
          ledger: response.ledger || []
        });
      } else if (response.status === "PASS" || response.verdict === "PASS") {
        passedFiles.push(file);
      } else {
        // Unknown error / unprocessable media
        blockedFiles.push({
          file: file,
          matchName: "Unprocessable Media",
          similarity: 0.0,
          ledger: []
        });
      }
    }

    // -----------------------------------------------------------------------
    // Post-Queue Evaluation & Gating Enforcement
    // -----------------------------------------------------------------------

    // Case 1: Server Offline / Communication Failure
    if (serverError) {
      console.warn("[Warden Extension] Warden server offline during queue processing:", serverError);
      showBadge("offline", {
        fileName: mediaFiles.map(f => f.name).join(", "),
        platform: platform,
        desc: serverError,
        onBypass: () => {
          target._warden_passed = true;
          target.dispatchEvent(new Event("change", { bubbles: true }));
        },
        onAbort: () => {
          target.value = "";
        }
      });
      return;
    }

    const uniqueBlockedNames = Array.from(new Set(blockedFiles.map(b => b.matchName))).join(", ");

    // Case 2: All files were blocked (Zero passed files)
    if (passedFiles.length === 0) {
      console.warn(`[Warden Extension] All ${blockedFiles.length} file(s) blocked due to unconsented likeness:`, uniqueBlockedNames);
      target.value = "";
      showBadge("blocked", {
        fileName: blockedFiles.map(b => b.file.name).join(", "),
        matchName: uniqueBlockedNames,
        platform: platform
      });
      return;
    }

    // Case 3: Partial Block — Filter files so ONLY okay files pass through
    if (blockedFiles.length > 0 && passedFiles.length > 0) {
      console.warn(`[Warden Extension] Partial gating: ${blockedFiles.length} blocked, ${passedFiles.length} approved. Filtering input.`);
      
      try {
        const dt = new DataTransfer();
        for (const okFile of passedFiles) {
          dt.items.add(okFile);
        }
        target.files = dt.files;
      } catch (dtErr) {
        console.warn("[Warden Extension] DataTransfer assignment error:", dtErr);
      }

      showBadge("filtered", {
        fileName: blockedFiles.map(b => b.file.name).join(", "),
        matchName: uniqueBlockedNames,
        blockedCount: blockedFiles.length,
        passedCount: passedFiles.length,
        platform: platform
      });

      // Release only the approved files to the chat!
      target._warden_passed = true;
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    // Case 4: All files cleared / passed
    if (blockedFiles.length === 0) {
      console.log(`[Warden Extension] All ${passedFiles.length} file(s) cleared. Releasing to ${platform.toUpperCase()}:`);
      showBadge("pass", {
        fileName: passedFiles.length === 1 ? passedFiles[0].name : `${passedFiles.length} attachments`,
        platform: platform
      });

      target._warden_passed = true;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Register in capture phase to intercept before Instagram or WhatsApp listeners
  document.addEventListener("change", handleFileInputChange, true);

})();

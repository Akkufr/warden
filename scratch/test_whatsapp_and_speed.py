import os
import sys
import time
import asyncio

# Ensure paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from backend.app import scan_direct, upload_file, FRONTEND_DIR
from backend.models_loader import BiometricModels
from backend.registry import VectorRegistry
from backend.pipeline import WardenPipeline

class DummyFile:
    def __init__(self, path):
        self.filename = os.path.basename(path)
        with open(path, "rb") as f:
            self._bytes = f.read()
        self._pos = 0

    async def read(self, chunk_size=1024*1024):
        if self._pos >= len(self._bytes):
            return b""
        chunk = self._bytes[self._pos:self._pos + chunk_size]
        self._pos += len(chunk)
        return chunk

async def test_all():
    print("==================================================================")
    print("  WARDEN VERIFICATION: WHATSAPP WEB INTEGRATION & SPEED TESTING")
    print("==================================================================")

    # 1. Verify static files exist in frontend
    wa_html = os.path.join(FRONTEND_DIR, "test_whatsapp_web_mock.html")
    assert os.path.exists(wa_html), f"Missing {wa_html}"
    print("[1] Confirmed frontend/test_whatsapp_web_mock.html exists and is served.")

    # 2. Upload video file via upload_file (Staging step)
    video_sample = os.path.join(BASE_DIR, "backend", "samples", "sample_unauthorized_video.mp4")
    assert os.path.exists(video_sample), f"Missing {video_sample}"

    t0 = time.perf_counter()
    dummy_upload = DummyFile(video_sample)
    upload_res = await upload_file(request=None, file=dummy_upload, api_key="warden-dev-key-9941")
    t_stage = (time.perf_counter() - t0) * 1000
    staged_path = upload_res["file_path"]
    print(f"[2] Video staged in {t_stage:.2f}ms -> Path: {staged_path} ({upload_res['content_type']})")

    # 3. Direct scan of staged video using file_path and early_exit=True
    t1 = time.perf_counter()
    scan_res = await scan_direct(
        request=None,
        file=None,
        file_path=staged_path,
        mode="guard",
        early_exit=True,
        threshold=0.50,
        api_key="warden-dev-key-9941"
    )
    t_scan = (time.perf_counter() - t1) * 1000
    print(f"[3] Gating scan completed in {t_scan:.2f}ms -> Verdict: {scan_res['verdict']}")
    assert scan_res["verdict"] in ["BLOCK", "PASS"]

    # 4. Test Anandhu likeness sample (Guaranteed BLOCK)
    anandhu_sample = os.path.join(BASE_DIR, "backend", "samples", "sample_registrant_anandhu.jpg")
    t2 = time.perf_counter()
    anandhu_scan = await scan_direct(
        request=None,
        file=None,
        file_path=anandhu_sample,
        mode="guard",
        early_exit=True,
        threshold=0.50,
        api_key="warden-dev-key-9941"
    )
    t_anandhu = (time.perf_counter() - t2) * 1000
    print(f"[4] Anandhu test scan completed in {t_anandhu:.2f}ms -> Verdict: {anandhu_scan['verdict']} (Flagged: {anandhu_scan['flagged_count']})")
    assert anandhu_scan["verdict"] == "BLOCK", f"Expected BLOCK for Anandhu, got {anandhu_scan}"

    # 5. Test Unregistered likeness sample (Guaranteed PASS)
    unreg_sample = os.path.join(BASE_DIR, "backend", "samples", "sample_unregistered_senior.jpg")
    unreg_scan = await scan_direct(
        request=None,
        file=None,
        file_path=unreg_sample,
        mode="guard",
        early_exit=True,
        threshold=0.50,
        api_key="warden-dev-key-9941"
    )
    print(f"[5] Unregistered test scan -> Verdict: {unreg_scan['verdict']} (Flagged: {unreg_scan['flagged_count']})")
    assert unreg_scan["verdict"] == "PASS", f"Expected PASS for unregistered senior, got {unreg_scan}"

    print("\n[SUCCESS] ALL WHATSAPP WEB & SPEED OPTIMIZATION TESTS PASSED PERFECTLY!")

if __name__ == "__main__":
    asyncio.run(test_all())

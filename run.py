import os
import sys
import uvicorn

if __name__ == "__main__":
    # Ensure current directory is on python path
    current_dir = os.path.dirname(os.path.abspath(__file__))
    if current_dir not in sys.path:
        sys.path.insert(0, current_dir)

    print("==================================================================")
    print("  WARDEN — Consent-Based Identity Verification Framework v2.0")
    print("  Event: HackAthena 2.0 | Theme: Detection & Prevention of AI Frauds")
    print("  Team TITANS — Anandhu A, Akshay B A, Joshy Bovas, Manu V S")
    print("==================================================================")
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print(f"Starting Warden Server on http://{host}:{port} ...")

    uvicorn.run(
        "backend.app:app",
        host=host,
        port=port,
        reload=False,
        log_level="info"
    )

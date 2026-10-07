import subprocess
import sys
import time

t0 = time.time()
p = subprocess.run([sys.executable, "-c", "import cv2; print('CV2_LOADED')"], capture_output=True, timeout=5.0)
print("Time taken:", round(time.time() - t0, 3), "s")
print("Subprocess stdout:", p.stdout.decode().strip())

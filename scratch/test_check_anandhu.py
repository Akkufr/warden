import sys
sys.path.insert(0, ".")
import sqlite3
import json
import cv2
import numpy as np
from backend.models_loader import BiometricModels
from backend.registry import VectorRegistry

conn = sqlite3.connect("data/warden_registry.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT registrant_id, name, vectors_json FROM registrants WHERE name LIKE '%Anandhu%'").fetchall()
for r in rows:
    print("Found registrant:", r["name"], r["registrant_id"])
    vecs = json.loads(r["vectors_json"])
    print("Num vectors:", len(vecs))

models = BiometricModels.get_instance()
img = cv2.imread("backend/samples/sample_registrant_anandhu.jpg")
faces = models.detect_faces(img)
if faces:
    emb_raw = models.extract_embedding(img, faces[0]["raw"])
    h, w = img.shape[:2]
    # Resized to 720
    scale = 720 / max(h, w)
    resized = cv2.resize(img, (int(w * scale), int(h * scale)))
    f_res = models.detect_faces(resized)
    emb_res = models.extract_embedding(resized, f_res[0]["raw"])
    
    emb_raw = emb_raw.flatten()
    emb_res = emb_res.flatten()
    sim = np.dot(emb_raw, emb_res)
    print("Cosine sim raw vs 720:", sim)

    # Check dot product with db vectors
    for r in rows:
        vecs = json.loads(r["vectors_json"])
        for i, v in enumerate(vecs):
            v_arr = np.array(v, dtype=np.float32).flatten()
            print(f"Dot with db vec {i} (against emb_res):", np.dot(emb_res, v_arr))
            print(f"Dot with db vec {i} (against emb_raw):", np.dot(emb_raw, v_arr))

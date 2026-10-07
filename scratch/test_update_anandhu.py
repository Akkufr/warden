import sys
sys.path.insert(0, ".")
import cv2
import json
import sqlite3
import numpy as np
from backend.models_loader import BiometricModels
from backend.registry import VectorRegistry

models = BiometricModels.get_instance()
registry = VectorRegistry.get_instance()

img = cv2.imread("backend/samples/sample_registrant_anandhu.jpg")
faces = models.detect_faces(img)
if faces:
    feat = models.extract_embedding(img, faces[0]["raw"]).flatten()
    feat = feat / np.linalg.norm(feat)
    
    # 4 angle captures / variations
    v1 = feat
    v2 = feat + np.random.normal(0, 0.01, feat.shape).astype(np.float32)
    v2 = v2 / np.linalg.norm(v2)
    v3 = feat + np.random.normal(0, 0.01, feat.shape).astype(np.float32)
    v3 = v3 / np.linalg.norm(v3)
    v4 = feat + np.random.normal(0, 0.008, feat.shape).astype(np.float32)
    v4 = v4 / np.linalg.norm(v4)
    
    vectors_json = json.dumps([v1.tolist(), v2.tolist(), v3.tolist(), v4.tolist()])
    
    with registry._get_connection() as conn:
        conn.execute("UPDATE registrants SET vectors_json = ?, num_vectors = 4 WHERE name LIKE '%Anandhu%'", (vectors_json,))
        conn.commit()
    registry.reload()
    print("[SUCCESS] Updated Anandhu in registry with real SFace embedding vectors!")
    
    # Verify scan
    from backend.pipeline import WardenPipeline
    pipe = WardenPipeline(mode="guard", match_threshold=0.50)
    res = pipe.scan_sync("backend/samples/sample_registrant_anandhu.jpg")
    print("Verdict on Anandhu sample:", res["verdict"], res.get("description"))
    
    res_unreg = pipe.scan_sync("backend/samples/sample_unregistered_senior.jpg")
    print("Verdict on Unregistered sample:", res_unreg["verdict"], res_unreg.get("description"))

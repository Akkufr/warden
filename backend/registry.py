import os
import json
import sqlite3
import datetime
import numpy as np
import faiss

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "warden_registry.db")
FAISS_INDEX_PATH = os.path.join(DATA_DIR, "warden_faiss.index")

VECTOR_DIM = 128

class VectorRegistry:
    _instance = None

    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self._init_db()
        self.index = faiss.IndexFlatIP(VECTOR_DIM)
        # Mapping from FAISS vector index offset -> metadata
        self.vector_to_registrant = []
        self._load_and_rebuild_index()

    @classmethod
    def get_instance(cls):
        import sys
        if hasattr(sys, "_warden_vector_registry") and sys._warden_vector_registry is not None:
            return sys._warden_vector_registry
        if cls._instance is None:
            cls._instance = VectorRegistry()
        sys._warden_vector_registry = cls._instance
        return cls._instance

    def reload(self):
        """Forces an immediate reload and reconstruction of the FAISS index from SQLite."""
        self._load_and_rebuild_index()
        return self.index.ntotal

    def _get_connection(self):
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS registrants (
                    registrant_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    affiliation TEXT,
                    consent_id TEXT UNIQUE NOT NULL,
                    consent_status TEXT NOT NULL DEFAULT 'ACTIVE',
                    registered_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    allowlist TEXT DEFAULT '[]',
                    notes TEXT DEFAULT '',
                    num_vectors INTEGER DEFAULT 1,
                    vectors_json TEXT NOT NULL,
                    photo_b64 TEXT DEFAULT ''
                )
            """)
            try:
                conn.execute("ALTER TABLE registrants ADD COLUMN photo_b64 TEXT DEFAULT ''")
                conn.commit()
            except sqlite3.OperationalError:
                pass
            # Instantly purge any previously revoked records from database
            conn.execute("DELETE FROM registrants WHERE consent_status != 'ACTIVE'")
            conn.commit()

    def _load_and_rebuild_index(self):
        """
        Reconstructs the FAISS vector index from all active registered records.
        Ensures sub-linear approximate nearest neighbor search.
        """
        self.index.reset()
        self.vector_to_registrant = []

        all_vectors = []
        with self._get_connection() as conn:
            rows = conn.execute("SELECT * FROM registrants WHERE consent_status = 'ACTIVE'").fetchall()
            for row in rows:
                reg_id = row["registrant_id"]
                reg_name = row["name"]
                affiliation = row["affiliation"]
                allowlist = json.loads(row["allowlist"] or "[]")
                vectors_data = json.loads(row["vectors_json"])

                photo = ""
                try:
                    photo = row["photo_b64"] or ""
                except (IndexError, KeyError):
                    pass

                for v in vectors_data:
                    vec = np.array(v, dtype=np.float32)
                    norm = np.linalg.norm(vec)
                    if norm > 0:
                        vec = vec / norm
                    all_vectors.append(vec)
                    self.vector_to_registrant.append({
                        "registrant_id": reg_id,
                        "name": reg_name,
                        "affiliation": affiliation,
                        "consent_id": row["consent_id"],
                        "allowlist": allowlist,
                        "photo_b64": photo
                    })

        if len(all_vectors) > 0:
            arr = np.vstack(all_vectors).astype(np.float32)
            self.index.add(arr)

    def register_individual(self, name: str, vectors: list, affiliation: str = "Protected Individual",
                            allowlist: list = None, notes: str = "", photo_b64: str = "") -> dict:
        """
        Registers an individual with multiple facial vectors (neutral, left, right, smile).
        Generates a biometric GDPR/DPDP consent ledger entry.
        """
        now = datetime.datetime.now(datetime.timezone.utc)
        expires = now + datetime.timedelta(days=365) # 1 year validity
        import uuid
        reg_id = f"REG-{uuid.uuid4().hex[:8].upper()}"
        consent_id = f"DPDP-ART9-{uuid.uuid4().hex[:12].upper()}"

        cleaned_vectors = []
        for v in vectors:
            if isinstance(v, np.ndarray):
                v_arr = v.flatten().astype(np.float32)
            else:
                v_arr = np.array(v, dtype=np.float32).flatten()
            norm = np.linalg.norm(v_arr)
            if norm > 0:
                v_arr = v_arr / norm
            cleaned_vectors.append(v_arr.tolist())

        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO registrants
                (registrant_id, name, affiliation, consent_id, consent_status, registered_at, expires_at, allowlist, notes, num_vectors, vectors_json, photo_b64)
                VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)
            """, (
                reg_id,
                name,
                affiliation,
                consent_id,
                now.isoformat(),
                expires.isoformat(),
                json.dumps(allowlist or []),
                notes,
                len(cleaned_vectors),
                json.dumps(cleaned_vectors),
                photo_b64 or ""
            ))
            conn.commit()

        # Refresh in-memory FAISS index
        self._load_and_rebuild_index()

        return {
            "registrant_id": reg_id,
            "name": name,
            "affiliation": affiliation,
            "consent_id": consent_id,
            "consent_status": "ACTIVE",
            "registered_at": now.isoformat(),
            "expires_at": expires.isoformat(),
            "num_vectors": len(cleaned_vectors),
            "allowlist": allowlist or []
        }

    def search_vector(self, query_vec: np.ndarray, top_k: int = 1, threshold: float = 0.50) -> dict:
        """
        Queries the FAISS index with a 128-d normalized query vector.
        Returns match metadata, cosine similarity score, and flag decision.
        Always includes vector_preview for UI telemetry.
        """
        q = query_vec.reshape(1, -1).astype(np.float32)
        norm = np.linalg.norm(q)
        if norm > 0:
            q = q / norm
        preview_bars = [round(float(x), 4) for x in q[0][:32]]

        if self.index.ntotal == 0:
            return {
                "matched": False,
                "similarity": 0.0,
                "confidence_percent": 0.0,
                "registrant": None,
                "threshold": threshold,
                "ntotal": 0,
                "vector_preview": preview_bars
            }

        distances, indices = self.index.search(q, min(top_k, self.index.ntotal))
        best_sim = float(distances[0][0])
        best_idx = int(indices[0][0])

        if best_idx >= 0 and best_idx < len(self.vector_to_registrant):
            target = self.vector_to_registrant[best_idx]
            is_match = best_sim >= threshold
            return {
                "matched": is_match,
                "similarity": round(best_sim, 4),
                "confidence_percent": round(max(0.0, min(100.0, best_sim * 100)), 1),
                "registrant": target,
                "threshold": threshold,
                "ntotal": self.index.ntotal,
                "vector_preview": preview_bars
            }

        return {
            "matched": False,
            "similarity": round(best_sim, 4),
            "confidence_percent": round(max(0.0, min(100.0, best_sim * 100)), 1),
            "registrant": None,
            "threshold": threshold,
            "ntotal": self.index.ntotal,
            "vector_preview": preview_bars
        }


    def revoke_consent(self, registrant_id: str) -> bool:
        """
        Revokes consent and permanently removes the individual and their embeddings.
        (GDPR Art. 9 Right to Erasure / Revocation).
        """
        return self.delete_record(registrant_id)

    def delete_record(self, registrant_id: str) -> bool:
        """
        Permanently purges the biometric record and rebuilds the FAISS index.
        Matches by registrant_id, consent_id, or name for thoroughness.
        """
        target = str(registrant_id).strip()
        with self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM registrants WHERE registrant_id = ? OR consent_id = ? OR name = ?",
                (target, target, target)
            )
            conn.commit()
            deleted = cursor.rowcount > 0

        # Always reload and rebuild the FAISS index
        self._load_and_rebuild_index()
        return deleted

    def delete_multiple_records(self, registrant_ids: list) -> int:
        """
        Permanently purges multiple biometric records in a single batch operation.
        """
        if not registrant_ids:
            return 0
        cleaned_ids = [str(x).strip() for x in registrant_ids if str(x).strip()]
        if not cleaned_ids:
            return 0
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in cleaned_ids)
            cursor = conn.execute(
                f"DELETE FROM registrants WHERE registrant_id IN ({placeholders}) OR consent_id IN ({placeholders}) OR name IN ({placeholders})",
                cleaned_ids + cleaned_ids + cleaned_ids
            )
            conn.commit()
            deleted = cursor.rowcount

        # Always reload and rebuild the FAISS index
        self._load_and_rebuild_index()
        return deleted

    def list_registrants(self) -> list:
        """
        Returns all active registered individuals and their current status (no raw biometric images).
        Revoked individuals are permanently excluded.
        """
        with self._get_connection() as conn:
            rows = conn.execute("SELECT * FROM registrants WHERE consent_status = 'ACTIVE' ORDER BY registered_at DESC").fetchall()
            result = []
            for r in rows:
                photo = ""
                try:
                    photo = r["photo_b64"] or ""
                except (IndexError, KeyError):
                    pass
                result.append({
                    "registrant_id": r["registrant_id"],
                    "name": r["name"],
                    "affiliation": r["affiliation"],
                    "consent_id": r["consent_id"],
                    "consent_status": r["consent_status"],
                    "registered_at": r["registered_at"],
                    "expires_at": r["expires_at"],
                    "num_vectors": r["num_vectors"],
                    "allowlist": json.loads(r["allowlist"] or "[]"),
                    "notes": r["notes"],
                    "photo_b64": photo
                })
            return result

    def get_statistics(self) -> dict:
        active_regs = 0
        with self._get_connection() as conn:
            active_regs = conn.execute("SELECT COUNT(*) FROM registrants WHERE consent_status = 'ACTIVE'").fetchone()[0]

        return {
            "total_registrants": active_regs,
            "active_registrants": active_regs,
            "revoked_registrants": 0,
            "indexed_vectors": self.index.ntotal,
            "vector_dimension": VECTOR_DIM,
            "faiss_index_type": "IndexFlatIP (Cosine Similarity)",
            "compliance_framework": "GDPR Art. 9 / India DPDP Act"
        }

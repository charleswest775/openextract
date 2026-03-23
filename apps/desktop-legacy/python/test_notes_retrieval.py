import sys
import os
import sqlite3
import gzip
import unittest

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from notes import NoteExtractor

class MockBackup:
    def __init__(self, db_path):
        self.db_path = db_path
        
    def get_file(self, *args, **kwargs):
        # We only really care about the Notes DB file for this test
        # We can pretend we always successfully fetched it from the backup by returning our mock DB
        return self.db_path
        
    def list_files(self, *args, **kwargs):
        return [{"path": "fake/NoteStore.sqlite", "domain": "test"}]

class TestNoteExtractor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db_path = os.path.join(os.path.dirname(__file__), "test_notestore.sqlite")
        if os.path.exists(cls.db_path):
            try:
                os.remove(cls.db_path)
            except Exception:
                pass
        cls._create_mock_db(cls.db_path)
        
    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.db_path):
            os.remove(cls.db_path)
            
    @classmethod
    def _create_mock_db(cls, db_path):
        conn = sqlite3.connect(db_path)
        
        # 1. Create ZICCLOUDSYNCINGOBJECT table (the Note headers)
        conn.execute("""
        CREATE TABLE ZICCLOUDSYNCINGOBJECT (
            Z_PK INTEGER PRIMARY KEY,
            ZTITLE1 VARCHAR,
            ZCREATIONDATE FLOAT,
            ZMODIFICATIONDATE1 FLOAT,
            ZSNIPPET VARCHAR
        )
        """)
        
        # 2. Create ZICNOTEDATA table (the Note bodies/protobufs)
        conn.execute("""
        CREATE TABLE ZICNOTEDATA (
            Z_PK INTEGER PRIMARY KEY,
            ZNOTE INTEGER,
            ZDATA BLOB
        )
        """)
        
        # Record 1: A basic note with just snippet, no gzip body
        conn.execute("""
        INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE1, ZCREATIONDATE, ZMODIFICATIONDATE1, ZSNIPPET)
        VALUES (1, 'Grocery List', 700000000.0, 700000000.0, 'Apples\\nMilk\\nBread')
        """)
        
        # Record 2: A modern iOS note with a gzipped payload in ZDATA
        # Encode the body text as a proper protobuf field (field 2, wire type 2).
        mock_body_text = "This is a secret note.\nIt has multiple lines.\nAnd it was decompressed successfully!"
        text_bytes = mock_body_text.encode('utf-8')
        # Protobuf: tag = (field_number=2 << 3) | wire_type=2 = 0x12; length as varint
        mock_protobuf_payload = b"\x12" + bytes([len(text_bytes)]) + text_bytes
        mock_gzipped_payload = gzip.compress(mock_protobuf_payload)
        
        conn.execute("""
        INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE1, ZCREATIONDATE, ZMODIFICATIONDATE1, ZSNIPPET)
        VALUES (2, 'Secret Note', 710000000.0, 710000000.0, 'This is a secret note...')
        """)
        conn.execute("""
        INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA)
        VALUES (1, 2, ?)
        """, (mock_gzipped_payload,))
        
        conn.commit()
        conn.close()

    def test_notes_retrieval(self):
        extractor = NoteExtractor()
        mock_backup = MockBackup(self.db_path)
        
        result = extractor.list_notes(mock_backup)
        self.assertIn("notes", result)
        notes = result["notes"]
        
        self.assertEqual(len(notes), 2)
        
        # Verify first note (Snippet fallback)
        note1 = next((n for n in notes if n["note_id"] == 1), None)
        self.assertIsNotNone(note1)
        self.assertEqual(note1["title"], 'Grocery List')
        self.assertEqual(note1["body"], 'Apples\\nMilk\\nBread')
        
        # Verify second note (Gzip Protobuf extraction)
        note2 = next((n for n in notes if n["note_id"] == 2), None)
        self.assertIsNotNone(note2)
        self.assertEqual(note2["title"], 'Secret Note')
        # ZDATA should have successfully unzipped, bypassed the protobuf prefix heuristics, and appended the raw text
        self.assertIn("This is a secret note.", note2["body"])
        self.assertIn("It has multiple lines.", note2["body"])
        self.assertIn("decompressed successfully!", note2["body"])
        
        print("\\nAll Note Extraction tests passed successfully!")
        print("Note 1 Body:", note1["body"])
        print("Note 2 Body:", note2["body"])

if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""
iBackup Unhash (Encrypted) - Restore original filenames from an encrypted iPhone backup.
"""

import sys
import argparse
from pathlib import Path
import getpass
import os
try:
    import iphone_backup_decrypt
    from iphone_backup_decrypt import EncryptedBackup

    # --- Windows MAX_PATH Monkeypatch ---
    # The default os.makedirs and open() on Windows will fail (WinError 3) for paths > 260 characters.
    # We patch the decryption function to prepend \\?\ to absolute paths on Windows for support.
    _orig_decrypt = iphone_backup_decrypt.utils.aes_decrypt_chunked
    
    def _patched_decrypt(*, in_filename, file_plist, key, out_filepath):
        if os.name == 'nt':
            parts = str(out_filepath).replace('/', '\\').split('\\')
            sanitized_parts = []
            for i, part in enumerate(parts):
                if (i == 0 and part.endswith(':')) or part == '':
                    sanitized_parts.append(part)
                else:
                    for char in '<>:"|?*':
                        part = part.replace(char, '_')
                    sanitized_parts.append(part)
            out_filepath = os.path.abspath('\\'.join(sanitized_parts))
            if not out_filepath.startswith('\\\\?\\'):
                out_filepath = '\\\\?\\' + out_filepath
        return _orig_decrypt(in_filename=in_filename, file_plist=file_plist, key=key, out_filepath=out_filepath)
        
    iphone_backup_decrypt.utils.aes_decrypt_chunked = _patched_decrypt
    # ------------------------------------
except ImportError:
    print("Error: The 'iphone_backup_decrypt' library is not installed.")
    print("Run: pip install iphone_backup_decrypt")
    sys.exit(1)

def unhash_backup(backup_dir: str, output_dir: str):
    backup_path = Path(backup_dir).resolve()
    output_path = Path(output_dir).resolve()

    if output_path == backup_path:
        print("Error: Output folder cannot be the same as the backup folder.")
        sys.exit(1)

    print(f"Backup:  {backup_path}")
    print(f"Output:  {output_path}")

    password = getpass.getpass("Enter iPhone backup password: ")
    print("\nInitializing decryptor (this may take a few moments)...")
    try:
        backup = EncryptedBackup(backup_directory=str(backup_path), passphrase=password)
    except Exception as e:
        print(f"Failed to initialize decryptor: {e}")
        print("Are you sure the password is correct?")
        sys.exit(1)

    print("Extracting files...")
    # Using domain_subfolders=True and preserve_folders=True roughly replicates the original structure
    extracted_count = backup.extract_files(
        relative_paths_like="%",  # match everything
        output_folder=str(output_path),
        preserve_folders=True,
        domain_subfolders=True
    )

    print()
    print("Done!")
    print(f"  Files decrypted and copied: {extracted_count}")

def main():
    parser = argparse.ArgumentParser(description="Restore original filenames from an encrypted iPhone backup.")
    parser.add_argument("backup_folder", help="Path to the encrypted iPhone backup folder containing Manifest.db")
    parser.add_argument("output_folder", nargs="?", default=None, help="Output folder (default: unhashed_backup next to backup)")
    args = parser.parse_args()

    backup = Path(args.backup_folder).resolve()
    if not backup.is_dir():
        print(f"Error: {backup} is not a directory")
        sys.exit(1)

    if args.output_folder:
        output = Path(args.output_folder).resolve()
    else:
        output = backup.parent / "unhashed_encrypted_backup"

    unhash_backup(str(backup), str(output))

if __name__ == "__main__":
    main()

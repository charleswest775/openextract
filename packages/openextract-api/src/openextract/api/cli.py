"""CLI entry point: openextract serve"""
from __future__ import annotations

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(
        prog="openextract",
        description="OpenExtract API server",
    )
    subparsers = parser.add_subparsers(dest="command")

    # serve
    serve_parser = subparsers.add_parser("serve", help="Start the API server")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8000)
    serve_parser.add_argument("--reload", action="store_true", help="Hot reload (dev mode)")
    serve_parser.add_argument(
        "--cors-origin",
        dest="cors_origins",
        action="append",
        default=None,
        help="Allowed CORS origin (repeat for multiple). Default: *",
    )

    # discover
    discover_parser = subparsers.add_parser("discover", help="Discover backups and print paths")
    discover_parser.add_argument("--path", default=None, help="Custom search path")

    args = parser.parse_args()

    if args.command == "serve":
        import uvicorn
        from .server import create_app

        app = create_app(cors_origins=args.cors_origins)
        print(f"\n  OpenExtract API starting on http://{args.host}:{args.port}")
        print(f"  Docs: http://{args.host}:{args.port}/docs\n")
        uvicorn.run(
            app if not args.reload else "openextract.api.server:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
        )

    elif args.command == "discover":
        import json
        from pathlib import Path
        from openextract.core import discover_backups

        path = Path(args.path) if args.path else None
        backups = discover_backups(path)
        if not backups:
            print("No backups found.")
            sys.exit(0)
        for b in backups:
            print(json.dumps({
                "udid": b.udid,
                "path": str(b.path),
                "device_name": b.device_name,
                "ios_version": b.ios_version,
                "is_encrypted": b.is_encrypted,
                "size_gb": round(b.size_bytes / 1e9, 2),
            }, indent=2))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
generate_session_qr.py — Generate TELEGRAM_STRING_SESSION via QR login (Telethon).

Usage:
    pip install telethon qrcode[terminal]
    python generate_session_qr.py

Scan the QR code with the READER Telegram account (a separate account you use
only for reading channels — not your main account).

The session string is printed to stdout only — never saved to a file.
"""

import asyncio
import os
import sys


def print_qr_terminal(url: str) -> None:
    """Render QR code in terminal, fallback to plain URL if qrcode not installed."""
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        # Print with inverted colours so it looks right on dark terminals
        qr.print_tty()
    except ImportError:
        print("(Install 'qrcode[terminal]' to render the QR code inline)\n")

    print(f"\nOr open this link on your phone:\n{url}\n")


async def main() -> None:
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        from telethon.errors import SessionPasswordNeededError
    except ImportError:
        print("Telethon is not installed. Run:\n  pip install telethon qrcode[terminal]")
        sys.exit(1)

    print("=== Telegram QR Session Generator ===\n")
    print("This creates a session for the READER account (not your main account).\n")

    api_id_str = os.environ.get("TELEGRAM_API_ID") or input("TELEGRAM_API_ID: ").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH") or input("TELEGRAM_API_HASH: ").strip()

    try:
        api_id = int(api_id_str)
    except ValueError:
        print("Error: TELEGRAM_API_ID must be a number.")
        sys.exit(1)

    # StringSession("") — in-memory only, nothing written to disk
    client = TelegramClient(StringSession(""), api_id, api_hash)

    await client.connect()

    if await client.is_user_authorized():
        print("Already authorized! Getting session string...")
        session_string = client.session.save()
        await client.disconnect()
        _print_result(session_string)
        return

    print("Starting QR login...\n")
    print("Open Telegram on the READER account → Settings → Devices → Link Desktop Device")
    print("(or Scan QR Code) and scan the code below:\n")

    qr_login = await client.qr_login()
    print_qr_terminal(qr_login.url)

    # Refresh loop — QR tokens expire every ~30 s
    async def refresh_loop() -> None:
        while True:
            await asyncio.sleep(25)
            try:
                await qr_login.recreate()
                print("\n[QR refreshed — scan the new code]\n")
                print_qr_terminal(qr_login.url)
            except Exception:
                break

    refresh_task = asyncio.create_task(refresh_loop())

    try:
        await qr_login.wait()
        refresh_task.cancel()
    except SessionPasswordNeededError:
        refresh_task.cancel()
        password = input("\n2FA password for this account: ")
        await client.sign_in(password=password)
    except asyncio.CancelledError:
        pass

    session_string = client.session.save()
    await client.disconnect()
    _print_result(session_string)


def _print_result(session_string: str) -> None:
    bar = "=" * 60
    print(f"\n{bar}")
    print("✅  Login successful!\n")
    print("Add this to Railway Variables as TELEGRAM_STRING_SESSION:\n")
    print(session_string)
    print(f"\n{bar}")
    print("The session string was NOT saved to any file.")
    print("Copy it now and paste into Railway → Variables → TELEGRAM_STRING_SESSION")


if __name__ == "__main__":
    asyncio.run(main())

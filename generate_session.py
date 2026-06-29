"""
Telethon string session generator for TON News Bot.

Usage:
    pip install telethon
    python generate_session.py

IMPORTANT — use the SEPARATE READER account:
    Log in with the separate Telegram READER account created only for this
    bot (the one that reads source channels), NOT your main personal account.
    The reader account only needs to join/read the source channels listed in
    artifacts/api-server/src/config/sources.json. It never publishes anything.

The generated TELEGRAM_STRING_SESSION value is ONLY printed to stdout — it is
never written to any file. Copy it manually into your Railway (or .env)
environment variables. Never commit the session string to version control.
"""

import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    print("=== TON News Bot — Telegram String Session Generator ===")
    print("Log in with the SEPARATE READER account (not your main account).\n")

    api_id_raw = input("Enter TELEGRAM_API_ID (integer): ").strip()
    if not api_id_raw.isdigit():
        print("Error: API_ID must be an integer.")
        return
    api_id = int(api_id_raw)

    api_hash = input("Enter TELEGRAM_API_HASH: ").strip()
    if not api_hash:
        print("Error: API_HASH cannot be empty.")
        return

    phone = input("Enter the READER account's phone number (international, e.g. +79001234567): ").strip()
    if not phone:
        print("Error: Phone number cannot be empty.")
        return

    print("\nConnecting to Telegram...")

    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        await client.start(phone=phone)
        session_string = client.session.save()

    print("\n" + "=" * 60)
    print("SUCCESS! Your TELEGRAM_STRING_SESSION value:")
    print("=" * 60)
    print(session_string)
    print("=" * 60)
    print("\nCopy the value above and set it as an environment variable:")
    print("  Railway: Settings → Variables → TELEGRAM_STRING_SESSION")
    print("  Local:   add to your .env file")
    print("\nKeep this value secret — it grants full access to the reader Telegram account.")
    print("It was NOT saved to any file. Paste it manually into Railway Variables only.")


if __name__ == "__main__":
    asyncio.run(main())

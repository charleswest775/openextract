"""
Who the backup shows you in touch with: a port of the app's People merge.

The app's People screen groups messages, WhatsApp chats, calls and voicemail into
people in TypeScript (src/components/people/gather.ts, with src/lib/people.ts). A data
bundle's people.json is made here, in the engine, so these are the same rules in
Python. One fixture, python/tests/fixtures/people-merge.json, is run by both
python/tests/test_people_merge.py and scripts/people-merge.test.mjs, so the two can't
drift: change a rule in both files and in the fixture.

Entries are shaped like the app's Timeline entries, with its field names, so the
fixture serves both::

    {"type": "message" | "whatsapp" | "call" | "voicemail",
     "contactName": str | None, "contactIdentifier": str | None, "timestamp": str,
     "message": {"isGroup": bool, "chatId": int},                       # messages
     "whatsapp": {"chatType": "individual" | "group" | ..., "chatId": int}}  # WhatsApp

and so are the people: ``key``, ``name``, ``identifier``, ``ids`` and ``numbers``
(sorted lists here, Sets there), ``counts``, ``total``, ``last``, ``isGroup``, and
``chatId``, ``waChatId``, ``waChatType`` when known.
"""

import re
import unicodedata
from typing import Optional

PERSON_KINDS = ("message", "whatsapp", "call", "voicemail")

# A WhatsApp chat's own address, e.g. "120363…@g.us" for a group (src/lib/people.ts)
_WHATSAPP_ADDRESS = re.compile(r"@(?:s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)\Z", re.IGNORECASE)
# Only ASCII digits, as JavaScript's \d
_NOT_DIGIT = re.compile(r"[^0-9]")
_LOOKS_LIKE_A_NUMBER = re.compile(r"[+0-9\s().-]+")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_TEAM_ID = re.compile(r"^[A-Z0-9]{10}\.")


def is_whatsapp_address(identifier: Optional[str]) -> bool:
    return bool(identifier) and bool(_WHATSAPP_ADDRESS.search(identifier.strip()))


def norm_phone(s: str) -> str:
    """The last 10 digits, so one number written many ways compares equal (normPhone)."""
    if is_whatsapp_address(s):
        return ""
    digits = _NOT_DIGIT.sub("", s)
    return digits[-10:] if len(digits) >= 10 else digits


def id_key(identifier: str) -> str:
    """One form of a number or address for comparing (idKey)."""
    digits = norm_phone(identifier)
    return digits if len(digits) >= 7 else identifier.strip().lower()


def _person_key(name: str) -> str:
    digits = norm_phone(name)
    return digits if _LOOKS_LIKE_A_NUMBER.fullmatch(name) and len(digits) >= 7 else name.strip().lower()


def _locale_key(name: str):
    """A sort key close to JavaScript's localeCompare: letters first without case or
    accents, then accents, then lower case before upper case."""
    decomposed = unicodedata.normalize("NFD", name)
    base = "".join(c for c in decomposed if not unicodedata.combining(c))
    accents = "".join(c for c in decomposed if unicodedata.combining(c))
    return (base.casefold(), accents, name.swapcase())


def _new_person(key: str, e: dict) -> dict:
    return {
        "key": key, "name": e.get("contactName") or e["contactIdentifier"], "identifier": e["contactIdentifier"],
        "ids": set(), "numbers": set(),
        "counts": {kind: 0 for kind in PERSON_KINDS}, "total": 0, "last": "",
        "isGroup": False,
    }


def _tally(p: dict, e: dict) -> None:
    identifier = e["contactIdentifier"]
    p["ids"].add(id_key(identifier))
    # A WhatsApp group's address isn't a number to search by
    if not is_whatsapp_address(identifier):
        p["numbers"].add(identifier)
    # "count" (Python only): one entry standing for that many alike, e.g. a whole
    # conversation's messages, so a big backup needn't hold an entry per message.
    # The same as that many entries with its timestamp as the latest.
    n = int(e.get("count", 1))
    p["counts"][e["type"]] += n
    p["total"] += n
    if (e.get("timestamp") or "") > p["last"]:
        p["last"] = e["timestamp"]
    message = e.get("message") or {}
    if message.get("isGroup"):
        p["isGroup"] = True
    if message.get("chatId") is not None and p.get("chatId") is None:
        p["chatId"] = message["chatId"]
    whatsapp = e.get("whatsapp")
    if whatsapp:
        # Broadcast lists and channels aren't a person either: they're listed with the groups
        if whatsapp.get("chatType") != "individual":
            p["isGroup"] = True
        if p.get("waChatId") is None:
            p["waChatId"] = whatsapp.get("chatId")
            p["waChatType"] = whatsapp.get("chatType")


def _sorted(by_key: dict) -> list:
    """Most in touch first, then by name."""
    people = sorted(by_key.values(), key=lambda p: _locale_key(p["name"]))
    return sorted(people, key=lambda p: -p["total"])


def gather_people(entries: list, cards: Optional[list] = None) -> list:
    """Everyone the entries are with, most in touch first (gatherPeople).

    Texts, calls and voicemail are one person per name, as the address book names
    them. A WhatsApp chat goes by its address: a group, broadcast list or channel is
    its own entry, and a one-to-one chat joins whoever already has its number (on
    their texts, calls, voicemail or card), or else is a person of its own.
    ``cards`` are list_contacts cards ({id, phones, emails}).
    """
    cards = cards or []
    by_key: dict = {}

    def into(key: str, e: dict) -> None:
        p = by_key.get(key)
        if p is None:
            p = by_key[key] = _new_person(key, e)
        _tally(p, e)

    whatsapp = []
    for e in entries:
        if e.get("type") not in PERSON_KINDS or not e.get("contactIdentifier"):
            continue
        if e["type"] == "whatsapp":
            whatsapp.append(e)
        else:
            into(_person_key(e.get("contactName") or e["contactIdentifier"]), e)
    if not whatsapp:
        return _sorted(by_key)

    # Who has each number already, and which card each number is on (the card read last)
    holder: dict = {}
    for p in by_key.values():
        if p["isGroup"]:
            continue
        for i in p["ids"]:
            holder.setdefault(i, p)
    card_of: dict = {}
    for c in cards:
        for i in list(c.get("phones") or []) + list(c.get("emails") or []):
            card_of[id_key(i)] = c

    def whatsapp_key(e: dict) -> str:
        i = id_key(e["contactIdentifier"])
        chat = e.get("whatsapp")
        if is_whatsapp_address(e["contactIdentifier"]) or (chat and chat.get("chatType") != "individual"):
            return f"wa:{i}"
        known = holder.get(i)
        if known:
            return known["key"]
        card = card_of.get(i)
        if not card:
            return f"wa:{i}"
        for other in list(card.get("phones") or []) + list(card.get("emails") or []):
            p = holder.get(id_key(other))
            if p:
                return p["key"]
        # Only on WhatsApp, with one card: its numbers are one person
        return f"wa-card:{card['id']}"

    for e in whatsapp:
        into(whatsapp_key(e), e)
    return _sorted(by_key)


def link_cards(people: list, cards: list) -> dict:
    """Which card belongs to which person (linkCards): person key → card id."""
    person_by_id: dict = {}
    for p in people:
        if p["isGroup"]:
            continue
        for i in p["ids"]:
            person_by_id.setdefault(i, p)
    card_of: dict = {}
    for c in cards:
        for i in list(c.get("phones") or []) + list(c.get("emails") or []):
            p = person_by_id.get(id_key(i))
            if p is not None:
                card_of.setdefault(p["key"], c["id"])
    return card_of


def plain(person: dict) -> dict:
    """A person as JSON: ids and numbers as sorted lists."""
    return {**person, "ids": sorted(person["ids"]), "numbers": sorted(person["numbers"])}


# ── Engine records as entries, as the app's Timeline makes them (useTimeline.ts) ──

def _app_name(bundle_id: str) -> str:
    """"T84QZS65DQ.com.facebook.Facebook" → "Facebook" (appDisplayName)."""
    parts = _TEAM_ID.sub("", bundle_id).split(".")
    return parts[-1] or bundle_id


def message_entry(conversation: dict, timestamp: str) -> dict:
    """A message in a conversation (normalizeMessage)."""
    return {
        "type": "message",
        "timestamp": timestamp,
        "contactName": conversation.get("display_name") or conversation.get("chat_identifier"),
        "contactIdentifier": conversation.get("chat_identifier"),
        "message": {"isGroup": bool(conversation.get("is_group")), "chatId": conversation.get("chat_id")},
    }


def call_entry(call: dict, timestamp: str) -> dict:
    """A call (normalizeCall): FaceTime's UUID addresses aren't anyone's number."""
    address = call.get("address") or ""
    is_uuid = bool(_UUID.match(address))
    contact = call.get("contact_name") or ""
    real_name = contact if contact and not _UUID.match(contact) else None
    name = real_name or (_app_name(call["app"]) if is_uuid and call.get("app") else None) or (
        address if not is_uuid else None)
    return {
        "type": "call",
        "timestamp": timestamp,
        "contactName": name,
        "contactIdentifier": None if is_uuid else address,
    }


def voicemail_entry(voicemail: dict, timestamp: str) -> dict:
    """A voicemail (normalizeVoicemail)."""
    return {
        "type": "voicemail",
        "timestamp": timestamp,
        "contactName": voicemail.get("contact_name") or voicemail.get("phone_number"),
        "contactIdentifier": voicemail.get("phone_number"),
    }

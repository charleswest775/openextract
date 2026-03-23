"""Communication pattern analysis: relationship graph and activity patterns."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from openextract.core.models import Conversation, Message

from .models import ActivityPattern, ContactSummary, RelationshipGraph


def build_relationship_graph(
    conversations: list[Conversation],
    messages_by_chat: dict[int, list[Message]],
) -> RelationshipGraph:
    """Compute per-contact stats from all messages."""
    contact_stats: dict[str, dict] = defaultdict(lambda: {
        "messages_sent": 0,
        "messages_received": 0,
        "first_contact": None,
        "last_contact": None,
        "response_gaps": [],
        "lengths": [],
        "display_name": None,
    })

    total_messages = 0

    for convo in conversations:
        chat_messages = messages_by_chat.get(convo.id, [])

        # Map participant identifier → display name
        name_map = dict(zip(convo.participants, convo.participant_names))

        prev_msg: Message | None = None
        for msg in sorted(chat_messages, key=lambda m: m.timestamp):
            total_messages += 1
            for participant in convo.participants:
                stats = contact_stats[participant]
                if stats["display_name"] is None:
                    stats["display_name"] = name_map.get(participant)

                is_sender = msg.sender == participant

                if is_sender:
                    stats["messages_sent"] += 1
                else:
                    stats["messages_received"] += 1

                if stats["first_contact"] is None or msg.timestamp < stats["first_contact"]:
                    stats["first_contact"] = msg.timestamp
                if stats["last_contact"] is None or msg.timestamp > stats["last_contact"]:
                    stats["last_contact"] = msg.timestamp

                if msg.text:
                    stats["lengths"].append(len(msg.text))

            # Response time: time between consecutive non-self messages
            if (
                prev_msg is not None
                and msg.is_from_me != prev_msg.is_from_me
                and prev_msg.timestamp
            ):
                gap = (msg.timestamp - prev_msg.timestamp).total_seconds()
                if 0 < gap < 86400:  # ignore gaps > 24h
                    for participant in convo.participants:
                        if msg.sender == participant:
                            contact_stats[participant]["response_gaps"].append(gap)

            prev_msg = msg

    summaries = []
    for identifier, stats in contact_stats.items():
        gaps = stats["response_gaps"]
        lengths = stats["lengths"]
        summaries.append(
            ContactSummary(
                identifier=identifier,
                display_name=stats["display_name"],
                messages_sent=stats["messages_sent"],
                messages_received=stats["messages_received"],
                total_messages=stats["messages_sent"] + stats["messages_received"],
                first_contact=stats["first_contact"],
                last_contact=stats["last_contact"],
                avg_response_seconds=sum(gaps) / len(gaps) if gaps else None,
                avg_message_length=sum(lengths) / len(lengths) if lengths else 0.0,
            )
        )

    # Sort by total interaction volume
    summaries.sort(key=lambda s: s.total_messages, reverse=True)

    all_timestamps = [
        m.timestamp
        for msgs in messages_by_chat.values()
        for m in msgs
        if m.timestamp
    ]

    return RelationshipGraph(
        contacts=summaries,
        total_conversations=len(conversations),
        total_messages=total_messages,
        date_range_start=min(all_timestamps) if all_timestamps else None,
        date_range_end=max(all_timestamps) if all_timestamps else None,
    )


def build_activity_patterns(
    messages_by_chat: dict[int, list[Message]],
) -> ActivityPattern:
    """Compute hour-of-day, day-of-week, monthly, and daily message frequency."""
    hour_counts: dict[int, int] = defaultdict(int)
    dow_counts: dict[int, int] = defaultdict(int)
    month_counts: dict[int, int] = defaultdict(int)
    daily_counts: dict[str, int] = defaultdict(int)

    for messages in messages_by_chat.values():
        for msg in messages:
            if not msg.timestamp:
                continue
            ts = msg.timestamp
            hour_counts[ts.hour] += 1
            dow_counts[ts.weekday()] += 1
            month_counts[ts.month] += 1
            daily_counts[ts.date().isoformat()] += 1

    return ActivityPattern(
        hour_of_day=dict(hour_counts),
        day_of_week=dict(dow_counts),
        month_of_year=dict(month_counts),
        daily_counts=dict(daily_counts),
    )

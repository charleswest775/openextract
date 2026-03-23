"""Timeline construction and topic clustering."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from math import log

from openextract.core.models import Conversation, Message, Note

from .models import (
    ConversationCluster,
    TimelineEvent,
    Topic,
    TopicAnalysis,
)

# Common English stop words to ignore in topic detection
_STOP_WORDS = frozenset(
    "i me my myself we our ours ourselves you your yours yourself he him his "
    "himself she her hers herself it its itself they them their theirs "
    "what which who whom this that these those am is are was were be been "
    "being have has had having do does did doing a an the and but if or "
    "because as until while of at by for with about against between through "
    "during before after above below to from up down in out on off over "
    "under again further then once here there when where why how all both "
    "each few more most other some such no nor not only own same so than "
    "too very s t can will just don should now d ll m o re ve y ain aren "
    "couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan "
    "shouldn wasn weren won wouldn ok yeah yes no hi hey lol ok okay "
    "actually really just like get got go going yeah yep nope".split()
)


def _tokenize(text: str) -> list[str]:
    """Simple word tokenizer."""
    words = re.findall(r"\b[a-z]{3,}\b", text.lower())
    return [w for w in words if w not in _STOP_WORDS]


def _tfidf_keywords(
    doc_tokens: list[str],
    all_docs: list[list[str]],
    top_n: int = 8,
) -> list[str]:
    """Extract top-n keywords from a document using TF-IDF."""
    if not doc_tokens:
        return []

    tf = Counter(doc_tokens)
    total = len(doc_tokens)
    n_docs = len(all_docs)

    scored: dict[str, float] = {}
    for word, count in tf.items():
        tf_score = count / total
        doc_freq = sum(1 for d in all_docs if word in d)
        idf_score = log((1 + n_docs) / (1 + doc_freq)) + 1
        scored[word] = tf_score * idf_score

    return sorted(scored, key=scored.get, reverse=True)[:top_n]  # type: ignore[arg-type]


def _label_topic(keywords: list[str]) -> str:
    """Generate a short human-readable label from top keywords."""
    if not keywords:
        return "General"
    # Capitalize first 2-3 keywords
    parts = [w.capitalize() for w in keywords[:2]]
    return " / ".join(parts)


def build_topic_analysis(
    conversations: list[Conversation],
    messages_by_chat: dict[int, list[Message]],
    notes: list[Note] | None = None,
) -> TopicAnalysis:
    """Cluster conversations by topic and identify timeline events."""

    # ── Build per-conversation token bags ──────────────────────────────────
    convo_tokens: dict[int, list[str]] = {}
    for convo in conversations:
        msgs = messages_by_chat.get(convo.id, [])
        tokens = []
        for msg in msgs:
            if msg.text:
                tokens.extend(_tokenize(msg.text))
        convo_tokens[convo.id] = tokens

    all_token_lists = list(convo_tokens.values())

    # ── Global vocabulary → topics ─────────────────────────────────────────
    all_tokens_flat = [t for ts in all_token_lists for t in ts]
    global_freq = Counter(all_tokens_flat)
    top_global = [w for w, _ in global_freq.most_common(200)]

    # Cluster into ~10 topic buckets by dominant keyword co-occurrence
    # (lightweight approach: sort convos by their top keyword, group by it)
    convo_primary: dict[int, str] = {}
    for cid, tokens in convo_tokens.items():
        if not tokens:
            continue
        kws = _tfidf_keywords(tokens, all_token_lists, top_n=1)
        if kws:
            convo_primary[cid] = kws[0]

    # Group conversations by primary keyword → form topic clusters
    keyword_convos: dict[str, list[int]] = defaultdict(list)
    for cid, kw in convo_primary.items():
        keyword_convos[kw].append(cid)

    # Merge small clusters
    topics_raw: list[tuple[str, list[int]]] = sorted(
        keyword_convos.items(), key=lambda x: len(x[1]), reverse=True
    )[:15]

    # ── Build Topic objects ────────────────────────────────────────────────
    topics: list[Topic] = []
    convo_map = {c.id: c for c in conversations}

    for primary_kw, cids in topics_raw:
        combined_tokens = [t for cid in cids for t in convo_tokens.get(cid, [])]
        keywords = _tfidf_keywords(combined_tokens, all_token_lists, top_n=8)
        if not keywords:
            continue

        msg_count = sum(
            len(messages_by_chat.get(cid, [])) for cid in cids
        )

        # Representative phrases: longest unique text snippets containing primary kw
        phrases: list[str] = []
        for cid in cids[:3]:
            for msg in messages_by_chat.get(cid, [])[:50]:
                if msg.text and primary_kw in msg.text.lower() and len(msg.text) > 20:
                    phrases.append(msg.text[:120])
                    if len(phrases) >= 3:
                        break

        timestamps = [
            msg.timestamp
            for cid in cids
            for msg in messages_by_chat.get(cid, [])
            if msg.timestamp
        ]

        topics.append(
            Topic(
                label=_label_topic(keywords),
                keywords=keywords,
                message_count=msg_count,
                representative_phrases=phrases,
                first_seen=min(timestamps) if timestamps else None,
                last_seen=max(timestamps) if timestamps else None,
            )
        )

    # ── Build ConversationCluster objects ──────────────────────────────────
    clusters: list[ConversationCluster] = []
    for convo in conversations:
        msgs = messages_by_chat.get(convo.id, [])
        tokens = convo_tokens.get(convo.id, [])
        primary_topics = _tfidf_keywords(tokens, all_token_lists, top_n=3)
        timestamps = [m.timestamp for m in msgs if m.timestamp]
        clusters.append(
            ConversationCluster(
                conversation_id=convo.id,
                display_name=convo.display_name or (
                    convo.participant_names[0] if convo.participant_names else None
                ),
                primary_topics=primary_topics,
                message_count=len(msgs),
                date_range_start=min(timestamps) if timestamps else None,
                date_range_end=max(timestamps) if timestamps else None,
            )
        )

    # ── Timeline events ────────────────────────────────────────────────────
    timeline_events = _detect_timeline_events(messages_by_chat, conversations)

    return TopicAnalysis(
        topics=topics,
        conversation_clusters=clusters,
        timeline_events=timeline_events,
    )


def _detect_timeline_events(
    messages_by_chat: dict[int, list[Message]],
    conversations: list[Conversation],
) -> list[TimelineEvent]:
    """Detect significant moments in communication history."""
    events: list[TimelineEvent] = []

    # Daily message counts
    daily: dict[str, int] = defaultdict(int)
    for msgs in messages_by_chat.values():
        for msg in msgs:
            if msg.timestamp:
                daily[msg.timestamp.date().isoformat()] += 1

    if not daily:
        return events

    avg_daily = sum(daily.values()) / len(daily)
    std_daily = (
        sum((v - avg_daily) ** 2 for v in daily.values()) / len(daily)
    ) ** 0.5

    # High-activity bursts: days 2+ std deviations above mean
    for date_str, count in sorted(daily.items()):
        if count > avg_daily + 2 * std_daily and count > 5:
            events.append(
                TimelineEvent(
                    date=datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc),
                    event_type="high_activity",
                    description=f"Unusually active day: {count} messages",
                    magnitude=min((count - avg_daily) / (std_daily + 1) / 5, 1.0),
                )
            )

    # Long silence periods: gaps > 7 days with no messages
    sorted_dates = sorted(daily.keys())
    for i in range(1, len(sorted_dates)):
        prev = datetime.fromisoformat(sorted_dates[i - 1])
        curr = datetime.fromisoformat(sorted_dates[i])
        gap_days = (curr - prev).days
        if gap_days >= 7:
            events.append(
                TimelineEvent(
                    date=prev.replace(tzinfo=timezone.utc),
                    event_type="silence",
                    description=f"{gap_days}-day communication gap",
                    magnitude=min(gap_days / 30, 1.0),
                )
            )

    # New contacts: first time a conversation appears
    convo_map = {c.id: c for c in conversations}
    for convo in sorted(conversations, key=lambda c: c.last_message_at or datetime.min):
        msgs = messages_by_chat.get(convo.id, [])
        if msgs:
            first = min(m.timestamp for m in msgs if m.timestamp)
            name = (
                convo.display_name
                or (convo.participant_names[0] if convo.participant_names else "Unknown")
            )
            events.append(
                TimelineEvent(
                    date=first,
                    event_type="new_contact",
                    description=f"First message with {name}",
                    participants=convo.participants[:3],
                    magnitude=0.3,
                )
            )

    # Sort chronologically
    events.sort(key=lambda e: e.date)
    return events

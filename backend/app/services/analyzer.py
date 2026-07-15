from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

DEFAULT_RULES = [
    ("PASSWORD_RESET", ["password reset", "reset your password", "new password", "비밀번호 재설정"]),
    ("LOGIN_ALERT", ["new sign-in", "login alert", "security alert", "sign in", "새 로그인"]),
    ("SECURITY", ["security", "verification code", "2-step", "authentication", "보안"]),
    ("PAYMENT", ["receipt", "invoice", "payment", "billing", "결제"]),
    ("SUBSCRIPTION", ["subscription", "renewal", "subscription update", "membership", "구독"]),
    ("PURCHASE", ["order confirmed", "order receipt", "purchase", "shipped", "주문"]),
    ("WELCOME_EMAIL", ["welcome", "thanks for signing up", "get started", "가입을 환영"]),
    ("VERIFY_EMAIL", ["verify your email", "confirm your email", "verification", "인증"]),
    ("ACCOUNT_UPDATE", ["account update", "profile updated", "terms updated", "policy", "계정 업데이트"]),
    ("NEWSLETTER", ["newsletter", "weekly", "digest", "unsubscribe", "news"]),
]


def normalize_text(value: str | None) -> str:
    return (value or "").lower()


def extract_domain(address: str | None) -> str:
    if not address or "@" not in address:
        return ""
    return address.split("@")[-1].strip().lower()


def pretty_service_from_domain(domain: str) -> str:
    base = (domain or "").replace("mail.", "").replace("www.", "").split(".")[0]
    return base[:1].upper() + base[1:] if base else "Unknown"


def activity_signal_for(mail_type: str) -> str:
    return {
        "LOGIN_ALERT": "HIGH",
        "PASSWORD_RESET": "HIGH",
        "PURCHASE": "HIGH",
        "PAYMENT": "HIGH",
        "SECURITY": "MEDIUM",
        "SUBSCRIPTION": "MEDIUM",
        "ACCOUNT_UPDATE": "MEDIUM",
        "VERIFY_EMAIL": "LOW",
        "WELCOME_EMAIL": "LOW",
        "NEWSLETTER": "NONE",
        "UNKNOWN": "UNKNOWN",
    }.get(mail_type, "UNKNOWN")


def parse_message_date(message: dict[str, Any]) -> str | None:
    if message.get("sentAt"):
        return message.get("sentAt")
    if message.get("date"):
        return message.get("date")
    return None


def classify_mail(message: dict[str, Any], enabled_rules: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    sender = message.get("sender") or message.get("from") or ""
    subject = message.get("subject") or ""
    snippet = message.get("snippet") or ""
    haystack = normalize_text(f"{subject} {snippet} {sender}")
    domain = extract_domain(sender)

    rules = enabled_rules or [{"mail_type": t, "pattern": " | ".join(signals)} for t, signals in DEFAULT_RULES]
    mail_type = "UNKNOWN"
    matched_rule = None

    for rule in rules:
        rule_type = rule.get("mail_type") or "UNKNOWN"
        pattern = rule.get("pattern") or ""
        candidates = [part.strip() for part in pattern.split("|") if part.strip()]
        if any(normalize_text(candidate) in haystack for candidate in candidates):
            mail_type = rule_type if rule_type in {r[0] for r in DEFAULT_RULES} else "UNKNOWN"
            matched_rule = rule.get("name") or pattern
            break

    return {
        "type": mail_type,
        "activitySignal": activity_signal_for(mail_type),
        "domain": domain,
        "sender": sender,
        "subject": subject,
        "sentAt": parse_message_date(message),
        "matchedRule": matched_rule or (mail_type if mail_type != "UNKNOWN" else None),
        "messageId": message.get("message_id") or message.get("id"),
    }


def normalize_service(domain: str) -> dict[str, str]:
    safe_domain = (domain or "").lower()
    return {
        "canonical_service_name": pretty_service_from_domain(safe_domain),
        "primary_domain": safe_domain,
        "service_key": safe_domain or pretty_service_from_domain(safe_domain).lower(),
    }


def score_service(messages: list[dict[str, Any]]) -> dict[str, Any]:
    timestamps = sorted([m.get("sentAt") for m in messages if m.get("sentAt")])
    first_seen = timestamps[0] if timestamps else None
    last_seen = timestamps[-1] if timestamps else None

    activity_score = 0
    confidence = 0
    mail_frequency = len(messages)
    reasons: list[str] = []
    signal_counts: dict[str, int] = {}

    for message in messages:
        confidence += 5 if message["type"] == "UNKNOWN" else 15
        signal = message["activitySignal"]
        signal_counts[message["type"]] = signal_counts.get(message["type"], 0) + 1
        if signal == "HIGH":
            activity_score += 30
        elif signal == "MEDIUM":
            activity_score += 15
        elif signal == "LOW":
            activity_score += 6

    if any(m["type"] == "LOGIN_ALERT" for m in messages):
        reasons.append("최근 로그인 알림 메일 발견")
    if any(m["type"] == "PASSWORD_RESET" for m in messages):
        reasons.append("비밀번호 재설정 메일 발견")
    if any(m["type"] == "PAYMENT" for m in messages):
        reasons.append("결제/청구 메일 발견")
    if any(m["type"] == "PURCHASE" for m in messages):
        reasons.append("구매 확인 메일 발견")
    if any(m["type"] == "NEWSLETTER" for m in messages):
        reasons.append("뉴스레터만 지속 수신")

    if last_seen:
        parsed = _parse_iso(last_seen)
        age_days = (datetime.now(timezone.utc) - parsed).days
        if age_days > 365:
            reasons.append(f"최근 {age_days}일 활동 없음")
            activity_score -= 18
        if age_days > 730:
            activity_score -= 12
    else:
        reasons.append("마지막 활동 시점이 없음")

    if mail_frequency == 1:
        reasons.append("메일 수가 매우 적음")
    elif mail_frequency >= 5:
        reasons.append(f"관련 메일 {mail_frequency}건 확인")

    return {
        "activity_score": max(0, min(100, round(activity_score))),
        "confidence": max(0, min(100, round(confidence))),
        "mail_frequency": mail_frequency,
        "first_seen_at": first_seen,
        "last_seen_at": last_seen,
        "reasons": reasons,
        "signal_breakdown": signal_counts,
    }


def recommend_service(score: dict[str, Any], threshold: int = 60) -> str:
    if not score.get("mail_frequency"):
        return "UNKNOWN"
    if score["activity_score"] >= 70 and score["confidence"] >= 50:
        return "KEEP"
    if score["activity_score"] >= threshold or score["confidence"] >= 40:
        return "REVIEW"
    return "LIKELY_UNUSED"


def build_service_candidates(classified_mails: list[dict[str, Any]], threshold: int = 60) -> list[dict[str, Any]]:
    service_map: dict[str, list[dict[str, Any]]] = {}
    for mail in classified_mails:
        if mail["type"] in {"NEWSLETTER", "UNKNOWN"}:
            continue
        normalized = normalize_service(mail["domain"])
        service_key = normalized["service_key"]
        service_map.setdefault(service_key, [])
        service_map[service_key].append(mail)

    services = []
    for service_key, mails in service_map.items():
        score = score_service(mails)
        services.append({
            "service_key": service_key,
            "canonical_service_name": normalize_service(mails[0]["domain"])["canonical_service_name"],
            "primary_domain": mails[0]["domain"],
            "category": None,
            **score,
            "status": recommend_service(score, threshold),
            "evidence": mails,
        })

    return sorted(services, key=lambda item: item["activity_score"], reverse=True)


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

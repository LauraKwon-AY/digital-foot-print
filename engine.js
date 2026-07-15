const MailType = Object.freeze({
  WELCOME_EMAIL: 'WELCOME_EMAIL',
  VERIFY_EMAIL: 'VERIFY_EMAIL',
  LOGIN_ALERT: 'LOGIN_ALERT',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PURCHASE: 'PURCHASE',
  PAYMENT: 'PAYMENT',
  SUBSCRIPTION: 'SUBSCRIPTION',
  NEWSLETTER: 'NEWSLETTER',
  SECURITY: 'SECURITY',
  ACCOUNT_UPDATE: 'ACCOUNT_UPDATE',
  UNKNOWN: 'UNKNOWN',
});

const ActivitySignal = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  NONE: 'NONE',
  UNKNOWN: 'UNKNOWN',
});

const RecommendationStatus = Object.freeze({
  KEEP: 'KEEP',
  REVIEW: 'REVIEW',
  LIKELY_UNUSED: 'LIKELY_UNUSED',
  UNKNOWN: 'UNKNOWN',
});

const RULES = [
  { type: MailType.PASSWORD_RESET, signals: ['password reset', 'reset your password', 'new password', '비밀번호 재설정'] },
  { type: MailType.LOGIN_ALERT, signals: ['new sign-in', 'login alert', 'security alert', 'sign in', '새 로그인'] },
  { type: MailType.SECURITY, signals: ['security', 'verification code', '2-step', 'authentication', '보안'] },
  { type: MailType.PAYMENT, signals: ['receipt', 'invoice', 'payment', 'billing', '결제'] },
  { type: MailType.SUBSCRIPTION, signals: ['subscription', 'renewal', 'subscription update', 'membership', '구독'] },
  { type: MailType.PURCHASE, signals: ['order confirmed', 'order receipt', 'purchase', 'shipped', '주문'] },
  { type: MailType.WELCOME_EMAIL, signals: ['welcome', 'thanks for signing up', 'get started', '가입을 환영'] },
  { type: MailType.VERIFY_EMAIL, signals: ['verify your email', 'confirm your email', 'verification', '인증'] },
  { type: MailType.ACCOUNT_UPDATE, signals: ['account update', 'profile updated', 'terms updated', 'policy', '계정 업데이트'] },
  { type: MailType.NEWSLETTER, signals: ['newsletter', 'weekly', 'digest', 'unsubscribe', 'news'] },
];

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function headerValue(message, name) {
  const headers = message?.payload?.headers || [];
  const header = headers.find(h => String(h.name).toLowerCase() === String(name).toLowerCase());
  return header?.value || '';
}

function extractDomain(address) {
  const match = String(address || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match ? match[1].toLowerCase() : '';
}

function prettyServiceFromDomain(domain) {
  const base = String(domain || '')
    .replace(/^mail\./, '')
    .replace(/^www\./, '')
    .split('.')[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Unknown';
}

function activitySignalFor(type) {
  const map = {
    [MailType.LOGIN_ALERT]: ActivitySignal.HIGH,
    [MailType.PASSWORD_RESET]: ActivitySignal.HIGH,
    [MailType.PURCHASE]: ActivitySignal.HIGH,
    [MailType.PAYMENT]: ActivitySignal.HIGH,
    [MailType.SECURITY]: ActivitySignal.MEDIUM,
    [MailType.SUBSCRIPTION]: ActivitySignal.MEDIUM,
    [MailType.ACCOUNT_UPDATE]: ActivitySignal.MEDIUM,
    [MailType.VERIFY_EMAIL]: ActivitySignal.LOW,
    [MailType.WELCOME_EMAIL]: ActivitySignal.LOW,
    [MailType.NEWSLETTER]: ActivitySignal.NONE,
    [MailType.UNKNOWN]: ActivitySignal.UNKNOWN,
  };
  return map[type] || ActivitySignal.UNKNOWN;
}

function classifyMail(message) {
  const from = headerValue(message, 'From');
  const subject = headerValue(message, 'Subject');
  const snippet = message?.snippet || '';
  const domain = extractDomain(from);
  const haystack = normalizeText(`${subject} ${snippet} ${from}`);

  const matched = RULES.find(rule => rule.signals.some(signal => haystack.includes(normalizeText(signal))));
  const mailType = matched?.type || MailType.UNKNOWN;

  return {
    type: mailType,
    activitySignal: activitySignalFor(mailType),
    domain,
    sender: from,
    subject,
    sentAt: message?.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
  };
}

function normalizeService(domain) {
  const safeDomain = String(domain || '').toLowerCase();
  const serviceName = prettyServiceFromDomain(safeDomain);
  return {
    canonicalServiceName: serviceName,
    primaryDomain: safeDomain,
    serviceKey: safeDomain || serviceName.toLowerCase(),
  };
}

function scoreService(messages) {
  const timestamps = messages.map(m => m.sentAt).filter(Boolean).sort();
  const firstSeen = timestamps[0] || null;
  const lastSeen = timestamps[timestamps.length - 1] || null;

  let activityScore = 0;
  let confidence = 0;
  const mailFrequency = messages.length;

  for (const message of messages) {
    confidence += message.type === MailType.UNKNOWN ? 5 : 15;
    if (message.activitySignal === ActivitySignal.HIGH) activityScore += 30;
    else if (message.activitySignal === ActivitySignal.MEDIUM) activityScore += 15;
    else if (message.activitySignal === ActivitySignal.LOW) activityScore += 6;
  }

  if (lastSeen) {
    const ageMonths = (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    if (ageMonths > 12) activityScore -= 18;
    if (ageMonths > 24) activityScore -= 12;
  }

  return {
    activityScore: clamp(Math.round(activityScore), 0, 100),
    confidence: clamp(Math.round(confidence), 0, 100),
    mailFrequency,
    firstSeen,
    lastSeen,
  };
}

function recommendService({ activityScore, confidence, mailFrequency, firstSeen, lastSeen }) {
  const hasMeaningfulSignal = activityScore >= 70 && confidence >= 50;
  const hasSomeSignal = activityScore >= 40 || confidence >= 40;
  const hasData = Boolean(firstSeen || lastSeen || mailFrequency > 0);

  if (!hasData) return RecommendationStatus.UNKNOWN;
  if (hasMeaningfulSignal) return RecommendationStatus.KEEP;
  if (hasSomeSignal) return RecommendationStatus.REVIEW;
  return RecommendationStatus.LIKELY_UNUSED;
}

function buildServiceCandidates(classifiedMails) {
  const serviceMap = new Map();

  for (const mail of classifiedMails) {
    if (mail.type === MailType.NEWSLETTER || mail.type === MailType.UNKNOWN) continue;
    const normalized = normalizeService(mail.domain);
    if (!serviceMap.has(normalized.serviceKey)) {
      serviceMap.set(normalized.serviceKey, {
        ...normalized,
        messages: [],
      });
    }
    serviceMap.get(normalized.serviceKey).messages.push(mail);
  }

  return [...serviceMap.values()]
    .map(item => {
      const score = scoreService(item.messages);
      return {
        canonical_service_name: item.canonicalServiceName,
        primary_domain: item.primaryDomain,
        ...score,
        status: recommendService(score),
        evidence_count: item.messages.length,
        signal_breakdown: item.messages.reduce((acc, mail) => {
          acc[mail.type] = (acc[mail.type] || 0) + 1;
          return acc;
        }, {}),
        evidence: item.messages,
      };
    })
    .sort((a, b) => b.activityScore - a.activityScore);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

window.DFMEngine = {
  MailType,
  ActivitySignal,
  RecommendationStatus,
  classifyMail,
  normalizeService,
  scoreService,
  recommendService,
  buildServiceCandidates,
};

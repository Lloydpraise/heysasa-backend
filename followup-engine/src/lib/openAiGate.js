const DEFAULT_MESSAGE = "cant call ai on debug 'openai 429 or 401 error'";

let openAiState = {
  available: true,
  status: null,
  reason: '',
  message: 'OpenAI available',
  lastCheckedAt: null,
  unavailableSince: null,
};

export function getOpenAIAvailabilityState() {
  return {
    available: openAiState.available,
    status: openAiState.status,
    reason: openAiState.reason,
    message: openAiState.message,
    lastCheckedAt: openAiState.lastCheckedAt,
    unavailableSince: openAiState.unavailableSince,
    health: openAiState.available ? 'ok' : 'unavailable',
  };
}

export function shouldPauseOpenAIRequest() {
  return !openAiState.available;
}

export function setOpenAIUnavailable({ status = null, reason = '', message = DEFAULT_MESSAGE } = {}) {
  const nextMessage = message || 'OpenAI Unavailable';
  openAiState = {
    available: false,
    status: status ?? null,
    reason: String(reason || ''),
    message: nextMessage,
    lastCheckedAt: new Date().toISOString(),
    unavailableSince: openAiState.unavailableSince || new Date().toISOString(),
  };
  return getOpenAIAvailabilityState();
}

export function clearOpenAIUnavailable() {
  openAiState = {
    available: true,
    status: null,
    reason: '',
    message: 'OpenAI available',
    lastCheckedAt: new Date().toISOString(),
    unavailableSince: null,
  };
  return getOpenAIAvailabilityState();
}

export async function checkOpenAIAvailability({ force = false } = {}) {
  if (!force && openAiState.available) {
    return getOpenAIAvailabilityState();
  }

  if (!process.env.OPENAI_API_KEY) {
    return setOpenAIUnavailable({
      status: 401,
      reason: 'missing OPENAI_API_KEY',
      message: 'OpenAI Unavailable: missing OPENAI_API_KEY',
    });
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_tokens: 8,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Return only JSON: {"ok":true}' },
          { role: 'user', content: 'ping' },
        ],
      }),
    });

    const bodyText = await res.text().catch(() => '');
    if (res.ok) {
      return clearOpenAIUnavailable();
    }

    const status = Number(res.status);
    if (status === 401 || status === 429 || /insufficient_quota|rate limit|invalid_api_key|billing/i.test(bodyText)) {
      return setOpenAIUnavailable({
        status,
        reason: bodyText.slice(0, 200) || 'OpenAI rejected the request',
        message: DEFAULT_MESSAGE,
      });
    }

    return {
      available: false,
      status,
      reason: bodyText.slice(0, 200) || 'OpenAI healthcheck failed',
      message: 'OpenAI Unavailable',
      lastCheckedAt: new Date().toISOString(),
      unavailableSince: openAiState.unavailableSince || new Date().toISOString(),
      health: 'unavailable',
    };
  } catch (error) {
    const message = String(error?.message || 'healthcheck failed');
    if (/401|429|rate limit|quota|api key|billing|insufficient/i.test(message)) {
      return setOpenAIUnavailable({
        status: /429/.test(message) ? 429 : /401/.test(message) ? 401 : null,
        reason: message,
        message: DEFAULT_MESSAGE,
      });
    }
    return {
      available: false,
      status: null,
      reason: message,
      message: 'OpenAI Unavailable',
      lastCheckedAt: new Date().toISOString(),
      unavailableSince: openAiState.unavailableSince || new Date().toISOString(),
      health: 'unavailable',
    };
  }
}

export interface ResendEmailConfig {
  apiKey: string;
  apiUrl: string;
  timeoutMilliseconds: number;
}

export interface ResendEmailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export async function sendResendEmail(config: ResendEmailConfig, input: ResendEmailInput): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, config.timeoutMilliseconds);

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await getResendErrorMessage(response));
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Resend email API request timed out.');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getResendErrorMessage(response: Response): Promise<string> {
  const fallback = `Resend email API failed with HTTP ${response.status}.`;
  const body = await response.text().catch(() => '');

  if (!body) {
    return fallback;
  }

  try {
    const payload = JSON.parse(body) as { message?: unknown; error?: unknown; name?: unknown };
    const detail = [payload.name, payload.message, payload.error]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(': ');

    return detail ? `${fallback} ${detail}` : fallback;
  } catch {
    return `${fallback} ${body.slice(0, 500)}`;
  }
}

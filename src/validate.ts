export interface PolicyRequest {
  partner_id: string;
  booking_id: string;
  premium: number;
  user: { name: string; email: string };
}

export type Validation = { ok: true; value: PolicyRequest } | { ok: false; errors: string[] };

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function validate(body: unknown): Validation {
  const errors: string[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b.partner_id)) errors.push('partner_id is required');
  if (!isNonEmptyString(b.booking_id)) errors.push('booking_id is required');
  if (typeof b.premium !== 'number' || !Number.isFinite(b.premium) || b.premium <= 0) {
    errors.push('premium must be a positive number');
  }
  const user = b.user as Record<string, unknown> | undefined;
  if (typeof user !== 'object' || user === null || !isNonEmptyString(user.name) || !isNonEmptyString(user.email)) {
    errors.push('user.name and user.email are required');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      partner_id: b.partner_id as string,
      booking_id: b.booking_id as string,
      premium: b.premium as number,
      user: { name: user!.name as string, email: user!.email as string },
    },
  };
}

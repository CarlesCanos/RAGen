export interface Appearance {
  chatBackground: string;
  userBubble: string;
  agentBubble: string;
  textColor: string;
  agentNameColor: string;
  lineHeight: number;
  lineBreakSpacing: number;
  letterSpacing: number;
  fontSize: number;
}

export const defaultAppearance: Appearance = {
  chatBackground: '#0c121d',
  userBubble: '#254b72',
  agentBubble: '#172131',
  textColor: '#edf3fc',
  agentNameColor: '#65d6b4',
  lineHeight: 1.55,
  lineBreakSpacing: 0,
  letterSpacing: 0,
  fontSize: 15,
};

const bounds = {
  lineHeight: [1.2, 2.2],
  lineBreakSpacing: [0, 24],
  letterSpacing: [0, 3],
  fontSize: [12, 24],
} as const;

export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid appearance settings.');
  const input = value as Record<string, unknown>;
  const allowed = new Set(Object.keys(defaultAppearance));
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unknown appearance setting.');
  const result = { ...defaultAppearance };
  for (const key of Object.keys(defaultAppearance) as Array<keyof Appearance>) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (key in bounds) {
      const [min, max] = bounds[key as keyof typeof bounds];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
        throw new Error(`${key} must be between ${min} and ${max}.`);
      }
      (result as unknown as Record<string, string | number>)[key] = raw;
    } else {
      if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) throw new Error(`${key} must be a six-digit hex color.`);
      (result as unknown as Record<string, string | number>)[key] = raw.toLowerCase();
    }
  }
  return result;
}

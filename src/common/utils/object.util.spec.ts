import { definedOnly, mergePatch } from './object.util';

/** Compiled with ES2022+ class fields: undeclared input still leaves an own `undefined` key. */
class SettingsDto {
  requireMfa?: boolean;
  auditRetentionDays?: number | null;
  allowedEmailDomains?: string[];
}

function dto(values: Partial<SettingsDto>): SettingsDto {
  return Object.assign(new SettingsDto(), values);
}

describe('definedOnly', () => {
  it('drops the undefined own properties a DTO instance carries', () => {
    const instance = dto({ auditRetentionDays: 90 });
    expect(Object.keys(instance)).toEqual(
      expect.arrayContaining(['requireMfa', 'allowedEmailDomains']),
    );
    expect(definedOnly(instance)).toEqual({ auditRetentionDays: 90 });
  });

  it('keeps null and falsy values, which are deliberate', () => {
    expect(definedOnly({ a: null, b: false, c: 0, d: '' })).toEqual({
      a: null,
      b: false,
      c: 0,
      d: '',
    });
  });

  it('treats a missing value as an empty patch', () => {
    expect(definedOnly(undefined)).toEqual({});
    expect(definedOnly(null)).toEqual({});
  });
});

describe('mergePatch', () => {
  const stored = {
    requireMfa: true,
    allowedEmailDomains: ['acme.test'],
    auditRetentionDays: 400,
  };

  it('changes only what the patch supplies (the settings-wipe regression)', () => {
    expect(mergePatch(stored, dto({ auditRetentionDays: 90 }))).toEqual({
      requireMfa: true,
      allowedEmailDomains: ['acme.test'],
      auditRetentionDays: 90,
    });
  });

  it('removes a key set to null', () => {
    expect(mergePatch(stored, dto({ auditRetentionDays: null }))).toEqual({
      requireMfa: true,
      allowedEmailDomains: ['acme.test'],
    });
  });

  it('starts from an empty object when nothing is stored', () => {
    expect(mergePatch(null, { requireMfa: false })).toEqual({ requireMfa: false });
  });

  it('does not mutate the stored object', () => {
    const before = { ...stored };
    mergePatch(stored, { requireMfa: false });
    expect(stored).toEqual(before);
  });
});

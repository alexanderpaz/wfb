import { describe, expect, it } from 'vitest';
import { attrValues, buildFilter, cnFromDn, escapeFilterValue } from '../../src/auth/ldap-utils.js';

describe('escapeFilterValue (RFC 4515)', () => {
  it('escapes filter metacharacters', () => {
    expect(escapeFilterValue('a*b(c)d\\e\0')).toBe('a\\2ab\\28c\\29d\\5ce\\00');
  });

  it('leaves normal usernames untouched', () => {
    expect(escapeFilterValue('john.doe-1_ñ')).toBe('john.doe-1_ñ');
  });

  it('neutralises injection payloads in templates', () => {
    expect(buildFilter('(uid={{username}})', '*)(uid=*))(|(uid=*')).toBe(
      '(uid=\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a)',
    );
    expect(buildFilter('(|(uid={{username}})(mail={{username}}))', 'x*')).toBe('(|(uid=x\\2a)(mail=x\\2a))');
  });
});

describe('cnFromDn', () => {
  it('extracts the CN of the first RDN', () => {
    expect(cnFromDn('cn=finance,ou=groups,dc=example,dc=org')).toBe('finance');
    expect(cnFromDn('CN=Domain Users,CN=Users,DC=corp,DC=local')).toBe('Domain Users');
  });

  it('handles escaped characters', () => {
    expect(cnFromDn('cn=Sales\\, EMEA,ou=groups,dc=x')).toBe('Sales, EMEA');
    expect(cnFromDn('cn=R\\2BD,ou=groups,dc=x')).toBe('R+D');
  });

  it('returns null when the first RDN is not a CN', () => {
    expect(cnFromDn('ou=groups,dc=example,dc=org')).toBeNull();
  });
});

describe('attrValues', () => {
  it('normalises strings, arrays and buffers', () => {
    expect(attrValues(undefined)).toEqual([]);
    expect(attrValues('a')).toEqual(['a']);
    expect(attrValues(['a', 'b'])).toEqual(['a', 'b']);
    expect(attrValues([Buffer.from('x')])).toEqual(['x']);
  });
});

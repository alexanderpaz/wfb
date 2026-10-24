/** RFC 4515 escaping of a value placed inside an LDAP search filter. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Replaces every `{{username}}` placeholder of a filter template with the escaped value. */
export function buildFilter(template: string, username: string): string {
  return template.split('{{username}}').join(escapeFilterValue(username));
}

function unescapeDnValue(value: string): string {
  return value
    .replace(/\\([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1')
    .trim();
}

/** `cn=finance,ou=groups,dc=example,dc=org` -> `finance`. Returns null when the first RDN is not a CN. */
export function cnFromDn(dn: string): string | null {
  const match = /^\s*cn\s*=\s*((?:\\.|[^,+])+)/i.exec(dn);
  return match ? unescapeDnValue(match[1]!) || null : null;
}

type AttrValue = Buffer | Buffer[] | string[] | string | undefined;

export function attrValues(value: AttrValue): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v)).filter((v) => v !== '');
}

export function firstAttr(value: AttrValue): string | undefined {
  return attrValues(value)[0];
}

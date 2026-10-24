import type { Entry, SearchOptions } from 'ldapts';
import type { LdapClient } from '../../src/auth/directory.js';

type Attrs = Record<string, string | string[]>;

export interface FakeEntry {
  dn: string;
  password?: string;
  attrs: Attrs;
}

class ResultError extends Error {
  constructor(
    public readonly code: number,
    name: string,
  ) {
    super(name);
    this.name = name;
  }
}

const unescape = (v: string) => v.replace(/\\([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/**
 * In-memory directory understanding the handful of filters the auth module
 * emits: `(attr=value)`, `(|(a=v)(b=v))` and the AD in-chain matching rule.
 * Records every operation for assertions.
 */
export class FakeDirectory {
  entries: FakeEntry[] = [];
  /** user DN -> groups returned by the LDAP_MATCHING_RULE_IN_CHAIN search. */
  nested = new Map<string, string[]>();
  /** userPrincipalName -> password, for AD UPN binds. */
  upns = new Map<string, { password: string }>();
  calls: { op: string; arg?: string; client: number }[] = [];
  unavailable = false;
  private seq = 0;

  add(entry: FakeEntry) {
    this.entries.push(entry);
    return this;
  }

  reset() {
    this.entries = [];
    this.nested.clear();
    this.upns.clear();
    this.calls = [];
    this.unavailable = false;
  }

  filters() {
    return this.calls.filter((c) => c.op === 'search').map((c) => c.arg);
  }

  factory = (): LdapClient => {
    const id = ++this.seq;
    const dir = this;
    const check = () => {
      if (dir.unavailable) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    return {
      async startTLS() {
        dir.calls.push({ op: 'startTLS', client: id });
        check();
      },
      async bind(dn: string, password?: string) {
        dir.calls.push({ op: 'bind', arg: dn, client: id });
        check();
        const upn = dir.upns.get(dn.toLowerCase());
        if (upn && password && upn.password === password) return;
        const entry = dir.entries.find((e) => e.dn.toLowerCase() === dn.toLowerCase());
        if (entry?.password && password && entry.password === password) return;
        throw new ResultError(49, 'InvalidCredentialsError');
      },
      async search(_base: string, options: SearchOptions) {
        const filter = String(options.filter);
        dir.calls.push({ op: 'search', arg: filter, client: id });
        check();
        const results = dir.evaluate(filter);
        if (options.sizeLimit && results.length > options.sizeLimit) {
          throw new ResultError(4, 'SizeLimitExceededError');
        }
        return { searchEntries: results };
      },
      async unbind() {
        dir.calls.push({ op: 'unbind', client: id });
      },
    };
  };

  private evaluate(filter: string): Entry[] {
    const inChain = /^\(member:1\.2\.840\.113556\.1\.4\.1941:=(.*)\)$/.exec(filter);
    if (inChain) {
      const groups = this.nested.get(unescape(inChain[1]!).toLowerCase()) ?? [];
      return groups.map((cn) => ({ dn: `cn=${cn},ou=groups,dc=example,dc=org`, cn }));
    }
    const terms = [...filter.matchAll(/\((\w+)=([^()]*)\)/g)].map((m) => ({
      attr: m[1]!.toLowerCase(),
      value: m[2]!,
    }));
    return this.entries
      .filter((e) =>
        terms.some(({ attr, value }) => {
          const key = Object.keys(e.attrs).find((k) => k.toLowerCase() === attr);
          const values = key ? [e.attrs[key]!].flat() : [];
          if (value === '*') return values.length > 0;
          const wanted = unescape(value).toLowerCase();
          return values.some((v) => v.toLowerCase() === wanted);
        }),
      )
      .map((e) => ({ dn: e.dn, ...e.attrs }));
  }
}

export function sampleDirectory(dir = new FakeDirectory()) {
  return dir
    .add({ dn: 'cn=readonly,dc=example,dc=org', password: 'readonly', attrs: { cn: 'readonly' } })
    .add({
      dn: 'uid=alice,ou=people,dc=example,dc=org',
      password: 'alice123',
      attrs: {
        uid: 'alice',
        cn: 'Alice Admin',
        mail: 'alice@example.org',
        memberOf: ['cn=staff,ou=groups,dc=example,dc=org', 'cn=engineering,ou=groups,dc=example,dc=org'],
      },
    })
    .add({
      dn: 'uid=carol,ou=people,dc=example,dc=org',
      password: 'carol123',
      attrs: { uid: 'carol', cn: 'Carol Contable', displayName: 'Carol C.' },
    })
    .add({
      dn: 'cn=finance,ou=groups,dc=example,dc=org',
      attrs: { cn: 'finance', uniqueMember: 'uid=carol,ou=people,dc=example,dc=org' },
    });
}

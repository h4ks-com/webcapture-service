import crypto from 'crypto';
import { URL } from 'url';

export function normalizeUrl(input: string): string {
  // ensure protocol
  let u = input;
  if (!/^[a-zA-Z]+:\/\//.test(u)) {
    u = 'http://' + u;
  }
  // throws on invalid
  return new URL(u).toString();
}

export function makeKey(url: string, format: string, length?: number): string {
  const h = crypto.createHash('sha1');
  h.update(url + '|' + format + '|' + (length ?? ''));
  return h.digest('hex');
}

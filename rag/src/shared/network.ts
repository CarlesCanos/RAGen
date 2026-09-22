export function isLoopbackHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.trim().toLowerCase());
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && isLoopbackHost(url.hostname)
      && !url.username
      && !url.password
      && (url.pathname === '/' || url.pathname === '')
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function assertLoopbackHttpUrl(value: string, name: string): void {
  if (!isLoopbackHttpUrl(value)) throw new Error(`${name} must be an HTTP loopback URL; received "${value}".`);
}

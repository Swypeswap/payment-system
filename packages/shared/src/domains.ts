export function parseDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  if (!domain) {
    throw new Error("Domain cannot be empty");
  }
  if (domain.includes("://")) {
    domain = new URL(domain).hostname;
  }
  domain = domain.replace(/\/.*$/, "").replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error(`Invalid domain: ${value}`);
  }
  return domain;
}

export function toHttpsWebsiteUrl(value: string): string {
  return `https://${parseDomain(value)}`;
}

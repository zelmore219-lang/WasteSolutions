export function loginIdentifier(
  value: string,
  loginDomain: string | undefined,
  isolatedDemo: boolean,
) {
  const login = value.trim().toLowerCase();
  if (isolatedDemo && login === "demo") return "demo@corewaste.local.test";
  if (login.includes("@")) return login;
  if (!loginDomain)
    throw Error(
      "Employee login domain is not configured; use your work email.",
    );
  return `${login}@${loginDomain}`;
}

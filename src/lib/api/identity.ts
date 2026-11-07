import type { Actor } from "../reservations/service";

export const SUBJECT_HEADER = "x-sso-subject";
export const NAME_HEADER = "x-sso-display-name";

const SUBJECT_PATTERN = /^[\x21-\x7e]{1,128}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanName(raw: string | null): string {
  const name = (raw ?? "").replace(CONTROL_CHARS, "").trim().slice(0, 100);
  return name === "" ? "Lab user" : name;
}

/**
 * Who is calling. The app sits behind the institution's SSO gateway, which authenticates the person
 * and forwards their opaque subject claim and display name in headers; the gateway must strip these
 * headers from outside requests (docs/adr/0006). Nothing else about a person is read or stored.
 * Outside production a fixed development identity is used when the headers are absent.
 */
export function identify(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Actor | undefined {
  const subject = request.headers.get(SUBJECT_HEADER);
  if (subject !== null) {
    if (!SUBJECT_PATTERN.test(subject)) return undefined;
    return { userId: subject, displayName: cleanName(request.headers.get(NAME_HEADER)) };
  }
  const devSubject = env["DEV_USER_SUBJECT"];
  if (
    env["NODE_ENV"] !== "production" &&
    devSubject !== undefined &&
    SUBJECT_PATTERN.test(devSubject)
  ) {
    return { userId: devSubject, displayName: cleanName(env["DEV_USER_NAME"] ?? null) };
  }
  return undefined;
}

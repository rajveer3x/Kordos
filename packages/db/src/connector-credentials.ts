import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

export const connectorKeySchema = z
  .base64url()
  .refine((value) => Buffer.from(value, "base64url").length === 32);
export const fixtureEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && url.hostname === "127.0.0.1"))
  );
});

export function sealConnectorCredential(
  key: string,
  workspace: string,
  installation: string,
  token: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    nonce,
  );
  cipher.setAAD(Buffer.from(`${workspace}/${installation}`));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), ciphertext]
    .map((value) => value.toString("base64url"))
    .join(".");
}

export function openConnectorCredential(
  key: string,
  workspace: string,
  installation: string,
  envelope: string,
) {
  const [nonce, tag, ciphertext, extra] = envelope.split(".");
  if (!nonce || !tag || !ciphertext || extra !== undefined)
    throw new Error("Invalid credential envelope.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    Buffer.from(nonce, "base64url"),
    { authTagLength: 16 },
  );
  cipher.setAAD(Buffer.from(`${workspace}/${installation}`));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    cipher.update(Buffer.from(ciphertext, "base64url")),
    cipher.final(),
  ]).toString("utf8");
}

import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export const issuerPort = Number(process.env.TEST_OIDC_PORT ?? 4399);
export const issuer = `http://127.0.0.1:${issuerPort}`;
export const oidcClientId = "kordos-test-client";
export const oidcClientSecret = "kordos-test-secret";

type Account = { name: string; email: string; email_verified: boolean };
type Login = {
  subject: string;
  nonce: string;
  challenge: string;
  redirect: string;
};

export async function startOidcFixture(
  accounts: Record<string, Account>,
  origin: string,
) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const codes = new Map<string, Login>();
  const tokens = new Map<string, string>();
  const keyId = "kordos-test-key";
  const callback = `${origin}/api/auth/callback`;

  function json(response: ServerResponse, data: unknown, status = 200) {
    response
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(data));
  }

  function idToken(login: Login) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "RS256", kid: keyId });
    const payload = encode({
      iss: issuer,
      aud: oidcClientId,
      sub: login.subject,
      nonce: login.nonce,
      iat: now,
      exp: now + 300,
    });
    const signed = `${header}.${payload}`;
    return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", issuer);
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      case "/jwks":
        return json(response, {
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              kid: keyId,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      case "/authorize": {
        const q = url.searchParams;
        const redirect = q.get("redirect_uri");
        const state = q.get("state");
        const nonce = q.get("nonce");
        const challenge = q.get("code_challenge");
        if (
          redirect !== callback ||
          !state ||
          !nonce ||
          !challenge ||
          q.get("code_challenge_method") !== "S256" ||
          q.get("client_id") !== oidcClientId
        ) {
          return json(response, { error: "invalid_request" }, 400);
        }
        const subject = q.get("account");
        if (!subject) {
          const buttons = Object.entries(accounts).map(([id, { name }]) => {
            const link = new URL(url);
            link.searchParams.set("account", id);
            return `<li><a href="${link.href.replaceAll("&", "&amp;")}">${name}</a></li>`;
          });
          return response
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(
              `<!doctype html><title>Test identity provider</title><ul>${buttons.join("")}</ul>`,
            );
        }
        if (!Object.hasOwn(accounts, subject))
          return json(response, { error: "access_denied" }, 400);
        const code = randomUUID();
        codes.set(code, { subject, nonce, challenge, redirect });
        const target = new URL(redirect);
        target.searchParams.set("state", state);
        target.searchParams.set("code", code);
        return response.writeHead(302, { Location: target.href }).end();
      }
      case "/token": {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        const code = body.get("code") ?? "";
        const login = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !login ||
          challenge !== login.challenge ||
          body.get("redirect_uri") !== login.redirect ||
          body.get("grant_type") !== "authorization_code" ||
          body.get("client_id") !== oidcClientId ||
          body.get("client_secret") !== oidcClientSecret
        ) {
          return json(response, { error: "invalid_grant" }, 400);
        }
        const token = randomUUID();
        tokens.set(token, login.subject);
        return json(response, {
          access_token: token,
          token_type: "Bearer",
          id_token: idToken(login),
        });
      }
      case "/userinfo": {
        const subject = tokens.get(
          request.headers.authorization?.slice("Bearer ".length) ?? "",
        );
        if (!subject) return json(response, { error: "invalid_token" }, 401);
        return json(response, { sub: subject, ...accounts[subject] });
      }
      default:
        return json(response, { error: "not_found" }, 404);
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() =>
      json(response, { error: "fixture_error" }, 500),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(issuerPort, "127.0.0.1", resolve);
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
}

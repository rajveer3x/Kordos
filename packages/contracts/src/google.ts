import { z } from "zod";
import { idSchema } from "./identity.js";

export const googleProviderSchema = z.enum(["calendar", "gmail"]);
export type GoogleProvider = z.infer<typeof googleProviderSchema>;

export const googleCalendarReadRoles = new Set([
  "reader",
  "writer",
  "writerWithoutPrivateAccess",
  "owner",
]);

export const googleScopeIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s\p{Cc}]+$/u);
export const googleIntentSchema = idSchema;
export const googleStartSchema = z.object({
  provider: googleProviderSchema,
  reconnect: z
    .object({
      id: idSchema,
      version: z.number().int().positive().max(2147483647),
    })
    .optional(),
});
export const googleAuthorizationSchema = z.object({ url: z.url() });
export const googleScopeChoiceSchema = z.object({
  id: googleScopeIdSchema,
  name: z.string().min(1).max(240),
});
export const googleChoicesSchema = z.object({
  provider: googleProviderSchema,
  scopes: z.array(googleScopeChoiceSchema).max(1000),
});
export const googleSelectionSchema = z.object({
  projectId: idSchema,
  scope: googleScopeIdSchema,
});
export const calendarAttachmentSchema = z.object({
  revision: z.number().int().positive().max(2147483647),
});
export const googleOAuthEnv = {
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
};
export const googlePermissions = {
  calendar: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
};

export type GoogleEndpoints = {
  authorization: string;
  token: string;
  userInfo: string;
  calendar: string;
  gmail: string;
};

export function googleEndpoints(fixture?: string): GoogleEndpoints {
  const base = fixture?.replace(/\/$/, "");
  return {
    authorization: base
      ? base + "/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth",
    token: base ? base + "/token" : "https://oauth2.googleapis.com/token",
    userInfo: base
      ? base + "/userinfo"
      : "https://openidconnect.googleapis.com/v1/userinfo",
    calendar: base
      ? base + "/calendar/v3/"
      : "https://www.googleapis.com/calendar/v3/",
    gmail: base
      ? base + "/gmail/v1/users/me/"
      : "https://gmail.googleapis.com/gmail/v1/users/me/",
  };
}

export type GoogleSettings = {
  clientId: string;
  clientSecret: string;
  key: string;
  endpoints: GoogleEndpoints;
};

export const googleRefreshTokenSchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,8192}$/);
export const googleSubjectSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);

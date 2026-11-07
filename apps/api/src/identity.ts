import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { applicationDefault, initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { assertIdentityConfiguration } from "./identity-config";
export async function verifyIdentity(header: string | undefined) {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new UnauthorizedException("Firebase ID token required");
  if (!process.env.FIREBASE_PROJECT_ID)
    throw new ServiceUnavailableException("Firebase is not configured");
  assertIdentityConfiguration();
  try {
    if (!getApps().length)
      initializeApp({
        ...(process.env.FIREBASE_AUTH_EMULATOR_HOST
          ? {}
          : { credential: applicationDefault() }),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    return await getAuth().verifyIdToken(token, true);
  } catch {
    throw new UnauthorizedException("Invalid or revoked identity token");
  }
}

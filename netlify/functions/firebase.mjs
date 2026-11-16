import crypto from "node:crypto";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const MAX_BODY_BYTES = 1_000_000;
const MAX_PATH_LENGTH = 500;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) ?? process.env[name];
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, name, maxLength = MAX_PATH_LENGTH) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, "Invalid " + name);
  }
  return value.trim();
}

function requiredPassword(value) {
  // Preserve intentional leading/trailing spaces in passwords.
  if (typeof value !== "string" || value.length < 6 || value.length > 128 || !value.trim()) {
    throw new HttpError(400, "Password must be 6 to 128 characters");
  }
  return value;
}

function cleanPath(value, options = {}) {
  const allowRoot = options.allowRoot === true;
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) {
    throw new HttpError(400, "Invalid path");
  }

  const trimmed = value.trim();
  if (allowRoot && (trimmed === "" || trimmed === "/")) return "/";

  const normalized = trimmed.replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new HttpError(400, "Invalid path");

  const segments = normalized.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new HttpError(400, "Invalid path");
  }
  return normalized;
}

function firestorePath(value, kind) {
  const path = cleanPath(value);
  const count = path.split("/").length;
  const shouldBeDocument = kind === "document";
  if ((shouldBeDocument && count % 2 !== 0) || (!shouldBeDocument && count % 2 !== 1)) {
    throw new HttpError(400, "Invalid Firestore " + kind + " path");
  }
  return path;
}

function boundedLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}

function firebase() {
  const projectId = env("FIREBASE_PROJECT_ID");
  const raw = env("FIREBASE_SERVICE_ACCOUNT_JSON");

  if (!projectId || !raw) {
    throw new HttpError(503, "Firebase service is not configured");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new HttpError(503, "Firebase service configuration is invalid");
  }

  if (!isRecord(serviceAccount) || serviceAccount.project_id !== projectId || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new HttpError(503, "Firebase service configuration is invalid");
  }

  const existing = getApps().find((item) => item.name === "[DEFAULT]");
  if (existing) return existing;

  return initializeApp({
    credential: cert(serviceAccount),
    projectId,
    databaseURL: env("FIREBASE_DATABASE_URL") || undefined,
    storageBucket: env("FIREBASE_STORAGE_BUCKET") || undefined,
  });
}

function requireDeleteConfirmation(body) {
  if (body.confirm !== "DELETE") {
    throw new HttpError(400, 'Send confirm: "DELETE" to confirm deletion');
  }
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json(405, { error: "Use POST" });
  }

  const expectedToken = env("ADMIN_API_TOKEN");
  const authorization = request.headers.get("authorization") || "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (typeof expectedToken !== "string" || expectedToken.length < 32 || !safeEqual(suppliedToken, expectedToken)) {
    return json(401, { error: "Unauthorized" });
  }

  let rawBody;
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json(413, { error: "Request too large" });

    rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return json(413, { error: "Request too large" });
    }
  } catch {
    return json(400, { error: "Could not read request body" });
  }

  let body;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (!isRecord(body) || typeof body.operation !== "string") {
    return json(400, { error: "A valid operation is required" });
  }

  try {
    const app = firebase();
    const operation = body.operation;

    if (operation === "health") {
      return json(200, { ok: true, projectId: env("FIREBASE_PROJECT_ID") });
    }

    if (operation.startsWith("firestore.")) {
      const db = getFirestore(app);

      if (operation === "firestore.get") {
        const path = firestorePath(body.path, "document");
        const snapshot = await db.doc(path).get();
        return json(200, {
          exists: snapshot.exists,
          data: snapshot.exists ? snapshot.data() : null,
        });
      }

      if (operation === "firestore.list") {
        const path = firestorePath(body.path, "collection");
        const snapshot = await db.collection(path)
          .limit(boundedLimit(body.limit, 50, 100))
          .get();
        return json(200, {
          documents: snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
        });
      }

      if (operation === "firestore.set" || operation === "firestore.update") {
        const path = firestorePath(body.path, "document");
        if (!isRecord(body.data)) throw new HttpError(400, "data must be an object");

        const reference = db.doc(path);
        if (operation === "firestore.set") {
          await reference.set(body.data, { merge: body.merge === true });
        } else {
          await reference.update(body.data);
        }
        return json(200, { ok: true });
      }

      if (operation === "firestore.delete") {
        const path = firestorePath(body.path, "document");
        requireDeleteConfirmation(body);
        await db.doc(path).delete();
        return json(200, { ok: true });
      }

      throw new HttpError(400, "Unsupported operation");
    }

    if (operation.startsWith("rtdb.")) {
      const path = cleanPath(body.path === undefined ? "/" : body.path, { allowRoot: true });
      const reference = getDatabase(app).ref(path);

      if (operation === "rtdb.get") {
        return json(200, { value: (await reference.get()).val() });
      }

      if (operation === "rtdb.set") {
        if (!Object.hasOwn(body, "data")) throw new HttpError(400, "data is required");
        await reference.set(body.data);
        return json(200, { ok: true });
      }

      if (operation === "rtdb.update") {
        if (!isRecord(body.data)) throw new HttpError(400, "data must be an object");
        await reference.update(body.data);
        return json(200, { ok: true });
      }

      if (operation === "rtdb.delete") {
        requireDeleteConfirmation(body);
        await reference.remove();
        return json(200, { ok: true });
      }

      throw new HttpError(400, "Unsupported operation");
    }

    if (operation.startsWith("auth.")) {
      const auth = getAuth(app);

      if (operation === "auth.list") {
        const result = await auth.listUsers(
          boundedLimit(body.limit, 100, 1000),
          typeof body.pageToken === "string" ? body.pageToken : undefined
        );
        return json(200, {
          users: result.users.map((user) => ({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            disabled: user.disabled,
            emailVerified: user.emailVerified,
          })),
          pageToken: result.pageToken || null,
        });
      }

      if (operation === "auth.create") {
        const email = requiredString(body.email, "email", 320);
        const password = requiredPassword(body.password);
        const user = await auth.createUser({
          email,
          password,
          displayName: typeof body.displayName === "string" ? body.displayName.slice(0, 256) : undefined,
          disabled: body.disabled === true,
        });
        return json(201, { uid: user.uid, email: user.email });
      }

      if (operation === "auth.enable" || operation === "auth.disable") {
        const uid = requiredString(body.uid, "uid", 128);
        await auth.updateUser(uid, { disabled: operation === "auth.disable" });
        return json(200, { ok: true });
      }

      if (operation === "auth.delete") {
        const uid = requiredString(body.uid, "uid", 128);
        requireDeleteConfirmation(body);
        await auth.deleteUser(uid);
        return json(200, { ok: true });
      }

      throw new HttpError(400, "Unsupported operation");
    }

    if (operation.startsWith("storage.")) {
      const bucket = getStorage(app).bucket();

      if (operation === "storage.list") {
        const prefix = body.prefix === undefined ? "" : requiredString(body.prefix, "prefix", MAX_PATH_LENGTH);
        const [files] = await bucket.getFiles({
          prefix,
          maxResults: boundedLimit(body.limit, 100, 500),
        });
        return json(200, {
          files: files.map((file) => ({
            name: file.name,
            size: file.metadata.size,
            contentType: file.metadata.contentType,
          })),
        });
      }

      if (operation === "storage.delete") {
        const path = cleanPath(body.path);
        requireDeleteConfirmation(body);
        await bucket.file(path).delete();
        return json(200, { ok: true });
      }

      throw new HttpError(400, "Unsupported operation");
    }

    throw new HttpError(400, "Unsupported operation");
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message });
    }
    // Keep Firebase and infrastructure details out of public API responses.
    return json(500, { error: "The requested operation failed" });
  }
}

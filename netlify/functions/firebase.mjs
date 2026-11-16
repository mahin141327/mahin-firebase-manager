import crypto from "node:crypto";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cleanPath = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || value.includes("..")) {
    throw new Error("Invalid path");
  }
  return value.replace(/^\/+|\/+$/g, "");
};
function firebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !raw) throw new Error("Firebase environment variables are not configured");
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); } catch { throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON"); }
  if (serviceAccount.project_id !== projectId) throw new Error("Service account project_id does not match FIREBASE_PROJECT_ID");
  const app = getApps()[0] || initializeApp({
    credential: cert(serviceAccount),
    projectId,
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
  });
  return app;
}
const needsDeleteConfirm = (body) => body.confirm === "DELETE";

export default async (req) => {
  if (req.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
  if (req.httpMethod !== "POST") return json(405, { error: "Use POST" });

  const expected = process.env.ADMIN_API_TOKEN;
  const authHeader = req.headers.authorization || "";
  const supplied = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!expected || !safeEqual(supplied, expected)) return json(401, { error: "Unauthorized" });

  let body;
  try {
    if ((req.body || "").length > 1_000_000) return json(413, { error: "Request too large" });
    body = JSON.parse(req.body || "{}");
  } catch { return json(400, { error: "Invalid JSON body" }); }

  try {
    const app = firebase();
    const op = body.operation;
    if (op === "health") return json(200, { ok: true, projectId: process.env.FIREBASE_PROJECT_ID });

    if (op.startsWith("firestore.")) {
      const db = getFirestore(app);
      if (op === "firestore.get") {
        const snap = await db.doc(cleanPath(body.path)).get();
        return json(200, { exists: snap.exists, data: snap.exists ? snap.data() : null });
      }
      if (op === "firestore.list") {
        const snap = await db.collection(cleanPath(body.path)).limit(Math.min(Number(body.limit) || 50, 100)).get();
        return json(200, { documents: snap.docs.map(d => ({ id: d.id, data: d.data() })) });
      }
      if (op === "firestore.set" || op === "firestore.update") {
        if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return json(400, { error: "data must be an object" });
        const ref = db.doc(cleanPath(body.path));
        if (op === "firestore.set") await ref.set(body.data, { merge: body.merge === true });
        else await ref.update(body.data);
        return json(200, { ok: true });
      }
      if (op === "firestore.delete") {
        if (!needsDeleteConfirm(body)) return json(400, { error: 'Send confirm: "DELETE" to confirm deletion' });
        await db.doc(cleanPath(body.path)).delete();
        return json(200, { ok: true });
      }
    }

    if (op.startsWith("rtdb.")) {
      const db = getDatabase(app);
      const ref = db.ref(cleanPath(body.path || "/"));
      if (op === "rtdb.get") return json(200, { value: (await ref.get()).val() });
      if (op === "rtdb.set" || op === "rtdb.update") {
        if (op === "rtdb.set") await ref.set(body.data);
        else await ref.update(body.data);
        return json(200, { ok: true });
      }
      if (op === "rtdb.delete") {
        if (!needsDeleteConfirm(body)) return json(400, { error: 'Send confirm: "DELETE" to confirm deletion' });
        await ref.remove();
        return json(200, { ok: true });
      }
    }

    if (op.startsWith("auth.")) {
      const auth = getAuth(app);
      if (op === "auth.list") {
        const result = await auth.listUsers(Math.min(Number(body.limit) || 100, 1000), body.pageToken);
        return json(200, { users: result.users.map(u => ({ uid:u.uid,email:u.email,displayName:u.displayName,disabled:u.disabled,emailVerified:u.emailVerified })), pageToken: result.pageToken || null });
      }
      if (op === "auth.create") {
        const user = await auth.createUser({ email:body.email, password:body.password, displayName:body.displayName, disabled:body.disabled === true });
        return json(201, { uid:user.uid, email:user.email });
      }
      if (op === "auth.disable" || op === "auth.enable") {
        await auth.updateUser(body.uid, { disabled: op === "auth.disable" });
        return json(200, { ok: true });
      }
      if (op === "auth.delete") {
        if (!needsDeleteConfirm(body)) return json(400, { error: 'Send confirm: "DELETE" to confirm deletion' });
        await auth.deleteUser(body.uid);
        return json(200, { ok: true });
      }
    }

    if (op.startsWith("storage.")) {
      const bucket = getStorage(app).bucket();
      if (op === "storage.list") {
        const [files] = await bucket.getFiles({ prefix: body.prefix || "", maxResults: Math.min(Number(body.limit) || 100, 500) });
        return json(200, { files: files.map(f => ({ name:f.name, size:f.metadata.size, contentType:f.metadata.contentType })) });
      }
      if (op === "storage.delete") {
        if (!needsDeleteConfirm(body)) return json(400, { error: 'Send confirm: "DELETE" to confirm deletion' });
        await bucket.file(cleanPath(body.path)).delete();
        return json(200, { ok: true });
      }
    }

    return json(400, { error: "Unsupported operation" });
  } catch (error) {
    const message = error?.message || "Internal error";
    const status = /Invalid path|data must|confirm:|Unsupported operation/.test(message) ? 400 : 500;
    return json(status, { error: message });
  }
};

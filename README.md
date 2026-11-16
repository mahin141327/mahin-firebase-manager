# Mahin Firebase Manager

A private, server-side Firebase management API for Netlify Functions.

## Firebase project
- Project ID: `burnished-inquiry-tmn89`

## Deploy
1. Connect this GitHub repository to the Netlify project `mahin-firebase-manager`.
2. Set the environment variables listed below in Netlify (Site configuration → Environment variables).
3. Trigger a deploy.

## Required Netlify environment variables
- `FIREBASE_PROJECT_ID`: `burnished-inquiry-tmn89`
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete service-account JSON, stored only as a Netlify secret.
- `ADMIN_API_TOKEN`: a long random secret (at least 32 random bytes).

Optional:
- `FIREBASE_DATABASE_URL`: Realtime Database URL.
- `FIREBASE_STORAGE_BUCKET`: Storage bucket name if not the project's default.

## API
POST `/.netlify/functions/firebase` with header `Authorization: Bearer <ADMIN_API_TOKEN>` and a JSON body.

Examples:
- `{"operation":"health"}`
- `{"operation":"firestore.get","path":"users/example"}`
- `{"operation":"firestore.list","path":"users","limit":50}`
- `{"operation":"rtdb.get","path":"settings"}`
- `{"operation":"auth.list","limit":100}`
- `{"operation":"storage.list","prefix":"uploads/"}`

Supported operation families: Firestore get/list/set/update/delete; Realtime Database get/set/update/delete; Authentication list/create/enable/disable/delete; Storage list/delete. Delete operations require `"confirm":"DELETE"`.

## Security notes
- Never commit Firebase service-account JSON, API tokens, or other credentials.
- Store secrets only in Netlify environment variables.
- Restrict access to the Netlify project and rotate the API token if exposed.
- This API is intended for a private admin client. Do not expose the admin token in browser code.
- Deletions require an explicit confirmation field. Review Firestore/Realtime Database rules separately; Admin SDK access bypasses Firebase Security Rules.
- Analytics reporting and Firebase Rules API management are not included in this first backend version.

# HAULXIFY Employee ID Verification System

A zero-hosting-cost starter system using:

## Recent changes

- **Fixed a real bug in `verify.js`:** Firestore Rules deny the read outright for a frozen, canceled, expired, or unknown token — that denial arrives as a `permission-denied` error, not as a missing document. The old code only checked `snap.exists()` and card status *after* the read succeeded, so that branch was unreachable for public visitors; everyone saw a generic "please try again" message instead of "this card is frozen/canceled/expired." The catch block now distinguishes `permission-denied` and shows the correct message.
- **QR codes are now generated with [`qr-code-styling`](https://github.com/kozakdenys/qr-code-styling)** instead of the older `qrcodejs`: rounded ("extra-rounded") modules, the HAULXIFY logo embedded in the center at `H`-level error correction (30% recovery, so the logo doesn't hurt scannability), and rendered at 1200×1200px so the downloaded PNG stays crisp when printed on a physical badge — not just on screen.
- **Visual redesign** of the landing, verification, and admin pages around a "credential" aesthetic (security-pattern header texture, dual-ring photo frame, monospace data fields) rather than a generic dashboard look.
- **Admin portal additions:** a stats strip (total / active / frozen / canceled / expiring within 30 days), a soft warning when issuing a second active card against an Employee ID that already has one, an "editing" banner so it's clear when you're updating vs. creating a card, a "Copy link" button next to the QR, and a "Last Updated" column on the cards table.
- **Basic audit fields** (`createdAt`, `issuedBy`, `updatedAt`, `updatedBy`) are now stored on each card document for traceability. They're admin-only fields — Firestore Rules don't expose them to the public verification page.

- GitHub Pages for the static frontend
- Firebase Authentication for admin login
- Cloud Firestore for employee/card data
- Browser-generated 256-bit random card tokens
- QR codes that point to `verify.html?card=<token>`
- Base64-compressed employee photos stored inside Firestore

## Important security model

There is intentionally **no employee ID search on the public verification page**.

The QR code contains a high-entropy random token. The verifier uses that exact token to read one Firestore document. Firestore Rules reject public collection queries and reject inactive/expired cards using a server-side Firestore timestamp.

Changing the URL by guessing another token should be computationally infeasible because the token is generated from 32 cryptographically random bytes.

The QR URL itself is effectively the verification credential. Anyone who legitimately obtains a copy of a QR code can use it, so do not publish QR codes for cards that should remain private.

## Privacy choice

The public verification page displays:

- Name
- Designation
- Employee ID
- Department
- Phone
- Shift
- Issue date
- Expiry date
- Optional photo

It intentionally does **not** display:

- Home address
- Emergency number
- Blood group

Those fields remain inside Firestore and are visible to authorized admins only. This is safer for an employee ID system.

## Firebase setup

1. Create a Firebase project.
2. Create a Cloud Firestore database.
3. Enable Authentication > Sign-in providers > Email/Password.
4. Create the admin user in Firebase Authentication.
5. Copy the Web App config into `js/firebase-config.js`.
6. Deploy `firestore.rules`.
7. Get the admin user's Firebase UID and manually create:
   `admins/<UID>`
   in Firestore. The document can contain any harmless field, e.g.:
   `enabled: true`
8. Do **not** give the frontend any Firebase Admin SDK service-account credentials.

Firestore's current free quota includes 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, 1 GiB storage, and 10 GiB/month outbound transfer. Heavy usage can exceed the free quota.

## GitHub Pages setup

Put the repository contents in a GitHub repository.

Then:

`Settings -> Pages -> Build and deployment -> Deploy from a branch -> main -> /root -> Save`

The site will be available on GitHub Pages. HTTPS is supported and can be enforced.

QR links automatically use the current site's URL, so the project works with either a GitHub Pages URL or your own HTTPS custom domain.

## First login

After adding the `admins/<UID>` document, open:

`/admin.html`

Sign in with the Firebase admin account.

## Card lifecycle

### Issue
Creates a new 256-bit random card token and saves the employee/card record.

### Freeze
The QR remains physically on the card, but public verification stops working.

### Cancel
Public verification stops working.

### New card
Create a new token/QR for the employee. The previous token can be canceled first.

### Delete
Permanently deletes the entire card document from Firestore. The old QR becomes invalid.

## Base64 photo storage

The admin panel resizes an uploaded image to 400px maximum dimension and stores a JPEG data URL as `photoBase64`.

Firestore documents have a size limit, so very large images are rejected after resizing.

For a very large employee directory, Firebase Storage would be a better photo store, but this version follows the requested Base64 approach.

## What this system cannot guarantee

A static frontend cannot prove that a URL was opened by a physical scanner rather than typed manually. The security boundary is possession of the unique QR token.

Likewise, a public QR is inherently shareable. If a QR image is photographed or copied, the copied token can be used. There is no way to prevent this completely with a free, client-side public verification page.

For stronger anti-sharing controls you would need additional server-side mechanisms such as signed short-lived verification sessions, a dedicated API, device/network controls, or an online challenge/response service.

## Recommended hardening for production

The core model (server-verified token + Firestore Rules, no client-trusted checks) is already sound. Before rolling this out at company scale, consider:

- **Firebase App Check** on both the admin and verification flows, to reject Firestore requests that don't come from your actual deployed pages — cuts down on scripted abuse of the public `get()` endpoint.
- **A Firestore composite index or Cloud Function** to enforce Employee ID uniqueness server-side; the admin portal only warns client-side today, which an admin can dismiss.
- **Firebase Storage instead of Base64 photos** once your employee count grows past what's comfortable inside Firestore's per-document size limit.
- **Structured audit logging** (e.g. a `cardEvents` collection written by a Cloud Function on every write) if you need a tamper-evident history beyond the `issuedBy`/`updatedBy` fields on the card document itself.

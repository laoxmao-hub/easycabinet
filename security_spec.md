# Security Specification - DRACO-X2

## 1. Data Invariants
- A `Project` module must always belong to a `Project` (identified by `projectCode`).
- Only users with `admin` or `mod` roles can create or modify items and projects.
- Users can only edit their own profile, except for the `role` field which is admin-only.
- All timestamps must be server-generated (`request.time`).
- Activity logs are append-only.

## 2. The "Dirty Dozen" Payloads

1. **Identity Spoofing**: Attempt to create a project with an `ownerId` that doesn't match the authenticated user.
2. **Privilege Escalation**: A `viewer` attempts to update their own `role` to `admin`.
3. **Ghost Field Injection**: Adding an `isVerified: true` field to an item.
4. **Invalid Type Poisoning**: Sending a string for a `quantity` field (which should be a number).
5. **Denial of Wallet (ID Poisoning)**: Creating a project with a 2KB long ID string.
6. **Immutable Field Tampering**: Attempting to change `createdAt` on an existing item.
7. **Cross-User Access**: A logged-in user attempts to read another user's private profile data (if we split it, currently it's one doc).
8. **Orphaned Record**: Creating a project entry without a `projectName`.
9. **Status Shortcut**: A user attempts to skip a status phase (though rules can't easily enforce sequence, they can enforce who can change it).
10. **Shadow Update**: Updating an item but including an unlisted field like `internalNotes`.
11. **PII Leakage**: A guest attempting to list all emails from the `users` collection.
12. **Timestamp Forgery**: Sending a client-side timestamp instead of `request.time`.

## 3. Test Runner Plan
The `firestore.rules.test.ts` will verify these cases.

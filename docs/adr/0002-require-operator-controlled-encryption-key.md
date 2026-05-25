# Require operator-controlled encryption key outside development fallback

Provider Keys are encrypted at rest, but storing the Encryption Key in the same SQLite database weakens that protection if the database is copied or leaked. Normal startup uses an operator-controlled `ENCRYPTION_KEY` from the deployment environment; on an empty non-production first install, the system may bootstrap that key into `.env` before any Provider Keys exist. The DB-stored fallback is allowed only through an explicit Development Encryption Fallback outside production.

Legacy DB-stored Encryption Keys are migration state, not a normal runtime source of trust. They are not used automatically outside the Development Encryption Fallback; the migration command moves the legacy key into `.env`, verifies that enabled Provider Keys can still be decrypted, and removes the legacy database key only after successful verification. If verification fails, the legacy key remains in SQLite and the operator is notified.

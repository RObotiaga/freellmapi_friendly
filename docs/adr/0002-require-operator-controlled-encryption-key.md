# Require operator-controlled encryption key outside development fallback

Provider Keys are encrypted at rest, but storing the Encryption Key in the same SQLite database weakens that protection if the database is copied or leaked. Normal startup requires an operator-controlled `ENCRYPTION_KEY` from the deployment environment; the DB-stored fallback is allowed only through an explicit Development Encryption Fallback outside production. Legacy DB-stored Encryption Keys are treated as migration state and must be moved into the deployment environment before normal startup continues.

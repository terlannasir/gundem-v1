// Only the four Google APIs we use (instead of the whole `googleapis` bundle: ~100 MB less RAM, ~1 s faster boot).
// Exposed as one mutable object so tests can swap in fakes.
import { gmail } from "@googleapis/gmail";
import { calendar } from "@googleapis/calendar";
import { drive } from "@googleapis/drive";
import { oauth2, auth } from "@googleapis/oauth2";

export const google = { gmail, calendar, drive, oauth2, auth: { OAuth2: auth.OAuth2 } };

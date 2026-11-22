# A signed-in account talks to the agent only once it is invited

Anyone can create an account; an account reaches the agent only when its Clerk public metadata holds `{"chat": true}`, which Enzo sets by hand. `chatAccess` in `src/lib/auth/chat-access.ts` answers one of three states: `anonymous`, `pending` (signed in, not invited) or `allowed`.

## Rules

- The grant is read first in the session token: the Clerk instance is set to copy the public metadata into the claim `metadata` (docs/deploy.md), and `GrantClaim` accepts `metadata.chat === true` and nothing looser. An invited account then costs no call to Clerk's API.
- Without the claim, the account is read through Clerk's API and the answer is remembered per function instance (`remembered`): 5 minutes when the access is granted, 10 seconds when it is not, so a person who has just been invited gets in at the next reload. The table is emptied when it reaches `MAX_REMEMBERED` (500) entries.
- A grant that is taken back therefore stops within the life of the session token, then within 5 minutes on an instance that remembered it.
- Public metadata is the right place because only the backend can write it: an account cannot grant itself. Do not move the grant to the unsafe metadata, which the browser can write.
- The page draws the door for `anonymous` and `pending` and the room for `allowed`. A pending account sees the e-mail address it is signed in with, so the person knows which account to have opened, and a sign-out button.
- Every API route of the conversation runs the same check (`chatUser`): 401 without a session, 403 for a pending account. The page hiding the room is not the barrier.
- After a sign-in at the door, the page asks the server for itself once (`router.refresh`): the door was rendered for an anonymous visitor, and the session now says otherwise.

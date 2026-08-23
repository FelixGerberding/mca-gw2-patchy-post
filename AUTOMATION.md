# Automation

Posts the Patch-Records recap to Reddit on its own, once a patch ends.

## The established format

Matched from the existing posts, so the automated ones are indistinguishable:

| Element | Value |
| --- | --- |
| Subreddit | r/Guildwars2 |
| Title | `Patch-Records - <patch name>`, e.g. *Patch-Records - Balance Patch February 2025* |
| Flair | `Other` |
| Content | the raid image and the strike image |
| Body | `New here and wondering what this is all about? Check out the original announcement and FAQ: [Introducing Monthly Raid Patch Record Recap](…)` |

The patch name comes straight from wingman's `patch.name`, so nothing needs
configuring per patch.

**On the post type.** Reddit gallery submissions take per-image captions but
no body text, and plain image submissions take neither. Two images *and* body
text means it has to be a self post whose body is richtext with the images
embedded - `kind=self` plus `richtext_json`. That is the least-travelled part
of the API here and is the thing to validate first.

## What runs

```
EventBridge (hourly)
  └─> Lambda (container image - canvas needs cairo/pango)
        ├─ wingman /api/patches - has the newest patch id changed?
        │    no  -> stop
        │    yes -> record the closed era as pending, due at the next 18:00
        │           Europe/Berlin, and stop
        ├─ pending and not yet due -> stop
        └─ pending and due
             ├─ render the raid and strike images
             ├─ sanity checks
             │    fail -> Discord webhook with both images and the reasons,
             │            nothing posted
             └─ pass -> upload both images, submit, Discord confirmation
```

State lives in one DynamoDB table: a `cursor` row holding the last-seen patch
id plus any pending era and its due time, and one `era#<id>` row per era
recording whether it went out. The era row is what stops a retry
double-posting.

Detection and publication are deliberately separate ticks - a patch can land
at any hour, but the post should not go out at 04:00.

## Blocking vs advisory

Only things that would make the post *wrong* hold it:

- no records at all for the era
- fewer than half the encounters having a record (wingman mid-outage)
- fewer than three teams, which the layout assumes
- the patch still being open, which makes "Final Standings" untrue

A team with no logo is **advisory**. Plenty of teams never upload one to
wingman, so holding the post over it would mean holding nearly every patch.
It is reported in the Discord message either way.

## Releasing a held post

Fix whatever it complained about, then invoke the function directly:

```bash
aws lambda invoke --function-name <name> \
  --payload '{"era":"26-07","force":true}' /dev/stdout
```

`force` skips the blocking checks. `dryRun` renders and reports without
posting. `era` on its own re-runs one era regardless of the cursor.

## Deploying

```bash
cd infra
npm install
npx cdk deploy
```

Then put the credentials in the secret the stack created
(`patchy-post/credentials`) as one JSON blob:

```json
{
  "REDDIT_CLIENT_ID": "...",
  "REDDIT_CLIENT_SECRET": "...",
  "REDDIT_USERNAME": "...",
  "REDDIT_PASSWORD": "...",
  "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/..."
}
```

The Reddit app must be registered as type **script** at
https://www.reddit.com/prefs/apps, with the posting account listed as a
developer - the password grant only works for that app type.

## Before it goes live

1. `npm run post:dry -- --era <a closed era>` locally and compare both images
   against a real post.
2. Point `PATCHY_SUBREDDIT` at a test subreddit and let it actually post, to
   prove out the richtext submit path.
3. Only then switch it to `Guildwars2`.

Check the posting account can post to r/Guildwars2 at all - subreddits
commonly gate on account age and karma, and a fresh bot account will bounce.

## Running it by hand

`src/post.js` is the same code path without any AWS:

```bash
node src/post.js --era previous --dry-run   # render + check, post nothing
node src/post.js --era 26-07 --force        # post despite blocking checks
```

It reads the same environment variables the Lambda gets from the secret.

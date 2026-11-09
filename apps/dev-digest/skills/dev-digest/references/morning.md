# dev-digest morning procedure

You are running unattended from an Orca automation. Nobody is watching: do not ask questions, and do not stop to
wait for confirmation. Follow the steps below in order, then report in one line.

## Rules

- **Never read, open, cat, grep, or search `secrets.json`** in the dev-digest home (`~/.dev-digest/secrets.json`),
  and never look for Slack Webhook URLs anywhere (files, environment, history). `publish` reads them by itself.
- Run the launcher by its absolute path exactly as written: `{{DEV_DIGEST}}`. Do not run other scripts.
- Write files only under `{{RUN_DIR}}`.
- Use only the browser commands of Orca (`orca tab`, `orca snapshot`, `orca scroll`, `orca goto`, `orca wait`,
  `orca get`) for X.

## 1. Collect the feeds

```bash
{{DEV_DIGEST}} collect
```

Note `x_since` in the output. It is when X posts were last stored (`none` on the first run: then read up to the
limits below).

## 2. Read X

Read the posts newer than `x_since` in Orca's built-in browser (it is already logged in to X).

- List: {{X_LIST}} (up to {{X_MAX_POSTS_LIST}} posts). If it is `none`, skip the list.
- Hashtag searches, newest first (up to {{X_MAX_POSTS_PER_HASHTAG}} posts each):

{{X_HASHTAGS}}

For each page:

1. `orca tab create --url <url> --json` and take the page id from the result.
2. `orca snapshot --page <id> --compact --urls` and read the posts in it.
3. For more posts, `orca scroll --page <id> --direction down --amount 3000` and snapshot again.
4. Stop when you reach a post older than `x_since`, or when you have read the limit above. Then
   `orca tab close --page <id>`.

How to read a post from the snapshot:

- **id and url**: the first link to `/status/<digits>` whose child is a `time` element. The url is
  `https://x.com/<handle>/status/<id>`.
- **author**: the handle in that url.
- **postedAt**: the snapshot shows only relative times, so derive the time from the id (a Snowflake id):
  `ms = (BigInt(id) >> 22n) + 1288834974657n`. Write it as an ISO 8601 UTC string.
- **text**: the generic text after the post header. Skip the element that starts with "Replying to", the quoted post
  that starts with "Quote", and cards or media.
- Keep each id only once across the list and the hashtag searches.

Write `{{RUN_DIR}}/x.json` in this shape:

```json
{
  "posts": [
    {
      "id": "<digits>",
      "url": "https://x.com/<handle>/status/<digits>",
      "author": "<handle>",
      "postedAt": "<ISO 8601 UTC, derived from the id>",
      "text": "<post text>"
    }
  ]
}
```

Then store it:

```bash
{{DEV_DIGEST}} ingest-x --file {{RUN_DIR}}/x.json
```

If X cannot be read (logged out, the page does not load, no posts can be found), do not retry for long. Record the
failure instead, and continue with step 3:

```bash
{{DEV_DIGEST}} ingest-x --failed "<short reason, for example: login expired>"
```

## 3. Build the pending list

```bash
{{DEV_DIGEST}} pending
```

It writes `{{RUN_DIR}}/pending.json`.

## 4. Write the digest

Read `{{RUN_DIR}}/pending.json`. It has:

- `runId`
- `items`: every undelivered item (`id`, `section`, `title`, `url`, `summary`, `severity`, `products`, `updated`, ...)
- `globalIds`: the items for the global message
- `repos`: each watched repository (`slug`, `displayName`, `watch`, `candidateIds`, `ownIds`)
- `failures`: sources that could not be fetched

Write `{{RUN_DIR}}/digest.json`:

```json
{
  "runId": 42,
  "notes": [
    { "id": 101, "summaryJa": "<1-2 sentences in Japanese>", "tags": ["aws", "lambda"] }
  ],
  "groups": [
    {
      "key": "lambda-runtime-update",
      "titleJa": "<short title in Japanese>",
      "summaryJa": "<1-2 sentences in Japanese>",
      "itemIds": [101, 205]
    }
  ],
  "repos": [
    { "slug": "owner/repo", "itemIds": [101] }
  ]
}
```

- `runId`: the same value as in `pending.json`.
- `notes`: one entry for **every** item in `items`. `summaryJa` is 1-2 sentences **written in Japanese** (the Slack
  message is read in Japanese). `tags` are short lowercase keywords.
- `groups`: items about the same topic, across sources (for example a release note, a blog post, and X posts about the
  same launch). `titleJa` and `summaryJa` are **written in Japanese**. `key` is a short stable English slug. Each item
  may be in at most one group, and every group has at least one item. Items that fit no group stay out of `groups`.
- `repos`: for each repository in `pending.json`, the ids from its `candidateIds` that are really relevant to its
  `watch` (languages, packages, cloud services, keywords). Use only ids from that repository's `candidateIds` or
  `ownIds`. `ownIds` are always delivered, so you do not need to repeat them.
- `groups` and `repos` are required; write `[]` when there is nothing to put in them.

## 5. Publish

```bash
{{DEV_DIGEST}} publish --file {{RUN_DIR}}/digest.json
```

- Exit 3: `digest.json` failed validation and nothing was sent. Read the errors on stderr, fix `digest.json`, and run
  `publish` again.
- Exit 2: something is not set up (configuration, `pending.json`, or the global Webhook). Do not try to fix it; report it.
- Exit 1: some messages could not be sent. Report the `failed` lines.

## 6. Report

Report the result in one line: what was sent (the `sent` / `skipped` / `failed` lines of `publish`), the number of items,
and whether X was read or failed.

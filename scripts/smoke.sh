#!/usr/bin/env bash
#
# Exercises every Phase 1 endpoint against a running server and cleans up
# after itself. Works against local dev or a deployed Worker:
#
#   npm run dev                       # in another shell
#   ADMIN_PASSWORD=... ./scripts/smoke.sh
#   ADMIN_PASSWORD=... ./scripts/smoke.sh https://blog.example.workers.dev
#
# Mutating routes need a session, so ADMIN_PASSWORD must be set to the same
# value the server is using. It is read from the environment, or from
# .env.local / .dev.vars if present.
#
# Requires curl and jq. jq is not optional: post objects carry a nested `tags`
# array whose members reuse the `id`/`slug` keys, so a regex extractor picks the
# wrong value and the script reports false results.
set -uo pipefail

BASE="${1:-${BASE_URL:-http://localhost:3000}}"
PASS=0
FAIL=0

if ! command -v jq >/dev/null 2>&1; then
  echo "smoke.sh needs jq (brew install jq / apt-get install jq)." >&2
  exit 2
fi

field() { jq -r "$1"; }

COOKIE_JAR="$(mktemp -t smoke-cookies)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Fall back to the local env files so the common case needs no arguments.
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  for env_file in .env.local .dev.vars .env; do
    [ -f "$env_file" ] || continue
    value="$(sed -n 's/^ADMIN_PASSWORD=//p' "$env_file" | head -1 | sed 's/^"//; s/"$//')"
    if [ -n "$value" ]; then ADMIN_PASSWORD="$value"; break; fi
  done
fi

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "ADMIN_PASSWORD is not set, and no .env.local / .dev.vars supplied one." >&2
  echo "Mutating routes are gated, so the script cannot run without it." >&2
  exit 2
fi

# NOTE: JSON bodies are built into variables rather than written inline at the
# call site. An inline "{...,...}" inside "$( ... )" gets brace-expanded by the
# shell into several arguments, which silently sends a malformed body.
req() { # method route [body]
  local method="$1" route="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE$route" -b "$COOKIE_JAR" \
      -H 'content-type: application/json' --data-binary "$body" -w '\n%{http_code}'
  else
    curl -sS -X "$method" "$BASE$route" -b "$COOKIE_JAR" -w '\n%{http_code}'
  fi
}

split() { # captures the body and trailing status code from req
  RESP_BODY="$(printf '%s' "$1" | sed '$d')"
  RESP_CODE="$(printf '%s' "$1" | tail -1)"
}

check() { # description expected actual [detail]
  local desc="$1" expected="$2" actual="$3" detail="${4:-}"
  if [ "$actual" = "$expected" ]; then
    printf '  \033[32mok\033[0m   %-52s %s\n' "$desc" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m %-52s expected %s, got %s\n' "$desc" "$expected" "$actual"
    [ -n "$detail" ] && printf '       %s\n' "$detail"
    FAIL=$((FAIL + 1))
  fi
}

echo "Smoke testing $BASE"
echo

echo "Auth"
split "$(curl -sS -X POST "$BASE/api/posts" -H 'content-type: application/json' \
  --data-binary '{"title":"unauthenticated"}' -w '\n%{http_code}')"
check "mutations rejected without a session" 401 "$RESP_CODE" "$RESP_BODY"

split "$(curl -sS "$BASE/api/posts" -w '\n%{http_code}')"
check "reads stay open without a session" 200 "$RESP_CODE" "$RESP_BODY"

split "$(curl -sS -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  --data-binary '{"password":"definitely-not-the-password"}' -w '\n%{http_code}')"
check "wrong password rejected" 401 "$RESP_CODE" "$RESP_BODY"

login_body="$(printf '{"password":%s}' "$(printf '%s' "$ADMIN_PASSWORD" | jq -Rs .)")"
split "$(curl -sS -c "$COOKIE_JAR" -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' --data-binary "$login_body" -w '\n%{http_code}')"
check "signs in" 200 "$RESP_CODE" "$RESP_BODY"

echo
STAMP="$(date +%s)"
TITLE="Smoke test $STAMP"

echo "POST /api/posts (create draft)"
body="$(printf '{"title":"%s","excerpt":"created by smoke.sh","tags":["Smoke Test"]}' "$TITLE")"
split "$(req POST /api/posts "$body")"
check "creates a draft" 201 "$RESP_CODE" "$RESP_BODY"
POST_ID="$(printf '%s' "$RESP_BODY" | field '.post.id')"
SLUG="$(printf '%s' "$RESP_BODY" | field '.post.slug')"
TAG_COUNT="$(printf '%s' "$RESP_BODY" | field '.post.tags | length')"
check "attached the tag" 1 "$TAG_COUNT" "$RESP_BODY"
echo "       id=$POST_ID slug=$SLUG"

echo
echo "POST /api/posts (same title -> -2 suffix)"
body="$(printf '{"title":"%s"}' "$TITLE")"
split "$(req POST /api/posts "$body")"
check "creates a second draft" 201 "$RESP_CODE" "$RESP_BODY"
DUP_ID="$(printf '%s' "$RESP_BODY" | field '.post.id')"
DUP_SLUG="$(printf '%s' "$RESP_BODY" | field '.post.slug')"
check "slug got a -2 suffix" "$SLUG-2" "$DUP_SLUG" "$RESP_BODY"

echo
echo "GET /api/posts"
split "$(req GET /api/posts)"
check "lists posts" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req GET '/api/posts?status=draft')"
check "filters by status=draft" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req GET '/api/posts?status=nonsense')"
check "rejects an unknown status" 422 "$RESP_CODE" "$RESP_BODY"

echo
echo "GET /api/posts/:id"
split "$(req GET "/api/posts/$POST_ID")"
check "returns the post" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req GET /api/posts/00000000-0000-4000-8000-000000000000)"
check "404s for an unknown id" 404 "$RESP_CODE" "$RESP_BODY"
split "$(req GET /api/posts/not-a-uuid)"
check "422s for a non-uuid id" 422 "$RESP_CODE" "$RESP_BODY"

echo
echo "PATCH /api/posts/:id"
body='{"title":"Smoke test (edited)","tags":["Smoke Test","Second Tag"]}'
split "$(req PATCH "/api/posts/$POST_ID" "$body")"
check "updates title and tags" 200 "$RESP_CODE" "$RESP_BODY"
NEW_SLUG="$(printf '%s' "$RESP_BODY" | field '.post.slug')"
check "editing the title kept the slug" "$SLUG" "$NEW_SLUG" "$RESP_BODY"

split "$(req PATCH "/api/posts/$POST_ID" '{"status":"published"}')"
check "publishes" 200 "$RESP_CODE" "$RESP_BODY"
PUBLISHED_AT="$(printf '%s' "$RESP_BODY" | field '.post.published_at')"
if [ -n "$PUBLISHED_AT" ] && [ "$PUBLISHED_AT" != "null" ]; then
  check "stamped published_at" set set
else
  check "stamped published_at" set missing "$RESP_BODY"
fi

split "$(req PATCH "/api/posts/$POST_ID" '{"slug":"Invalid Slug"}')"
check "rejects a malformed slug" 422 "$RESP_CODE" "$RESP_BODY"
split "$(req PATCH "/api/posts/$POST_ID" '{}')"
check "rejects an empty patch" 422 "$RESP_CODE" "$RESP_BODY"

echo
echo "DELETE /api/posts/:id"
split "$(req DELETE "/api/posts/$POST_ID")"
check "deletes the post" 204 "$RESP_CODE" "$RESP_BODY"
split "$(req DELETE "/api/posts/$DUP_ID")"
check "deletes the duplicate" 204 "$RESP_CODE" "$RESP_BODY"
split "$(req GET "/api/posts/$POST_ID")"
check "deleted post is gone" 404 "$RESP_CODE" "$RESP_BODY"

echo
echo "Public site"
split "$(req GET /)"
check "home feed renders" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req GET /rss.xml)"
check "rss feed renders" 200 "$RESP_CODE" "$RESP_BODY"
case "$RESP_BODY" in
  '<?xml version="1.0" encoding="UTF-8"?>'*) check "rss is xml" xml xml ;;
  *) check "rss is xml" xml "not-xml" "$RESP_BODY" ;;
esac
split "$(req GET /no-such-post-here)"
check "unknown slug is a real 404" 404 "$RESP_CODE" "$RESP_BODY"
split "$(req GET /tag/no-such-tag-here)"
check "unknown tag is a real 404" 404 "$RESP_CODE" "$RESP_BODY"

# A draft must never be readable at its slug, even by someone who guesses it.
draft_body="$(printf '{"title":"Smoke draft %s"}' "$STAMP")"
split "$(req POST /api/posts "$draft_body")"
check "creates a draft to probe with" 201 "$RESP_CODE" "$RESP_BODY"
DRAFT_ID="$(printf '%s' "$RESP_BODY" | field '.post.id')"
DRAFT_SLUG="$(printf '%s' "$RESP_BODY" | field '.post.slug')"
split "$(req GET "/$DRAFT_SLUG")"
check "draft is not readable at its slug" 404 "$RESP_CODE" "$RESP_BODY"
split "$(req DELETE "/api/posts/$DRAFT_ID")"
check "removes the probe draft" 204 "$RESP_CODE" "$RESP_BODY"

echo
echo "Series and search"
split "$(req GET /search)"
check "search page renders" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req GET '/search?q=zzzznotfoundzzz')"
check "a no-result search is still 200" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req GET /series/no-such-series)"
check "unknown series is a real 404" 404 "$RESP_CODE" "$RESP_BODY"

echo
echo "Comments"
# Publish a post to comment on, so the probe never touches real content.
body="$(printf '{"title":"Smoke comment host %s","status":"published","content_html":"<p>Host.</p>"}' "$STAMP")"
split "$(req POST /api/posts "$body")"
check "publishes a host post" 201 "$RESP_CODE" "$RESP_BODY"
HOST_ID="$(printf '%s' "$RESP_BODY" | field '.post.id')"
HOST_SLUG="$(printf '%s' "$RESP_BODY" | field '.post.slug')"

# Submission is the one public write: no session should be needed.
comment="$(printf '{"post_id":"%s","author_name":"Smoke Reader","author_email":"smoke@example.com","body":"A comment from the smoke script."}' "$HOST_ID")"
split "$(curl -sS -X POST "$BASE/api/comments" -H 'content-type: application/json' --data-binary "$comment" -w '\n%{http_code}')"
check "anyone may submit a comment" 202 "$RESP_CODE" "$RESP_BODY"

split "$(req GET "/$HOST_SLUG")"
case "$RESP_BODY" in
  *"A comment from the smoke script"*) check "pending comment stays private" hidden "shown" "$RESP_BODY" ;;
  *) check "pending comment stays private" hidden hidden ;;
esac

honey="$(printf '{"post_id":"%s","author_name":"Bot","author_email":"bot@example.com","body":"Spam body.","website":"http://spam.example"}' "$HOST_ID")"
split "$(curl -sS -X POST "$BASE/api/comments" -H 'content-type: application/json' --data-binary "$honey" -w '\n%{http_code}')"
check "honeypot answers like a real submission" 202 "$RESP_CODE" "$RESP_BODY"

split "$(curl -sS "$BASE/api/comments" -w '\n%{http_code}')"
check "moderation queue needs a session" 401 "$RESP_CODE" "$RESP_BODY"

split "$(req GET '/api/comments?status=pending')"
check "queue readable with a session" 200 "$RESP_CODE" "$RESP_BODY"
COMMENT_ID="$(printf '%s' "$RESP_BODY" | jq -r --arg p "$HOST_ID" '[.comments[] | select(.post.id == $p)][0].id')"

split "$(req PATCH "/api/comments/$COMMENT_ID" '{"status":"approved"}')"
check "approves the comment" 200 "$RESP_CODE" "$RESP_BODY"
sleep 2
split "$(req GET "/$HOST_SLUG")"
case "$RESP_BODY" in
  *"A comment from the smoke script"*) check "approved comment is now public" shown shown ;;
  *) check "approved comment is now public" shown "hidden" ;;
esac

split "$(req DELETE "/api/posts/$HOST_ID")"
check "removes the host post" 204 "$RESP_CODE" "$RESP_BODY"

echo
echo "Sign out"
# -c so curl writes the cleared cookie back to the jar. The session token is
# stateless and stays valid until it expires; signing out removes the client's
# copy of it, which is what this checks.
split "$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST "$BASE/api/auth/logout" -w '\n%{http_code}')"
check "signs out" 200 "$RESP_CODE" "$RESP_BODY"
split "$(req POST /api/posts '{"title":"after logout"}')"
check "cookie no longer sent, so mutations are refused" 401 "$RESP_CODE" "$RESP_BODY"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1

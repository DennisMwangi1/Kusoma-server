#!/usr/bin/env bash
# Phase 1 + 2 verification (§14 of kusoma-migration-prompt.md).
#
# Run against an ALREADY-RUNNING server:  ./scripts/verify.sh [base-url]
# Requires the seed to have run:          npm run db:seed
#
# Proves the things the Revision 2 rework actually changed:
#   - one /auth/login serves tutors and guardians, with different permissions
#   - POST /students creates room + participants in the same transaction
#   - a guardian is read-only at the route layer, not just in the UI
set -euo pipefail

B="${1:-http://localhost:3000}"
j() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log($1)"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "verifying $B"

# --- health ---------------------------------------------------------------
[ "$(curl -sf "$B/health" | j 'd.status')" = "ok" ] && pass "health" || fail "health"

# --- tutor login ----------------------------------------------------------
TUTOR=$(curl -sf -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d '{"phone":"0700000000","password":"kusoma-dev"}')
TT=$(echo "$TUTOR" | j 'd.token')
TROLES=$(echo "$TUTOR" | j 'd.roles.join(",")')
TPERMS=$(echo "$TUTOR" | j 'd.permissions.length')
[ "$TROLES" = "tutor" ] && pass "tutor roles = [tutor]" || fail "tutor roles = $TROLES"
[ "$TPERMS" = "9" ] && pass "tutor has 9 permissions" || fail "tutor permissions = $TPERMS"

# --- create a student -----------------------------------------------------
PHONE="07$(date +%H%M%S)0"
S=$(curl -sf -X POST "$B/students" -H "authorization: Bearer $TT" \
  -H 'content-type: application/json' \
  -d "{\"firstName\":\"Amina\",\"grade\":6,\"phone\":\"$PHONE\"}")
SID=$(echo "$S" | j 'd.student.id')
echo "$S" | j 'd.telegramDeepLink' | grep -q "startgroup=$SID" \
  && pass "telegramDeepLink carries the student id" || fail "deep link"

# The room must exist BEFORE Telegram is involved (§7) — that is the whole
# point of telegram_chat_id being nullable.
DETAIL=$(curl -sf "$B/students/$SID" -H "authorization: Bearer $TT")
[ "$(echo "$DETAIL" | j 'd.chatGroup !== null')" = "true" ] \
  && pass "chat room created with the student" || fail "no chat room"
[ "$(echo "$DETAIL" | j 'd.chatGroup.telegramLinked')" = "false" ] \
  && pass "room not yet Telegram-linked (webhook binds it later)" || fail "telegramLinked"

# --- guardian: the RBAC claim -------------------------------------------
GPHONE="08$(date +%H%M%S)0"
curl -sf -X POST "$B/students/$SID/guardians" -H "authorization: Bearer $TT" \
  -H 'content-type: application/json' \
  -d "{\"displayName\":\"Parent\",\"phone\":\"$GPHONE\",\"password\":\"parent-dev\"}" >/dev/null
pass "guardian created"

# Same endpoint as the tutor used — there is no /auth/guardian/login.
G=$(curl -sf -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d "{\"phone\":\"$GPHONE\",\"password\":\"parent-dev\"}")
GT=$(echo "$G" | j 'd.token')
[ "$(echo "$G" | j 'd.roles.join(",")')" = "guardian" ] \
  && pass "guardian logs in via the SAME /auth/login" || fail "guardian roles"
GP=$(echo "$G" | j 'd.permissions.length')
GW=$(echo "$G" | j "d.permissions.filter(p=>!p.endsWith(':read')).length")
[ "$GP" = "4" ] && pass "guardian has exactly 4 permissions" || fail "guardian permissions = $GP"
[ "$GW" = "0" ] && pass "guardian holds NO write/send permission" || fail "guardian has $GW non-read grants"

# Reads: allowed and scoped to their own child.
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/students/$SID" -H "authorization: Bearer $GT")" = "200" ] \
  && pass "guardian CAN read their student" || fail "guardian read"

# Writes: refused at the route layer, not by hiding a button (§15).
for m in "PATCH /students/$SID" "DELETE /students/$SID"; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X "${m% *}" "$B${m#* }" \
    -H "authorization: Bearer $GT" -H 'content-type: application/json' -d '{"firstName":"Hacked"}')
  [ "$CODE" = "403" ] && pass "guardian BLOCKED from ${m%% *} (403)" || fail "${m%% *} returned $CODE"
done

# Dashboard degrades to their one student rather than 403-ing (§8.2).
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/dashboard/summary" -H "authorization: Bearer $GT")" = "200" ] \
  && pass "guardian dashboard degrades to their student" || fail "guardian dashboard"

# --- unauthenticated ------------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/students")" = "401" ] \
  && pass "unauthenticated request rejected" || fail "unauthenticated"

echo
[ "$FAILED" = "0" ] && echo "all checks passed" || { echo "some checks FAILED"; exit 1; }

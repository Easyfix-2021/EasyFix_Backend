#!/usr/bin/env bash
# ============================================================================
# bootstrap-env.sh — interactive env-var manager for /opt/easyfix/
#
# Batch-mode interactive script. Loop through any number of env var
# add/update operations in one session, then refresh affected Docker
# containers ONCE at the end (deduplicated — backend restart and crm-ui
# rebuild each happen at most once, regardless of how many edits queued).
#
# Files managed (auto-created if absent):
#   /opt/easyfix/.env         (chmod 644) — compose-time / build-args
#                                            (NEXT_PUBLIC_API_URL, etc.)
#   /opt/easyfix/backend.env  (chmod 600) — backend runtime secrets
#                                            (DB_PASSWORD, JWT_SECRET, etc.)
#
# Usage:
#   sudo bash bootstrap-env.sh
#   (no args — fully interactive)
#
# Exit codes:
#   0  success
#   1  user cancelled
#   2  validation / IO error
# ============================================================================

set -euo pipefail

EASYFIX_DIR=/opt/easyfix
ENV_PUBLIC="$EASYFIX_DIR/.env"
ENV_SECRET="$EASYFIX_DIR/backend.env"
COMPOSE_DIR="$EASYFIX_DIR"

# ── pretty helpers ───────────────────────────────────────────────────
RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); NC=$(printf '\033[0m')

err()  { echo "${RED}✗${NC} $*" >&2; }
ok()   { echo "${GREEN}✓${NC} $*"; }
note() { echo "${DIM}$*${NC}"; }
ask()  { local q="$1"; local default="${2:-}"; local input
        if [[ -n "$default" ]]; then read -rp "$q [$default]: " input; echo "${input:-$default}"
        else                          read -rp "$q: " input; echo "$input"; fi; }
ask_secret() { local q="$1"; local input; read -srp "$q: " input; echo >&2; printf '%s' "$input"; }
yesno() { local q="$1"; local default="${2:-N}"; local input
          read -rp "$q [y/N] " input || true
          input="${input:-$default}"
          [[ "$input" =~ ^[Yy] ]]; }

status_line() {
  local f="$1" label="$2"
  if [[ -f "$f" ]]; then
    local count
    count=$(grep -cE '^[A-Z_][A-Z0-9_]*=' "$f" 2>/dev/null || echo 0)
    echo "  ${GREEN}●${NC} $label  $f  ${DIM}($count keys)${NC}"
  else
    echo "  ${YELLOW}○${NC} $label  $f  ${DIM}(will be created)${NC}"
  fi
}

ensure_file() {
  local f="$1" mode="$2"
  if [[ ! -f "$f" ]]; then
    install -m "$mode" -o root -g root /dev/null "$f"
    note "Created $f ($mode)"
  fi
}

key_in_file() {
  local key="$1" file="$2"
  [[ -f "$file" ]] && grep -qE "^${key}=" "$file"
}

display_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || { echo "(file missing)"; return; }
  local value
  value=$(grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-)
  if [[ "$file" == "$ENV_SECRET" ]]; then
    if [[ -z "$value" ]]; then echo "(empty)"
    else                       echo "*** (${#value} chars, masked)"; fi
  else
    echo "$value"
  fi
}

# Atomic write — no sed escaping, handles any character in VALUE.
upsert_kv() {
  local file="$1" key="$2" value="$3"
  ensure_file "$file" "$([[ "$file" == "$ENV_SECRET" ]] && echo 600 || echo 644)"

  local tmp; tmp=$(mktemp)
  local found=0
  if [[ -s "$file" ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == "${key}="* ]]; then
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
        found=1
      else
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < "$file"
  fi
  if [[ $found -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  if [[ -f "$file" ]]; then
    chmod --reference="$file" "$tmp" 2>/dev/null \
      || chmod "$([[ "$file" == "$ENV_SECRET" ]] && echo 600 || echo 644)" "$tmp"
    chown --reference="$file" "$tmp" 2>/dev/null || chown root:root "$tmp"
  fi
  mv "$tmp" "$file"
}

# ── refresh tracker (set semantics — each action runs at most once) ──
# We use plain bash variables instead of associative arrays for portability.
NEEDS_BACKEND_RESTART=0
NEEDS_CRMUI_REBUILD=0
NEEDS_CRMUI_RESTART_ONLY=0

mark_refresh_for() {
  local file="$1" key="$2"
  if [[ "$file" == "$ENV_SECRET" ]]; then
    NEEDS_BACKEND_RESTART=1
    return
  fi
  # File is .env — interpolated by compose at build/up time.
  if [[ "$key" == NEXT_PUBLIC_* ]]; then
    NEEDS_CRMUI_REBUILD=1
    return
  fi
  # Other .env vars — ask once which service(s) need it. We accumulate
  # the answer into the global flags so a second edit doesn't re-ask
  # if the user already chose "both".
  echo
  note "$key is in .env (interpolated at compose time)."
  echo "  Which service(s) should pick up the change?"
  echo "    1) backend"
  echo "    2) crm-ui (rebuild + recreate)"
  echo "    3) both"
  echo "    4) skip — won't auto-restart for this var"
  local choice; choice=$(ask "Choice" "3")
  case "$choice" in
    1) NEEDS_BACKEND_RESTART=1 ;;
    2) NEEDS_CRMUI_REBUILD=1 ;;
    3) NEEDS_BACKEND_RESTART=1; NEEDS_CRMUI_REBUILD=1 ;;
    4) note "Skipped — restart manually if needed" ;;
    *) err "Invalid choice; nothing queued for refresh"; return ;;
  esac
}

# Run all queued refreshes ONCE at the end. Idempotent — calling with
# nothing queued is a no-op.
apply_refreshes() {
  local did=0
  cd "$COMPOSE_DIR"

  if [[ $NEEDS_BACKEND_RESTART -eq 1 ]]; then
    note "▶ Recreating backend container"
    docker compose up -d --force-recreate backend
    did=1
  fi
  if [[ $NEEDS_CRMUI_REBUILD -eq 1 ]]; then
    note "▶ Rebuilding + recreating crm-ui (NEXT_PUBLIC_* changes are baked in)"
    docker compose build crm-ui
    docker compose up -d --force-recreate crm-ui
    did=1
  elif [[ $NEEDS_CRMUI_RESTART_ONLY -eq 1 ]]; then
    note "▶ Recreating crm-ui (no rebuild)"
    docker compose up -d --force-recreate crm-ui
    did=1
  fi

  [[ $did -eq 1 ]] && ok "All affected containers refreshed"
}

# ── one round: prompt for KEY, do the upsert, queue refresh ──────────
# Returns 0 if a change was made, 1 if user cancelled this round.
one_round() {
  local KEY VAL VAL2 ACTION TARGET_FILE OTHER_FILE CHOICE
  declare -a EXISTING_FILES=()

  echo
  KEY=$(ask "Env var KEY (or blank to finish)")
  [[ -z "$KEY" ]] && return 1

  if [[ ! "$KEY" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    err "'$KEY' is not a valid env-var name (UPPER_SNAKE_CASE only)"
    return 1
  fi

  key_in_file "$KEY" "$ENV_PUBLIC" && EXISTING_FILES+=("$ENV_PUBLIC")
  key_in_file "$KEY" "$ENV_SECRET" && EXISTING_FILES+=("$ENV_SECRET")

  if [[ ${#EXISTING_FILES[@]} -gt 0 ]]; then
    echo "${BOLD}'$KEY' currently exists in:${NC}"
    for f in "${EXISTING_FILES[@]}"; do
      printf "  • %-32s value: %s\n" "$f" "$(display_value "$KEY" "$f")"
    done
    echo
    echo "What do you want to do?"
    local idx=1
    for f in "${EXISTING_FILES[@]}"; do
      echo "  $idx) Update value in $(basename "$f")"
      idx=$((idx + 1))
    done
    if [[ ${#EXISTING_FILES[@]} -lt 2 ]]; then
      OTHER_FILE=$([[ "${EXISTING_FILES[0]}" == "$ENV_PUBLIC" ]] && echo "$ENV_SECRET" || echo "$ENV_PUBLIC")
      echo "  $idx) Also add to $(basename "$OTHER_FILE")"
    fi
    echo "  9) Cancel this round"

    CHOICE=$(ask "Choice" "1")
    case "$CHOICE" in
      1) TARGET_FILE="${EXISTING_FILES[0]}";  ACTION="update" ;;
      2)
        if [[ ${#EXISTING_FILES[@]} -ge 2 ]]; then
          TARGET_FILE="${EXISTING_FILES[1]}"; ACTION="update"
        else
          TARGET_FILE="$OTHER_FILE";          ACTION="add"
        fi ;;
      9) note "Cancelled this round"; return 1 ;;
      *) err "Invalid choice"; return 1 ;;
    esac
  else
    echo "'$KEY' is ${YELLOW}not present${NC} in any env file."
    echo "Which file?"
    echo "  1) .env          ${DIM}(build-args / compose interpolation)${NC}"
    echo "  2) backend.env   ${DIM}(backend runtime secrets)${NC}"
    echo "  9) Cancel this round"
    CHOICE=$(ask "Choice" "2")
    case "$CHOICE" in
      1) TARGET_FILE="$ENV_PUBLIC"; ACTION="add" ;;
      2) TARGET_FILE="$ENV_SECRET"; ACTION="add" ;;
      9) note "Cancelled this round"; return 1 ;;
      *) err "Invalid choice"; return 1 ;;
    esac
  fi

  # Value input (masked for backend.env)
  if [[ "$TARGET_FILE" == "$ENV_SECRET" ]]; then
    VAL=$(ask_secret "New value for $KEY (input hidden)")
    VAL2=$(ask_secret "Confirm value")
    if [[ "$VAL" != "$VAL2" ]]; then err "Values don't match"; return 1; fi
  else
    VAL=$(ask "New value for $KEY")
  fi
  if [[ -z "$VAL" ]] && ! yesno "Value is empty — are you sure?"; then
    note "Cancelled this round"
    return 1
  fi

  # Confirm
  echo
  echo "${BOLD}About to $ACTION:${NC}"
  echo "  Key:   $KEY"
  echo "  File:  $TARGET_FILE"
  if [[ "$TARGET_FILE" == "$ENV_SECRET" ]]; then
    echo "  Value: *** (${#VAL} chars, masked)"
  else
    echo "  Value: $VAL"
  fi
  if ! yesno "Proceed?" "Y"; then
    note "Cancelled this round"
    return 1
  fi

  upsert_kv "$TARGET_FILE" "$KEY" "$VAL"
  ok "Wrote $KEY to $TARGET_FILE"

  # Track which container needs the change picked up. We DON'T restart
  # here — restarts are batched at the end so multi-edit sessions only
  # bounce each container once.
  mark_refresh_for "$TARGET_FILE" "$KEY"

  return 0
}

# ── main ─────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || { err "Run as root (sudo bash $0)"; exit 2; }
mkdir -p "$EASYFIX_DIR"

echo "${BOLD}EasyFix env-var manager (batch mode)${NC}"
echo
status_line "$ENV_PUBLIC" "compose / build-args (.env)         "
status_line "$ENV_SECRET" "backend runtime secrets (backend.env)"
echo
note "Add or update one var per round. Press Enter on a blank KEY to finish."
note "Restarts are deferred until the end so multiple edits → one restart per service."

CHANGES=0
while one_round; do
  CHANGES=$((CHANGES + 1))
  echo
  if ! yesno "Add/update another var?" "Y"; then
    break
  fi
done

echo
if [[ $CHANGES -eq 0 ]]; then
  note "No changes made. Exiting."
  exit 0
fi

ok "Made $CHANGES change(s)."
echo
echo "${BOLD}Pending refreshes:${NC}"
[[ $NEEDS_BACKEND_RESTART -eq 1 ]] && echo "  • backend → recreate container"
[[ $NEEDS_CRMUI_REBUILD   -eq 1 ]] && echo "  • crm-ui  → rebuild + recreate (NEXT_PUBLIC_* baked at build time)"
if [[ $NEEDS_BACKEND_RESTART -eq 0 && $NEEDS_CRMUI_REBUILD -eq 0 && $NEEDS_CRMUI_RESTART_ONLY -eq 0 ]]; then
  note "  (none — changes are written but no service was flagged for refresh)"
fi
echo

if yesno "Apply refreshes now?" "Y"; then
  apply_refreshes
else
  note "Skipped. Manual: cd $COMPOSE_DIR && docker compose up -d --force-recreate <service>"
  [[ $NEEDS_CRMUI_REBUILD -eq 1 ]] && note "                  + 'docker compose build crm-ui' for NEXT_PUBLIC_* changes"
fi

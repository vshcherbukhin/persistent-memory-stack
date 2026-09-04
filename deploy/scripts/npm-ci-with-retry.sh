#!/bin/sh
set -eu

attempts="${NPM_CI_ATTEMPTS:-4}"
delay="${NPM_CI_RETRY_DELAY_SECONDS:-5}"

npm config set fetch-retries "${NPM_FETCH_RETRIES:-5}" >/dev/null
npm config set fetch-retry-factor "${NPM_FETCH_RETRY_FACTOR:-2}" >/dev/null
npm config set fetch-retry-mintimeout "${NPM_FETCH_RETRY_MINTIMEOUT:-20000}" >/dev/null
npm config set fetch-retry-maxtimeout "${NPM_FETCH_RETRY_MAXTIMEOUT:-120000}" >/dev/null
npm config set fetch-timeout "${NPM_FETCH_TIMEOUT:-300000}" >/dev/null

i=1
while [ "$i" -le "$attempts" ]; do
  if npm ci "$@"; then
    exit 0
  fi
  status="$?"
  if [ "$i" -eq "$attempts" ]; then
    echo "npm ci failed after ${attempts} attempts." >&2
    exit "$status"
  fi
  echo "npm ci failed with exit ${status}; retrying in ${delay}s (${i}/${attempts})..." >&2
  npm cache clean --force >/dev/null 2>&1 || true
  sleep "$delay"
  delay=$((delay * 2))
  i=$((i + 1))
done

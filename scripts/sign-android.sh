#!/usr/bin/env bash
# Sign a built APK using an external keystore. Never commit signing credentials.
# Requires Bash, GNU coreutils (Linux / WSL), Java, and Android build-tools.
set -euo pipefail
umask 077

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

if [[ $# -ne 2 ]]; then
  printf 'Usage: SHIYU_KEYSTORE=/path/release.jks SHIYU_KEYSTORE_PASSWORD_FILE=/path/password.txt %s INPUT.apk OUTPUT.apk\n' "$0" >&2
  printf 'Optional: SHIYU_KEY_ALIAS (default: shiyu-release), APKSIGNER, ANDROID_HOME / ANDROID_SDK_ROOT.\n' >&2
  exit 2
fi

: "${SHIYU_KEYSTORE:?Set SHIYU_KEYSTORE to an external release keystore}"
: "${SHIYU_KEYSTORE_PASSWORD_FILE:?Set SHIYU_KEYSTORE_PASSWORD_FILE to its password file}"
[[ -f "$1" && -r "$1" ]] || die 'Input APK must be a readable file.'
[[ -f "$SHIYU_KEYSTORE" && -r "$SHIYU_KEYSTORE" ]] || die 'Keystore must be a readable file.'
[[ -s "$SHIYU_KEYSTORE_PASSWORD_FILE" && -r "$SHIYU_KEYSTORE_PASSWORD_FILE" ]] || die 'Password file must be readable and nonempty.'
[[ ! -e "$2" && ! -L "$2" ]] || die 'Output must be a new path; the input APK is never overwritten.'

apksigner_bin="${APKSIGNER:-}"
if [[ -z "$apksigner_bin" ]]; then
  if command -v apksigner >/dev/null 2>&1; then
    apksigner_bin="$(command -v apksigner)"
  else
    sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
    [[ -n "$sdk_root" ]] || die 'Set APKSIGNER or install Android build-tools and set ANDROID_HOME.'
    shopt -s nullglob
    candidates=("$sdk_root"/build-tools/*/apksigner)
    ((${#candidates[@]} > 0)) || die 'No apksigner found in Android build-tools.'
    apksigner_bin="$(printf '%s\n' "${candidates[@]}" | sort -V | tail -n 1)"
  fi
fi
[[ -x "$apksigner_bin" ]] || die 'APKSIGNER must point to an executable.'

output_dir="$(dirname -- "$2")"
mkdir -p -- "$output_dir"
staging_dir="$(mktemp -d "$output_dir/.shiyu-sign.XXXXXXXX")"
trap 'rm -rf -- "$staging_dir"' EXIT

# apksigner replaces existing APK signatures, including a local debug signature.
# Both passwords are read by apksigner from the file, never from shell arguments.
"$apksigner_bin" sign \
  --ks "$SHIYU_KEYSTORE" \
  --ks-key-alias "${SHIYU_KEY_ALIAS:-shiyu-release}" \
  --ks-pass "file:$SHIYU_KEYSTORE_PASSWORD_FILE" \
  --key-pass "file:$SHIYU_KEYSTORE_PASSWORD_FILE" \
  --v4-signing-enabled false \
  --out "$staging_dir/signed.apk" \
  --in "$1"
"$apksigner_bin" verify --verbose --print-certs "$staging_dir/signed.apk"

# A hard link publishes the already verified file atomically without overwriting
# an existing destination, even if another process created it while signing.
ln -T -- "$staging_dir/signed.apk" "$2"
printf 'Signed and verified APK: %s\n' "$2"

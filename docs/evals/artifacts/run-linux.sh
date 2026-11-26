#!/bin/sh
# Usage from the repo root: sh docs/evals/artifacts/run-linux.sh BEFORE AFTER OUTPUT
set -eu
before=$(git rev-parse --verify "${1:?baseline ref}^{commit}")
after=$(git rev-parse --verify "${2:?comparison ref}^{commit}")
output=${3:?output directory}
image=node@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
volume=$(docker volume create)
trap 'docker volume rm "$volume" >/dev/null' EXIT
docker image inspect "$image" >/dev/null 2>&1 || docker pull --platform linux/arm64 "$image" >/dev/null

# Each revision gets its own sources and node_modules on the VM's native filesystem.
for side in before after; do
  if [ "$side" = before ]; then rev=$before; else rev=$after; fi
  git archive "$rev" | docker run --rm -i --network none -v "$volume:/study" "$image" \
    sh -ec 'mkdir -p "/study/$1" && tar xf - -C "/study/$1"' sh "$side"
done
docker run --rm -v "$volume:/study" -e COREPACK_HOME=/study/corepack -e CI=true "$image" sh -ec '
  mkdir -p /study/bin
  corepack enable --install-directory /study/bin pnpm
  for side in before after; do
    cd "/study/$side"
    corepack pnpm install --frozen-lockfile --reporter=append-only
  done
  chown -R node:node /study
'
status=0
for side in before after; do
  mkdir -p "$output/$side"
  if [ "$side" = before ]; then rev=$before; else rev=$after; fi
  {
    echo "revision=$rev"
    echo "image=$image"
    docker run --rm --network none -u node -v "$volume:/study" -w "/study/$side" \
      -e COREPACK_HOME=/study/corepack -e COREPACK_ENABLE_NETWORK=0 "$image" \
      sh -ec 'node -p "process.platform + \"/\" + process.arch + \" \" + process.version"; corepack pnpm --version'
  } > "$output/$side/environment.log"
  for gate in tests typecheck web-build; do
    case "$gate" in
      tests) set -- test ;;
      typecheck) set -- typecheck ;;
      web-build) set -- --filter @alter/web build ;;
    esac
    code=0
    # Reap orphaned fixture subprocesses as on a regular host with an init process.
    docker run --rm --init --network none -u node -v "$volume:/study" -w "/study/$side" \
      -e PATH=/study/bin:/usr/local/bin:/usr/bin:/bin -e COREPACK_HOME=/study/corepack \
      -e COREPACK_ENABLE_NETWORK=0 -e CI=true -e NO_COLOR=1 -e TZ=UTC -e ALTER_BROWSER=off \
      -e pnpm_config_workspace_concurrency=1 -e VITEST_MAX_WORKERS=1 \
      "$image" pnpm "$@" > "$output/$side/$gate.log" 2>&1 || code=$?
    echo "$code" > "$output/$side/$gate.exit"
    if [ "$code" != 0 ]; then status=1; fi
  done
done
exit "$status"
